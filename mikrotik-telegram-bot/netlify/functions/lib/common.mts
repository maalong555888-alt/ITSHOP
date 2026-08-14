import { getStore } from "@netlify/blobs";
import { createHash, webcrypto } from "node:crypto";

const te = new TextEncoder();
const td = new TextDecoder();

export const env = (name: string): string =>
  (globalThis as any).Netlify?.env?.get?.(name) ?? process.env[name] ?? "";

export const DB = () => getStore("network-control", { consistency: "strong" });
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const allowedUsers = () => new Set(env("ALLOWED_USER_IDS").split(",").map(x => Number(x.trim())).filter(Number.isFinite));
export const webhookSecret = () => hash(`webhook:${env("TELEGRAM_BOT_TOKEN")}`).slice(0, 64);

async function cryptoKey(): Promise<CryptoKey> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const raw = createHash("sha256").update(`store:${token}`).digest();
  return webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value: unknown): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), te.encode(JSON.stringify(value)));
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(cipher).toString("base64url")}`;
}

export async function unseal<T>(value: string): Promise<T> {
  const [a, b] = value.split(".", 2);
  const plain = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(Buffer.from(a, "base64url")) },
    await cryptoKey(),
    new Uint8Array(Buffer.from(b, "base64url")),
  );
  return JSON.parse(td.decode(plain)) as T;
}

export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  return data.result;
}

export async function say(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  let rest = text || "(empty)";
  while (rest.length > 3900) {
    await tg("sendMessage", { chat_id: chatId, text: rest.slice(0, 3900), ...extra });
    rest = rest.slice(3900);
  }
  await tg("sendMessage", { chat_id: chatId, text: rest, ...extra });
}

export async function deleteMessage(chatId: number, messageId: number) {
  try { await tg("deleteMessage", { chat_id: chatId, message_id: messageId }); } catch {}
}
