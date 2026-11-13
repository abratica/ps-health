import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://ktpztiyqyoalrwnqtqme.supabase.co";
const SUPABASE_KEY = "sb_publishable_aUvlMasnVDO34rV8wBWnCw_oywTssOz";
const API = `${SUPABASE_URL}/functions/v1/api`;
const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" } });

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r0 = (n) => Math.round(Number(n) || 0);
const KEYS = ["kcal", "protein", "carbs", "fat", "sat_fat", "fiber", "soluble_fiber", "sugar", "sodium"];

const ENERGY = [["wired", "Wired"], ["good", "Good"], ["flat", "Flat"], ["crashed", "Crashed"]];
const STOMACH = [["great", "Great"], ["fine", "Fine"], ["bloated", "Bloated"], ["rough", "Rough"]];

let user = null;
let tab = "today";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

async function api(action, payload = {}) {
  const { data: { session } } = await db.auth.getSession();
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}`, apikey: SUPABASE_KEY },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
function when(d) {
  d = new Date(d);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return timeFmt.format(d);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${timeFmt.format(d)}`;
  return `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
}
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const localInputValue = (d = new Date()) => {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
};

function sumNutrients(list) {
  const t = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const n of list) for (const k of KEYS) t[k] += Number(n?.[k]) || 0;
  return t;
}
function scale(n, f) {
  return Object.fromEntries(KEYS.map((k) => [k, (Number(n?.[k]) || 0) * f]));
}
const macroLine = (n) => `${r0(n.kcal)} cal · ${r0(n.protein)}g protein`;

// Shrink a photo before sending: keeps cost and upload time low.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
function toJpeg(img, max, quality) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
function squareThumb(img, size = 160) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const m = Math.min(img.naturalWidth, img.naturalHeight);
  c.getContext("2d").drawImage(img, (img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.7);
}

// ---------------------------------------------------------------------------
// Sheet (bottom modal)
// ---------------------------------------------------------------------------
function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  return $("#sheet-body");
}
function closeSheet() {
  stopScanner();
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}
$("#sheet").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const THEME_KEY = "psh-theme";
try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.dataset.theme = t; } catch {}
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch {}
});

// ---------------------------------------------------------------------------
// Sign in (6-digit email code)
// ---------------------------------------------------------------------------
function renderSignIn() {
  $("#tabs").hidden = true;
  $("#sub").textContent = "What you eat, and how it makes you feel";
  app.innerHTML = `
    <div class="card">
      <h2>Sign in</h2>
      <p class="muted small">Enter your email and we'll send you a sign-in link.</p>
      <form id="f-email">
        <label class="field"><span>Email</span><input class="input" id="email" type="email" autocomplete="email" required></label>
        <button class="btn primary block">Email me a link</button>
      </form>
      <div id="sent" hidden>
        <p>Check your email and tap <b>Log In</b>. It opens PS Health signed in.</p>
        <p class="small muted">Use this same phone. Didn't get it? Check spam, or <button type="button" class="link" id="resend">send again</button>.</p>
      </div>
    </div>`;
  const send = async () => {
    const { error } = await db.auth.signInWithOtp({
      email: $("#email").value.trim(),
      options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) return toast(error.message);
    $("#f-email").hidden = true;
    $("#sent").hidden = false;
  };
  $("#f-email").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("#resend").addEventListener("click", send);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const VIEWS = { today: renderToday, foods: renderFoods, insights: renderInsights, you: renderYou };
function go(next) {
  tab = next;
  for (const b of document.querySelectorAll("#tabs button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  return VIEWS[tab]();
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) go(b.dataset.tab);
});

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------
async function renderToday(highlightId) {
  $("#sub").textContent = dayFmt.format(new Date());
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const [{ data: meals }, { data: pending }] = await Promise.all([
    db.from("meals").select("id,name,servings,nutrients,eaten_at,energy,stomach,food_id").gte("eaten_at", startOfToday().toISOString()).order("eaten_at", { ascending: false }),
    db.from("meals").select("id,name,eaten_at,energy,stomach").gte("eaten_at", since).lte("checkin_due_at", new Date().toISOString()).is("checked_in_at", null).order("eaten_at", { ascending: false }),
  ]);
  const t = sumNutrients((meals ?? []).map((m) => m.nutrients));

  app.innerHTML = `
    <div id="install-slot"></div>
    <div class="log-actions">
      <button class="btn primary wide" id="snap"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Snap food</button>
      <button class="btn" id="scan"><svg viewBox="0 0 24 24"><path d="M4 7V5h3M17 5h3v2M20 17v2h-3M7 19H4v-2M8 9v6M11 9v6M14 9v6M16.5 9v6"/></svg>Scan barcode</button>
      <button class="btn" id="type"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>Type it</button>
    </div>
    <p class="small muted" style="margin:8px 2px 0">Eating something you've had before? Tap it in <button class="link" id="to-foods">My foods</button>.</p>

    ${(pending ?? []).length ? `<h3>How do you feel?</h3>${pending.map(checkinCard).join("")}` : ""}

    <h3>Today, roughly</h3>
    <div class="card totals">
      <div><b>${r0(t.kcal)}</b><span>calories</span></div>
      <div><b>${r0(t.protein)}g</b><span>protein</span></div>
      <div><b>${r0(t.carbs)}g</b><span>carbs</span></div>
      <div><b>${r0(t.fat)}g</b><span>fat</span></div>
    </div>

    <h3>Logged today</h3>
    ${(meals ?? []).length
      ? `<div class="card"><ul class="list">${meals.map((m) => `
          <li><button class="row" data-meal="${m.id}">
            <div class="main"><div class="name">${esc(m.name)}${m.servings != 1 ? ` <span class="badge">×${m.servings}</span>` : ""}</div>
            <div class="meta">${timeFmt.format(new Date(m.eaten_at))} · ${macroLine(m.nutrients)}</div></div>
            <div class="end">${feelBadge(m)}</div>
          </button></li>`).join("")}</ul></div>`
      : `<p class="empty">Nothing logged yet today.</p>`}
  `;
  $("#snap").addEventListener("click", () => $("#camera").click());
  $("#type").addEventListener("click", openTextLog);
  $("#scan").addEventListener("click", openScanner);
  $("#to-foods").addEventListener("click", () => go("foods"));
  bindCheckins(app, () => renderToday());
  app.querySelectorAll("[data-meal]").forEach((b) => b.addEventListener("click", () => openMeal(b.dataset.meal)));
  showInstallBar();

  if (highlightId) {
    const card = app.querySelector(`[data-checkin="${highlightId}"]`);
    if (card) { card.scrollIntoView({ block: "center" }); card.classList.add("flash"); }
    else openMeal(highlightId);
  }
}

const feelLabel = (list, v) => list.find(([k]) => k === v)?.[1] ?? "";
function feelBadge(m) {
  const bits = [m.energy && feelLabel(ENERGY, m.energy), m.stomach && feelLabel(STOMACH, m.stomach)].filter(Boolean);
  return bits.length ? bits.join(" · ") : "";
}

function checkinCard(m) {
  const chips = (field, list) => list.map(([k, label]) =>
    `<button class="chip" data-field="${field}" data-val="${k}" aria-pressed="${m[field] === k}">${label}</button>`).join("");
  return `
    <div class="card checkin" data-checkin="${m.id}">
      <div class="name" style="font-weight:600">${esc(m.name)}</div>
      <div class="small muted">Eaten ${when(m.eaten_at)}</div>
      <div class="q">Energy</div><div class="chips">${chips("energy", ENERGY)}</div>
      <div class="q">Stomach</div><div class="chips">${chips("stomach", STOMACH)}</div>
    </div>`;
}

function bindCheckins(root, onDone) {
  root.querySelectorAll("[data-checkin]").forEach((card) => {
    card.addEventListener("click", async (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const id = card.dataset.checkin;
      const field = chip.dataset.field;
      card.querySelectorAll(`.chip[data-field="${field}"]`).forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      const done = card.querySelector('.chip[data-field="energy"][aria-pressed="true"]') && card.querySelector('.chip[data-field="stomach"][aria-pressed="true"]');
      const patch = { [field]: chip.dataset.val };
      if (done) patch.checked_in_at = new Date().toISOString();
      const { error } = await db.from("meals").update(patch).eq("id", id);
      if (error) return toast(error.message);
      if (done) { toast("Got it, thanks"); setTimeout(onDone, 500); }
    });
  });
}

async function openMeal(id) {
  const { data: m } = await db.from("meals").select("*").eq("id", id).single();
  if (!m) return;
  const n = m.nutrients;
  const body = openSheet(`
    <h2>${esc(m.name)}</h2>
    <p class="muted small">${when(m.eaten_at)}${m.servings != 1 ? ` · ×${m.servings}` : ""}</p>
    <div class="card totals">
      <div><b>${r0(n.kcal)}</b><span>calories</span></div>
      <div><b>${r0(n.protein)}g</b><span>protein</span></div>
      <div><b>${r0(n.carbs)}g</b><span>carbs</span></div>
      <div><b>${r0(n.fat)}g</b><span>fat</span></div>
    </div>
    <p class="small muted">Saturated fat ${r0(n.sat_fat)}g · fiber ${r0(n.fiber)}g · sodium ${r0(n.sodium)}mg</p>
    ${checkinCard(m)}
    <button class="btn danger block" id="del">Delete this entry</button>`);
  bindCheckins(body, () => { closeSheet(); go(tab); });
  $("#del", body).addEventListener("click", async () => {
    await db.from("meals").delete().eq("id", id);
    closeSheet();
    toast("Deleted");
    go(tab);
  });
}

// ---------------------------------------------------------------------------
// Logging: photo or text -> review -> save to foods + log meal
// ---------------------------------------------------------------------------
for (const id of ["camera", "gallery"]) {
  $(`#${id}`).addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const img = await loadImage(file);
      const full = toJpeg(img, 1024, 0.8);
      const thumb = squareThumb(img);
      const barcode = pendingBarcode;
      pendingBarcode = null;
      analyze({ image: full.split(",")[1], mediaType: "image/jpeg" }, { thumb, source: barcode ? "barcode" : "photo", preview: full, barcode });
    } catch {
      toast("Couldn't read that photo");
    }
  });
}

