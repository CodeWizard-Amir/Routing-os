import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { encryptPushPayload, getQStashClient, isPushApiAuthorized, isPushEncryptionKeyConfigured, isValidPushSubscription } from "@/lib/push-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DELAY_MS = 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000;
const MIN_DELAY_MS = 10 * 1000;

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

export async function POST(request: NextRequest) {
  if (!process.env.PUSH_API_SECRET) {
    return NextResponse.json({ error: "تنظیم PUSH_API_SECRET در Vercel انجام نشده است." }, { status: 503 });
  }
  if (!isPushEncryptionKeyConfigured()) {
    return NextResponse.json({ error: "کلید رمزگذاری PUSH_PAYLOAD_ENCRYPTION_KEY در Vercel تنظیم نشده یا معتبر نیست." }, { status: 503 });
  }
  if (!isPushApiAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "کد اتصال اعلان معتبر نیست." }, { status: 401 });
  }

  try {
    const input = await request.json() as Record<string, unknown>;
    if (!isValidPushSubscription(input.subscription)) {
      return NextResponse.json({ error: "اشتراک اعلان مرورگر معتبر نیست. اعلان‌ها را دوباره فعال کن." }, { status: 400 });
    }

    const occurrenceId = text(input.occurrenceId, 180);
    const title = text(input.title, 120);
    const body = text(input.body, 300);
    const url = typeof input.url === "string" && input.url.startsWith("/") && !input.url.startsWith("//") ? input.url.slice(0, 300) : "/";
    const scheduledAt = typeof input.scheduledAt === "number" ? input.scheduledAt : Number.NaN;
    const now = Date.now();

    if (!occurrenceId || !title || !body || !Number.isFinite(scheduledAt)) {
      return NextResponse.json({ error: "اطلاعات زمان‌بندی اعلان ناقص یا نامعتبر است." }, { status: 400 });
    }
    if (scheduledAt < now + MIN_DELAY_MS) {
      return NextResponse.json({ error: "زمان اعلان باید حداقل ۱۰ ثانیه در آینده باشد." }, { status: 422 });
    }
    if (scheduledAt > now + MAX_DELAY_MS) {
      return NextResponse.json({ error: "در پلن رایگان، زمان‌بندی اعلان حداکثر تا حدود ۷ روز آینده پشتیبانی می‌شود." }, { status: 422 });
    }

    const destination = new URL("/api/push/deliver", request.url).toString();
    const subscriptionFingerprint = createHash("sha256").update(input.subscription.endpoint).digest("hex").slice(0, 20);
    const deduplicationId = createHash("sha256")
      .update(`routine-os|${subscriptionFingerprint}|${occurrenceId}|${scheduledAt}`)
      .digest("hex");

    const result = await getQStashClient().publishJSON({
      url: destination,
      body: encryptPushPayload({
        subscription: input.subscription,
        notification: {
          title,
          body,
          tag: `routine-${occurrenceId}`.slice(0, 64),
          url,
        },
      }),
      notBefore: Math.ceil(scheduledAt / 1000),
      retries: 3,
      timeout: 25,
      deduplicationId,
      label: "routine-os-reminder",
    });

    return NextResponse.json({ messageId: result.messageId, scheduledAt });
  } catch (error) {
    console.error("Push scheduling failed:", error);
    return NextResponse.json({ error: "ثبت زمان اعلان در سرویس زمان‌بندی ناموفق بود. تنظیمات QStash را بررسی کن." }, { status: 502 });
  }
}
