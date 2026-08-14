import type { Config, Context } from "@netlify/functions";
import { allowedIds, env, getClients, getDevices, getGroups, makeRuijieClient, ruijieConfigured, sendText } from "../lib/common.mts";

async function startBackground(path: string, chatId: number): Promise<void> {
  const site = env("URL").replace(/\/$/, "");
  if (!site || !env("INTERNAL_JOB_SECRET")) throw new Error("Background job configuration is missing");
  const response = await fetch(`${site}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-job-secret": env("INTERNAL_JOB_SECRET") }, body: JSON.stringify({ chatId }) });
  if (!response.ok) throw new Error(`Could not start background scan (HTTP ${response.status})`);
}

async function handleCommand(chatId: number, userId: string, text: string): Promise<void> {
  const [raw, ...args] = text.trim().split(/\s+/);
  const command = raw.toLowerCase().split("@")[0];
  if (command === "/start" || command === "/help") {
    await sendText(chatId, ["Ruijie / Reyee Cloud control bot ✅", "", "Account: /projects /alldevices /allclients", "Project: /devices <group_id> /clients <group_id>", "Device: /device <serial> /traffic24h <serial> /performance <serial> /ports <serial> /poe <serial>", "System: /status", "", "Unsupported destructive/write commands are disabled."].join("\n"));
    return;
  }
  if (command === "/status") {
    await sendText(chatId, `Bot online ✅\nRuijie API: ${ruijieConfigured() ? "configured ✅" : "waiting for private Secret ⚠️"}\nAuthorized user: ${allowedIds().has(userId) ? "yes" : "no"}`);
    return;
  }
  if (!ruijieConfigured()) { await sendText(chatId, "Ruijie API connection is prepared, but the replacement private Secret has not been configured yet."); return; }
  if (command === "/alldevices") { await sendText(chatId, "Scanning all projects for equipment…"); await startBackground("/.netlify/functions/scan-all-devices-background", chatId); return; }
  if (command === "/allclients") { await sendText(chatId, "Scanning all projects for current clients…"); await startBackground("/.netlify/functions/scan-all-clients-background", chatId); return; }

  const rj = await makeRuijieClient();
  if (command === "/projects" || command === "/allprojects") {
    const rows = await getGroups(rj); const lines = [`Ruijie/Reyee projects & groups (${rows.length}):`];
    for (const row of rows) lines.push(`${"  ".repeat(Math.min(row.depth, 5))}• ${row.name} — id:${row.id}`);
    await sendText(chatId, lines.join("\n")); return;
  }
  if (command === "/devices") {
    if (!args[0] || !/^\d+$/.test(args[0])) { await sendText(chatId, "Usage: /devices <group_id>"); return; }
    const devices = await getDevices(rj, Number(args[0]));
    const lines = devices.map((d: any) => { const sn = d.serialNumber ?? d.sn ?? "?"; const name = d.deviceName ?? d.name ?? sn; const type = d.productType ?? d.commonType ?? d.type ?? "?"; return `• ${name} [${type}] SN:${sn}`; });
    await sendText(chatId, devices.length ? [`Devices in group ${args[0]} (${devices.length}):`, ...lines].join("\n") : `No devices found in group ${args[0]}.`); return;
  }
  if (command === "/clients") {
    if (!args[0] || !/^\d+$/.test(args[0])) { await sendText(chatId, "Usage: /clients <group_id>"); return; }
    const clients = await getClients(rj, Number(args[0]));
    const lines = clients.map((c: any) => `• ${c.userName ?? c.hostname ?? c.staName ?? "unknown"} — ${c.mac ?? c.macAddress ?? c.staMac ?? ""} — ${c.ip ?? c.ipAddress ?? c.staIp ?? ""}`);
    await sendText(chatId, clients.length ? [`Current clients in group ${args[0]} (${clients.length}):`, ...lines].join("\n") : `No current clients in group ${args[0]}.`); return;
  }
  if (["/device", "/traffic24h", "/performance", "/ports", "/poe"].includes(command)) {
    const sn = args[0]; if (!sn) { await sendText(chatId, `Usage: ${command} <serial>`); return; }
    let data: any;
    if (command === "/device") data = await rj(`/service/api/device/${encodeURIComponent(sn)}`);
    else if (command === "/traffic24h") { const endDate = Date.now(), startDate = endDate - 86400000; data = await rj("/logbizagent/logbiz/api/flow/show/hour", { method: "POST", body: { sn, startDate, endDate } }); }
    else if (command === "/performance") data = await rj("/logbizagent/logbiz/api/sys/current_performance", { params: { sn } });
    else if (command === "/ports") { try { data = await rj(`/service/api/gateway/intf/info/${encodeURIComponent(sn)}`); } catch { data = await rj(`/service/api/conf/switch/device/${encodeURIComponent(sn)}/ports`, { params: { page_size: 100, page_index: 0 } }); } }
    else { const [info, power] = await Promise.all([rj(`/service/api/conf/switch/device/${encodeURIComponent(sn)}/poe/info`), rj(`/service/api/conf/switch/device/${encodeURIComponent(sn)}/poe/pwr`)]); data = { info, power }; }
    await sendText(chatId, `${command.slice(1)} for ${sn}:\n${JSON.stringify(data, null, 2)}`); return;
  }
  await sendText(chatId, "Unknown command. Use /help");
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return new Response("OK");
  if (!env("TELEGRAM_WEBHOOK_SECRET") || req.headers.get("x-telegram-bot-api-secret-token") !== env("TELEGRAM_WEBHOOK_SECRET")) return new Response("Forbidden", { status: 403 });
  let update: any; try { update = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const message = update?.message;
  if (!message?.chat?.id || !message?.from?.id || typeof message?.text !== "string") return new Response("OK");
  const userId = String(message.from.id);
  if (!allowedIds().has(userId)) { await sendText(message.chat.id, "Not authorized. This bot is private."); return new Response("OK"); }
  try { await handleCommand(Number(message.chat.id), userId, message.text); }
  catch (error) { console.error("command failed", error); await sendText(message.chat.id, `API error: ${String((error as Error)?.message || error).slice(0, 900)}`); }
  return new Response("OK");
};

export const config: Config = { path: "/api/telegram" };