function openTextLog() {
  const body = openSheet(`
    <h2>What are you eating?</h2>
    <form id="tf">
      <label class="field"><span>Describe it the way you'd say it</span>
        <textarea class="input" id="tx" rows="3" placeholder="e.g. chicken burrito bowl with rice, beans and guac"></textarea></label>
      <button class="btn primary block">Look it up</button>
    </form>
    <p class="small muted" style="margin-top:10px">Prefer a photo? <button class="link" id="pick">Choose from gallery</button></p>`);
  $("#tx", body).focus();
  $("#pick", body).addEventListener("click", () => $("#gallery").click());
  $("#tf", body).addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#tx", body).value.trim();
    if (text) analyze({ text }, { source: "text" });
  });
}

// ---------------------------------------------------------------------------
// Barcode scanning (camera + Chrome's built-in barcode reader, Open Food Facts lookup)
// ---------------------------------------------------------------------------
let scanStream = null;
let scanTimer = null;
function stopScanner() {
  clearTimeout(scanTimer);
  scanTimer = null;
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
}

async function openScanner() {
  const supported = "BarcodeDetector" in window;
  const body = openSheet(`
    <h2>Scan a barcode</h2>
    ${supported ? `<div class="scan-box"><video id="cam" playsinline muted></video><div class="scan-line"></div></div>
      <p class="small muted" style="text-align:center">Hold the barcode inside the box.</p>` :
      `<p class="small muted">This browser can't read barcodes from the camera. Type the number under the barcode instead.</p>`}
    <form id="bf" style="display:flex;gap:8px;margin-top:8px">
      <input class="input" id="bc" inputmode="numeric" placeholder="Or type the barcode number" autocomplete="off">
      <button class="btn primary">Look up</button>
    </form>`);
  $("#bf", body).addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("#bc", body).value.replace(/\D/g, "");
    if (code.length >= 6) handleBarcode(code);
  });
  if (!supported) return;

  try {
    const formats = (await BarcodeDetector.getSupportedFormats()).filter((f) => ["ean_13", "ean_8", "upc_a", "upc_e"].includes(f));
    const detector = new BarcodeDetector({ formats: formats.length ? formats : undefined });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
    const video = $("#cam", body);
    video.srcObject = scanStream;
    await video.play();
    const tick = async () => {
      if (!scanStream) return;
      try {
        const codes = await detector.detect(video);
        const hit = codes.find((c) => /^\d{6,14}$/.test(c.rawValue));
        if (hit) {
          navigator.vibrate?.(60);
          return handleBarcode(hit.rawValue);
        }
      } catch {}
      scanTimer = setTimeout(tick, 200);
    };
    tick();
  } catch (err) {
    stopScanner();
    const box = $(".scan-box", body);
    if (box) box.outerHTML = `<p class="small muted">Couldn't open the camera${err?.name === "NotAllowedError" ? " (permission was blocked)" : ""}. You can type the number instead.</p>`;
  }
}

