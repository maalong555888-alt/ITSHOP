interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_USER_ID: string;
  RUIJIE_APP_ID: string;
  RUIJIE_APP_SECRET: string;
  RUIJIE_BASE_URL: string;
}

type Json = Record<string, any>;
type GroupRow = { id: number; name: string; indent: number };

const ACCESS_TOKEN_MAGIC = "d63dss0a81e4415a889ac5b78fsc904a";
const DEVICE_TYPES = ["AP", "Switch", "Gateway"];
let cachedToken = "";
let tokenExpiresAt = 0;

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function readJson(resp: Response): Promise<Json> {
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(`HTTP ${resp.status}: Ruijie returned non-JSON content`);
  }
  const data = await resp.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`HTTP ${resp.status}: unexpected response format`);
  }
  return data as Json;
}

function apiMessage(data: Json): string {
  return String(data.msg ?? data.message ?? data.error ?? "Request failed");
}

function apiSucceeded(data: Json): boolean {
  return data.code === undefined || data.code === null || data.code === 0 || data.code === "0";
}

function tokenExpired(data: Json): boolean {
  const code = data.code;
  const msg = String(data.msg ?? "").toLowerCase();
  return code === 4 || code === "4" || (msg.includes("token") && (msg.includes("expire") || msg.includes("invalid")));
}

