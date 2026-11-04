// Sale Now On — coming-soon landing page + sign-up capture.
// Env: DATABASE_URL, ADMIN_USER, ADMIN_PASSWORD, CONTACT_EMAIL, CONTROLLER, PORT (3000)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const QRCode = require("qrcode");

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
          note text, scans int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
        create table if not exists events (
          id bigserial primary key, ts timestamptz not null default now(), kind text not null, path text, code text,
          ref text, src text, visitor text, device text);
        create index if not exists events_ts on events (ts);
        delete from events where ts < now() - interval '13 months';`);
      await D.migrate();
      return console.log("db ready");
    } catch (e) { console.log("waiting for db…", e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".txt": "text/plain" };
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

// One-click sign-in from the Chrome extension: the extension's key buys a 2-minute, single-use link; the link sets a 30-day cookie.
const signKey = () => crypto.createHash("sha256").update("sno-admin-session|" + (process.env.ADMIN_PASSWORD || "") + "|" + (process.env.INTAKE_KEY || "")).digest();
const sign = (kind, exp) => crypto.createHmac("sha256", signKey()).update(kind + "." + exp).digest("hex");
const mint = (kind, seconds) => { const exp = Date.now() + seconds * 1000; return exp + "." + sign(kind, exp); };
const valid = (kind, tok) => { const [exp, sig] = String(tok || "").split("."); if (!exp || !sig || +exp < Date.now()) return false;
  const want = Buffer.from(sign(kind, exp)), got = Buffer.from(sig); return want.length === got.length && crypto.timingSafeEqual(want, got); };
const usedLinks = new Set();
const cookieOf = (req, name) => (String(req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "=")) || "").slice(name.length + 1);
function authed(req) {
  if (process.env.ADMIN_PASSWORD && process.env.INTAKE_KEY && valid("session", cookieOf(req, "sno_admin"))) return true;
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
  if (url.pathname === "/admin/login") {
    const t = url.searchParams.get("t");
    if (!process.env.ADMIN_PASSWORD || !process.env.INTAKE_KEY || !valid("link", t) || usedLinks.has(t))
      return send(res, 403, "This sign-in link has expired or was already used. Click Open my dashboard in the Chrome extension again.", "text/plain; charset=utf-8");
    usedLinks.add(t); if (usedLinks.size > 500) usedLinks.clear();
    res.writeHead(303, { ...SEC, Location: "/admin/stats", "Cache-Control": "no-store",
      "Set-Cookie": `sno_admin=${mint("session", 30 * 86400)}; Path=/admin; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax` });
    return res.end();
  }
  if (url.pathname === "/admin/logout") {
    res.writeHead(303, { ...SEC, Location: "/", "Set-Cookie": "sno_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax" }); return res.end();
  }
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
  const qm = /^\/admin\/qr\/([a-z0-9-]{2,40})\.(svg|png)$/.exec(url.pathname);
  if (qm) {
    const link = "https://salenowon.co.uk/go/" + qm[1], opt = { errorCorrectionLevel: "M", margin: 2, color: { dark: "#222222", light: "#ffffff" } };
    const disp = { "Content-Disposition": `attachment; filename=salenowon-qr-${qm[1]}.${qm[2]}` };
    if (qm[2] === "svg") return send(res, 200, await QRCode.toString(link, { ...opt, type: "svg" }), "image/svg+xml", disp);
    return send(res, 200, await QRCode.toBuffer(link, { ...opt, width: 1200 }), "image/png", disp);
  }
  if (url.pathname === "/admin/stats") return stats(res, url);
  if (url.pathname === "/admin/deals") return D.adminDeals(req, res, url);
  const im = /^\/admin\/intake\/(\d+)\.json$/.exec(url.pathname);
  if (im) { const r = await db.query("select * from intake where id=$1", [+im[1]]); return send(res, r.rows.length ? 200 : 404, r.rows[0] || { error: "not found" }); }
  if (url.pathname === "/admin/intake.json") { const r = await db.query("select id,campaign,host,page_url,count,created_at from intake order by id desc limit 200"); return send(res, 200, r.rows); }
  let it = [], lk = [];
  const dl = v => v ? v.toLocaleString("sv-SE", { timeZone: "Europe/London" }).slice(0, 16).replace(" ", "T") : "";
  const linkForm = l => `<h3 id="edit" style="margin:4px 0 8px">${l ? "Change link /go/" + esc(l.code) : "New short link"}</h3>