async function handleBarcode(code) {
  stopScanner();
  // Already in My foods? Then it's one tap.
  const { data: known } = await db.from("foods").select("*").eq("barcode", code).limit(1);
  if (known?.length) return openFood(known[0]);

  openSheet(`<div class="spinner"></div><p class="muted" style="text-align:center">Looking up ${esc(code)}…</p>`);
  try {
    const result = await api("barcode", { code });
    if (result.error) {
      const body = openSheet(`
        <h2>${result.error === "no_nutrition" ? "No nutrition info for that one" : "Not in the database yet"}</h2>
        <p class="muted">Snap the Nutrition Facts label instead and I'll read the numbers off it.</p>
        <button class="btn primary block" id="lbl">Snap the label</button>
        <button class="btn ghost block" id="again" style="margin-top:8px">Scan again</button>`);
      $("#lbl", body).addEventListener("click", () => { pendingBarcode = code; $("#camera").click(); });
      $("#again", body).addEventListener("click", openScanner);
      return;
    }
    review(result, { source: "barcode", barcode: code, thumb: result.image ?? null });
  } catch (err) {
    const body = openSheet(`<h2>That didn't work</h2><p class="muted small">${esc(err.message)}</p>
      <button class="btn primary block" id="retry">Try again</button>`);
    $("#retry", body).addEventListener("click", () => handleBarcode(code));
  }
}
// When a barcode isn't found and you snap the label, remember the code so the next scan is instant.
let pendingBarcode = null;

