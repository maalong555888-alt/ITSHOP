import type { Config, Context } from "@netlify/functions";
import { env } from "../lib/common.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env("SETUP_SECRET") || req.headers.get("x-setup-secret") !== env("SETUP_SECRET")) return new Response("Forbidden", { status: 403 });
  const token = env("TELEGRAM_BOT_TOKEN"), webhookSecret = env("TELEGRAM_WEBHOOK_SECRET"), siteUrl = env("URL");
  if (!token || !webhookSecret || !siteUrl) return Response.json({ ok: false, error: "Required Telegram settings are missing" }, { status: 503 });
  const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meResponse.json() as any;
  if (!me?.ok) return Response.json({ ok: false, error: "Telegram token is not valid" }, { status: 400 });
  const webhookUrl = `${siteUrl.replace(/\/$/, "")}/api/telegram`;
  const setResponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret, allowed_updates: ["message"] }) });
  const set = await setResponse.json() as any;
  return Response.json({ ok: Boolean(set?.ok), bot: me.result?.username || null, webhookUrl, result: set?.ok ? "configured" : (set?.description || "failed") });
};

export const config: Config = { path: "/api/setup" };
