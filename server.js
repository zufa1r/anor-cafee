"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 6) {
  console.error("XATO: ADMIN_PASSWORD o'rnatilmagan yoki 6 belgidan qisqa. Xodimlar paroli kerak.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- Maxfiy kalit (QR-kodlar va kirish uchun) ---------- */
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const file = path.join(DATA_DIR, "secret.txt");
  try { return fs.readFileSync(file, "utf8").trim(); }
  catch (e) {
    const s = crypto.randomBytes(24).toString("hex");
    fs.writeFileSync(file, s);
    return s;
  }
}
const SECRET = loadSecret();
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
const tableKey = (t) => hmac("table:" + t).slice(0, 10);
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- Xodimlar kirishi ---------- */
const SESSION_MS = 12 * 3600 * 1000;
function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return exp + "." + hmac("staff:" + exp).slice(0, 32);
}
function cookieOf(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
function isStaff(req) {
  const tok = cookieOf(req, "staff");
  const [exp, sig] = tok.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEq(sig, hmac("staff:" + exp).slice(0, 32));
}
function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  res.status(401).json({ error: "Kirish kerak" });
}
const loginTries = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginTries.get(ip);
  if (!rec || rec.reset < now) { loginTries.set(ip, { n: 1, reset: now + 60000 }); return true; }
  rec.n += 1;
  return rec.n <= 6;
}

/* ---------- Menyu ---------- */
function getMenu() {
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "menu.json"), "utf8"));
  const items = {};
  menu.categories.forEach((c) => c.items.forEach((it, i) => {
    items[c.id + "-" + i] = { n: it.n, p: it.p, dest: c.dest };
  }));
  return { menu, items };
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function renderMenu(menu) {
  let tabs = "", body = "";
  menu.categories.forEach((c) => {
    tabs += `<button class="tab" type="button" data-cat="${esc(c.id)}">${esc(c.name)}</button>`;
    body += `<section class="cat" id="cat-${esc(c.id)}"><h2>${esc(c.name)}</h2><ul class="list">`;
    c.items.forEach((it, i) => {
      const id = c.id + "-" + i;
      body += `<li class="item" data-id="${esc(id)}" data-name="${esc(it.n)}" data-price="${it.p}" data-dest="${esc(c.dest)}">` +
        `<div class="txt"><span class="nm">${esc(it.n)}</span><span class="ds">${esc(it.d || "")}</span>` +
        `<span class="pr">${fmt(it.p)} so'm</span></div>` +
        `<div class="ctl"><button type="button" class="add" data-act="plus">Qo'shish</button>` +
        `<div class="step" hidden><button type="button" data-act="minus" aria-label="Kamaytirish">−</button>` +
        `<span class="q">0</span><button type="button" data-act="plus" aria-label="Ko'paytirish">+</button></div></div></li>`;
    });
    body += "</ul></section>";
  });
  return { tabs, body };
}
function ldJson(menu) {
  const prices = [];
  menu.categories.forEach((c) => c.items.forEach((it) => prices.push(it.p)));
  const data = {
    "@context": "https://schema.org",
    "@type": "CafeOrCoffeeShop",
    name: menu.name,
    servesCuisine: ["Qahva", "Choy", "O'zbek oshxonasi"],
    priceRange: fmt(Math.min(...prices)) + " - " + fmt(Math.max(...prices)) + " UZS",
    address: { "@type": "PostalAddress", streetAddress: "Yunusobod tumani", addressLocality: "Toshkent", addressCountry: "UZ" },
    openingHours: "Mo-Su 08:00-23:00"
  };
  if (BASE_URL) data.url = BASE_URL;
  return '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g, "\\u003c") + "</script>";
}

/* ---------- Buyurtmalar ombori (data/orders.json) ---------- */
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
let orders = [];
try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch (e) { orders = []; }
const KEEP_MS = 14 * 24 * 3600 * 1000;
orders = orders.filter((o) => Date.now() - o.createdAt < KEEP_MS);

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  const tmp = ORDERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(orders));
  fs.renameSync(tmp, ORDERS_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { console.error("Saqlashda xato:", e.message); } }, 200);
}
process.on("SIGTERM", () => { try { saveNow(); } catch (e) {} process.exit(0); });
process.on("SIGINT", () => { try { saveNow(); } catch (e) {} process.exit(0); });

const dayOf = (ts) => new Date(ts + 5 * 3600 * 1000).toISOString().slice(0, 10); // Toshkent vaqti
const NEXT = { new: "cooking", cooking: "ready", ready: "done" };