async function analyze(payload, meta) {
  openSheet(`
    ${meta.preview ? `<img class="preview" src="${meta.preview}" alt="">` : ""}
    <div class="spinner"></div>
    <p class="muted" style="text-align:center">Looking at your food…</p>`);
  try {
    const result = await api("analyze", payload);
    if (result.error === "no_food") {
      openSheet(`<h2>No food found</h2><p class="muted">I couldn't spot any food there. Try another photo, or type it instead.</p>
        <button class="btn primary block" data-close>OK</button>`);
      return;
    }
    review(result, meta);
  } catch (err) {
    const body = openSheet(`<h2>That didn't work</h2><p class="muted small">${esc(err.message)}</p>
      <button class="btn primary block" id="retry">Try again</button>`);
    $("#retry", body).addEventListener("click", () => analyze(payload, meta));
  }
}

function review(result, meta) {
  const items = result.items.map((it) => ({ ...it }));
  let servings = 1;
  const body = openSheet(`
    ${meta.preview ? `<img class="preview" src="${meta.preview}" alt="">` : ""}
    <label class="field"><span>Name</span><input class="input" id="nm" value="${esc(result.name)}"></label>
    <h3>What's in it <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· edit grams if the portion looks off</span></h3>
    <div class="card" id="items"></div>
    ${result.note ? `<p class="small muted">${esc(result.note)}</p>` : ""}
    <div class="field"><span class="muted small">Servings</span>
      <div class="seg" id="sv">${[0.5, 1, 1.5, 2].map((v) => `<button data-v="${v}" aria-pressed="${v === 1}">${v === 0.5 ? "½" : v === 1.5 ? "1½" : v}</button>`).join("")}</div></div>
    <label class="field"><span>When</span><input class="input" id="at" type="datetime-local" value="${localInputValue()}"></label>
    <div class="card totals" id="tot"></div>
    <button class="btn primary block" id="save">Save & log it</button>
    <p class="small muted" style="text-align:center;margin-top:8px">It'll be saved to My foods for one-tap logging next time.</p>`);

  const draw = () => {
    $("#items", body).innerHTML = items.length
      ? items.map((it, i) => `
        <div class="item">
          <div><div class="nm">${esc(it.name)}${it.source === "estimate" ? '<span class="badge">estimate</span>' : it.source === "label" ? '<span class="badge">label</span>' : ""}</div>
            <div class="pt">${esc(it.portion)} · ${r0(it.nutrients.kcal)} cal</div></div>
          <label><input class="input" type="number" inputmode="numeric" min="1" data-i="${i}" value="${it.grams}"> <span class="small muted">g</span></label>
          <button class="x" data-rm="${i}" aria-label="Remove">×</button>
        </div>`).join("")
      : `<p class="muted small">No items left.</p>`;
    const t = scale(sumNutrients(items.map((i) => i.nutrients)), servings);
    $("#tot", body).innerHTML = `
      <div><b>${r0(t.kcal)}</b><span>calories</span></div>
      <div><b>${r0(t.protein)}g</b><span>protein</span></div>
      <div><b>${r0(t.carbs)}g</b><span>carbs</span></div>
      <div><b>${r0(t.fat)}g</b><span>fat</span></div>`;
  };
  draw();

  $("#items", body).addEventListener("change", (e) => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    const g = Math.max(1, Number(e.target.value) || 1);
    const it = items[i];
    it.grams = g;
    it.nutrients = Object.fromEntries(KEYS.map((k) => [k, (it.per_gram?.[k] ?? 0) * g]));
    draw();
  });
  $("#items", body).addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (!rm) return;
    items.splice(Number(rm.dataset.rm), 1);
    draw();
  });
  $("#sv", body).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    servings = Number(b.dataset.v);
    $("#sv", body).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  });

  $("#save", body).addEventListener("click", async () => {
    if (!items.length) return toast("Nothing to save");
    $("#save", body).disabled = true;
    const perServing = sumNutrients(items.map((i) => i.nutrients));
    const name = $("#nm", body).value.trim() || result.name;
    const { data: food, error } = await db.from("foods").insert({
      name,
      portion_label: items.map((i) => i.portion).join(", "),
      components: items.map(({ name, portion, grams, nutrients, per_gram, source }) => ({ name, portion, grams, nutrients, per_gram, source })),
      nutrients: perServing,
      tags: result.tags ?? [],
      thumb: meta.thumb ?? null,
      source: meta.source,
      barcode: meta.barcode ?? null,
    }).select().single();
    if (error) { $("#save", body).disabled = false; return toast(error.message); }
    await logFood(food, servings, new Date($("#at", body).value || Date.now()));
  });
}