<p class="small" style="margin:0 0 8px">Times are UK time. Outside the start and end times, a scan goes to the fallback page instead.</p>
<form method="post" action="/admin/links" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:30px">
<label>Code<input name="code" placeholder="e.g. dshirt" required value="${esc(l?.code || "")}" ${l ? "readonly" : ""}></label>
<label>Send people to<input name="target" placeholder="/deals/denim" required value="${esc(l?.target || "")}"></label>
<label>Fallback page<input name="fallback" placeholder="/" value="${esc(l?.fallback || "/")}"></label>
<label>Starts<input name="starts_at" type="datetime-local" value="${dl(l?.starts_at)}"></label>
<label>Ends<input name="ends_at" type="datetime-local" value="${dl(l?.ends_at)}"></label>
<label>Note<input name="note" value="${esc(l?.note || "")}"></label>
<button class="btn" style="align-self:end">Save link</button>${l ? '<a href="/admin#edit" style="align-self:end">Cancel</a>' : ""}</form>`;
  const a = (await db.query("select id,email,categories,created_at,unsubscribed_at from alert_signups order by created_at desc")).rows;
  const e = (await db.query("select id,business,site,kind,categories,other,name,email,created_at from early_access order by created_at desc")).rows;
  if (url.pathname === "/admin/alerts.csv") return send(res, 200, csv(a), "text/csv", { "Content-Disposition": "attachment; filename=sales-alerts.csv" });
  if (url.pathname === "/admin/early-access.csv") return send(res, 200, csv(e), "text/csv", { "Content-Disposition": "attachment; filename=early-access.csv" });
  const cellOf = (c, v) => c === "tools" ? `<a href="/admin?edit=${encodeURIComponent(v)}#edit">Edit</a> · <a href="/admin/qr/${encodeURIComponent(v)}.png">QR png</a> · <a href="/admin/qr/${encodeURIComponent(v)}.svg">svg</a>` : esc(Array.isArray(v) ? v.join(", ") : v instanceof Date ? v.toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" }) : v);
  const table = (rows, cols, t) => `<table><tr>${cols.map(c => `<th>${c}</th>`).join("")}<th></th></tr>${rows.map(r => `<tr>${cols.map(c => `<td>${cellOf(c, r[c])}</td>`).join("")}<td><form method="post" action="/admin/delete?t=${t}&id=${r.id}" onsubmit="return confirm('Delete this entry for good?')"><button style="border:0;background:none;color:#a31c22;cursor:pointer;font:inherit">Delete</button></form></td></tr>`).join("")}</table>`;
  send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>SNO admin</title>
<link rel="stylesheet" href="/style.css"><style>table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0 30px}th,td{border-bottom:1px solid #e2e2e2;padding:7px;text-align:left;vertical-align:top}th{color:#6b6b6b}</style>
<main class="wrap" style="padding-top:24px"><a class="logo" href="/">SALE NOW ON</a> <span class="pill">Admin</span> <a href="/admin/stats" style="margin-left:12px;font-weight:700">Analytics →</a> <a href="/admin/deals" style="margin-left:12px;font-weight:700">Deals →</a> <a href="/admin/logout" style="margin-left:12px;font-size:13px;color:#6b6b6b">Sign out</a>
<h2 style="margin-top:24px">Pages sent from Chrome · ${(it = (await db.query("select id,campaign,host,count,created_at from intake order by id desc limit 50")).rows).length}</h2>${table(it, ["campaign", "host", "count", "created_at"], "intake")}
<h2 style="margin-top:24px">QR short links · salenowon.co.uk/go/…</h2>${(lk = (await db.query("select code as id, code, target, fallback, starts_at, ends_at, scans, note from links order by updated_at desc")).rows, "")}${table(lk.map(l => ({ ...l, tools: l.code })), ["code", "target", "fallback", "starts_at", "ends_at", "scans", "note", "tools"], "links")}
${linkForm(lk.find(l => l.code === url.searchParams.get("edit")))}
<h2 style="margin-top:24px">SALES ALERTS · ${a.length} <a style="font-size:14px" href="/admin/alerts.csv">Download CSV</a></h2>${table(a, ["email", "categories", "created_at", "unsubscribed_at"], "alerts")}
<h2>Early access · ${e.length} <a style="font-size:14px" href="/admin/early-access.csv">Download CSV</a></h2>${table(e, ["business", "site", "kind", "categories", "other", "name", "email", "created_at"], "early")}</main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
}

// Visit counting without cookies: an anonymous visitor code from IP + browser + today's date, so it cannot follow anyone across days.
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|headless|monitor|uptime|lighthouse/i;
function visitorOf(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash("sha256").update(`${process.env.DB_PASSWORD || "sno"}|${day}|${ip}|${req.headers["user-agent"] || ""}`).digest("hex").slice(0, 16);
}
const deviceOf = ua => /ipad|tablet/i.test(ua) ? "tablet" : /mobi|android|iphone/i.test(ua) ? "phone" : "desktop";
function track(req, kind, extra = {}) {
  const ua = req.headers["user-agent"] || "";
  if (!db || BOTS.test(ua) || !ua) return;
  let ref = null; try { const r = new URL(req.headers.referer || ""); if (!/salenowon\.co\.uk$/.test(r.hostname)) ref = r.hostname.replace(/^www\./, ""); } catch {}
  const u = new URL(req.url, "http://x");
  const src = clean(u.searchParams.get("utm_source") || u.searchParams.get("src") || extra.src || "", 40) || null;
  db.query("insert into events (kind, path, code, ref, src, visitor, device) values ($1,$2,$3,$4,$5,$6,$7)",
    [kind, clean(u.pathname, 200), extra.code || null, ref, src, visitorOf(req), deviceOf(ua)]).catch(e => console.error("track", e.message));
}

// Short links behind QR codes: salenowon.co.uk/go/CODE. Targets are paths on this site only, so a link can never send people elsewhere.
const CODE = /^[a-z0-9-]{2,40}$/;
const sitePath = v => { v = String(v || "").trim(); return /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) && v.length < 300 ? v : null; };
// A time without a zone (from the admin form) is UK wall-clock time, GMT or BST as it falls.
const ukOffset = d => { const p = new Date(d.toLocaleString("en-US", { timeZone: "Europe/London" })); const u = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })); return p - u; };
const when = v => { if (!v) return null; v = String(v);
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(v)) { const z = new Date(v + "Z"); if (isNaN(z)) return undefined; return new Date(z - ukOffset(new Date(z - ukOffset(z)))); }
  const d = new Date(v); return isNaN(d) ? undefined : d; };
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
async function go(req, res, code) {
  let dest = "/";
  if (db && CODE.test(code)) {
    const human = !BOTS.test(req.headers["user-agent"] || "x") && !!req.headers["user-agent"];
    const r = await db.query("update links set scans = scans + $2 where code=$1 returning target,fallback,starts_at,ends_at", [code, human ? 1 : 0]);
    if (r.rows.length) { track(req, "scan", { code, src: "qr" }); const l = r.rows[0], now = new Date();
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

// Analytics dashboard: /admin/stats?days=7|30|90
function barChart(rows, key, label) {
  const W = 900, H = 180, pad = 28, rp = 24, n = rows.length, max = Math.max(1, ...rows.map(r => r[key]));
  const bw = (W - pad - rp) / n, nice = max <= 5 ? max : Math.ceil(max / 5) * 5;
  const bars = rows.map((r, i) => {
    const h = Math.round((r[key] / nice) * (H - 30)), x = pad + i * bw, y = H - 20 - h, d = r.day.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
    return `<g><rect x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H - 20}" fill="transparent"><title>${d}: ${r[key]} ${label}</title></rect>` +
      (h ? `<rect x="${(x + 1).toFixed(1)}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h}" rx="2" fill="#d7262d" pointer-events="none"/>` : "") + `</g>`;
  }).join("");
  const lab = i => rows[i] ? `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${rows[i].day.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" })}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${label} per day" style="font:12px Poppins,sans-serif;fill:#6b6b6b;display:block">
<line x1="${pad}" x2="${W - rp}" y1="10" y2="10" stroke="#eee"/><text x="${pad - 6}" y="14" text-anchor="end">${nice}</text>
<line x1="${pad}" x2="${W - rp}" y1="${H - 20}" y2="${H - 20}" stroke="#ccc"/><text x="${pad - 6}" y="${H - 20}" text-anchor="end">0</text>${bars}${lab(0)}${lab(Math.floor(n / 2))}${lab(n - 1)}</svg>`;
}
async function stats(res, url) {
  const days = [7, 30, 90].includes(+url.searchParams.get("days")) ? +url.searchParams.get("days") : 30;
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  const tile = async (from, to) => (await q(`select
      count(*) filter (where kind='view') views,
      count(distinct (visitor, ts::date)) filter (where kind in ('view','scan','play')) visitors,
      count(*) filter (where kind='scan') scans,
      count(distinct (visitor, path, ts::date)) filter (where kind='play') plays,
      count(*) filter (where kind='out') outs
    from events where ts >= now() - $1::interval and ts < now() - $2::interval`, [from + " days", to + " days"]))[0];
  const cur = await tile(days, 0), prev = await tile(days * 2, days);
  const today = (await q(`select count(distinct visitor) n from events where ts >= date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London'`))[0].n;
  const daily = await q(`select d::date as day, coalesce(v.views,0)::int views, coalesce(v.scans,0)::int scans, coalesce(v.visitors,0)::int visitors
    from generate_series((now() at time zone 'Europe/London')::date - ($1::int - 1), (now() at time zone 'Europe/London')::date, '1 day') d
    left join (select (ts at time zone 'Europe/London')::date as day, count(*) filter (where kind='view') views, count(*) filter (where kind='scan') scans,
               count(distinct visitor) visitors from events group by 1) v on v.day = d::date order by 1`, [days]);
  const codes = await q(`select l.code, l.target, l.note, l.scans all_time,
      count(e.id) filter (where e.ts >= now() - $1::interval) scans, count(distinct (e.visitor, e.ts::date)) filter (where e.ts >= now() - $1::interval) people,
      max(e.ts) last_scan
    from links l left join events e on e.kind='scan' and e.code=l.code group by l.code order by scans desc, all_time desc`, [days + " days"]);
  const sources = await q(`select coalesce(src, ref, 'Direct or typed in') source, count(*) n from events where kind in ('view','scan') and ts >= now() - $1::interval group by 1 order by 2 desc limit 12`, [days + " days"]);
  const devices = await q(`select device, count(distinct (visitor, ts::date)) n from events where ts >= now() - $1::interval group by 1 order by 2 desc`, [days + " days"]);
  const pages = await q(`select case when path = '/' then 'Home page' when path = '/privacy' then 'Privacy notice' when path = '/bot' then 'Robot information' when path = '/deals' then 'Deals hub' when path like '/show/%' then 'Show page ' || substr(path, 7) when path like '/d/%' then 'Deal ' || substr(path, 4) else path end as path, count(*) n from events where kind='view' and ts >= now() - $1::interval group by 1 order by 2 desc limit 10`, [days + " days"]);
  const fmt = n => Number(n).toLocaleString("en-GB");
  const change = (a, b) => { a = +a; b = +b; if (!b) return a ? `<span class="chg">new this period</span>` : `<span class="chg">no activity yet</span>`;
    const pc = Math.round(100 * (a - b) / b); return `<span class="chg">${pc >= 0 ? "▲ up" : "▼ down"} ${Math.abs(pc)}% on the previous ${days} days</span>`; };
  const T = (title, val, prevVal, note) => `<div class="tile"><div class="tl">${title}</div><div class="tv">${fmt(val)}</div>${change(val, prevVal)}${note ? `<div class="tn">${note}</div>` : ""}</div>`;
  const total = devices.reduce((a, r) => a + +r.n, 0) || 1;
  const tbl = (rows, cols, heads) => rows.length ? `<div style="overflow-x:auto"><table><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${typeof c === "function" ? c(r) : esc(r[c] instanceof Date ? r[c].toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" }) : r[c] ?? "")}</td>`).join("")}</tr>`).join("")}</table></div>` : `<p class="small">Nothing yet.</p>`;
  send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>SNO analytics</title>
