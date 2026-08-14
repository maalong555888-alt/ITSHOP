import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";

const store = getStore("network-control", { consistency: "strong" });
const enc = new TextEncoder();
const dec = new TextDecoder();

function env(name: string): string {
  return (globalThis as any).Netlify?.env?.get?.(name) ?? process.env[name] ?? "";
}

function allowedUsers(): Set<number> {
  return new Set(
    env("ALLOWED_USER_IDS")
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x)),
  );
}

function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function fromB64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function cryptoKey(): Promise<CryptoKey> {
  const raw = Buffer.from(env("STORE_KEY"), "base64");
  if (raw.length !== 32) throw new Error("STORE_KEY must be a 32-byte base64 value");
  return webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(value: unknown): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey();
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(new Uint8Array(ciphertext))}`;
}

async function openSealed<T>(value: string): Promise<T> {
  const [ivPart, dataPart] = value.split(".", 2);
  const key = await cryptoKey();
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(ivPart) },
    key,
    fromB64url(dataPart),
  );
  return JSON.parse(dec.decode(plaintext)) as T;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
};

type PendingJob = {
  jobId: string;
  label: string;
  chatId: number;
  script: string;
  expectsResult: boolean;
  createdAt: string;
};

type RouterRecord = {
  id: string;
  name: string;
  tokenHash: string;
  callbackBase: string;
  createdAt: string;
  lastSeen?: string;
  info?: Record<string, string>;
  pending?: PendingJob | null;
  activeJob?: PendingJob | null;
  lastResult?: { label: string; data: string; at: string } | null;
};

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  return data.result;
}

async function sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const chunks: string[] = [];
  let rest = text || "(empty)";
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf("\n", 3900);
    if (cut < 1000) cut = 3900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const chunk of chunks) await tg("sendMessage", { chat_id: chatId, text: chunk, ...extra });
}

async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
  }
}

function parseCommand(text: string): { cmd: string; args: string[] } {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts.shift() ?? "").split("@", 1)[0].toLowerCase();
  return { cmd, args: parts };
}

async function getRouterIndex(): Promise<string[]> {
  return (await store.get("router-index", { type: "json" })) ?? [];
}

async function setRouterIndex(ids: string[]): Promise<void> {
  await store.setJSON("router-index", ids);
}

async function getRouter(id: string): Promise<RouterRecord | null> {
  return (await store.get(`router/${id}`, { type: "json" })) ?? null;
}

async function saveRouter(router: RouterRecord): Promise<void> {
  await store.setJSON(`router/${router.id}`, router);
  const ids = await getRouterIndex();
  if (!ids.includes(router.id)) {
    ids.push(router.id);
    await setRouterIndex(ids);
  }
}

async function findRouterByName(name: string): Promise<RouterRecord | null> {
  const ids = await getRouterIndex();
  const target = name.toLowerCase();
  for (const id of ids) {
    const router = await getRouter(id);
    if (router?.name.toLowerCase() === target) return router;
  }
  return null;
}

async function removeRouter(router: RouterRecord): Promise<void> {
  await store.delete(`router/${router.id}`);
  const ids = await getRouterIndex();
  await setRouterIndex(ids.filter((id) => id !== router.id));
}

function agentInstaller(base: string, id: string, token: string): string {
  const source = `:local base \"${base}\"; :local rid \"${id}\"; :local tok \"${token}\"; :local body (\"identity=\".[/system identity get name].\"\\nversion=\".[/system resource get version].\"\\nuptime=\".[/system resource get uptime].\"\\ncpu=\".[/system resource get cpu-load].\"\\nfree=\".[/system resource get free-memory].\"\\ntotal=\".[/system resource get total-memory]); :local r [/tool fetch url=($base.\"/api/mikrotik/agent?id=\".$rid.\"&token=\".$tok) http-method=post http-data=$body as-value output=user]; :local c ($r->\"data\"); :if ([:len $c] > 0) do={:execute $c}`;
  return `/system script remove [find name=chatgpt-net-agent]\n/system scheduler remove [find name=chatgpt-net-agent]\n/system script add name=chatgpt-net-agent policy=ftp,reboot,read,write,test source={${source}}\n/system scheduler add name=chatgpt-net-agent interval=10s start-time=startup on-event=\"/system script run chatgpt-net-agent\" policy=ftp,reboot,read,write,test\n/system script run chatgpt-net-agent`;
}

