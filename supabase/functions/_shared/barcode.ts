// Barcode lookup via Open Food Facts (free, open data).
import { KEYS, type Nutrients } from "./food.ts";

const zero = (): Nutrients => Object.fromEntries(KEYS.map((k) => [k, 0])) as Nutrients;
const round = (n: number, k: string) => Math.round(n * (k === "kcal" || k === "sodium" ? 1 : 10)) / (k === "kcal" || k === "sodium" ? 1 : 10);

// Open Food Facts nutriment names -> our keys. Sodium comes in grams; we store mg.
const OFF: [keyof Nutrients, string, number][] = [
  ["kcal", "energy-kcal", 1],
  ["protein", "proteins", 1],
  ["carbs", "carbohydrates", 1],
  ["fat", "fat", 1],
  ["sat_fat", "saturated-fat", 1],
  ["fiber", "fiber", 1],
  ["sugar", "sugars", 1],
  ["sodium", "sodium", 1000],
];

export async function lookupBarcode(code: string) {
  const clean = String(code).replace(/\D/g, "");
  if (clean.length < 6 || clean.length > 14) return { error: "bad_code" };

  const url = `https://world.openfoodfacts.org/api/v2/product/${clean}.json?fields=product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,image_front_small_url`;
  const res = await fetch(url, { headers: { "User-Agent": "PSHealth/1.0 (personal food log; abratica.github.io/ps-health)" } });
  if (res.status === 404) return { error: "not_found", barcode: clean };
  if (!res.ok) throw new Error(`Open Food Facts ${res.status}`);
  const data = await res.json();
  const p = data.product;
  if (!data.status || !p) return { error: "not_found", barcode: clean };

  const n = p.nutriments ?? {};
  const servingG = Number(p.serving_quantity) || 0;
  const hasServing = servingG > 0 && n["energy-kcal_serving"] !== undefined;
  const hasPer100 = n["energy-kcal_100g"] !== undefined;
  if (!hasServing && !hasPer100) return { error: "no_nutrition", barcode: clean };

  const grams = hasServing ? servingG : 100;
  const nutrients = zero();
  for (const [key, off, mult] of OFF) {
    const v = hasServing ? n[`${off}_serving`] : n[`${off}_100g`];
    const fallback = n[`${off}_100g`] !== undefined ? (Number(n[`${off}_100g`]) * grams) / 100 : 0;
    nutrients[key] = (v !== undefined ? Number(v) : fallback) * mult;
  }
  const per_gram = zero();
  for (const k of KEYS) {
    per_gram[k] = nutrients[k] / grams;
    nutrients[k] = round(nutrients[k], k);
  }

  const brand = String(p.brands ?? "").split(",")[0].trim();
  const productName = String(p.product_name_en || p.product_name || "").trim() || "Packaged food";
  const name = brand && !productName.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${productName}` : productName;
  const portion = hasServing ? (p.serving_size ? String(p.serving_size) : `${grams} g`) : "100 g";

  return {
    name,
    items: [{ name, portion, grams: Math.round(grams), nutrients, per_gram, source: "label" }],
    nutrients,
    tags: [] as string[],
    confidence: "high",
    note: hasServing ? "Label numbers from Open Food Facts, per serving." : "Open Food Facts only lists this per 100 g, so adjust the grams to what you had.",
    barcode: clean,
    image: p.image_front_small_url ?? null,
  };
}
