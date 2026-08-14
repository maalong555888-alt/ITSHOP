import type { Context } from "@netlify/functions";
import { deviceLine, env, getDevices, getGroups, makeRuijieClient, mapLimit, sendText } from "../lib/common.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST" || !env("INTERNAL_JOB_SECRET") || req.headers.get("x-job-secret") !== env("INTERNAL_JOB_SECRET")) return;
  const { chatId } = await req.json() as { chatId: number };
  const rj = await makeRuijieClient();
  const groups = await getGroups(rj);
  const results = await mapLimit(groups, 8, async (group) => ({ group, devices: await getDevices(rj, group.id) }));
  const lines = ["All Ruijie/Reyee equipment:"]; let total = 0, errors = 0;
  for (const result of results as any[]) {
    if (result?.__error) { errors++; continue; }
    if (!result.devices?.length) continue;
    lines.push(`\n${result.group.name} (id:${result.group.id})`);
    for (const device of result.devices) { total++; lines.push(`  ${deviceLine(device)}`); }
  }
  lines.push(`\nTotal equipment: ${total}`); if (errors) lines.push(`Groups with API errors: ${errors}`);
  await sendText(chatId, lines.join("\n"));
};
