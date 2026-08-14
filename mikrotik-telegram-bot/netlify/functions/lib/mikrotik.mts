import { randomBytes, randomUUID } from "node:crypto";
import { DB, hash, seal, unseal, say, tg } from "./common.mjs";

type Job = { jobId: string; label: string; chatId: number; script: string; result: boolean };
type Router = {
  id: string; name: string; tokenHash: string; base: string; created: string;
  lastSeen?: string; info?: Record<string, string>; pending?: Job | null; active?: Job | null;
  last?: { label: string; data: string; at: string } | null;
};

const index = async () => ((await DB().get("routers", { type: "json" })) ?? []) as string[];
async function getRouter(id: string) { return ((await DB().get(`r/${id}`, { type: "json" })) ?? null) as Router | null; }
async function save(r: Router) {
  await DB().setJSON(`r/${r.id}`, r);
  const ids = await index();
  if (!ids.includes(r.id)) { ids.push(r.id); await DB().setJSON("routers", ids); }
}
async function byName(name: string) {
  for (const id of await index()) { const r = await getRouter(id); if (r?.name.toLowerCase() === name.toLowerCase()) return r; }
  return null;
}
async function remove(r: Router) { await DB().delete(`r/${r.id}`); await DB().setJSON("routers", (await index()).filter(x => x !== r.id)); }

function installer(base: string, id: string, token: string) {
  const src = `:local b \"${base}\"; :local i \"${id}\"; :local t \"${token}\"; :local d (\"identity=\".[/system identity get name].\"\\nversion=\".[/system resource get version].\"\\nuptime=\".[/system resource get uptime].\"\\ncpu=\".[/system resource get cpu-load].\"\\nfree=\".[/system resource get free-memory].\"\\ntotal=\".[/system resource get total-memory]); :local x [/tool fetch url=($b.\"/api/mikrotik/agent?id=\".$i.\"&token=\".$t) http-method=post http-data=$d as-value output=user]; :local c ($x->\"data\"); :if ([:len $c]>0) do={:execute $c}`;
  return `/system script remove [find name=chatgpt-net-agent]\n/system scheduler remove [find name=chatgpt-net-agent]\n/system script add name=chatgpt-net-agent policy=ftp,reboot,read,write,test source={${src}}\n/system scheduler add name=chatgpt-net-agent interval=10s start-time=startup on-event=\"/system script run chatgpt-net-agent\" policy=ftp,reboot,read,write,test\n/system script run chatgpt-net-agent`;
}

function readScript(r: Router, kind: string, job: string, resultToken: string) {
  const post = `/tool fetch url=\"${r.base}/api/mikrotik/result?id=${r.id}&job=${job}&token=${resultToken}\" http-method=post http-data=$o output=none`;
  const scripts: Record<string, string> = {
    interfaces: `:local o \"\"; :foreach i in=[/interface find] do={:set o ($o.[/interface get $i name].\" | type=\".[/interface get $i type].\" | running=\".[/interface get $i running].\" | disabled=\".[/interface get $i disabled].\"\\n\")}; ${post}`,
    dhcp: `:local o \"\"; :foreach i in=[/ip dhcp-server lease find] do={:set o ($o.[/ip dhcp-server lease get $i address].\" | \".[/ip dhcp-server lease get $i mac-address].\" | host=\".[/ip dhcp-server lease get $i host-name].\" | status=\".[/ip dhcp-server lease get $i status].\"\\n\")}; ${post}`,
    arp: `:local o \"\"; :foreach i in=[/ip arp find] do={:set o ($o.[/ip arp get $i address].\" | \".[/ip arp get $i mac-address].\" | \".[/ip arp get $i interface].\"\\n\")}; ${post}`,
    routes: `:local o \"\"; :foreach i in=[/ip route find] do={:set o ($o.[/ip route get $i dst-address].\" | gw=\".[/ip route get $i gateway].\" | active=\".[/ip route get $i active].\"\\n\")}; ${post}`,
    firewall: `:local o \"\"; :foreach i in=[/ip firewall filter find] do={:set o ($o.\"chain=\".[/ip firewall filter get $i chain].\" | action=\".[/ip firewall filter get $i action].\" | disabled=\".[/ip firewall filter get $i disabled].\" | \".[/ip firewall filter get $i comment].\"\\n\")}; ${post}`,
    nat: `:local o \"\"; :foreach i in=[/ip firewall nat find] do={:set o ($o.\"chain=\".[/ip firewall nat get $i chain].\" | action=\".[/ip firewall nat get $i action].\" | disabled=\".[/ip firewall nat get $i disabled].\" | \".[/ip firewall nat get $i comment].\"\\n\")}; ${post}`,
    queues: `:local o \"\"; :foreach i in=[/queue simple find] do={:set o ($o.[/queue simple get $i name].\" | target=\".[/queue simple get $i target].\" | max=\".[/queue simple get $i max-limit].\"\\n\")}; ${post}`,
    logs: `:local o \"\"; :local n 0; :foreach i in=[/log find] do={:if ($n<30) do={:set o ($o.[/log get $i time].\" | \".[/log get $i topics].\" | \".[/log get $i message].\"\\n\");:set n ($n+1)}}; ${post}`,
  };
  return scripts[kind] ?? null;
}

