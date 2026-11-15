import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@upstash/qstash";

export function isPushApiAuthorized(authorization: string | null): boolean {
  const expected = process.env.PUSH_API_SECRET;
  if (!expected || !authorization?.startsWith("Bearer ")) return false;

  const received = Buffer.from(authorization.slice(7).trim());
  const configured = Buffer.from(expected.trim());
  if (!received.length || received.length !== configured.length) return false;
  return timingSafeEqual(received, configured);
}

export function getQStashClient(): Client {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QSTASH_TOKEN is not configured.");
  return new Client({ token, enableTelemetry: false });
}

export function isValidPushSubscription(value: unknown): value is {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length > 4096) return false;
  try {
    const endpoint = new URL(candidate.endpoint);
    if (endpoint.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (!candidate.keys || typeof candidate.keys !== "object") return false;
  const keys = candidate.keys as Record<string, unknown>;
  return typeof keys.p256dh === "string" && keys.p256dh.length > 20 && keys.p256dh.length <= 256
    && typeof keys.auth === "string" && keys.auth.length > 8 && keys.auth.length <= 256;
}


export type EncryptedPushEnvelope = {
  version: 1;
  iv: string;
  tag: string;
  data: string;
};

function getPushEncryptionKey(): Buffer {
  const configured = process.env.PUSH_PAYLOAD_ENCRYPTION_KEY;
  if (!configured) throw new Error("PUSH_PAYLOAD_ENCRYPTION_KEY is not configured.");
  const key = Buffer.from(configured.trim(), "base64");
  if (key.length !== 32) throw new Error("PUSH_PAYLOAD_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function isPushEncryptionKeyConfigured(): boolean {
  try {
    getPushEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypts reminder data before it is stored in the delayed QStash message. */
export function encryptPushPayload(payload: unknown): EncryptedPushEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getPushEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  };
}

/** Decrypts only after the QStash request signature has been verified. */
export function decryptPushPayload(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("Invalid encrypted push envelope.");
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") {
    throw new Error("Invalid encrypted push envelope.");
  }

  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  const encrypted = Buffer.from(envelope.data, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0 || encrypted.length > 20_000) {
    throw new Error("Invalid encrypted push payload size.");
  }

  const decipher = createDecipheriv("aes-256-gcm", getPushEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
