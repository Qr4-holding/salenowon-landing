// Sale Now On — coming-soon landing page + sign-up capture.
// Env: DATABASE_URL, ADMIN_USER, ADMIN_PASSWORD, CONTACT_EMAIL, CONTROLLER, PORT (3000)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = +process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const CONTACT = process.env.CONTACT_EMAIL || "hello@salenowon.co.uk";
const CONTROLLER = process.env.CONTROLLER || "Sale Now On";
const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

async function migrate() {
  if (!db) return console.warn("No DATABASE_URL: sign-ups will not be stored");
  for (let i = 0; i < 20; i++) {
    try {
      await db.query(`
        create table if not exists alert_signups (
          id serial primary key, email text not null unique, categories text[] not null default '{}',
          consent_text text not null, ip_hash text, user_agent text,
          created_at timestamptz not null default now(), unsubscribed_at timestamptz);
        create table if not exists early_access (
          id serial primary key, business text not null, site text, kind text, categories text[] not null default '{}',
          other text, name text not null, email text not null, ip_hash text,
          created_at timestamptz not null default now());
        create table if not exists intake (
          id serial primary key, campaign text not null, host text, page_url text, page_title text,
          products jsonb not null, count int not null, created_at timestamptz not null default now());
        create table if not exists links (
          code text primary key, target text not null, fallback text not null default '/', starts_at timestamptz, ends_at timestamptz,
          note text, scans int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
      return console.log("db ready");
    } catch (e) { console.log("waiting for db…", e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".txt": "text/plain" };
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" };

function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, { "Content-Type": type, ...SEC, ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found", "text/plain");
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    const cache = /\.(mp4|jpg|png|svg)$/.test(file) ? "public, max-age=86400" : "no-cache";
    if (file.endsWith("privacy.html")) {
      const html = fs.readFileSync(file, "utf8").replaceAll("{{CONTACT_EMAIL}}", esc(CONTACT)).replaceAll("{{CONTROLLER}}", esc(CONTROLLER));
      return send(res, 200, html, type, { "Cache-Control": cache });
    }
    const range = req.headers.range;
    if (range && type === "video/mp4") {        // Safari needs byte ranges for video
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...SEC, "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache,
        "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...SEC, "Content-Type": type, "Content-Length": st.size, "Cache-Control": cache, "Accept-Ranges": "bytes" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const cats = a => Array.isArray(a) ? a.slice(0, 20).map(c => clean(c, 40)).filter(Boolean) : [];
const ipOf = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const ipHash = ip => crypto.createHash("sha256").update("sno:" + ip).digest("hex").slice(0, 16);

// simple per-IP rate limit: 8 posts / 10 min
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 600000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 8;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ""; req.on("data", c => { data += c; if (data.length > 20000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("bad json")); } });
  });
}

const CONSENT = "By signing up you agree to a weekly sales email from Sale Now On. Unsubscribe any time.";

async function api(req, res, route) {
  const ip = ipOf(req);
  if (limited(ip)) return send(res, 429, { error: "Too many tries. Please wait a few minutes." });
  let b; try { b = await readJson(req); } catch { return send(res, 400, { error: "Something went wrong. Please try again." }); }
  if (b.website) return send(res, 200, { ok: true });            // honeypot: pretend success
  if (!db) return send(res, 503, { error: "Sign-ups open shortly. Please try again later." });
  const email = clean(b.email, 254).toLowerCase();
  if (!okEmail(email)) return send(res, 400, { error: "Please enter a valid email address." });
  try {
    if (route === "alerts") {
      await db.query(`insert into alert_signups (email, categories, consent_text, ip_hash, user_agent) values ($1,$2,$3,$4,$5)
        on conflict (email) do update set categories = excluded.categories, unsubscribed_at = null`,
        [email, cats(b.categories), CONSENT, ipHash(ip), clean(req.headers["user-agent"], 300)]);
    } else {
      const business = clean(b.business, 160), name = clean(b.name, 120);
      if (!business || !name) return send(res, 400, { error: "Please add your business name and your name." });
      await db.query(`insert into early_access (business, site, kind, categories, other, name, email, ip_hash) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [business, clean(b.site, 200), clean(b.kind, 20), cats(b.categories), clean(b.other, 200), name, email, ipHash(ip)]);
    }
    send(res, 200, { ok: true });
  } catch (e) { console.error(e); send(res, 500, { error: "Something went wrong. Please try again." }); }
}

function authed(req) {
  const pw = process.env.ADMIN_PASSWORD; if (!pw) return false;
  const h = req.headers.authorization || ""; if (!h.startsWith("Basic ")) return false;
  const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  const a = Buffer.from(`${u}:${p}`), want = Buffer.from(`${process.env.ADMIN_USER || "admin"}:${pw}`);
  return a.length === want.length && crypto.timingSafeEqual(a, want);
}