async function logFood(food, servings, eatenAt) {
  const { error } = await db.from("meals").insert({
    food_id: food.id,
    name: food.name,
    servings,
    nutrients: scale(food.nutrients, servings),
    tags: food.tags ?? [],
    eaten_at: eatenAt.toISOString(),
  });
  if (error) return toast(error.message);
  await db.from("foods").update({ times_logged: (food.times_logged ?? 0) + 1, last_logged_at: new Date().toISOString() }).eq("id", food.id);
  closeSheet();
  const due = new Date(eatenAt.getTime() + 2 * 3600e3);
  toast(due > new Date() ? `Logged. I'll check in around ${timeFmt.format(due)}.` : "Logged");
  go("today");
}

// ---------------------------------------------------------------------------
// My foods
// ---------------------------------------------------------------------------
async function renderFoods() {
  $("#sub").textContent = "Tap something to log it again";
  const { data: foods } = await db.from("foods").select("id,name,nutrients,thumb,times_logged,last_logged_at,tags,portion_label")
    .order("last_logged_at", { ascending: false, nullsFirst: false });
  const list = foods ?? [];
  app.innerHTML = list.length
    ? `<label class="search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm5-2 4 4"/></svg>
        <input id="q" type="search" placeholder="Search my foods" autocomplete="off"></label>
       <div class="card"><ul class="list" id="fl"></ul></div>`
    : `<p class="empty">Your foods list fills up as you log.<br>Snap or type your first meal on the Today tab.</p>`;
  if (!list.length) return;

  const draw = (q = "") => {
    const ql = q.toLowerCase();
    const shown = list.filter((f) => f.name.toLowerCase().includes(ql));
    $("#fl").innerHTML = shown.map((f) => `
      <li><button class="row" data-food="${f.id}">
        <div class="thumb" ${f.thumb ? `style="background-image:url('${f.thumb}')"` : ""}>${f.thumb ? "" : "🍽"}</div>
        <div class="main"><div class="name">${esc(f.name)}</div><div class="meta">${macroLine(f.nutrients)}</div></div>
        <div class="end">${f.times_logged ? `×${f.times_logged}` : ""}</div>
      </button></li>`).join("") || `<p class="muted small">No matches.</p>`;
  };
  draw();
  $("#q").addEventListener("input", (e) => draw(e.target.value));
  $("#fl").addEventListener("click", (e) => {
    const b = e.target.closest("[data-food]");
    if (b) openFood(list.find((f) => f.id === b.dataset.food));
  });
}

