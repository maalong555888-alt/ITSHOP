import type { Config } from "@netlify/functions";
import { allowedUsers, env, say, tg, webhookSecret } from "./lib/common.mjs";
import { handleMtCommand, handleMtCallback, handleAgent, handleResult } from "./lib/mikrotik.mjs";
import { handleRjCommand, handleRjCallback } from "./lib/ruijie.mjs";

async function updateHandler(update:any,origin:string){
  if(update.callback_query){const q=update.callback_query,uid=Number(q.from?.id);if(!allowedUsers().has(uid)){await tg("answerCallbackQuery",{callback_query_id:q.id,text:"Not authorized"});return}await tg("answerCallbackQuery",{callback_query_id:q.id});const data=String(q.data??"");if(data==="cancel"){await tg("editMessageText",{chat_id:q.message.chat.id,message_id:q.message.message_id,text:"Cancelled."});return}if(await handleMtCallback(data,q))return;if(await handleRjCallback(data,q))return;return}
  const m=update.message??update.edited_message;if(!m?.text||!m.from)return;const uid=Number(m.from.id),chat=Number(m.chat.id);if(!allowedUsers().has(uid)){await say(chat,"Not authorized. This bot is private.");return}const parts=m.text.trim().split(/\s+/),cmd=(parts.shift()??"").split("@")[0].toLowerCase(),args=parts;
  if(cmd==="/start"||cmd==="/help"){await say(chat,"Network bot — Ruijie/Reyee + MikroTik\n\nRuijie: /login /projects /devices /clients /traffic /reboot /adddevice /rename /setpass /logout\nMikroTik: /mtpair /mtrouters /mtstatus /mtinterfaces /mtdhcp /mtarp /mtroutes /mtfirewall /mtnat /mtqueues /mtlogs /mtreboot /mtresult /mtremove");return}
  if(await handleMtCommand(cmd,args,m,origin))return;
  if(await handleRjCommand(cmd,args,m))return;
  await say(chat,"Unknown command. Use /help.");
}

export default async(req:Request)=>{const u=new URL(req.url);
  if(u.pathname==="/api/health")return Response.json({ok:true,service:"Ruijie/Reyee + MikroTik Telegram control",telegramConfigured:!!env("TELEGRAM_BOT_TOKEN"),allowedUsersConfigured:allowedUsers().size>0,time:new Date().toISOString()});
  if(u.pathname==="/api/register-webhook"){if(!env("TELEGRAM_BOT_TOKEN"))return Response.json({ok:false,error:"TELEGRAM_BOT_TOKEN missing"},{status:503});try{await tg("setWebhook",{url:`${u.origin}/api/telegram`,secret_token:webhookSecret(),allowed_updates:["message","edited_message","callback_query"]});const x=await tg("getWebhookInfo",{});return Response.json({ok:true,webhook:{url:x.url,pending_update_count:x.pending_update_count,last_error_message:x.last_error_message??null}})}catch(e:any){return Response.json({ok:false,error:e.message},{status:500})}}
  if(u.pathname==="/api/mikrotik/agent")return handleAgent(req,u);
  if(u.pathname==="/api/mikrotik/result")return handleResult(req,u);
  if(u.pathname==="/api/telegram"){if(req.headers.get("x-telegram-bot-api-secret-token")!==webhookSecret())return new Response("unauthorized",{status:401});try{await updateHandler(await req.json(),u.origin)}catch(e:any){console.error(e?.message??e)}return new Response("ok")}
  return new Response("Network bot online");
};
export const config:Config={path:["/","/api/health","/api/register-webhook","/api/telegram","/api/mikrotik/agent","/api/mikrotik/result"]};