async function queue(r: Router, kind: string, chatId: number) {
  if (r.pending || r.active) return "Router is busy. Try again shortly.";
  const jobId = randomUUID(), resultToken = randomBytes(18).toString("base64url");
  const script = readScript(r, kind, jobId, resultToken); if (!script) return "Unsupported request.";
  await DB().set(`jt/${r.id}`, await seal({ token: resultToken, exp: Date.now() + 120000 }));
  r.pending = { jobId, label: kind, chatId, script, result: true }; await save(r);
  return `Request queued for ${r.name} ✅`;
}

export async function handleMtCommand(cmd: string, args: string[], message: any, origin: string): Promise<boolean> {
  const chat = Number(message.chat.id);
  if (!cmd.startsWith("/mt")) return false;
  if (cmd === "/mtpair") {
    if (message.chat.type !== "private") { await say(chat, "Use /mtpair in private chat."); return true; }
    const name = args[0]; if (!name || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) { await say(chat, "Usage: /mtpair <router_name>"); return true; }
    if (await byName(name)) { await say(chat, "That router name already exists."); return true; }
    const id = randomUUID(), token = randomBytes(24).toString("base64url");
    await save({ id, name, tokenHash: hash(token), base: origin, created: new Date().toISOString() });
    await say(chat, `Pairing created for ${name}.\n\nPaste ALL of this once into MikroTik Terminal:\n\n${installer(origin, id, token)}\n\nDo not share this pairing script.`); return true;
  }
  if (cmd === "/mtrouters") {
    const out: string[] = []; for (const id of await index()) { const r = await getRouter(id); if (r) out.push(`${r.lastSeen && Date.now()-Date.parse(r.lastSeen)<45000 ? "🟢" : "🔴"} ${r.name} — ${r.info?.identity ?? "not paired"} — ${r.info?.version ?? ""}`); }
    await say(chat, out.join("\n") || "No routers. Use /mtpair <name>."); return true;
  }
  if (cmd === "/mtstatus") {
    const r = args[0] ? await byName(args[0]) : null; if (!r) { await say(chat, "Usage: /mtstatus <name>"); return true; }
    const on = r.lastSeen && Date.now()-Date.parse(r.lastSeen)<45000;
    await say(chat, `${on?"🟢 ONLINE":"🔴 OFFLINE"} — ${r.name}\nIdentity: ${r.info?.identity??"?"}\nVersion: ${r.info?.version??"?"}\nUptime: ${r.info?.uptime??"?"}\nCPU: ${r.info?.cpu??"?"}%\nMemory free/total: ${r.info?.free??"?"}/${r.info?.total??"?"}\nLast seen: ${r.lastSeen??"never"}`); return true;
  }
  const reads: Record<string,string> = {"/mtinterfaces":"interfaces","/mtdhcp":"dhcp","/mtarp":"arp","/mtroutes":"routes","/mtfirewall":"firewall","/mtnat":"nat","/mtqueues":"queues","/mtlogs":"logs"};
  if (reads[cmd]) { const r = args[0] ? await byName(args[0]) : null; if (!r) { await say(chat, `Usage: ${cmd} <name>`); return true; } await say(chat, await queue(r, reads[cmd], chat)); return true; }
  if (cmd === "/mtresult") { const r=args[0]?await byName(args[0]):null; if(!r){await say(chat,"Usage: /mtresult <name>");return true} await say(chat,r.last?`${r.last.label} — ${r.last.at}\n${r.last.data}`:"No result yet.");return true; }
  if (cmd === "/mtreboot") { const r=args[0]?await byName(args[0]):null;if(!r){await say(chat,"Usage: /mtreboot <name>");return true}await say(chat,`Reboot MikroTik ${r.name}?`,{reply_markup:{inline_keyboard:[[{text:"✅ Confirm reboot",callback_data:`mtreboot:${r.name}`},{text:"❌ Cancel",callback_data:"cancel"}]]}});return true; }
  if (cmd === "/mtremove") { const r=args[0]?await byName(args[0]):null;if(!r){await say(chat,"Usage: /mtremove <name>");return true}await remove(r);await say(chat,`${r.name} removed.`);return true; }
  await say(chat, "Unknown MikroTik command. Use /help."); return true;
}