function commandScript(router: RouterRecord, tokenForScript: string, kind: string, jobId: string): string | null {
  const endpoint = `${router.callbackBase}/api/mikrotik/result?id=${router.id}&job=${jobId}&token=${tokenForScript}`;
  const post = `/tool fetch url=\"${endpoint}\" http-method=post http-data=$o output=none`;
  const scripts: Record<string, string> = {
    interfaces: `:local o \"\"; :foreach i in=[/interface find] do={:set o ($o.[/interface get $i name].\" | type=\".[/interface get $i type].\" | running=\".[/interface get $i running].\" | disabled=\".[/interface get $i disabled].\"\\n\")}; ${post}`,
    dhcp: `:local o \"\"; :foreach i in=[/ip dhcp-server lease find] do={:set o ($o.[/ip dhcp-server lease get $i address].\" | \".[/ip dhcp-server lease get $i mac-address].\" | host=\".[/ip dhcp-server lease get $i host-name].\" | status=\".[/ip dhcp-server lease get $i status].\"\\n\")}; ${post}`,
    arp: `:local o \"\"; :foreach i in=[/ip arp find] do={:set o ($o.[/ip arp get $i address].\" | \".[/ip arp get $i mac-address].\" | iface=\".[/ip arp get $i interface].\"\\n\")}; ${post}`,
    routes: `:local o \"\"; :foreach i in=[/ip route find] do={:set o ($o.[/ip route get $i dst-address].\" | gw=\".[/ip route get $i gateway].\" | active=\".[/ip route get $i active].\" | disabled=\".[/ip route get $i disabled].\"\\n\")}; ${post}`,
    firewall: `:local o \"\"; :foreach i in=[/ip firewall filter find] do={:set o ($o.\"chain=\".[/ip firewall filter get $i chain].\" | action=\".[/ip firewall filter get $i action].\" | disabled=\".[/ip firewall filter get $i disabled].\" | comment=\".[/ip firewall filter get $i comment].\"\\n\")}; ${post}`,
    nat: `:local o \"\"; :foreach i in=[/ip firewall nat find] do={:set o ($o.\"chain=\".[/ip firewall nat get $i chain].\" | action=\".[/ip firewall nat get $i action].\" | disabled=\".[/ip firewall nat get $i disabled].\" | comment=\".[/ip firewall nat get $i comment].\"\\n\")}; ${post}`,
    queues: `:local o \"\"; :foreach i in=[/queue simple find] do={:set o ($o.[/queue simple get $i name].\" | target=\".[/queue simple get $i target].\" | max=\".[/queue simple get $i max-limit].\" | disabled=\".[/queue simple get $i disabled].\"\\n\")}; ${post}`,
    logs: `:local o \"\"; :local n 0; :foreach i in=[/log find] do={:if ($n < 30) do={:set o ($o.[/log get $i time].\" | \".[/log get $i topics].\" | \".[/log get $i message].\"\\n\"); :set n ($n + 1)}}; ${post}`,
  };
  return scripts[kind] ?? null;
}

async function queueRouterRead(router: RouterRecord, kind: string, chatId: number, tokenForScript: string): Promise<string> {
  if (router.pending || router.activeJob) return "That router already has a command waiting. Try again in a few seconds.";
  const jobId = randomUUID();
  const script = commandScript(router, tokenForScript, kind, jobId);
  if (!script) return "Unsupported MikroTik request.";
  router.pending = {
    jobId,
    label: kind,
    chatId,
    script,
    expectsResult: true,
    createdAt: new Date().toISOString(),
  };
  await saveRouter(router);
  return `Request queued for ${router.name} ✅\nThe router normally checks in within about 10 seconds.`;
}

async function saveRuijieCreds(userId: number, appid: string, secret: string): Promise<void> {
  await store.set(`ruijie/${userId}`, await seal({ appid, secret }));
}

