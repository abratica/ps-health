import { sql, ownerId } from "./db.ts";
import { pushToUser } from "./push.ts";
import { askClaudeJson } from "./claude.ts";

const TZ = "America/New_York";
const hourInBoston = () =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()));
const fmtWhen = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);

// ---------------------------------------------------------------------------
// Check-ins: ~2 hours after each logged meal
// ---------------------------------------------------------------------------
export async function runCheckins() {
  const owner = await ownerId();
  if (!owner) return { skipped: "no owner" };

  // Too old to ask about: retire quietly (still answerable in the app).
  await sql`update public.meals set checkin_pushed = true
            where checkin_pushed = false and eaten_at < now() - interval '6 hours'`;

  const hour = hourInBoston();
  if (hour >= 22 || hour < 8) return { skipped: "quiet hours" };

  const due = await sql`
    select id, name from public.meals
    where user_id = ${owner} and checkin_pushed = false and checkin_due_at <= now()
      and energy is null and stomach is null
    order by eaten_at`;
  let sent = 0;
  for (const m of due) {
    await sql`update public.meals set checkin_pushed = true where id = ${m.id}`;
    sent += await pushToUser(owner, {
      title: "How do you feel?",
      body: `About 2 hours after ${m.name}. Tap to check in.`,
      url: `./#checkin=${m.id}`,
      tag: `c${String(m.id).slice(0, 8)}`,
    });
  }
  return { due: due.length, sent };
}

// ---------------------------------------------------------------------------
// Pattern scan (nightly)
// ---------------------------------------------------------------------------
type Row = { id: string; food_id: string | null; name: string; eaten_at: Date; energy: string | null; stomach: string | null; nutrients: Record<string, number> };

const SIGNALS: { key: string; label: string; test: (r: Row) => boolean; field: "energy" | "stomach" }[] = [
  { key: "low_energy", label: "flat or crashed energy", field: "energy", test: (r) => r.energy === "flat" || r.energy === "crashed" },
  { key: "good_energy", label: "good energy", field: "energy", test: (r) => r.energy === "good" },
  { key: "wired", label: "feeling wired", field: "energy", test: (r) => r.energy === "wired" },
  { key: "rough_stomach", label: "a bloated or rough stomach", field: "stomach", test: (r) => r.stomach === "bloated" || r.stomach === "rough" },
  { key: "great_stomach", label: "a great stomach", field: "stomach", test: (r) => r.stomach === "great" },
];

const MIN_TIMES = 4;     // pattern needs at least this many check-ins
const MIN_SHARE = 0.75;  // ...and this share of them pointing the same way

const PATTERN_SYSTEM = `You write short, plain-English observations for a personal food-and-feelings tracker.
The user logs meals and, about 2 hours later, taps how their energy and stomach feel.
You are given one pattern the app's code found, with the evidence. Explain it honestly:
it is one person's data and a small sample, so frame it as something worth watching, not a conclusion.
Keep it practical and specific. No medical diagnoses.
JSON shape: {"title":"max 8 words","short":"one notification line, max 90 characters","pattern":"1-2 sentences: what the app noticed","why":"1-2 sentences: what might be going on","watch":"1-2 sentences: a simple thing to try or keep an eye on"}`;