function openFood(food) {
  let servings = 1;
  const body = openSheet(`
    <h2>${esc(food.name)}</h2>
    <p class="muted small">${esc(food.portion_label || "")}</p>
    <div class="field"><span class="muted small">Servings</span>
      <div class="seg" id="sv">${[0.5, 1, 1.5, 2].map((v) => `<button data-v="${v}" aria-pressed="${v === 1}">${v === 0.5 ? "½" : v === 1.5 ? "1½" : v}</button>`).join("")}</div></div>
    <label class="field"><span>When</span><input class="input" id="at" type="datetime-local" value="${localInputValue()}"></label>
    <div class="card totals" id="tot"></div>
    <button class="btn primary block" id="log">Log it</button>
    <button class="btn danger block" id="rm" style="margin-top:10px">Remove from My foods</button>`);
  const draw = () => {
    const t = scale(food.nutrients, servings);
    $("#tot", body).innerHTML = `
      <div><b>${r0(t.kcal)}</b><span>calories</span></div><div><b>${r0(t.protein)}g</b><span>protein</span></div>
      <div><b>${r0(t.carbs)}g</b><span>carbs</span></div><div><b>${r0(t.fat)}g</b><span>fat</span></div>`;
  };
  draw();
  $("#sv", body).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    servings = Number(b.dataset.v);
    $("#sv", body).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    draw();
  });
  $("#log", body).addEventListener("click", () => logFood(food, servings, new Date($("#at", body).value || Date.now())));
  $("#rm", body).addEventListener("click", async () => {
    await db.from("foods").delete().eq("id", food.id);
    closeSheet();
    toast("Removed");
    renderFoods();
  });
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------
async function renderInsights() {
  $("#sub").textContent = "Weekly summaries and patterns";
  const since = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
  const [{ data: obs }, { data: week }] = await Promise.all([
    db.from("observations").select("id,kind,title,short,created_at,read_at").order("created_at", { ascending: false }).limit(50),
    db.from("meals").select("name,nutrients,eaten_at").gte("eaten_at", since),
  ]);
  const meals = week ?? [];
  const days = new Set(meals.map((m) => new Date(m.eaten_at).toDateString())).size || 1;
  const t = sumNutrients(meals.map((m) => m.nutrients));
  const sat = new Map();
  for (const m of meals) sat.set(m.name, (sat.get(m.name) ?? 0) + (Number(m.nutrients?.sat_fat) || 0));
  const topSat = [...sat.entries()].sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 1).slice(0, 3);

  app.innerHTML = `
    <h3>Last 7 days, per logged day</h3>
    ${meals.length ? `
      <div class="card totals">
        <div><b>${r0(t.kcal / days)}</b><span>calories</span></div>
        <div><b>${r0(t.protein / days)}g</b><span>protein</span></div>
        <div><b>${r0(t.carbs / days)}g</b><span>carbs</span></div>
        <div><b>${r0(t.fat / days)}g</b><span>fat</span></div>
      </div>
      ${topSat.length ? `<p class="small muted">Most saturated fat: ${topSat.map(([n, v]) => `${esc(n)} (${r0(v)}g)`).join(", ")}</p>` : ""}
      <button class="btn ghost block" id="gen">Write my summary now</button>` : `<p class="empty">Log a few meals and this fills in.</p>`}

    <h3>Summaries & patterns</h3>
    ${(obs ?? []).length ? (obs).map((o) => `
      <button class="card obs row ${o.read_at ? "" : "unread"}" data-obs="${o.id}" style="display:block">
        <div class="when">${o.kind === "weekly" ? "Weekly summary" : "Pattern"} · ${dayFmt.format(new Date(o.created_at))}</div>
        <div class="title">${esc(o.title)}</div>
        <div class="small muted">${esc(o.short)}</div>
      </button>`).join("")
    : `<p class="empty">Your first weekly summary arrives Sunday morning. Patterns show up once something repeats a few times in your check-ins.</p>`}
  `;
  $("#gen")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Writing…";
    try {
      const r = await api("weekly_now");
      if (r.id) openObservation(r.id);
      else toast("Not enough logged yet");
    } catch (err) { toast(err.message); }
    renderInsights();
  });
  app.querySelectorAll("[data-obs]").forEach((b) => b.addEventListener("click", () => openObservation(b.dataset.obs)));
  refreshDot();
}

