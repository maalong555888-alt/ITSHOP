import worker from "./index";

interface SecureEnv {
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_USER_ID: string;
  SETUP_SECRET: string;
  [key: string]: unknown;
}

function plain(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function notFound(): Response {
  return plain("Not Found", 404);
}

export default {
  async fetch(request: Request, env: SecureEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Keep webhook setup off the public GET surface. It can only be invoked
    // deliberately with a separate Cloudflare secret in the Authorization header.
    if (url.pathname === "/setup") {
      if (request.method !== "POST") return notFound();
      const auth = request.headers.get("authorization") || "";
      if (!env.SETUP_SECRET || auth !== `Bearer ${env.SETUP_SECRET}`) return notFound();

      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const forwarded = new Request(request.url, { method: "GET", headers });
      return (worker as any).fetch(forwarded, env, ctx);
    }

    if (url.pathname === "/telegram/webhook") {
      if (request.method !== "POST") return notFound();

      // Telegram signs webhook deliveries with the secret configured by setWebhook.
      const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || supplied !== env.TELEGRAM_WEBHOOK_SECRET) return notFound();

      // Reject all commands except the owner's direct/private chat before the
      // application layer sees them. This prevents project/client data from ever
      // being returned in groups or to another Telegram account.
      let update: any;
      try {
        update = await request.clone().json();
      } catch {
        return plain("Bad Request", 400);
      }

      const message = update?.message;
      if (!message) return plain("OK");

      const fromId = String(message?.from?.id ?? "");
      const chatId = String(message?.chat?.id ?? "");
      const chatType = String(message?.chat?.type ?? "");
      const allowedId = String(env.ALLOWED_TELEGRAM_USER_ID || "");

      if (!allowedId || fromId !== allowedId || chatId !== allowedId || chatType !== "private") {
        return plain("OK");
      }

      return (worker as any).fetch(request, env, ctx);
    }

    // Only expose the minimal health endpoint publicly.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return (worker as any).fetch(request, env, ctx);
    }

    return notFound();
  },
};