export async function runPatterns() {
  const owner = await ownerId();
  if (!owner) return { skipped: "no owner" };

  const rows = (await sql`
    select id, food_id, name, eaten_at, energy, stomach, nutrients from public.meals
    where user_id = ${owner} and eaten_at > now() - interval '60 days'
      and (energy is not null or stomach is not null)
    order by eaten_at`) as unknown as Row[];

  // Groups: each saved food, plus late meals and big meals.
  const groups = new Map<string, { label: string; rows: Row[] }>();
  const add = (k: string, label: string, r: Row) => {
    if (!groups.has(k)) groups.set(k, { label, rows: [] });
    groups.get(k)!.rows.push(r);
  };
  for (const r of rows) {
    add(`food:${r.food_id ?? r.name.toLowerCase()}`, r.name, r);
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(r.eaten_at)));
    if (h >= 20) add("late", "meals eaten after 8pm", r);
    if ((r.nutrients?.kcal ?? 0) >= 900) add("big", "big meals (900+ calories)", r);
  }

  const recent = await sql`select pattern_key from public.observations
                           where user_id = ${owner} and kind = 'pattern' and created_at > now() - interval '45 days'`;
  const seen = new Set(recent.map((r) => r.pattern_key));

  const candidates: { key: string; group: string; signal: (typeof SIGNALS)[number]; hits: Row[]; all: Row[] }[] = [];
  for (const [gk, g] of groups) {
    for (const s of SIGNALS) {
      const answered = g.rows.filter((r) => r[s.field] !== null);
      if (answered.length < MIN_TIMES) continue;
      const hits = answered.filter(s.test);
      if (hits.length / answered.length < MIN_SHARE) continue;
      const key = `${gk}:${s.key}`;
      if (seen.has(key)) continue;
      candidates.push({ key, group: g.label, signal: s, hits, all: answered });
    }
  }
  // Strongest first, at most two new observations per night.
  candidates.sort((a, b) => b.hits.length / b.all.length - a.hits.length / a.all.length || b.all.length - a.all.length);

  let created = 0;
  for (const c of candidates.slice(0, 2)) {
    const evidence = c.all.map((r) => ({
      meal_id: r.id,
      name: r.name,
      when: fmtWhen(new Date(r.eaten_at)),
      energy: r.energy,
      stomach: r.stomach,
    }));
    const text = await askClaudeJson<{ title: string; short: string; pattern: string; why: string; watch: string }>(
      PATTERN_SYSTEM,
      [{
        type: "text",
        text: `Pattern: after ${c.group}, the user reported ${c.signal.label} on ${c.hits.length} of ${c.all.length} check-ins.\nEvidence:\n` +
          evidence.map((e) => `- ${e.when}: ${e.name} (energy: ${e.energy ?? "-"}, stomach: ${e.stomach ?? "-"})`).join("\n"),
      }],
      700,
    );
    await sql`insert into public.observations (user_id, kind, pattern_key, title, short, body, evidence)
              values (${owner}, 'pattern', ${c.key}, ${text.title}, ${text.short},
                      ${sql.json({ pattern: text.pattern, why: text.why, watch: text.watch, stat: `${c.hits.length} of ${c.all.length} check-ins` })},
                      ${sql.json(evidence)})`;
    created++;
  }
  return { checked: rows.length, candidates: candidates.length, created };
}

// ---------------------------------------------------------------------------
// Pattern notification: at most one a day
// ---------------------------------------------------------------------------
export async function runNotify() {
  const owner = await ownerId();
  if (!owner) return { skipped: "no owner" };
  const recent = await sql`select 1 from public.observations
                           where user_id = ${owner} and kind = 'pattern' and notified_at > now() - interval '20 hours'`;
  if (recent.length) return { skipped: "already notified today" };
  const next = await sql`select id, short from public.observations
                         where user_id = ${owner} and kind = 'pattern' and notified_at is null
                           and created_at > now() - interval '7 days'
                         order by created_at limit 1`;
  if (!next.length) return { skipped: "nothing new" };
  await sql`update public.observations set notified_at = now() where id = ${next[0].id}`;
  const sent = await pushToUser(owner, { title: "Pattern spotted", body: next[0].short, url: `./#obs=${next[0].id}`, tag: "pattern" });
  return { sent };
}

// ---------------------------------------------------------------------------
// Weekly summary (Sunday morning, or on demand)
// ---------------------------------------------------------------------------
const WEEKLY_SYSTEM = `You write the weekly summary for a personal food tracker. The reader is a knowledgeable adult who wants
a general, informational picture of their eating, including what tends to raise LDL cholesterol: no scores, no lecturing.
Numbers are rough (estimated from photos), so talk in ballpark terms.
Use only the data given. Be specific to the actual foods eaten. Keep every section short (1-3 sentences, or up to 3 short bullets as an array of strings where noted).
JSON shape:
{"title":"max 6 words","short":"one notification line, max 90 characters",
 "eating":"what he mostly ate this week and the ballpark calories/macros",
 "cholesterol_up":["up to 3 bullets: the foods pushing cholesterol up most, with why (saturated fat mainly)"],
 "less_of":["2-3 practical, specific cuts or swaps based on what he actually ate"],
 "feelings":"what the check-ins say about energy and stomach this week, or empty string if there were none",
 "weight":"one line on weight trend if weight data exists, else empty string"}`;

