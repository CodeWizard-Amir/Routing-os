const PUSH_ACCESS_KEY_STORAGE = "routine-os-push-access-key";

export type PushSubscriptionPayload = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type SchedulePushInput = {
  subscription: PushSubscriptionPayload;
  occurrenceId: string;
  scheduledAt: number;
  title: string;
  body: string;
  url?: string;
};

export function readPushAccessKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(PUSH_ACCESS_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function savePushAccessKey(value: string): void {
  if (typeof window === "undefined") return;
  if (value.trim()) window.localStorage.setItem(PUSH_ACCESS_KEY_STORAGE, value.trim());
  else window.localStorage.removeItem(PUSH_ACCESS_KEY_STORAGE);
}

function decodeVapidPublicKey(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function getOrCreatePushSubscription(): Promise<PushSubscription> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("این مرورگر از Push API پشتیبانی نمی‌کند.");
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error("کلید عمومی اعلان در تنظیمات Vercel تعریف نشده است.");

  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidPublicKey(publicKey) as BufferSource,
    });
  }
  return subscription;
}

async function pushApiRequest<T>(path: string, accessKey: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessKey}`,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  const result = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(result.error || `درخواست اعلان ناموفق بود (${response.status}).`);
  }
  return result;
}

export function schedulePushReminder(accessKey: string, payload: SchedulePushInput) {
  return pushApiRequest<{ messageId: string; scheduledAt: number }>("/api/push/schedule", accessKey, payload);
}

export function cancelPushReminders(accessKey: string, messageIds: string[]) {
  if (!messageIds.length) return Promise.resolve({ cancelled: 0, requested: 0 });
  return pushApiRequest<{ cancelled: number; requested: number }>("/api/push/cancel", accessKey, { messageIds });
}
