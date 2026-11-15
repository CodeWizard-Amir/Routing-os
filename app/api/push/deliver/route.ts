import { Receiver } from "@upstash/qstash";
import webpush from "web-push";
import { NextRequest, NextResponse } from "next/server";
import { decryptPushPayload, isPushEncryptionKeyConfigured, isValidPushSubscription } from "@/lib/push-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function isPushPayload(value: unknown): value is {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  notification: { title: string; body: string; tag?: string; url?: string };
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!isValidPushSubscription(candidate.subscription)) return false;
  if (!candidate.notification || typeof candidate.notification !== "object") return false;
  const notification = candidate.notification as Record<string, unknown>;
  const safeUrl = notification.url === undefined
    || (typeof notification.url === "string" && notification.url.startsWith("/") && !notification.url.startsWith("//") && notification.url.length <= 300);
  const safeTag = notification.tag === undefined
    || (typeof notification.tag === "string" && notification.tag.length > 0 && notification.tag.length <= 64);
  return typeof notification.title === "string" && notification.title.length > 0 && notification.title.length <= 120
    && typeof notification.body === "string" && notification.body.length > 0 && notification.body.length <= 300
    && safeUrl && safeTag;
}

export async function POST(request: NextRequest) {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!currentSigningKey || !nextSigningKey || !publicKey || !privateKey || !isPushEncryptionKeyConfigured()) {
    return NextResponse.json({ error: "Push delivery environment is not configured." }, { status: 503 });
  }

  const body = await request.text();
  const signature = request.headers.get("Upstash-Signature");
  if (!signature) return NextResponse.json({ error: "Missing QStash signature." }, { status: 401 });

  try {
    const receiver = new Receiver({ currentSigningKey, nextSigningKey });
    const valid = await receiver.verify({ body, signature, url: request.url });
    if (!valid) return NextResponse.json({ error: "Invalid QStash signature." }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "QStash signature verification failed." }, { status: 401 });
  }

  let payload: unknown;
  try {
    const encryptedEnvelope: unknown = JSON.parse(body);
    payload = JSON.parse(decryptPushPayload(encryptedEnvelope));
    if (!isPushPayload(payload)) {
      return NextResponse.json({ error: "Invalid push payload." }, { status: 400 });
    }
  } catch (error) {
    console.error("Push payload decryption or validation failed:", error);
    return NextResponse.json({ error: "Invalid or undecryptable push payload." }, { status: 400 });
  }

  try {
    const subject = process.env.VAPID_SUBJECT || new URL(request.url).origin;
    webpush.setVapidDetails(subject, publicKey, privateKey);

    await webpush.sendNotification(
      payload.subscription,
      JSON.stringify({
        title: payload.notification.title,
        body: payload.notification.body,
        tag: payload.notification.tag ?? "routine-os-reminder",
        url: payload.notification.url ?? "/",
      }),
      { TTL: 3600, urgency: "high" },
    );

    return NextResponse.json({ delivered: true });
  } catch (error) {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 0;

    // A 404/410 means this device subscription has expired or was revoked.
    // Retrying a dead subscription cannot help, so acknowledge it to QStash.
    if (statusCode === 404 || statusCode === 410) {
      return NextResponse.json({ delivered: false, subscriptionExpired: true });
    }

    console.error("Web Push delivery failed:", error);
    return NextResponse.json({ error: "Web Push provider rejected the notification." }, { status: 502 });
  }
}