export async function handleMtCallback(data: string, q: any): Promise<boolean> {
  if (!data.startsWith("mtreboot:")) return false;
  const chat = Number(q.message?.chat?.id), r = await byName(data.slice("mtreboot:".length));
  if (!r) { await say(chat, "Router not found."); return true; }
  if (r.pending || r.active) { await say(chat, "Router is busy. Try again shortly."); return true; }
  r.pending = { jobId: randomUUID(), label: "reboot", chatId: chat, script: ":delay 2s; /system reboot", result: false }; await save(r);
  await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `Reboot queued for ${r.name} ✅` }); return true;
}

export async function handleAgent(req: Request, url: URL) {
  const id=url.searchParams.get("id")??"", token=url.searchParams.get("token")??"", r=await getRouter(id);
  if(!r || hash(token)!==r.tokenHash) return new Response("unauthorized",{status:401});
  const body=req.method==="POST"?await req.text():"", info:Record<string,string>={};
  for(const line of body.split(/\r?\n/)){const i=line.indexOf("=");if(i>0)info[line.slice(0,i)]=line.slice(i+1)}
  r.lastSeen=new Date().toISOString();r.info={...(r.info??{}),...info};let script="";
  if(r.pending){script=r.pending.script;if(r.pending.result)r.active=r.pending;r.pending=null}await save(r);
  return new Response(script,{headers:{"content-type":"text/plain; charset=utf-8"}});
}

export async function handleResult(req: Request, url: URL) {
  const id=url.searchParams.get("id")??"", job=url.searchParams.get("job")??"", token=url.searchParams.get("token")??"", r=await getRouter(id);
  if(!r?.active || r.active.jobId!==job) return new Response("not found",{status:404});
  const raw=await DB().get(`jt/${id}`); if(!raw)return new Response("unauthorized",{status:401});
  const j=await unseal<{token:string;exp:number}>(raw); if(j.exp<Date.now()||j.token!==token)return new Response("unauthorized",{status:401});
  const data=(await req.text()).slice(0,32000)||"(no data)", active=r.active;
  r.last={label:active.label,data,at:new Date().toISOString()};r.active=null;await save(r);await DB().delete(`jt/${id}`);await say(active.chatId,`${r.name} — ${active.label} ✅\n${data}`);return new Response("ok");
}