async function authenticate(env: Env): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const base = env.RUIJIE_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/service/api/oauth20/client/access_token`);
  url.searchParams.set("token", ACCESS_TOKEN_MAGIC);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ appid: env.RUIJIE_APP_ID, secret: env.RUIJIE_APP_SECRET }),
  });
  const data = await readJson(resp);
  if (!resp.ok || !apiSucceeded(data)) throw new Error(`Ruijie login failed: ${apiMessage(data)}`);
  const token = String(data.accessToken ?? data.access_token ?? "").trim();
  if (!token) throw new Error("Ruijie login response did not include an access token");
  cachedToken = token;
  tokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return token;
}

async function ruijieRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number> = {},
  body?: unknown,
  retry = true,
): Promise<Json> {
  const token = await authenticate(env);
  const base = env.RUIJIE_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", token);
  const resp = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await readJson(resp);
  if (retry && tokenExpired(data)) {
    cachedToken = "";
    tokenExpiresAt = 0;
    return ruijieRequest(env, method, path, params, body, false);
  }
  if (!resp.ok || !apiSucceeded(data)) throw new Error(`${apiMessage(data)} (${path})`);
  return data;
}

function extractList(data: Json, keys: string[]): Json[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
    if (value && typeof value === "object") {
      for (const nestedKey of ["list", "items", "records", "deviceList", "data"]) {
        const nested = value[nestedKey];
        if (Array.isArray(nested)) return nested.filter((x: unknown) => x && typeof x === "object");
      }
    }
  }
  return [];
}

function walkGroups(node: unknown, indent = 0, rows: GroupRow[] = []): GroupRow[] {
  if (Array.isArray(node)) {
    for (const child of node) walkGroups(child, indent, rows);
    return rows;
  }
  if (!node || typeof node !== "object") return rows;
  const obj = node as Json;
  const rawId = obj.groupId ?? obj.id;
  if (rawId !== undefined && rawId !== null && !Number.isNaN(Number(rawId))) {
    rows.push({ id: Number(rawId), name: String(obj.name ?? obj.groupName ?? "Unnamed"), indent });
  }
  for (const key of ["subGroups", "children", "groups"]) {
    if (Array.isArray(obj[key])) walkGroups(obj[key], indent + (rawId !== undefined ? 1 : 0), rows);
  }
  return rows;
}

async function getGroups(env: Env): Promise<GroupRow[]> {
  const data = await ruijieRequest(env, "GET", "/service/api/group/single/tree", { depth: "DEVICE" });
  const root = data.groups ?? data.data ?? data;
  const rows = walkGroups(root);
  const seen = new Set<number>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

async function getDevices(env: Env, groupId: number): Promise<Json[]> {
  const result: Json[] = [];
  const seen = new Set<string>();
  for (const commonType of DEVICE_TYPES) {
    const data = await ruijieRequest(env, "GET", "/service/api/maint/devices", {
      common_type: commonType,
      group_id: groupId,
      page: 0,
      per_page: 1000,
    });
    for (const row of extractList(data, ["deviceList", "list", "data", "records"])) {
      const key = String(row.serialNumber ?? row.sn ?? JSON.stringify(row));
      if (!seen.has(key)) {
        seen.add(key);
        result.push(row);
      }
    }
  }
  return result;
}

async function getClients(env: Env, groupId: number): Promise<Json[]> {
  const data = await ruijieRequest(env, "POST", "/logbizagent/logbiz/api/sta/sta_users", {}, {
    groupId,
    pageSize: 1000,
    pageIndex: 0,
    staType: "currentUser",
  });
  return extractList(data, ["list", "data", "records"]);
}

async function telegramApi(env: Env, method: string, payload: Json): Promise<Json> {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await resp.json()) as Json;
  if (!resp.ok || data.ok !== true) throw new Error(`Telegram ${method} failed: ${String(data.description ?? resp.status)}`);
  return data;
}

async function sendText(env: Env, chatId: number | string, text: string): Promise<void> {
  let remaining = text || "(empty)";
  while (remaining.length > 3900) {
    let cut = remaining.lastIndexOf("\n", 3900);
    if (cut < 1000) cut = 3900;
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: remaining.slice(0, cut) });
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: remaining });
}

function statusLabel(d: Json): string {
  const raw = d.online ?? d.isOnline ?? d.deviceOnline ?? d.status ?? d.state;
  if (raw === true || raw === 1 || raw === "1" || String(raw).toLowerCase() === "online") return "🟢";
  if (raw === false || raw === 0 || raw === "0" || String(raw).toLowerCase() === "offline") return "🔴";
  return "⚪";
}

function formatDevice(d: Json): string {
  const sn = String(d.serialNumber ?? d.sn ?? "?");
  const name = String(d.name ?? d.deviceName ?? d.alias ?? sn);
  const type = String(d.productType ?? d.commonType ?? d.type ?? d.productClass ?? "device");
  return `${statusLabel(d)} ${name} [${type}] SN:${sn}`;
}

function formatClient(c: Json): string {
  const name = String(c.userName ?? c.hostname ?? c.deviceName ?? c.nickName ?? "unknown");
  const mac = String(c.mac ?? c.macAddress ?? "");
  const ip = String(c.ip ?? c.ipAddress ?? "");
  return `• ${name}${mac ? ` — ${mac}` : ""}${ip ? ` — ${ip}` : ""}`;
}

function summarizeObject(value: unknown, maxLines = 60): string {
  if (!value || typeof value !== "object") return String(value ?? "No data");
  const data = value as Json;
  const lines: string[] = [];
  const visit = (obj: unknown, prefix = "", depth = 0) => {
    if (lines.length >= maxLines || depth > 2) return;
    if (Array.isArray(obj)) {
      obj.slice(0, 20).forEach((item, i) => visit(item, `${prefix}[${i}]`, depth + 1));
      return;
    }
    if (!obj || typeof obj !== "object") {
      lines.push(`${prefix}: ${String(obj ?? "")}`);
      return;
    }
    for (const [k, v] of Object.entries(obj as Json)) {
      if (lines.length >= maxLines) break;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") visit(v, key, depth + 1);
      else lines.push(`${key}: ${String(v ?? "")}`);
    }
  };
  visit(data);
  return lines.length ? lines.join("\n") : JSON.stringify(data).slice(0, 3500);
}

async function handleCommand(env: Env, chatId: number, userId: number, text: string): Promise<void> {
  if (String(userId) !== String(env.ALLOWED_TELEGRAM_USER_ID)) {
    await sendText(env, chatId, "Not authorized. This bot is private.");
    return;
  }
  const parts = text.trim().split(/\s+/);
  const command = (parts.shift() || "").split("@")[0].toLowerCase();
  const args = parts;

  try {
    if (command === "/start" || command === "/help") {
      await sendText(env, chatId,
        "Ruijie / Reyee Cloud control bot ✅\n\n" +
        "/projects — all projects/groups\n" +
        "/devices <group_id> — equipment in one project\n" +
        "/clients <group_id> — current clients\n" +
        "/alldevices [page] — paged account-wide equipment scan\n" +
        "/allclients [page] — paged account-wide client scan\n" +
        "/device <serial> — device details\n" +
        "/traffic <serial> — last 24h traffic\n" +
        "/performance <serial> — current performance\n" +
        "/ports <serial> — gateway/switch ports\n" +
        "/poe <serial> — switch PoE info\n\n" +
        "Credentials are stored as private Cloudflare secrets; do not send them in Telegram."
      );
      return;
    }

    if (command === "/projects" || command === "/allprojects") {
      const rows = await getGroups(env);
      if (!rows.length) return sendText(env, chatId, "No projects/groups returned by Ruijie Cloud.");
      const lines = [`All Ruijie/Reyee projects & groups (${rows.length}):`];
      for (const r of rows) lines.push(`${"  ".repeat(Math.min(r.indent, 6))}• ${r.name} — id: ${r.id}`);
      await sendText(env, chatId, lines.join("\n"));
      return;
    }

    if (command === "/devices") {
      if (!args[0] || Number.isNaN(Number(args[0]))) return sendText(env, chatId, "Usage: /devices <group_id>\nUse /projects to find the ID.");
      const groupId = Number(args[0]);
      const devices = await getDevices(env, groupId);
      const lines = [`Devices in project/group ${groupId} (${devices.length}):`, ...devices.map(formatDevice)];
      await sendText(env, chatId, lines.join("\n"));
      return;
    }

    if (command === "/clients") {
      if (!args[0] || Number.isNaN(Number(args[0]))) return sendText(env, chatId, "Usage: /clients <group_id>\nUse /projects to find the ID.");
      const groupId = Number(args[0]);
      const clients = await getClients(env, groupId);
      const lines = [`Current clients in project/group ${groupId} (${clients.length}):`, ...clients.map(formatClient)];
      await sendText(env, chatId, lines.join("\n"));
      return;
    }

    if (command === "/alldevices") {
      const page = Math.max(1, Number(args[0] || 1) || 1);
      const pageSize = 8;
      const groups = await getGroups(env);
      const start = (page - 1) * pageSize;
      const batch = groups.slice(start, start + pageSize);
      if (!batch.length) return sendText(env, chatId, `No project groups on page ${page}. Total groups: ${groups.length}.`);
      const lines = [`Account-wide equipment — page ${page}/${Math.max(1, Math.ceil(groups.length / pageSize))}:`];
      let total = 0;
      for (const g of batch) {
        try {
          const devices = await getDevices(env, g.id);
          if (!devices.length) continue;
          lines.push(`\n${g.name} (id ${g.id})`);
          for (const d of devices) { lines.push(`  ${formatDevice(d)}`); total += 1; }
        } catch (e) {
          lines.push(`\n${g.name} (id ${g.id}) — read error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      lines.push(`\nEquipment shown on this page: ${total}`);
      if (start + pageSize < groups.length) lines.push(`Next: /alldevices ${page + 1}`);
      await sendText(env, chatId, lines.join("\n"));
      return;
    }

    if (command === "/allclients") {
      const page = Math.max(1, Number(args[0] || 1) || 1);
      const pageSize = 12;
      const groups = await getGroups(env);
      const start = (page - 1) * pageSize;
      const batch = groups.slice(start, start + pageSize);
      if (!batch.length) return sendText(env, chatId, `No project groups on page ${page}. Total groups: ${groups.length}.`);
      const lines = [`Account-wide clients — page ${page}/${Math.max(1, Math.ceil(groups.length / pageSize))}:`];
      let total = 0;
      for (const g of batch) {
        try {
          const clients = await getClients(env, g.id);
          if (!clients.length) continue;
          lines.push(`\n${g.name} (id ${g.id})`);
          for (const c of clients) { lines.push(`  ${formatClient(c)}`); total += 1; }
        } catch (e) {
          lines.push(`\n${g.name} (id ${g.id}) — read error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      lines.push(`\nClients shown on this page: ${total}`);
      if (start + pageSize < groups.length) lines.push(`Next: /allclients ${page + 1}`);
      await sendText(env, chatId, lines.join("\n"));
      return;
    }

    if (["/device", "/traffic", "/performance", "/ports", "/poe"].includes(command)) {
      const sn = args[0];
      if (!sn) return sendText(env, chatId, `Usage: ${command} <serial>`);
      let data: Json;
      if (command === "/device") data = await ruijieRequest(env, "GET", `/service/api/device/${encodeURIComponent(sn)}`);
      else if (command === "/traffic") {
        const endDate = Date.now();
        data = await ruijieRequest(env, "POST", "/logbizagent/logbiz/api/flow/show/hour", {}, { sn, startDate: endDate - 86400000, endDate });
      } else if (command === "/performance") data = await ruijieRequest(env, "GET", "/logbizagent/logbiz/api/sys/current_performance", { sn });
      else if (command === "/poe") {
        const info = await ruijieRequest(env, "GET", `/service/api/conf/switch/device/${encodeURIComponent(sn)}/poe/info`);
        const power = await ruijieRequest(env, "GET", `/service/api/conf/switch/device/${encodeURIComponent(sn)}/poe/pwr`);
        data = { info, power };
      } else {
        try {
          data = await ruijieRequest(env, "GET", `/service/api/gateway/intf/info/${encodeURIComponent(sn)}`);
        } catch {
          data = await ruijieRequest(env, "GET", `/service/api/conf/switch/device/${encodeURIComponent(sn)}/ports`, { page_size: 100, page_index: 0 });
        }
      }
      await sendText(env, chatId, `${command.slice(1)} for ${sn}:\n${summarizeObject(data)}`);
      return;
    }

    if (["/login", "/logout", "/reboot", "/adddevice", "/rename", "/setpass"].includes(command)) {
      await sendText(env, chatId, "This command is intentionally disabled. Cloud credentials are private Worker secrets, and unsupported/destructive Ruijie write operations are not enabled until Ruijie documents the exact API endpoint and schema.");
      return;
    }

    await sendText(env, chatId, "Unknown command. Use /help.");
  } catch (e) {
    console.error("command error", e);
    await sendText(env, chatId, `Cloud/API error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function setupTelegram(env: Env, request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/telegram/webhook`;
  const webhook = await telegramApi(env, "setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  await telegramApi(env, "setMyCommands", {
    commands: [
      { command: "start", description: "Bot status and help" },
      { command: "projects", description: "List all projects/groups" },
      { command: "devices", description: "Devices in one project" },
      { command: "clients", description: "Current clients in one project" },
      { command: "alldevices", description: "Paged account-wide equipment" },
      { command: "allclients", description: "Paged account-wide clients" },
      { command: "device", description: "Device details" },
      { command: "traffic", description: "Last 24h traffic" },
      { command: "performance", description: "Current performance" },
      { command: "ports", description: "Gateway/switch ports" },
      { command: "poe", description: "Switch PoE info" },
    ],
  });
  return textResponse(`Telegram webhook configured successfully.\n${webhookUrl}\n${String(webhook.description ?? "OK")}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(JSON.stringify({ ok: true, service: "ruijie-telegram-bot", time: new Date().toISOString() }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      try { return await setupTelegram(env, request); }
      catch (e) { return textResponse(`Setup failed: ${e instanceof Error ? e.message : String(e)}`, 500); }
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || supplied !== env.TELEGRAM_WEBHOOK_SECRET) return textResponse("Forbidden", 403);
      let update: Json;
      try { update = (await request.json()) as Json; }
      catch { return textResponse("Bad JSON", 400); }
      const message = update.message;
      if (message && typeof message.text === "string" && message.chat?.id !== undefined && message.from?.id !== undefined) {
        ctx.waitUntil(handleCommand(env, Number(message.chat.id), Number(message.from.id), message.text));
      }
      return textResponse("OK");
    }

    return textResponse("Not Found", 404);
  },
};
