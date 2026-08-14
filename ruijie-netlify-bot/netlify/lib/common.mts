const MAGIC = "d63dss0a81e4415a889ac5b78fsc904a";
const TYPES = ["AP", "Switch", "Gateway"] as const;

type Json = Record<string, any>;
export type GroupRow = { id: number; name: string; depth: number };

export function env(name: string): string {
  return Netlify.env.get(name) ?? "";
}

export function allowedIds(): Set<string> {
  return new Set(env("ALLOWED_USER_IDS").split(",").map((x) => x.trim()).filter(Boolean));
}

export async function telegram(method: string, payload: Json): Promise<any> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json() as Json;
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

export async function sendText(chatId: number | string, text: string): Promise<void> {
  let rest = String(text || "(empty)");
  const chunks: string[] = [];
  while (rest.length > 3900) {
    let cut = rest.lastIndexOf("\n", 3900);
    if (cut < 1000) cut = 3900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  }
}

export function ruijieConfigured(): boolean {
  return Boolean(env("RUIJIE_APPID") && env("RUIJIE_SECRET"));
}

export async function makeRuijieClient(): Promise<(path: string, options?: { method?: string; params?: Json; body?: any }) => Promise<Json>> {
  const appid = env("RUIJIE_APPID");
  const secret = env("RUIJIE_SECRET");
  const base = (env("RUIJIE_BASE_URL") || "https://cloud-as.ruijienetworks.com").replace(/\/$/, "");
  if (!appid || !secret) throw new Error("Ruijie API credentials are not configured yet");

  const authUrl = new URL(`${base}/service/api/oauth20/client/access_token`);
  authUrl.searchParams.set("token", MAGIC);
  const authResponse = await fetch(authUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ appid, secret }),
  });
  const authType = authResponse.headers.get("content-type") || "";
  if (!authType.toLowerCase().includes("json")) throw new Error(`Ruijie auth returned HTTP ${authResponse.status} non-JSON response`);
  const authData = await authResponse.json() as Json;
  if (!authResponse.ok || ![0, "0", undefined, null].includes(authData.code)) {
    throw new Error(authData.msg || authData.message || `Ruijie auth failed (HTTP ${authResponse.status})`);
  }
  const accessToken = authData.accessToken || authData.access_token;
  if (!accessToken) throw new Error("Ruijie auth response did not include accessToken");

  return async (path, options = {}) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries({ ...(options.params || {}), access_token: accessToken })) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const init: RequestInit = { method: options.method || "GET", headers: { accept: "application/json" } };
    if (options.body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, init);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("json")) throw new Error(`Ruijie returned HTTP ${response.status} non-JSON response for ${path}`);
    const data = await response.json() as Json;
    if (!response.ok || ![0, "0", undefined, null].includes(data.code)) throw new Error(data.msg || data.message || `Ruijie API failed at ${path}`);
    return data;
  };
}

export function extractList(data: Json, keys: string[]): Json[] {
  for (const key of keys) {
    const value = data?.[key];
    if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
    if (value && typeof value === "object") {
      for (const nested of ["list", "items", "records", "deviceList", "data"]) {
        if (Array.isArray(value[nested])) return value[nested].filter((x: any) => x && typeof x === "object");
      }
    }
  }
  return [];
}

export function walkGroups(node: any, depth = 0, out: GroupRow[] = []): GroupRow[] {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const child of node) walkGroups(child, depth, out);
    return out;
  }
  if (typeof node !== "object") return out;
  const id = node.groupId ?? node.id ?? node.networkId;
  const name = node.groupName ?? node.name ?? node.projectName ?? "Unnamed";
  if (id !== undefined && id !== null && Number.isFinite(Number(id))) out.push({ id: Number(id), name: String(name), depth });
  for (const key of ["subGroups", "children", "groups", "groupList", "subGroupList"]) {
    if (Array.isArray(node[key])) for (const child of node[key]) walkGroups(child, depth + 1, out);
  }
  return out;
}

export async function getGroups(rj: Awaited<ReturnType<typeof makeRuijieClient>>): Promise<GroupRow[]> {
  const data = await rj("/service/api/group/single/tree", { params: { depth: "BUILDING" } });
  const roots = data.groups ?? data.data ?? data.groupList ?? data;
  const rows = walkGroups(roots);
  return rows.filter((row, index, all) => all.findIndex((x) => x.id === row.id) === index);
}

export async function getDevices(rj: Awaited<ReturnType<typeof makeRuijieClient>>, groupId: number): Promise<Json[]> {
  const seen = new Set<string>();
  const rows: Json[] = [];
  await Promise.all(TYPES.map(async (commonType) => {
    const data = await rj("/service/api/maint/devices", { params: { common_type: commonType, group_id: groupId, page: 0, per_page: 1000 } });
    for (const device of extractList(data, ["deviceList", "list", "data"])) {
      const key = String(device.serialNumber ?? device.sn ?? JSON.stringify(device));
      if (!seen.has(key)) { seen.add(key); rows.push(device); }
    }
  }));
  return rows;
}

export async function getClients(rj: Awaited<ReturnType<typeof makeRuijieClient>>, groupId: number): Promise<Json[]> {
  const data = await rj("/logbizagent/logbiz/api/sta/sta_users", { method: "POST", body: { groupId, pageSize: 1000, pageIndex: 0, staType: "currentUser" } });
  return extractList(data, ["list", "data", "records"]);
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<(R | { __error: string })[]> {
  const output: (R | { __error: string })[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { output[index] = await fn(items[index], index); }
      catch (error) { output[index] = { __error: String((error as Error)?.message || error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

export function deviceLine(device: Json): string {
  const sn = device.serialNumber ?? device.sn ?? "?";
  const name = device.deviceName ?? device.name ?? sn;
  const type = device.productType ?? device.commonType ?? device.type ?? "?";
  const raw = device.online ?? device.isOnline ?? device.status;
  const online = raw === true || raw === 1 || raw === "1" || String(raw).toLowerCase() === "online";
  return `${online ? "🟢" : "🔴"} ${name} [${type}] SN:${sn}`;
}

export function clientLine(client: Json): string {
  const name = client.userName ?? client.hostname ?? client.staName ?? client.deviceName ?? "unknown";
  const mac = client.mac ?? client.macAddress ?? client.staMac ?? "";
  const ip = client.ip ?? client.ipAddress ?? client.staIp ?? "";
  return `• ${name} — ${mac} — ${ip}`;
}
