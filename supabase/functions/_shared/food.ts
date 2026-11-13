import { askClaudeJson } from "./claude.ts";

export const KEYS = ["kcal", "protein", "carbs", "fat", "sat_fat", "fiber", "soluble_fiber", "sugar", "sodium"] as const;
export type Nutrients = Record<(typeof KEYS)[number], number>;

const zero = (): Nutrients => Object.fromEntries(KEYS.map((k) => [k, 0])) as Nutrients;

type ClaudeItem = {
  name: string;
  portion: string;
  grams: number;
  usda_query: string;
  estimate: Partial<Nutrients>;
  from_label?: boolean;
};
type ClaudeMeal = {
  error?: string;
  name: string;
  items: ClaudeItem[];
  tags?: string[];
  confidence?: string;
  note?: string;
};

const SYSTEM = `You are the food-logging engine of a personal nutrition app.
The user shows you a photo of food they are about to eat, or describes it in words.
Identify each distinct food on the plate and estimate a realistic portion in grams.
Include likely hidden additions (cooking oil, butter, dressing, sauce) as their own items when they are probably there.
For each item give:
- name: plain everyday name
- portion: friendly portion description, e.g. "1 cup", "6 oz", "2 slices"
- grams: estimated edible weight in grams (number)
- usda_query: a short generic search term for the USDA FoodData Central database, e.g. "chicken breast roasted", "white rice cooked", "broccoli cooked"
- estimate: your own per-portion estimate of kcal, protein, carbs, fat, sat_fat, fiber, soluble_fiber, sugar (all grams except kcal) and sodium (mg)
Also return:
- name: a short name for the whole meal, as the user would call it (max 5 words)
- tags: any that apply from ["nut","soy","plant_sterol","soluble_fiber"] (soluble_fiber when the meal contains a meaningful source such as oats, barley, beans, lentils, apples, citrus, psyllium)
- confidence: "high", "medium" or "low"
- note: one short sentence about your main assumption, or ""
If the photo shows a Nutrition Facts label (or any printed nutrition panel), do not estimate: return ONE item for the product,
with portion = the label's serving size, grams = the serving size in grams (estimate from the label if only volume is given),
estimate = the label's exact per-serving numbers (sodium in mg; soluble_fiber only if printed, else 0), usda_query = "", and "from_label": true.
Use the product name if it is visible, otherwise a short description such as "Protein bar".
If the image or text contains no food, reply {"error":"no_food"}.
JSON shape: {"name":"","items":[{"name":"","portion":"","grams":0,"usda_query":"","estimate":{}}],"tags":[],"confidence":"","note":""}`;

// USDA nutrient numbers -> our keys (values per 100 g for Foundation / SR Legacy / FNDDS foods)
const USDA_MAP: Record<string, keyof Nutrients> = {
  "203": "protein",
  "204": "fat",
  "205": "carbs",
  "291": "fiber",
  "269": "sugar",
  "307": "sodium",
  "606": "sat_fat",
};

type UsdaHit = { fdcId: number; description: string; per100: Partial<Nutrients> };

async function usdaLookup(query: string): Promise<UsdaHit | null> {
  const key = Deno.env.get("USDA_API_KEY");
  if (!key || !query) return null;
  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", "5");
  url.searchParams.set("dataType", "Survey (FNDDS),SR Legacy,Foundation");
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const food = (data.foods ?? [])[0];
    if (!food) return null;
    const per100: Partial<Nutrients> = {};
    let kcal208: number | undefined, kcalAtwater: number | undefined;
    for (const n of food.foodNutrients ?? []) {
      const num = String(n.nutrientNumber ?? "");
      const unit = String(n.unitName ?? "").toUpperCase();
      if (num === "208" && unit === "KCAL") kcal208 = n.value;
      else if ((num === "958" || num === "957") && unit === "KCAL") kcalAtwater ??= n.value;
      else if (USDA_MAP[num]) per100[USDA_MAP[num]] = n.value;
    }
    const kcal = kcal208 ?? kcalAtwater;
    if (kcal === undefined) return null;
    per100.kcal = kcal;
    return { fdcId: food.fdcId, description: food.description, per100 };
  } catch {
    return null;
  }
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export type AnalyzedItem = {
  name: string;
  portion: string;
  grams: number;
  nutrients: Nutrients;
  per_gram: Nutrients;
  source: "usda" | "estimate" | "label";
  usda_desc?: string;
};

export async function analyzeMeal(input: { image?: string; mediaType?: string; text?: string }) {
  const content = [];
  if (input.image) {
    content.push({
      type: "image" as const,
      source: { type: "base64" as const, media_type: input.mediaType || "image/jpeg", data: input.image },
    });
  }
  content.push({
    type: "text" as const,
    text: input.text?.trim()
      ? `Here is what I'm eating: ${input.text.trim()}`
      : "Here is a photo of what I'm eating.",
  });

  const meal = await askClaudeJson<ClaudeMeal>(SYSTEM, content, 2000);
  if (meal.error) return { error: meal.error };

  const items: AnalyzedItem[] = await Promise.all(
    (meal.items ?? []).map(async (it) => {
      const grams = Math.max(1, Number(it.grams) || 100);
      const est = zero();
      for (const k of KEYS) est[k] = Number(it.estimate?.[k]) || 0;

      const fromLabel = it.from_label === true;
      const hit = fromLabel ? null : await usdaLookup(it.usda_query || it.name);
      let nutrients = est;
      let source: "usda" | "estimate" | "label" = fromLabel ? "label" : "estimate";
      if (hit) {
        const fromUsda = zero();
        for (const k of KEYS) {
          const v = hit.per100[k];
          fromUsda[k] = v === undefined ? est[k] : (v * grams) / 100;
        }
        fromUsda.soluble_fiber = est.soluble_fiber; // USDA rarely reports soluble fiber
        // Guard against a bad database match: keep the estimate if calories disagree wildly.
        const ratio = est.kcal > 30 ? fromUsda.kcal / est.kcal : 1;
        if (ratio >= 0.4 && ratio <= 2.5) {
          nutrients = fromUsda;
          source = "usda";
        }
      }
      const per_gram = zero();
      for (const k of KEYS) {
        per_gram[k] = nutrients[k] / grams;
        nutrients[k] = round(nutrients[k], k === "kcal" || k === "sodium" ? 0 : 1);
      }
      return {
        name: it.name,
        portion: it.portion,
        grams: Math.round(grams),
        nutrients,
        per_gram,
        source,
        usda_desc: source === "usda" ? hit?.description : undefined,
      };
    }),
  );

  const total = zero();
  for (const it of items) for (const k of KEYS) total[k] += it.nutrients[k];
  for (const k of KEYS) total[k] = round(total[k], k === "kcal" || k === "sodium" ? 0 : 1);

  const tags = (meal.tags ?? []).filter((t) => ["nut", "soy", "plant_sterol", "soluble_fiber"].includes(t));
  return {
    name: meal.name || items.map((i) => i.name).join(", "),
    items,
    nutrients: total,
    tags,
    confidence: meal.confidence ?? "medium",
    note: meal.note ?? "",
  };
}
