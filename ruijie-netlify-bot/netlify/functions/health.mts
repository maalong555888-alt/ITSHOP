import type { Config, Context } from "@netlify/functions";
import { env } from "../lib/common.mts";

export default async (_req: Request, _context: Context) => {
  const token = env("TELEGRAM_BOT_TOKEN");
  let telegramReachable: boolean | null = null;
  let username: string | null = null;
  if (token) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json() as any;
      telegramReachable = Boolean(data?.ok);
      username = data?.ok ? (data.result?.username || null) : null;
    } catch { telegramReachable = false; }
  }
  return Response.json({
    ok: true,
    service: "ruijie-telegram-bot",
    telegram: { configured: Boolean(token), reachable: telegramReachable, username },
    ruijie: { appIdConfigured: Boolean(env("RUIJIE_APPID")), secretConfigured: Boolean(env("RUIJIE_SECRET")), baseUrl: env("RUIJIE_BASE_URL") || "https://cloud-as.ruijienetworks.com" },
    accessControlConfigured: Boolean(env("ALLOWED_USER_IDS")),
    webhookSecretConfigured: Boolean(env("TELEGRAM_WEBHOOK_SECRET")),
  });
};

export const config: Config = { path: "/api/health" };
