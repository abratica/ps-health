// Scheduled jobs, called by pg_cron with a shared secret.
import { getConfig } from "../_shared/db.ts";
import { runCheckins, runNotify, runPatterns, runWeekly } from "../_shared/tasks.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const secret = await getConfig("cron_secret");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);

  const { task } = await req.json().catch(() => ({ task: "" }));
  try {
    switch (task) {
      case "checkins": return json(await runCheckins());
      case "patterns": return json(await runPatterns());
      case "notify":   return json(await runNotify());
      case "weekly":   return json(await runWeekly({ notify: true }));
      default:         return json({ error: "unknown task" }, 400);
    }
  } catch (e) {
    console.error(task, e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