async function openObservation(id) {
  const { data: o } = await db.from("observations").select("*").eq("id", id).single();
  if (!o) return;
  if (!o.read_at) { await db.from("observations").update({ read_at: new Date().toISOString() }).eq("id", id); refreshDot(); }
  const b = o.body || {};
  const list = (v) => Array.isArray(v) ? `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p>${esc(v)}</p>`;
  let html = `<div class="detail"><p class="muted small">${o.kind === "weekly" ? "Weekly summary" : "Pattern spotted"} · ${dayFmt.format(new Date(o.created_at))}</p><h2>${esc(o.title)}</h2>`;
  if (o.kind === "weekly") {
    html += `
      <h3>What you're eating</h3>${list(b.eating)}
      <h3>What's pushing cholesterol up</h3>${list(b.cholesterol_up)}
      <h3>What to have less of</h3>${list(b.less_of)}
      ${b.feelings ? `<h3>How you felt</h3>${list(b.feelings)}` : ""}
      ${b.weight ? `<h3>Weight</h3>${list(b.weight)}` : ""}
      ${b.stats ? `<p class="small muted" style="margin-top:18px">${b.stats.meals} meals over ${b.stats.days} days · about ${b.stats.per_day?.kcal ?? "?"} cal and ${b.stats.per_day?.protein ?? "?"}g protein a day · saturated fat ≈ ${b.stats.sat_pct}% of calories</p>` : ""}`;
  } else {
    html += `
      <h3>The pattern</h3><p>${esc(b.pattern)}${b.stat ? ` <span class="muted">(${esc(b.stat)})</span>` : ""}</p>
      <h3>The evidence</h3><ul class="evidence">${(o.evidence || []).map((e) => `<li>${esc(e.when)}: ${esc(e.name)} — energy ${esc(e.energy ? feelLabel(ENERGY, e.energy) : "–")}, stomach ${esc(e.stomach ? feelLabel(STOMACH, e.stomach) : "–")}</li>`).join("")}</ul>
      <h3>Likely why</h3><p>${esc(b.why)}</p>
      <h3>What to watch</h3><p>${esc(b.watch)}</p>`;
  }
  html += `</div>`;
  openSheet(html);
}

async function refreshDot() {
  const { count } = await db.from("observations").select("id", { count: "exact", head: true }).is("read_at", null);
  $('#tabs [data-tab="insights"] .dot').hidden = !count;
}