export async function runWeekly(opts: { notify: boolean }) {
  const owner = await ownerId();
  if (!owner) return { skipped: "no owner" };

  const meals = await sql`
    select name, food_id, nutrients, energy, stomach, eaten_at,
           (eaten_at at time zone ${TZ})::date as day
    from public.meals
    where user_id = ${owner} and eaten_at > now() - interval '7 days'
    order by eaten_at`;
  if (!meals.length) return { skipped: "no meals this week" };

  const num = (v: unknown) => Number(v) || 0;
  const days = new Set(meals.map((m) => String(m.day))).size;
  const totals: Record<string, number> = {};
  for (const m of meals) for (const [k, v] of Object.entries(m.nutrients ?? {})) totals[k] = (totals[k] ?? 0) + num(v);
  const perDay = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v / days)]));

  const byFood = new Map<string, { times: number; sat_fat: number; kcal: number }>();
  for (const m of meals) {
    const f = byFood.get(m.name) ?? { times: 0, sat_fat: 0, kcal: 0 };
    f.times++;
    f.sat_fat += num(m.nutrients?.sat_fat);
    f.kcal += num(m.nutrients?.kcal);
    byFood.set(m.name, f);
  }
  const frequent = [...byFood.entries()].sort((a, b) => b[1].times - a[1].times).slice(0, 8);
  const satTotal = totals.sat_fat || 0;
  const satRank = [...byFood.entries()].sort((a, b) => b[1].sat_fat - a[1].sat_fat).slice(0, 5)
    .filter(([, f]) => f.sat_fat > 0)
    .map(([n, f]) => `${n}: ${Math.round(f.sat_fat)}g sat fat (${satTotal ? Math.round((f.sat_fat / satTotal) * 100) : 0}% of the week's)`);

  const count = (field: "energy" | "stomach") => {
    const c: Record<string, number> = {};
    for (const m of meals) if (m[field]) c[m[field]] = (c[m[field]] ?? 0) + 1;
    return c;
  };

  const weights = await sql`select measured_at, weight_lb from public.weights
                            where user_id = ${owner} and measured_at > now() - interval '30 days' order by measured_at`;
  const labs = await sql`select taken_on, ldl, hdl, triglycerides, total_chol from public.labs
                         where user_id = ${owner} order by taken_on desc limit 1`;

  const satPct = perDay.kcal ? Math.round(((perDay.sat_fat ?? 0) * 9 / perDay.kcal) * 100) : 0;
  const brief = [
    `Logged meals: ${meals.length} across ${days} day(s).`,
    `Average per logged day: ${perDay.kcal ?? 0} kcal, ${perDay.protein ?? 0}g protein, ${perDay.carbs ?? 0}g carbs, ${perDay.fat ?? 0}g fat, ${perDay.sat_fat ?? 0}g saturated fat (~${satPct}% of calories), ${perDay.fiber ?? 0}g fiber (~${perDay.soluble_fiber ?? 0}g soluble), ${perDay.sodium ?? 0}mg sodium.`,
    `Most frequent foods: ${frequent.map(([n, f]) => `${n} (x${f.times})`).join(", ")}.`,
    `Biggest saturated fat sources: ${satRank.join("; ") || "none notable"}.`,
    `Energy check-ins: ${JSON.stringify(count("energy"))}. Stomach check-ins: ${JSON.stringify(count("stomach"))}.`,
    weights.length ? `Weight (lb, last 30 days): ${weights.map((w) => `${fmtWhen(new Date(w.measured_at))}: ${w.weight_lb}`).join("; ")}.` : "No weight data.",
    labs.length ? `Most recent labs (${labs[0].taken_on}): LDL ${labs[0].ldl ?? "?"}, HDL ${labs[0].hdl ?? "?"}, triglycerides ${labs[0].triglycerides ?? "?"}, total ${labs[0].total_chol ?? "?"}.` : "No lab results entered.",
  ].join("\n");

  const s = await askClaudeJson<{ title: string; short: string; eating: string; cholesterol_up: string[]; less_of: string[]; feelings: string; weight: string }>(
    WEEKLY_SYSTEM,
    [{ type: "text", text: brief }],
    1200,
  );

  const body = { ...s, stats: { meals: meals.length, days, per_day: perDay, sat_pct: satPct } };
  const ins = await sql`insert into public.observations (user_id, kind, title, short, body, evidence, notified_at)
                        values (${owner}, 'weekly', ${s.title}, ${s.short}, ${sql.json(body)}, ${sql.json(frequent.map(([n, f]) => ({ name: n, times: f.times })))},
                                ${opts.notify ? new Date() : null})
                        returning id`;
  let sent = 0;
  if (opts.notify) {
    sent = await pushToUser(owner, { title: "Your week in food", body: s.short, url: `./#obs=${ins[0].id}`, tag: "weekly" });
  }
  return { id: ins[0].id, sent };
}
