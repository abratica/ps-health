import postgres from "npm:postgres@3.4.5";

// Direct database connection (service-level). Only used inside edge functions.
export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

export async function getConfig(key: string): Promise<string | null> {
  const rows = await sql`select value from private.config where key = ${key}`;
  return rows.length ? rows[0].value : null;
}

export async function setConfig(key: string, value: string) {
  await sql`insert into private.config (key, value) values (${key}, ${value})
            on conflict (key) do update set value = excluded.value`;
}

export async function ownerId(): Promise<string | null> {
  return await getConfig("owner_id");
}