const csv = rows => {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const cell = v => { v = Array.isArray(v) ? v.join("; ") : v instanceof Date ? v.toISOString() : String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [keys.join(","), ...rows.map(r => keys.map(k => cell(r[k])).join(","))].join("\n");
};

async function admin(req, res, url) {
  if (!authed(req)) return send(res, 401, "Sign in required", "text/plain", { "WWW-Authenticate": 'Basic realm="Sale Now On admin"' });
  if (!db) return send(res, 503, "No database", "text/plain");
  if (req.method === "POST" && url.pathname === "/admin/delete") {
    const t = { alerts: "alert_signups", early: "early_access", intake: "intake", links: "links" }[url.searchParams.get("t")] || "early_access", id = url.searchParams.get("id");
    if (t === "links") await db.query("delete from links where code = $1", [id]);
    else if (+id) await db.query(`delete from ${t} where id = $1`, [+id]);
    res.writeHead(303, { Location: "/admin" }); return res.end();
  }
  if (req.method === "POST" && url.pathname === "/admin/links") {
    let body = ""; for await (const c of req) { body += c; if (body.length > 20000) break; }
    const err = await saveLink(Object.fromEntries(new URLSearchParams(body)));
    if (err) return send(res, 400, err + ". Go back and try again.", "text/plain; charset=utf-8");
    res.writeHead(303, { Location: "/admin" }); return res.end();
  }
  const im = /^\/admin\/intake\/(\d+)\.json$/.exec(url.pathname);
  if (im) { const r = await db.query("select * from intake where id=$1", [+im[1]]); return send(res, r.rows.length ? 200 : 404, r.rows[0] || { error: "not found" }); }
  if (url.pathname === "/admin/intake.json") { const r = await db.query("select id,campaign,host,page_url,count,created_at from intake order by id desc limit 200"); return send(res, 200, r.rows); }
  let it = [], lk = [];
  const a = (await db.query("select id,email,categories,created_at,unsubscribed_at from alert_signups order by created_at desc")).rows;
  const e = (await db.query("select id,business,site,kind,categories,other,name,email,created_at from early_access order by created_at desc")).rows;
  if (url.pathname === "/admin/alerts.csv") return send(res, 200, csv(a), "text/csv", { "Content-Disposition": "attachment; filename=sales-alerts.csv" });
  if (url.pathname === "/admin/early-access.csv") return send(res, 200, csv(e), "text/csv", { "Content-Disposition": "attachment; filename=early-access.csv" });
  const table = (rows, cols, t) => `<table><tr>${cols.map(c => `<th>${c}</th>`).join("")}<th></th></tr>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(Array.isArray(r[c]) ? r[c].join(", ") : r[c] instanceof Date ? r[c].toISOString().slice(0, 16).replace("T", " ") : r[c])}</td>`).join("")}<td><form method="post" action="/admin/delete?t=${t}&id=${r.id}" onsubmit="return confirm('Delete this entry for good?')"><button style="border:0;background:none;color:#a31c22;cursor:pointer;font:inherit">Delete</button></form></td></tr>`).join("")}</table>`;
  send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>SNO admin</title>
<link rel="stylesheet" href="/style.css"><style>table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0 30px}th,td{border-bottom:1px solid #e2e2e2;padding:7px;text-align:left;vertical-align:top}th{color:#6b6b6b}</style>
<main class="wrap" style="padding-top:24px"><a class="logo" href="/">SALE NOW ON</a> <span class="pill">Admin</span>
<h2 style="margin-top:24px">Pages sent from Chrome · ${(it = (await db.query("select id,campaign,host,count,created_at from intake order by id desc limit 50")).rows).length}</h2>${table(it, ["campaign", "host", "count", "created_at"], "intake")}
<h2 style="margin-top:24px">QR short links · salenowon.co.uk/go/…</h2>${table((lk = (await db.query("select code as id, code, target, fallback, starts_at, ends_at, scans, note from links order by updated_at desc")).rows), ["code", "target", "fallback", "starts_at", "ends_at", "scans", "note"], "links")}
<form method="post" action="/admin/links" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:30px">
<input name="code" placeholder="code e.g. dshirt" required><input name="target" placeholder="send to e.g. /deals/denim" required>
<input name="fallback" placeholder="outside the times: /" ><input name="starts_at" type="datetime-local" title="Starts (optional)"><input name="ends_at" type="datetime-local" title="Ends (optional)">
<input name="note" placeholder="note"><button class="btn">Save link</button></form>
<h2 style="margin-top:24px">SALES ALERTS · ${a.length} <a style="font-size:14px" href="/admin/alerts.csv">Download CSV</a></h2>${table(a, ["email", "categories", "created_at", "unsubscribed_at"], "alerts")}
<h2>Early access · ${e.length} <a style="font-size:14px" href="/admin/early-access.csv">Download CSV</a></h2>${table(e, ["business", "site", "kind", "categories", "other", "name", "email", "created_at"], "early")}</main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
}