async function loadRuijieCreds(userId: number): Promise<{ appid: string; secret: string } | null> {
  const value = await store.get(`ruijie/${userId}`);
  return value ? openSealed(value) : null;
}

async function ruijieAuth(appid: string, secret: string): Promise<string> {
  const base = env("RUIJIE_BASE_URL") || "https://cloud-as.ruijienetworks.com";
  const url = new URL("/service/api/oauth20/client/access_token", base);
  url.searchParams.set("token", "d63dss0a81e4415a889ac5b78fsc904a");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appid, secret }),
  });
  const data: any = await res.json();
  if (!res.ok || data.code !== 0 || !data.accessToken) throw new Error(data.msg || "Ruijie authentication failed");
  return data.accessToken;
}

async function ruijieRequest(userId: number, path: string, method = "GET", params: Record<string, string> = {}, body?: unknown): Promise<any> {
  const creds = await loadRuijieCreds(userId);
  if (!creds) throw new Error("Not logged in to Ruijie. Use /login <appid> <secret> first.");
  const accessToken = await ruijieAuth(creds.appid, creds.secret);
  const base = env("RUIJIE_BASE_URL") || "https://cloud-as.ruijienetworks.com";
  const url = new URL(path, base);
  url.searchParams.set("access_token", accessToken);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data: any = await res.json();
  if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new Error(data.msg || `Ruijie API error ${data.code ?? res.status}`);
  return data;
}

function flattenGroups(node: any, depth = 0, out: string[] = []): string[] {
  if (!node) return out;
  out.push(`${"  ".repeat(depth)}${node.name ?? "Unnamed"} — id: ${node.groupId ?? "?"}`);
  for (const child of node.subGroups ?? []) flattenGroups(child, depth + 1, out);
  return out;
}