/* ---------- Ilova ---------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  next();
});

function renderIndex() {
  const { menu } = getMenu();
  const r = renderMenu(menu);
  let html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  html = html.replace("<!--TABS-->", () => r.tabs).replace("<!--MENU-->", () => r.body).replace("<!--LD-->", () => ldJson(menu));
  return html;
}
app.get("/", (req, res) => res.type("html").send(renderIndex()));

app.get("/robots.txt", (req, res) => {
  const base = BASE_URL || req.protocol + "://" + req.get("host");
  res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: " + base + "/sitemap.xml\n");
});
app.get("/sitemap.xml", (req, res) => {
  const base = BASE_URL || req.protocol + "://" + req.get("host");
  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + esc(base) + "/</loc></url></urlset>\n");
});

app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "1h" }));

/* Mijoz API */
app.post("/api/orders", (req, res) => {
  const b = req.body || {};
  const { menu, items } = getMenu();
  const table = String(b.table || "");
  if (!menu.tables.includes(table)) return res.status(400).json({ error: "Noto'g'ri stol raqami." });
  if (!safeEq(String(b.key || ""), tableKey(table))) {
    return res.status(403).json({ error: "QR-kod yaroqsiz. Stoldagi QR-kodni qayta skanerlang." });
  }
  const now = Date.now();
  if (orders.filter((o) => o.table === table && now - o.createdAt < 10 * 60000).length >= 6) {
    return res.status(429).json({ error: "Bu stoldan juda ko'p buyurtma berildi. Ofitsiantni chaqiring." });
  }
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) {
    return res.status(400).json({ error: "Savat bo'sh." });
  }
  const qty = {};
  for (const it of b.items) {
    const id = String(it && it.id);
    const q = Math.floor(Number(it && it.q));
    if (!items[id] || !(q >= 1 && q <= 20)) return res.status(400).json({ error: "Savatda noto'g'ri taom bor." });
    qty[id] = Math.min(20, (qty[id] || 0) + q);
  }
  const lines = [];
  const status = {};
  let total = 0;
  Object.keys(qty).forEach((id) => {
    const it = items[id];
    lines.push({ n: it.n, q: qty[id], p: it.p, dest: it.dest });
    total += qty[id] * it.p;
    status[it.dest] = "new";
  });
  const today = dayOf(now);
  const no = orders.filter((o) => dayOf(o.createdAt) === today).length + 1;
  const order = {
    id: crypto.randomBytes(9).toString("hex"), no, table, items: lines, total,
    note: String(b.note || "").trim().slice(0, 200), createdAt: now, status
  };
  orders.push(order);
  save();
  res.json({ id: order.id, no, total, dests: Object.keys(status) });
});

app.get("/api/orders/:id", (req, res) => {
  const o = orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "Topilmadi" });
  res.json({ no: o.no, table: o.table, total: o.total, status: o.status });
});

/* Xodimlar API */
app.post("/api/login", (req, res) => {
  if (!loginAllowed(req.ip)) return res.status(429).json({ error: "Juda ko'p urinish. Bir daqiqadan keyin qayta urinib ko'ring." });
  const given = crypto.createHash("sha256").update(String((req.body || {}).password || "")).digest("hex");
  const real = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex");
  if (!safeEq(given, real)) return res.status(401).json({ error: "Parol noto'g'ri." });
  res.setHeader("Set-Cookie", "staff=" + encodeURIComponent(makeToken()) + "; Max-Age=" + SESSION_MS / 1000 +
    "; Path=/; HttpOnly; SameSite=Lax" + (req.secure ? "; Secure" : ""));
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "staff=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
  res.json({ ok: true });
});
app.get("/api/staff/orders", requireStaff, (req, res) => {
  const now = Date.now();
  const active = orders
    .filter((o) => now - o.createdAt < 24 * 3600 * 1000 && Object.values(o.status).some((s) => s !== "done"))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ orders: active, now });
});
app.post("/api/staff/orders/:id/status", requireStaff, (req, res) => {
  const o = orders.find((x) => x.id === req.params.id);
  const dest = String((req.body || {}).dest || "");
  if (!o || !o.status[dest]) return res.status(404).json({ error: "Topilmadi" });
  if (NEXT[o.status[dest]] !== (req.body || {}).next) {
    return res.status(409).json({ error: "Holat allaqachon o'zgargan.", status: o.status });
  }
  o.status[dest] = NEXT[o.status[dest]];
  save();
  res.json({ ok: true, status: o.status });
});

/* Sahifalar: xodimlar paneli va QR-kodlar */
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin/qr", async (req, res) => {
  if (!isStaff(req)) return res.redirect("/admin");
  const { menu } = getMenu();
  const base = BASE_URL || req.protocol + "://" + req.get("host");
  let cards = "";
  for (const t of menu.tables) {
    const url = base + "/?stol=" + encodeURIComponent(t) + "&k=" + tableKey(t);
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    cards += `<figure class="qr">${svg}<figcaption><b>Stol ${esc(t)}</b><span>Skanerlang va buyurtma bering</span></figcaption></figure>`;
  }
  res.type("html").send(`<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Stol QR-kodlari</title><link rel="stylesheet" href="/style.css"></head>
<body class="qrpage"><div class="app wide">
<div class="qrtop"><h1>Stol QR-kodlari</h1><button class="ghost" type="button" id="printBtn">Chop etish</button><a class="ghost" href="/admin">Panelga qaytish</a></div>
<p class="eyebrow">Manzil: ${esc(base)}. Har stolga o'z kodini yopishtiring.</p>
<div class="qrgrid">${cards}</div></div><script src="/qr.js"></script></body></html>`);
});

app.listen(PORT, () => {
  console.log("Anor Kafe serveri ishga tushdi: http://localhost:" + PORT);
});
