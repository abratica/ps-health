// App API, called from the PS Health web app by the signed-in owner.
import { createClient } from "npm:@supabase/supabase-js@2";
import { analyzeMeal } from "../_shared/food.ts";
import { lookupBarcode } from "../_shared/barcode.ts";
import { vapidKeys, pushToUser } from "../_shared/push.ts";
import { runWeekly } from "../_shared/tasks.ts";
import { ownerId } from "../_shared/db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://ktpztiyqyoalrwnqtqme.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_aUvlMasnVDO34rV8wBWnCw_oywTssOz";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.rpc("is_owner");
  return !error && data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  try {
    if (!(await isOwner(req))) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case "analyze": {
        if (!body.image && !body.text) return json({ error: "Send a photo or a description" }, 400);
        const result = await analyzeMeal({ image: body.image, mediaType: body.mediaType, text: body.text });
        return json(result);
      }
      case "barcode": {
        if (!body.code) return json({ error: "Send a barcode" }, 400);
        return json(await lookupBarcode(body.code));
      }
      case "vapid": {
        const { publicKey } = await vapidKeys();
        return json({ publicKey });
      }
      case "test_push": {
        const owner = await ownerId();
        const sent = await pushToUser(owner!, {
          title: "PS Health",
          body: "Notifications are working.",
          url: "./",
          tag: "test",
        });
        return json({ sent });
      }
      case "weekly_now": {
        return json(await runWeekly({ notify: false }));
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