async function handleTelegram(update: any, origin: string): Promise<void> {
  if (update.callback_query) {
    const q = update.callback_query;
    const uid = Number(q.from?.id);
    if (!allowedUsers().has(uid)) {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Not authorized." });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    const chatId = Number(q.message?.chat?.id);
    const data = String(q.data ?? "");
    if (data === "cancel") {
      await tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: "Cancelled." });
      return;
    }
    if (data.startsWith("mtreboot:")) {
      const name = data.slice("mtreboot:".length);
      const router = await findRouterByName(name);
      if (!router) {
        await tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: "Router not found." });
        return;
      }
      if (router.pending || router.activeJob) {
        await tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: "Router is busy. Try again shortly." });
        return;
      }
      router.pending = {
        jobId: randomUUID(),
        label: "reboot",
        chatId,
        script: ":delay 2s; /system reboot",
        expectsResult: false,
        createdAt: new Date().toISOString(),
      };
      await saveRouter(router);
      await tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: `Reboot queued for ${router.name} ✅` });
      return;
    }
    if (data.startsWith("rjreboot:")) {
      const serial = data.slice("rjreboot:".length);
      try {
        await ruijieRequest(uid, "/service/api/device/reboot", "POST", {}, { sn: serial });
        await tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: `Ruijie reboot command sent to ${serial} ✅` });
      } catch (e: any) {
        await tg("editMessageText", { chat_id: chatId, message_id: q.message.message_id, text: `Ruijie error: ${e.message}` });
      }
      return;
    }
    return;
  }

  const message: TelegramMessage | undefined = update.message ?? update.edited_message;
  if (!message?.text || !message.from) return;
  const userId = Number(message.from.id);
  const chatId = Number(message.chat.id);
  if (!allowedUsers().has(userId)) {
    await sendMessage(chatId, "Not authorized. This bot is private.");
    return;
  }
  const { cmd, args } = parseCommand(message.text);

  if (cmd === "/start" || cmd === "/help") {
    await sendMessage(
      chatId,
      "Network control bot — Ruijie/Reyee + MikroTik\n\n" +
        "Ruijie: /login /projects /devices /clients /traffic /reboot /adddevice /rename /setpass /logout\n" +
        "MikroTik: /mtpair /mtrouters /mtstatus /mtinterfaces /mtdhcp /mtarp /mtroutes /mtfirewall /mtnat /mtqueues /mtlogs /mtreboot /mtresult /mtremove",
    );
    return;
  }

  if (cmd === "/mtpair") {
    if (message.chat.type !== "private") {
      await sendMessage(chatId, "Use /mtpair in a private chat with the bot.");
      return;
    }
    const name = args[0];
    if (!name || !safeName(name)) {
      await sendMessage(chatId, "Usage: /mtpair <router_name>\nUse letters, numbers, _ or - only.");
      return;
    }
    if (await findRouterByName(name)) {
      await sendMessage(chatId, "That router name already exists. Use /mtremove <name> first if you want to pair it again.");
      return;
    }
    const id = randomUUID();
    const token = randomBytes(24).toString("base64url");
    const router: RouterRecord = {
      id,
      name,
      tokenHash: tokenHash(token),
      callbackBase: origin,
      createdAt: new Date().toISOString(),
      pending: null,
      activeJob: null,
      lastResult: null,
    };
    await saveRouter(router);
    const script = agentInstaller(origin, id, token);
    await sendMessage(chatId, `Pairing created for ${name}.\n\nPaste ALL of this into the MikroTik Terminal once:\n\n${script}\n\nDo not share this pairing script.`);
    return;
  }

  if (cmd === "/mtrouters") {
    const ids = await getRouterIndex();
    const lines: string[] = [];
    for (const id of ids) {
      const r = await getRouter(id);
      if (!r) continue;
      const online = r.lastSeen && Date.now() - Date.parse(r.lastSeen) < 45_000;
      lines.push(`${online ? "🟢" : "🔴"} ${r.name} — ${r.info?.identity ?? "not paired yet"} — ${r.info?.version ?? ""}`);
    }
    await sendMessage(chatId, lines.join("\n") || "No MikroTik routers paired yet. Use /mtpair <name>.");
    return;
  }

  if (cmd === "/mtstatus") {
    const r = args[0] ? await findRouterByName(args[0]) : null;
    if (!r) {
      await sendMessage(chatId, "Usage: /mtstatus <router_name>");
      return;
    }
    const online = r.lastSeen && Date.now() - Date.parse(r.lastSeen) < 45_000;
    await sendMessage(
      chatId,
      `${online ? "🟢 ONLINE" : "🔴 OFFLINE"} — ${r.name}\n` +
        `Identity: ${r.info?.identity ?? "unknown"}\nVersion: ${r.info?.version ?? "unknown"}\nUptime: ${r.info?.uptime ?? "unknown"}\nCPU: ${r.info?.cpu ?? "?"}%\nMemory free/total: ${r.info?.free ?? "?"}/${r.info?.total ?? "?"}\nLast seen: ${r.lastSeen ?? "never"}`,
    );
    return;
  }

  const readKinds: Record<string, string> = {
    "/mtinterfaces": "interfaces",
    "/mtdhcp": "dhcp",
    "/mtarp": "arp",
    "/mtroutes": "routes",
    "/mtfirewall": "firewall",
    "/mtnat": "nat",
    "/mtqueues": "queues",
    "/mtlogs": "logs",
  };
  if (readKinds[cmd]) {
    const r = args[0] ? await findRouterByName(args[0]) : null;
    if (!r) {
      await sendMessage(chatId, `Usage: ${cmd} <router_name>`);
      return;
    }
    const resultToken = randomBytes(18).toString("base64url");
    await store.set(`jobtoken/${r.id}`, await seal({ token: resultToken, expires: Date.now() + 120_000 }));
    await sendMessage(chatId, await queueRouterRead(r, readKinds[cmd], chatId, resultToken));
    return;
  }

  if (cmd === "/mtresult") {
    const r = args[0] ? await findRouterByName(args[0]) : null;
    if (!r) {
      await sendMessage(chatId, "Usage: /mtresult <router_name>");
      return;
    }
    await sendMessage(chatId, r.lastResult ? `${r.lastResult.label} (${r.lastResult.at})\n${r.lastResult.data}` : "No result stored yet.");
    return;
  }

  if (cmd === "/mtreboot") {
    const r = args[0] ? await findRouterByName(args[0]) : null;
    if (!r) {
      await sendMessage(chatId, "Usage: /mtreboot <router_name>");
      return;
    }
    await sendMessage(chatId, `Reboot MikroTik ${r.name}?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Confirm reboot", callback_data: `mtreboot:${r.name}` },
          { text: "❌ Cancel", callback_data: "cancel" },
        ]],
      },
    });
    return;
  }

  if (cmd === "/mtremove") {
    const r = args[0] ? await findRouterByName(args[0]) : null;
    if (!r) {
      await sendMessage(chatId, "Usage: /mtremove <router_name>");
      return;
    }
    await removeRouter(r);
    await sendMessage(chatId, `${r.name} removed from this bot. The agent script on the router can also be removed later if desired.`);
    return;
  }

  if (cmd === "/login") {
    if (message.chat.type !== "private") {
      await sendMessage(chatId, "Use /login only in private chat.");
      return;
    }
    await deleteMessage(chatId, message.message_id);
    if (args.length !== 2) {
      await sendMessage(chatId, "Usage: /login <appid> <secret>\nYour login message is deleted for safety.");
      return;
    }
    try {
      await ruijieAuth(args[0], args[1]);
      await saveRuijieCreds(userId, args[0], args[1]);
      await sendMessage(chatId, "Logged in to Ruijie Cloud ✅");
    } catch (e: any) {
      await sendMessage(chatId, `Ruijie login failed: ${e.message}`);
    }
    return;
  }

  if (cmd === "/logout") {
    await store.delete(`ruijie/${userId}`);
    await sendMessage(chatId, "Ruijie credentials cleared.");
    return;
  }

  try {
    if (cmd === "/projects") {
      const data = await ruijieRequest(userId, "/service/api/group/single/tree", "GET", { depth: "BUILDING" });
      await sendMessage(chatId, flattenGroups(data.groups).join("\n") || "No projects found.");
      return;
    }
    if (cmd === "/devices") {
      if (!args[0]) return void (await sendMessage(chatId, "Usage: /devices <group_id>"));
      const data = await ruijieRequest(userId, "/service/api/device/list", "GET", { groupId: args[0] });
      const devices = data.devices ?? data.list ?? [];
      await sendMessage(chatId, devices.map((d: any) => `${d.online || d.isOnline ? "🟢" : "🔴"} ${d.name ?? d.sn ?? "device"} | ${d.productType ?? "?"} | SN:${d.sn ?? d.serialNumber ?? "?"}`).join("\n") || "No devices found.");
      return;
    }
    if (cmd === "/clients") {
      if (!args[0]) return void (await sendMessage(chatId, "Usage: /clients <group_id>"));
      const data = await ruijieRequest(userId, "/service/api/client/list", "GET", { groupId: args[0] });
      const clients = data.clients ?? data.list ?? [];
      await sendMessage(chatId, clients.map((c: any) => `${c.userName ?? c.hostname ?? "unknown"} | ${c.mac ?? ""} | ${c.ip ?? ""}`).join("\n") || "No connected clients.");
      return;
    }
    if (cmd === "/traffic") {
      if (!args[0]) return void (await sendMessage(chatId, "Usage: /traffic <serial>"));
      const data = await ruijieRequest(userId, "/service/api/device/traffic", "GET", { sn: args[0] });
      await sendMessage(chatId, `Traffic for ${args[0]}:\n${JSON.stringify(data, null, 2)}`);
      return;
    }
    if (cmd === "/reboot") {
      if (!args[0]) return void (await sendMessage(chatId, "Usage: /reboot <serial>"));
      await sendMessage(chatId, `Reboot Ruijie/Reyee ${args[0]}?`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Confirm reboot", callback_data: `rjreboot:${args[0]}` },
            { text: "❌ Cancel", callback_data: "cancel" },
          ]],
        },
      });
      return;
    }
    if (cmd === "/adddevice") {
      if (args.length < 2) return void (await sendMessage(chatId, "Usage: /adddevice <group_id> <serial> [mac]"));
      const body: any = { groupId: Number(args[0]), sn: args[1] };
      if (args[2]) body.mac = args[2];
      await ruijieRequest(userId, "/service/api/device/add", "POST", {}, body);
      await sendMessage(chatId, `Device ${args[1]} added ✅`);
      return;
    }
    if (cmd === "/rename") {
      if (args.length < 3) return void (await sendMessage(chatId, "Usage: /rename <group_id> <mac> <new_name>"));
      await ruijieRequest(userId, "/service/api/client/rename", "POST", {}, { groupId: Number(args[0]), mac: args[1], userName: args.slice(2).join(" ") });
      await sendMessage(chatId, "Client renamed ✅");
      return;
    }
    if (cmd === "/setpass") {
      await deleteMessage(chatId, message.message_id);
      if (args.length < 3) return void (await sendMessage(chatId, "Usage: /setpass <group_id> <mac> <password>"));
      await ruijieRequest(userId, "/service/api/client/password", "POST", {}, { groupId: Number(args[0]), mac: args[1], password: args[2] });
      await sendMessage(chatId, "Password updated ✅");
      return;
    }
  } catch (e: any) {
    await sendMessage(chatId, `Ruijie error: ${e.message}`);
    return;
  }

  await sendMessage(chatId, "Unknown command. Use /help.");
}

function parseAgentBody(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

async function handleAgent(req: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const router = await getRouter(id);
  if (!router || tokenHash(token) !== router.tokenHash) return new Response("unauthorized", { status: 401 });
  const text = req.method === "POST" ? await req.text() : "";
  router.lastSeen = new Date().toISOString();
  router.info = { ...(router.info ?? {}), ...parseAgentBody(text) };
  let script = "";
  if (router.pending) {
    script = router.pending.script;
    if (router.pending.expectsResult) router.activeJob = router.pending;
    router.pending = null;
  }
  await saveRouter(router);
  return new Response(script, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function handleResult(req: Request, url: URL): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  const jobId = url.searchParams.get("job") ?? "";
  const resultToken = url.searchParams.get("token") ?? "";
  const router = await getRouter(id);
  if (!router?.activeJob || router.activeJob.jobId !== jobId) return new Response("not found", { status: 404 });
  const sealed = await store.get(`jobtoken/${router.id}`);
  if (!sealed) return new Response("unauthorized", { status: 401 });
  const tokenInfo = await openSealed<{ token: string; expires: number }>(sealed);
  if (tokenInfo.expires < Date.now() || tokenInfo.token !== resultToken) return new Response("unauthorized", { status: 401 });
  const data = (await req.text()).slice(0, 32_000) || "(no data)";
  const job = router.activeJob;
  router.lastResult = { label: job.label, data, at: new Date().toISOString() };
  router.activeJob = null;
  await saveRouter(router);
  await store.delete(`jobtoken/${router.id}`);
  await sendMessage(job.chatId, `${router.name} — ${job.label} ✅\n${data}`);
  return new Response("ok");
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (url.pathname === "/api/health") {
    return Response.json({
      ok: true,
      service: "Ruijie/Reyee + MikroTik Telegram control",
      telegramConfigured: Boolean(env("TELEGRAM_BOT_TOKEN")),
      allowedUsersConfigured: allowedUsers().size > 0,
      storeKeyConfigured: Boolean(env("STORE_KEY")),
      time: new Date().toISOString(),
    });
  }
  if (url.pathname === "/api/mikrotik/agent") return handleAgent(req, url);
  if (url.pathname === "/api/mikrotik/result") return handleResult(req, url);
  if (url.pathname === "/api/telegram") {
    const expected = env("TELEGRAM_WEBHOOK_SECRET");
    if (expected && req.headers.get("x-telegram-bot-api-secret-token") !== expected) return new Response("unauthorized", { status: 401 });
    try {
      const update = await req.json();
      await handleTelegram(update, url.origin);
      return new Response("ok");
    } catch (e: any) {
      console.error("telegram webhook error", e?.message ?? e);
      return new Response("ok");
    }
  }
  return new Response("Network bot online", { status: 200 });
};

export const config: Config = {
  path: ["/", "/api/health", "/api/telegram", "/api/mikrotik/agent", "/api/mikrotik/result"],
};