// ---------------------------------------------------------------------------
// You: notifications, weight, labs
// ---------------------------------------------------------------------------
async function renderYou() {
  $("#sub").textContent = user?.email ?? "";
  const [{ data: weights }, { data: labs }] = await Promise.all([
    db.from("weights").select("*").order("measured_at", { ascending: false }).limit(8),
    db.from("labs").select("*").order("taken_on", { ascending: false }).limit(10),
  ]);
  const pushState = await pushStatus();

  app.innerHTML = `
    <h3>Notifications</h3>
    <div class="card">
      <p class="small" style="margin-top:0">Check-ins about 2 hours after you eat (not between 10pm and 8am), patterns when they show up, and your Sunday summary.</p>
      ${pushState === "unsupported" ? `<p class="small muted">This browser can't receive notifications. Install the app to your home screen from Chrome first.</p>`
        : pushState === "denied" ? `<p class="small muted">Notifications are blocked. Allow them in your browser's site settings for this app.</p>`
        : pushState === "on" ? `<p class="small" style="color:var(--good)">On for this device.</p><button class="btn ghost block" id="test">Send a test</button>`
        : `<button class="btn primary block" id="push">Turn on notifications</button>`}
    </div>

    <h3>Weight <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· optional</span></h3>
    <div class="card">
      <form id="wf" style="display:flex;gap:8px">
        <input class="input" id="wt" type="number" inputmode="decimal" step="0.1" placeholder="lb" required>
        <button class="btn primary">Log</button>
      </form>
      ${(weights ?? []).length ? `<ul class="list" style="margin-top:8px">${weights.map((w) => `<li class="row" style="cursor:default"><div class="main">${w.weight_lb} lb</div><div class="end">${dayFmt.format(new Date(w.measured_at))}</div></li>`).join("")}</ul>` : ""}
    </div>

    <h3>Lab results</h3>
    <div class="card">
      <form id="lf">
        <label class="field"><span>Test date</span><input class="input" id="ld" type="date" required value="${new Date().toISOString().slice(0, 10)}"></label>
        <div class="grid4">
          <label class="field"><span>LDL</span><input class="input" id="l-ldl" type="number" inputmode="numeric"></label>
          <label class="field"><span>HDL</span><input class="input" id="l-hdl" type="number" inputmode="numeric"></label>
          <label class="field"><span>Trig.</span><input class="input" id="l-tg" type="number" inputmode="numeric"></label>
          <label class="field"><span>Total</span><input class="input" id="l-tc" type="number" inputmode="numeric"></label>
        </div>
        <button class="btn primary block">Save results</button>
      </form>
      ${(labs ?? []).length ? `<ul class="list" style="margin-top:10px">${labs.map((l) => `
        <li class="row" style="cursor:default"><div class="main"><div class="name">LDL ${l.ldl ?? "–"} · HDL ${l.hdl ?? "–"}</div>
        <div class="meta">Triglycerides ${l.triglycerides ?? "–"} · total ${l.total_chol ?? "–"}</div></div>
        <div class="end">${dayFmt.format(new Date(l.taken_on + "T12:00"))}</div></li>`).join("")}</ul>` : ""}
    </div>

    <button class="btn ghost block" id="out" style="margin-top:18px">Sign out</button>
  `;
  $("#push")?.addEventListener("click", enablePush);
  $("#test")?.addEventListener("click", async () => {
    try { const r = await api("test_push"); toast(r.sent ? "Sent. It should pop up in a moment." : "No devices subscribed yet"); }
    catch (e) { toast(e.message); }
  });
  $("#wf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await db.from("weights").insert({ weight_lb: Number($("#wt").value) });
    if (error) return toast(error.message);
    toast("Weight logged");
    renderYou();
  });
  $("#lf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (id) => ($(id).value === "" ? null : Number($(id).value));
    const row = { taken_on: $("#ld").value, ldl: v("#l-ldl"), hdl: v("#l-hdl"), triglycerides: v("#l-tg"), total_chol: v("#l-tc") };
    if ([row.ldl, row.hdl, row.triglycerides, row.total_chol].every((x) => x === null)) return toast("Enter at least one number");
    const { error } = await db.from("labs").insert(row);
    if (error) return toast(error.message);
    toast("Results saved");
    renderYou();
  });
  $("#out").addEventListener("click", () => db.auth.signOut());
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
function b64ToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
async function pushStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? "on" : "off";
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications not allowed"); return renderYou(); }
    const { publicKey } = await api("vapid");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    const j = sub.toJSON();
    const { error } = await db.from("push_subscriptions").upsert(
      { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
      { onConflict: "endpoint" },
    );
    if (error) throw error;
    toast("Notifications are on");
  } catch (e) {
    toast(e.message || "Couldn't turn on notifications");
  }
  renderYou();
}

// ---------------------------------------------------------------------------
// Install prompt (Android Chrome)
// ---------------------------------------------------------------------------
let deferredInstall = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; showInstallBar(); });
function showInstallBar() {
  const slot = $("#install-slot");
  if (!slot || !deferredInstall || standalone()) return;
  try { if (localStorage.getItem("psh-install-x")) return; } catch {}
  slot.innerHTML = `<div class="install-bar"><span><b>Install PS Health</b>Logging and check-ins from your home screen</span>
    <button class="btn primary" id="inst">Install</button><button class="x" id="inst-x" aria-label="Not now">×</button></div>`;
  $("#inst").addEventListener("click", async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; slot.innerHTML = ""; });
  $("#inst-x").addEventListener("click", () => { try { localStorage.setItem("psh-install-x", "1"); } catch {} slot.innerHTML = ""; });
}

// ---------------------------------------------------------------------------
// Deep links from notifications: #checkin=<meal id>, #obs=<observation id>
// ---------------------------------------------------------------------------
async function handleHash() {
  const h = location.hash.slice(1);
  if (!h || !user || !/^(checkin|obs)=/.test(h)) return false;
  history.replaceState(null, "", location.pathname + location.search);
  const [k, v] = h.split("=");
  if (k === "checkin" && v) { tab = "today"; markTab(); await renderToday(v); return true; }
  if (k === "obs" && v) { tab = "insights"; markTab(); await renderInsights(); openObservation(v); return true; }
  return false;
}
function markTab() {
  for (const b of document.querySelectorAll("#tabs button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", handleHash);
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open" && e.data.url) { location.hash = new URL(e.data.url, location.href).hash; }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function enter(session) {
  user = session?.user ?? null;
  if (!user) return renderSignIn();
  const { data: owner, error } = await db.rpc("claim_owner");
  if (error || !owner) {
    $("#tabs").hidden = true;
    app.innerHTML = `<p class="empty">This PS Health belongs to someone else.</p><button class="btn ghost block" id="out">Sign out</button>`;
    $("#out").addEventListener("click", () => db.auth.signOut());
    return;
  }
  $("#tabs").hidden = false;
  if (!(await handleHash())) await go(tab);
  refreshDot();
}

let lastUserId;
db.auth.onAuthStateChange((event, session) => {
  const id = session?.user?.id ?? null;
  if (id === lastUserId && event !== "SIGNED_OUT") return;
  lastUserId = id;
  setTimeout(() => enter(session), 0);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && user && tab === "today" && $("#sheet").hidden) renderToday();
});