<link rel="stylesheet" href="/style.css"><style>
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0 26px}th,td{border-bottom:1px solid #e2e2e2;padding:7px;text-align:left;vertical-align:top}th{color:#6b6b6b;font-weight:600}
body{overflow-x:hidden}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:14px 0 26px}
.tile{border:1.5px solid #e2e2e2;border-radius:14px;padding:14px 16px;background:#fff}.tl{font-size:13px;color:#6b6b6b;font-weight:600}
.tv{font-size:34px;font-weight:900;letter-spacing:-1px;margin:2px 0}.chg{font-size:12px;color:#6b6b6b}.tn{font-size:12px;color:#6b6b6b;margin-top:4px}
.box{border:1.5px solid #e2e2e2;border-radius:14px;padding:14px 16px;margin:0 0 22px;background:#fff}.box h3{margin:0 0 6px;font-size:16px}
.range a{display:inline-block;padding:6px 12px;border:1.5px solid #e2e2e2;border-radius:20px;margin-right:6px;color:#222;text-decoration:none;font-weight:600;font-size:14px}.range a.on{border-color:#d7262d;color:#d7262d}
.bar{display:inline-block;height:8px;border-radius:4px;background:#d7262d;vertical-align:middle;margin-right:8px}
</style>
<main class="wrap" style="padding-top:24px;max-width:1000px"><a class="logo" href="/">SALE NOW ON</a> <span class="pill">Analytics</span> <a href="/admin" style="margin-left:12px;font-weight:700">← Admin and QR links</a> <a href="/admin/deals" style="margin-left:12px;font-weight:700">Deals</a>
<p class="range" style="margin-top:20px">${[7, 30, 90].map(d => `<a class="${d === days ? "on" : ""}" href="?days=${d}">Last ${d} days</a>`).join("")}</p>
<div class="tiles">
${T("Unique visitors today", today, null, "People on the site so far today (UK time)").replace(/<span class="chg">.*?<\/span>/, "")}
${T(`Page views, last ${days} days`, cur.views, prev.views)}
${T(`Visitors, last ${days} days`, cur.visitors, prev.visitors, "Each person counted once per day")}
${T(`QR code scans, last ${days} days`, cur.scans, prev.scans)}
${T(`Video plays, last ${days} days`, cur.plays, prev.plays, "Promo video started on the site")}
${T(`Clicks to shops, last ${days} days`, cur.outs, prev.outs, "Go to the shop pressed on a deal page")}
</div>
<div class="box"><h3>Page views per day</h3>${barChart(daily, "views", "page views")}</div>
<div class="box"><h3>QR code scans per day</h3>${barChart(daily, "scans", "QR scans")}</div>
<h2>QR codes</h2>${tbl(codes, [r => `<a href="/admin?edit=${encodeURIComponent(r.code)}#edit">${esc(r.code)}</a>`, "target", "scans", "people", "all_time", "last_scan", "note"],
  ["Code", "Sends people to", `Scans, ${days} days`, `People, ${days} days`, "Scans, all time", "Last scan", "Note"])}
<h2>Where visits came from</h2>${tbl(sources, ["source", "n"], ["Source (link tag, or referring site)", "Visits and scans"])}
<h2>Devices</h2>${tbl(devices, [r => `<span class="bar" style="width:${Math.round(120 * r.n / total)}px"></span>${esc(r.device)}`, r => `${fmt(r.n)} (${Math.round(100 * r.n / total)}%)`], ["Device", "Visitors"])}
<h2>Pages</h2>${tbl(pages, ["path", "n"], ["Page", "Views"])}
<details style="margin-bottom:30px"><summary style="cursor:pointer;font-weight:700">Day-by-day numbers</summary>${tbl(daily.slice().reverse(), [r => r.day.toLocaleDateString("en-GB", { timeZone: "Europe/London" }), "views", "visitors", "scans"], ["Day", "Page views", "Visitors", "QR scans"])}</details>
<p class="small">Counted without cookies: each visitor gets an anonymous code made from their connection and today's date, which changes every day, so nobody is followed from one day to the next. Robots and link previews are left out. Records older than 13 months are deleted.</p>
</main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
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
  for await (const c of req) { body += c; if (body.length > 3_000_000) return send(res, 413, { error: "Too much data" }, "application/json", CORS); }
  let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: "Bad data" }, "application/json", CORS); }
  if (b.kind === "links") {  // a brand directory: names and page links, no prices
    const links = (Array.isArray(b.links) ? b.links : []).slice(0, 3000).map(l => ({ name: clean(l.name, 80), url: clean(l.url, 400) }))
      .filter(l => l.name && /^https:\/\//.test(l.url));
    if (!links.length) return send(res, 400, { error: "No brands in that page" }, "application/json", CORS);
    const r = await db.query("insert into intake (campaign, host, page_url, page_title, products, count) values ($1,$2,$3,$4,$5,$6) returning id",
      [clean(b.campaign, 60) || "Brands", clean(b.host, 120), clean(b.page_url, 800), clean(b.page_title, 200), JSON.stringify(links), links.length]);
    return send(res, 200, { ok: true, id: r.rows[0].id, count: links.length }, "application/json", CORS);
  }
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
    if (url.pathname === "/api/intake") return await intake(req, res);
    if (url.pathname === "/api/links") return await linksApi(req, res);
    if (url.pathname === "/api/deals/from-intake") {
      if (req.method !== "POST" || !process.env.INTAKE_KEY || req.headers["x-sno-key"] !== process.env.INTAKE_KEY) return send(res, 401, { error: "Wrong or missing key" });
      return send(res, 200, await D.fromIntake(+url.searchParams.get("id")));
    }
    if (url.pathname === "/api/deals") { // feed for the show and ad builders
      if (!process.env.INTAKE_KEY || req.headers["x-sno-key"] !== process.env.INTAKE_KEY) return send(res, 401, { error: "Wrong or missing key" });
      const st = ["live", "pending", "all"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "live";
      const r = await db.query(`select code, title, category, now::float, was::float, cur, off, images, checked_at, expires_at, status from deals
        where ${st === "all" ? "status in ('live','pending')" : "status = $1"} and (expires_at is null or expires_at > now()) order by off desc limit 2000`, st === "all" ? [] : [st]);
      return send(res, 200, r.rows, "application/json", { "Cache-Control": "no-store" });
    }
    if (url.pathname === "/api/shows") {
      if (req.method !== "POST" || !process.env.INTAKE_KEY || req.headers["x-sno-key"] !== process.env.INTAKE_KEY) return send(res, 401, { error: "Wrong or missing key" });
      let body = ""; for await (const c of req) { body += c; if (body.length > 3_000_000) return send(res, 413, { error: "Too much data" }); }
      let j; try { j = JSON.parse(body); } catch { return send(res, 400, { error: "Bad data" }); }
      const err = await D.saveShow(j); return send(res, err ? 400 : 200, err ? { error: err } : { ok: true, url: "https://salenowon.co.uk/show/" + j.slug });
    }
    if (db && (url.pathname === "/shows" || url.pathname === "/shows/")) return await D.showsList(req, res);
    const sm = /^\/show\/([a-z0-9-]{1,60})\/?$/.exec(url.pathname);
    if (db && sm) return await D.showPage(req, res, sm[1]);
    if (db && (url.pathname === "/deals" || url.pathname === "/deals/")) return await D.hub(req, res, url);
    const dm = /^\/(d|out)\/(\d{1,9})\/?$/.exec(url.pathname);
    if (db && dm) return dm[1] === "d" ? await D.dealPage(req, res, dm[2]) : await D.out(req, res, dm[2]);
    if (url.pathname === "/api/admin-link") {
      if (req.method === "OPTIONS") return send(res, 204, "", "text/plain", CORS);
      const key = process.env.INTAKE_KEY;
      if (req.method !== "POST" || !key || !process.env.ADMIN_PASSWORD || req.headers["x-sno-key"] !== key) return send(res, 401, { error: "Wrong or missing key" }, "application/json", CORS);
      return send(res, 200, { url: "https://salenowon.co.uk/admin/login?t=" + mint("link", 120) }, "application/json", { ...CORS, "Cache-Control": "no-store" });
    }
    const gm = /^\/go\/([^/]+)\/?$/.exec(url.pathname);
    if (gm) return await go(req, res, decodeURIComponent(gm[1]).toLowerCase());
    if (req.method === "POST" && url.pathname === "/api/alerts") return await api(req, res, "alerts");
    if (req.method === "POST" && url.pathname === "/api/early-access") return await api(req, res, "early");
    if (url.pathname === "/health") return send(res, 200, { ok: true, db: !!db });
    if (url.pathname.startsWith("/admin")) return await admin(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    let p = decodeURIComponent(url.pathname);
    if (req.method === "GET" && ["/", "/privacy", "/bot", "/index.html"].includes(p)) track(req, "view");
    if (req.method === "GET" && /\.mp4$/.test(p) && (!req.headers.range || /^bytes=0-/.test(req.headers.range))) track(req, "play");
    if (p === "/") p = "/index.html";
    if (p === "/privacy") p = "/privacy.html";
    if (p === "/bot") p = "/bot.html";
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB)) return send(res, 403, "Forbidden", "text/plain");
    serveFile(req, res, file);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, "Something went wrong", "text/plain"); else res.end(); }
}).listen(PORT, () => console.log("Sale Now On landing on :" + PORT));

const D = require("./deals")({ db, esc, clean, send, SEC, track, authed });
process.on("unhandledRejection", e => console.error("unhandled", e));
migrate();
