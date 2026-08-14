import type { Context } from "@netlify/functions";
import { clientLine, env, getClients, getGroups, makeRuijieClient, mapLimit, sendText } from "../lib/common.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST" || !env("INTERNAL_JOB_SECRET") || req.headers.get("x-job-secret") !== env("INTERNAL_JOB_SECRET")) return;
  const { chatId } = await req.json() as { chatId: number };
  const rj = await makeRuijieClient();
  const groups = await getGroups(rj);
  const results = await mapLimit(groups, 12, async (group) => ({ group, clients: await getClients(rj, group.id) }));
  const lines = ["Current clients across all projects:"]; let total = 0, errors = 0;
  for (const result of results as any[]) {
    if (result?.__error) { errors++; continue; }
    if (!result.clients?.length) continue;
    lines.push(`\n${result.group.name} (id:${result.group.id})`);
    for (const client of result.clients) { total++; lines.push(`  ${clientLine(client)}`); }
  }
  lines.push(`\nTotal current clients: ${total}`); if (errors) lines.push(`Groups with API errors: ${errors}`);
  await sendText(chatId, lines.join("\n"));
};
