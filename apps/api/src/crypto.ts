import crypto from "node:crypto";
import { config } from "./config.js";

const key = crypto.createHash("sha256").update(config.secret).digest();
const secretAad = Buffer.from("submail-secret:v1", "utf8");

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(secretAad);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  const versioned = value.startsWith("v1.");
  const payload = Buffer.from(versioned ? value.slice(3) : value, "base64url");
  if (payload.length < 29) throw new Error("加密凭据格式无效");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  if (versioned) decipher.setAAD(secretAad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("base64url"));
  const expected = Buffer.from(hash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createSessionToken(): string {
  return `sess_${crypto.randomBytes(32).toString("base64url")}`;
}

export function createApiKey(): string {
  return `sk_submail_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}