// Short links behind QR codes: salenowon.co.uk/go/CODE. Targets are paths on this site only, so a link can never send people elsewhere.
const CODE = /^[a-z0-9-]{2,40}$/;
const sitePath = v => { v = String(v || "").trim(); return /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) && v.length < 300 ? v : null; };
const when = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? undefined : d; };
async function saveLink(b) {
  const code = String(b.code || "").toLowerCase().trim(), target = sitePath(b.target), fallback = sitePath(b.fallback || "/");
  const st = when(b.starts_at), en = when(b.ends_at);
  if (!CODE.test(code)) return "Code: 2 to 40 lowercase letters, numbers or dashes";
  if (!target || !fallback) return "Target and fallback must be paths on salenowon.co.uk, starting with /";
  if (st === undefined || en === undefined) return "Dates not understood";
  await db.query(`insert into links (code,target,fallback,starts_at,ends_at,note) values ($1,$2,$3,$4,$5,$6)
    on conflict (code) do update set target=$2, fallback=$3, starts_at=$4, ends_at=$5, note=$6, updated_at=now()`,
    [code, target, fallback, st, en, clean(b.note, 120)]);
  return null;
}
async function go(res, code) {
  let dest = "/";
  if (db && CODE.test(code)) {
    const r = await db.query("update links set scans = scans + 1 where code=$1 returning target,fallback,starts_at,ends_at", [code]);
    if (r.rows.length) { const l = r.rows[0], now = new Date();
      dest = (!l.starts_at || now >= l.starts_at) && (!l.ends_at || now < l.ends_at) ? l.target : l.fallback; }
  }
  res.writeHead(302, { ...SEC, Location: dest, "Cache-Control": "no-store" }); res.end();
}
async function linksApi(req, res) {
  const key = process.env.INTAKE_KEY;
  if (!key || req.headers["x-sno-key"] !== key) return send(res, 401, { error: "Wrong or missing key" });
  if (!db) return send(res, 503, { error: "No database" });
  if (req.method === "GET") return send(res, 200, (await db.query("select * from links order by updated_at desc")).rows, "application/json", { "Cache-Control": "no-store" });
  let body = ""; for await (const c of req) { body += c; if (body.length > 20000) return send(res, 413, { error: "Too much data" }); }
  let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: "Bad data" }); }
  const err = await saveLink(b); send(res, err ? 400 : 200, err ? { error: err } : { ok: true, url: "https://salenowon.co.uk/go/" + b.code });
}

async function intake(req, res) {
  const key = process.env.INTAKE_KEY;
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain", CORS);
  if (!key || req.headers["x-sno-key"] !== key) return send(res, 401, { error: "Wrong or missing key. Check the extension's Settings." }, "application/json", CORS);
  if (!db) return send(res, 503, { error: "No database" }, "application/json", CORS);
  if (req.method === "GET") { // read-only feed for the video builder: the public sale listings people sent
    const id = +new URL(req.url, "http://x").searchParams.get("id");
    const r = id ? await db.query("select * from intake where id=$1", [id])
                 : await db.query("select id,campaign,host,page_url,count,created_at from intake order by id desc limit 50");
    return send(res, 200, id ? (r.rows[0] || {}) : r.rows, "application/json", { "Cache-Control": "no-store" });
  }
  let body = "";
  for await (const c of req) { body += c; if (body.length > 2_000_000) return send(res, 413, { error: "Too much data" }, "application/json", CORS); }
  let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: "Bad data" }, "application/json", CORS); }
  const items = (Array.isArray(b.products) ? b.products : []).slice(0, 300).map(p => ({
    name: clean(p.name, 160), was: +p.was || 0, now: +p.now || 0, cur: clean(p.cur, 3), off: Math.round(+p.off || 0),
    url: clean(p.url, 600), image: clean(p.image, 800) })).filter(p => p.name && p.now > 0 && p.was > p.now);
  if (!items.length) return send(res, 400, { error: "No products in that page" }, "application/json", CORS);
  const r = await db.query("insert into intake (campaign, host, page_url, page_title, products, count) values ($1,$2,$3,$4,$5,$6) returning id",
    [clean(b.campaign, 60), clean(b.host, 120), clean(b.page_url, 800), clean(b.page_title, 200), JSON.stringify(items), items.length]);
  send(res, 200, { ok: true, id: r.rows[0].id, count: items.length }, "application/json", CORS);
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-SNO-Key", "Access-Control-Allow-Methods": "POST, OPTIONS" };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/intake") return intake(req, res);
    if (url.pathname === "/api/links") return linksApi(req, res);
    const gm = /^\/go\/([^/]+)\/?$/.exec(url.pathname);
    if (gm) return go(res, decodeURIComponent(gm[1]).toLowerCase());
    if (req.method === "POST" && url.pathname === "/api/alerts") return api(req, res, "alerts");
    if (req.method === "POST" && url.pathname === "/api/early-access") return api(req, res, "early");
    if (url.pathname === "/health") return send(res, 200, { ok: true, db: !!db });
    if (url.pathname.startsWith("/admin")) return admin(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    if (p === "/privacy") p = "/privacy.html";
    if (p === "/bot") p = "/bot.html";
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB)) return send(res, 403, "Forbidden", "text/plain");
    serveFile(req, res, file);
  } catch (e) { console.error(e); send(res, 500, "Error", "text/plain"); }
}).listen(PORT, () => console.log("Sale Now On landing on :" + PORT));

migrate();
