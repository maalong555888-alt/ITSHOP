import { DB, env, seal, unseal, say, deleteMessage, tg } from "./common.mjs";

async function creds(uid:number){
  const raw=await DB().get(`ruijie/${uid}`);
  if(raw)return unseal<{appid:string;secret:string}>(raw);
  const appid=env("RUIJIE_APP_ID"),secret=env("RUIJIE_APP_SECRET");
  return appid&&secret?{appid,secret}:null;
}
async function auth(appid:string,secret:string){const base=env("RUIJIE_BASE_URL")||"https://cloud-as.ruijienetworks.com",u=new URL("/service/api/oauth20/client/access_token",base);u.searchParams.set("token","d63dss0a81e4415a889ac5b78fsc904a");const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({appid,secret})});const j:any=await r.json();if(!r.ok||j.code!==0||!j.accessToken)throw Error(j.msg||"Ruijie authentication failed");return j.accessToken}
async function api(uid:number,path:string,method="GET",params:Record<string,string>={},body:any=null){const c=await creds(uid);if(!c)throw Error("Ruijie API credentials are not configured.");const token=await auth(c.appid,c.secret),u=new URL(path,env("RUIJIE_BASE_URL")||"https://cloud-as.ruijienetworks.com");u.searchParams.set("access_token",token);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));const r=await fetch(u,{method,headers:{"content-type":"application/json"},body:method==="GET"?undefined:JSON.stringify(body??{})});const j:any=await r.json();if(!r.ok||(j.code!==undefined&&j.code!==0))throw Error(j.msg||`Ruijie API error ${j.code??r.status}`);return j}
function groups(n:any,d=0,o:string[]=[]){if(!n)return o;o.push(`${"  ".repeat(d)}${n.name??"Unnamed"} — id: ${n.groupId??"?"}`);for(const c of n.subGroups??[])groups(c,d+1,o);return o}

export async function handleRjCommand(cmd:string,args:string[],m:any):Promise<boolean>{
  const uid=Number(m.from.id),chat=Number(m.chat.id);
  const known=["/login","/logout","/projects","/devices","/clients","/traffic","/reboot","/adddevice","/rename","/setpass"];
  if(!known.includes(cmd))return false;
  if(cmd==="/login"){if(m.chat.type!=="private"){await say(chat,"Use /login in private chat.");return true}await deleteMessage(chat,m.message_id);if(args.length!==2){await say(chat,"Usage: /login <appid> <secret>");return true}try{await auth(args[0],args[1]);await DB().set(`ruijie/${uid}`,await seal({appid:args[0],secret:args[1]}));await say(chat,"Logged in to Ruijie Cloud ✅")}catch(e:any){await say(chat,`Ruijie login failed: ${e.message}`)}return true}
  if(cmd==="/logout"){await DB().delete(`ruijie/${uid}`);await say(chat,"Saved per-user Ruijie credentials cleared. Secure project credentials remain available.");return true}
  try{
    if(cmd==="/projects"){const j=await api(uid,"/service/api/group/single/tree","GET",{depth:"BUILDING"});await say(chat,groups(j.groups).join("\n")||"No projects.");return true}
    if(cmd==="/devices"){if(!args[0]){await say(chat,"Usage: /devices <group_id>");return true}const j=await api(uid,"/service/api/device/list","GET",{groupId:args[0]}),x=j.devices??j.list??[];await say(chat,x.map((d:any)=>`${d.online||d.isOnline?"🟢":"🔴"} ${d.name??d.sn??"device"} | ${d.productType??"?"} | SN:${d.sn??d.serialNumber??"?"}`).join("\n")||"No devices.");return true}
    if(cmd==="/clients"){if(!args[0]){await say(chat,"Usage: /clients <group_id>");return true}const j=await api(uid,"/service/api/client/list","GET",{groupId:args[0]}),x=j.clients??j.list??[];await say(chat,x.map((c:any)=>`${c.userName??c.hostname??"unknown"} | ${c.mac??""} | ${c.ip??""}`).join("\n")||"No clients.");return true}
    if(cmd==="/traffic"){if(!args[0]){await say(chat,"Usage: /traffic <serial>");return true}await say(chat,JSON.stringify(await api(uid,"/service/api/device/traffic","GET",{sn:args[0]}),null,2));return true}
    if(cmd==="/reboot"){if(!args[0]){await say(chat,"Usage: /reboot <serial>");return true}await say(chat,`Reboot Ruijie/Reyee ${args[0]}?`,{reply_markup:{inline_keyboard:[[{text:"✅ Confirm reboot",callback_data:`rjreboot:${args[0]}`},{text:"❌ Cancel",callback_data:"cancel"}]]}});return true}
    if(cmd==="/adddevice"){if(args.length<2){await say(chat,"Usage: /adddevice <group_id> <serial> [mac]");return true}await api(uid,"/service/api/device/add","POST",{},{groupId:Number(args[0]),sn:args[1],...(args[2]?{mac:args[2]}:{})});await say(chat,"Device added ✅");return true}
    if(cmd==="/rename"){if(args.length<3){await say(chat,"Usage: /rename <group_id> <mac> <new_name>");return true}await api(uid,"/service/api/client/rename","POST",{},{groupId:Number(args[0]),mac:args[1],userName:args.slice(2).join(" ")});await say(chat,"Client renamed ✅");return true}
    if(cmd==="/setpass"){await deleteMessage(chat,m.message_id);if(args.length<3){await say(chat,"Usage: /setpass <group_id> <mac> <password>");return true}await api(uid,"/service/api/client/password","POST",{},{groupId:Number(args[0]),mac:args[1],password:args[2]});await say(chat,"Password updated ✅");return true}
  }catch(e:any){await say(chat,`Ruijie error: ${e.message}`);return true}
  return true;
}

export async function handleRjCallback(data:string,q:any):Promise<boolean>{if(!data.startsWith("rjreboot:"))return false;const uid=Number(q.from.id),chat=Number(q.message?.chat?.id),serial=data.slice("rjreboot:".length);try{await api(uid,"/service/api/device/reboot","POST",{},{sn:serial});await tg("editMessageText",{chat_id:chat,message_id:q.message.message_id,text:`Ruijie reboot sent to ${serial} ✅`})}catch(e:any){await say(chat,`Ruijie error: ${e.message}`)}return true}
