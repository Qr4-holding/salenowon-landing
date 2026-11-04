// Deals: made from pages sent by the Chrome extension, approved in admin, shown at /deals and /d/CODE.
// Product names are brand-free and the shop is not named until further notice (SHOW_SHOP).
// Deals stay a private preview (signed-in admin only) until the "show to the public" switch is on.
const SHOW_SHOP = false;
const DAYS_LIVE = 7; // a deal expires this many days after its price was read

module.exports = function deals({ db, esc, clean, send, SEC, track, authed }) {
  const GARMENT = /^(jeans?|shorts?|skirts?|dress|dresses|jackets?|shirts?|tops?|pants|trousers?|coats?|vests?|jumpsuits?|overalls?|rompers?|corsets?|bodysuits?|blazers?|tunics?|capris?|cardigans?|jumpers?|sweaters?|hoodies?|bags?|boots?|trainers?|sandals?|heels?|shoes?|blouses?|leggings?|joggers?|bras?|knickers?|pyjamas?|swimsuits?|bikinis?|scarf|scarves|hats?|belts?|bracelets?|necklaces?|earrings?|rings?|watch|watches|sunglasses|wallets?|purses?)$/i;
  const fmt = (cur, v) => (cur || "£") + (v % 1 ? (+v).toFixed(2) : String(+v));
  const ukDate = d => new Date(d).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function migrate() {
    await db.query(`
      create table if not exists deals (
        id serial primary key, code int unique, title text not null, category text, now numeric not null, was numeric not null,
        cur text not null default '£', off int not null, images jsonb not null default '[]', shop text, url text not null unique,
        source_intake int, status text not null default 'pending', checked_at timestamptz not null default now(),
        expires_at timestamptz, created_at timestamptz not null default now(), decided_at timestamptz);
      create index if not exists deals_status on deals (status, off desc);
      create table if not exists settings (key text primary key, value text);
      create table if not exists shows (
        slug text primary key, title text not null, date_label text, video text, youtube text, duration numeric,
        chapters jsonb not null default '[]', items jsonb not null default '[]', created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
  }

  // "Amana Denim Shirt The Wolf Gang" -> "Amana Denim Shirt": cut after the last garment word; else drop trailing capitalised brand words
  function brandFree(name) {
    const w = String(name).replace(/\s+/g, " ").trim().split(" ");
    const g = x => GARMENT.test(String(x || "").replace(/[^a-z]/gi, ""));
    let i = w.findIndex(g);                       // first garment word, plus any garment word right after it ("Shirt Dress")
    if (i >= 0) { while (g(w[i + 1])) i++; return w.slice(0, i + 1).join(" "); }
    while (w.length > 2 && /^[A-Z0-9'&.-]{2,}$/.test(w[w.length - 1])) w.pop();
    return w.join(" ");
  }
  function imagesFor(p) {
    const u = String(p.image || ""); if (!/^https:\/\//.test(u)) return [];
    const m = /^(https:\/\/is\d\.revolveassets\.com\/images\/p4\/n\/)[a-z]+\/(.+)_V1\.jpg$/.exec(u);
    if (m) return [1, 2, 3, 4, 5, 6].map(v => `${m[1]}z/${m[2]}_V${v}.jpg`); // Revolve numbers each product's photos
    return [u];
  }
  const thumbOf = d => String(d.images[0] || "").replace("/images/p4/n/z/", "/images/p4/n/uv/");

  // Names that are really photo captions ("(Image 0).") are replaced by the name in the product's link
  const junkName = t => !t || t.length < 4 || /^[(\[]?\s*(image|img|photo|picture|product( image)?)\s*\d*\s*[)\]]?\.?$/i.test(String(t).trim()) || !/[a-z]{3}/i.test(t);
  const fromUrl = u => { try { const seg = new URL(u).pathname.split("/").filter(Boolean).pop() || ""; return /[a-z]-[a-z]/i.test(seg) ? seg.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : ""; } catch { return ""; } };
  async function fromIntake(id) {
    const r = await db.query("select * from intake where id=$1", [id]); if (!r.rows.length) return { error: "No such page" };
    const it = r.rows[0], cat = clean(it.campaign, 60).replace(/\s+on\s*:.*$/i, "").trim() || "Sale";
    let added = 0, skipped = 0;
    for (const p of it.products) {
      const imgs = imagesFor(p), url = String(p.url || "");
      if (junkName(p.name)) p.name = fromUrl(url);
      if (!p.name) { skipped++; continue; }
      if (!imgs.length || !/^https:\/\//.test(url) || !(p.was > p.now) || p.now <= 0) { skipped++; continue; }
      const q = await db.query(`insert into deals (title, category, now, was, cur, off, images, shop, url, source_intake, checked_at, expires_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11::timestamptz + interval '${DAYS_LIVE} days')
        on conflict (url) do update set now=excluded.now, was=excluded.was, off=excluded.off, checked_at=excluded.checked_at, expires_at=excluded.expires_at,
          status = case when deals.status = 'expired' or (deals.now <> excluded.now and deals.status = 'live') then 'pending' else deals.status end
        returning (xmax = 0) as inserted`,
        [clean(brandFree(p.name), 120), cat, p.now, p.was, clean(p.cur, 3) || "£", Math.round(100 * (1 - p.now / p.was)), JSON.stringify(imgs), clean(it.host, 120), url, it.id, it.created_at]);
      q.rows[0].inserted ? added++ : skipped++;
    }
    await db.query("update deals set code = id + 1000 where code is null");
    return { ok: true, added, updated_or_skipped: skipped };
  }

  const isPublic = async () => ((await db.query("select value from settings where key='deals_public'")).rows[0] || {}).value === "on";
  const liveWhere = "status='live' and (expires_at is null or expires_at > now())";

  // ---- page shell ----
  const page = (title, body, { preview = false, desc = "" } = {}) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<title>${esc(title)} · Sale Now On</title>${desc ? `<meta name="description" content="${esc(desc)}">` : ""}
${preview ? '<meta name="robots" content="noindex,nofollow">' : ""}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/deals.css"></head><body>
${preview ? '<div class="preview">Preview: only you can see the deals. Turn them on for everyone in Admin → Deals.</div>' : ""}
<header class="top wrap"><a class="logo" href="/">SALE NOW ON</a><a class="pill" href="/deals">All deals</a></header>
${body}
<footer class="foot wrap"><nav><a href="/">Home</a><a href="/deals">Deals</a><a href="/privacy">Privacy</a><a href="mailto:hello@salenowon.co.uk?subject=Advertise%20with%20Sale%20Now%20On">Advertise with us</a></nav>
<p class="small">Sale Now On shows shops' own sale prices and links to their sites. Prices are set by the shops and can change.</p><p>© 2026 Sale Now On</p></footer></body></html>`;

  const notYet = res => send(res, 200, page("Deals coming soon", `<main class="wrap dz"><h1 style="font-size:40px">Deals are coming soon</h1>
<p class="lead">We're getting the first sales ready. Check back shortly.</p><p><a class="btn" href="/">Back to the home page</a></p></main>`, { preview: true }), "text/html; charset=utf-8", { "Cache-Control": "no-store" });

  async function gate(req, res) {
    if (await isPublic()) return { ok: true, preview: false };
    if (authed(req)) return { ok: true, preview: true };
    notYet(res); return { ok: false };
  }

  const card = d => `<a class="dcard" href="/d/${d.code}"><span class="dimg"><img src="${esc(thumbOf(d))}" alt="" loading="lazy"><b class="doff">${d.off}%</b></span>
<span class="dinfo"><span class="dname">${esc(d.title)}</span><span class="dcode">${SHOW_SHOP ? esc(d.shop) + " · " : ""}SNO ${d.code}</span>
<span class="dprice"><b>${fmt(d.cur, d.now)}</b> <s>${fmt(d.cur, d.was)}</s></span></span></a>`;

  async function hub(req, res, url) {
    const g = await gate(req, res); if (!g.ok) return;
    const code = String(url.searchParams.get("code") || "").replace(/\D/g, "");
    if (code) { res.writeHead(303, { ...SEC, Location: "/d/" + code }); return res.end(); }
    const cat = clean(url.searchParams.get("cat"), 60);
    const cats = (await db.query(`select category, count(*) n from deals where ${liveWhere} group by 1 order by 2 desc`)).rows;
    const list = (await db.query(`select * from deals where ${liveWhere} ${cat ? "and category=$1" : ""} order by off desc, now asc limit 300`, cat ? [cat] : [])).rows;
    const total = cats.reduce((a, c) => a + +c.n, 0);
    if (!g.preview) track(req, "view");
    send(res, 200, page(cat ? cat + " deals" : "Today's deals", `<main class="wrap dz">
<h1 class="dh1"><span class="red">${total}</span> deals on sale now</h1>
<form class="codebox" action="/deals" method="get"><label for="code">Saw a deal on a video? Enter its code</label>
<div class="row"><input id="code" name="code" inputmode="numeric" placeholder="e.g. 1042" autocomplete="off"><button class="btn">Find</button></div></form>
<nav class="cats"><a class="${cat ? "" : "on"}" href="/deals">All</a>${cats.map(c => `<a class="${c.category === cat ? "on" : ""}" href="/deals?cat=${encodeURIComponent(c.category)}">${esc(c.category)}</a>`).join("")}</nav>
<h2 class="dh2">${cat ? esc(cat) : "Today's deals"} <span class="small">Biggest saving first</span></h2>
${list.length ? `<div class="dgrid">${list.map(card).join("")}</div>` : '<p class="lead">No deals here right now. New ones arrive every day.</p>'}
</main>`, { preview: g.preview, desc: `${total} sale deals, biggest savings first.` }), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  async function dealPage(req, res, code) {
    const g = await gate(req, res); if (!g.ok) return;
    const r = await db.query("select * from deals where code=$1 and status in ('live','expired')", [+code || 0]);
    const d = r.rows[0];
    if (!d && !(g.preview && (await db.query("select 1 from deals where code=$1", [+code || 0])).rows.length))
      return send(res, 404, page("Deal not found", `<main class="wrap dz"><h1 style="font-size:40px">We couldn't find deal ${esc(code)}</h1>
<p class="lead">Check the code from the video, or browse today's deals.</p><p><a class="btn" href="/deals">See today's deals</a></p></main>`, { preview: g.preview }), "text/html; charset=utf-8");
    const deal = d || (await db.query("select * from deals where code=$1", [+code])).rows[0];
    const ended = deal.status === "expired" || (deal.expires_at && new Date(deal.expires_at) < new Date());
    const more = (await db.query(`select * from deals where ${liveWhere} and category=$1 and code<>$2 order by off desc limit 6`, [deal.category, deal.code])).rows;
    if (!g.preview) track(req, "view");
    const imgs = deal.images.slice(0, 6);
    send(res, 200, page(deal.title, `<main class="wrap dz dpage">
<div class="gal"><div class="gmain"><img id="gm" src="${esc(imgs[0])}" alt="${esc(deal.title)}"><b class="doff big">${deal.off}%<i>OFF</i></b></div>
${imgs.length > 1 ? `<div class="gthumbs">${imgs.map((u, i) => `<button type="button" class="${i ? "" : "on"}" data-src="${esc(u)}"><img src="${esc(u.replace("/n/z/", "/n/uv/"))}" alt="" loading="lazy" onerror="this.parentNode.remove()"></button>`).join("")}</div>` : ""}</div>
<div class="dside"><p class="dcat">${SHOW_SHOP ? esc(deal.shop) + " · " : ""}${esc(deal.category || "")} · Deal code <b>SNO ${deal.code}</b></p>
<h1 class="dtitle">${esc(deal.title)}</h1>
<p class="dbig"><b>${fmt(deal.cur, deal.now)}</b> <span>Was <s>${fmt(deal.cur, deal.was)}</s></span></p>
<p class="dsave">You save ${fmt(deal.cur, Math.round((deal.was - deal.now) * 100) / 100)}</p>
${ended ? `<p class="ended">This sale has ended. Prices were correct on ${esc(ukDate(deal.checked_at))}.</p>`
        : `<a class="btn wide go" href="/out/${deal.code}" rel="nofollow noopener" target="_blank">Go to the shop</a>
<p class="small">Price checked ${esc(ukDate(deal.checked_at))}. The Was price is the shop's own earlier price. Prices are set by the shop and can change, so check before you buy.</p>`}
<p class="small">Shop owner? <a href="mailto:hello@salenowon.co.uk?subject=Remove%20listing%20SNO%20${deal.code}">Ask us to remove this listing</a>.</p></div>
${more.length ? `<section class="more"><h2 class="dh2">More ${esc(deal.category)} deals</h2><div class="dgrid">${more.map(card).join("")}</div></section>` : ""}
</main><script>document.querySelectorAll(".gthumbs button").forEach(b=>b.onclick=()=>{document.getElementById("gm").src=b.dataset.src;document.querySelectorAll(".gthumbs button").forEach(x=>x.classList.toggle("on",x===b))});</script>`,
      { preview: g.preview, desc: `${deal.title}: ${fmt(deal.cur, deal.now)}, was ${fmt(deal.cur, deal.was)}. Save ${deal.off}%.` }), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  async function out(req, res, code) {
    const r = await db.query(`select url from deals where code=$1 and ${liveWhere}`, [+code || 0]);
    const pub = await isPublic();
    if (!r.rows.length || (!pub && !authed(req))) { res.writeHead(302, { ...SEC, Location: "/d/" + (+code || 0) }); return res.end(); }
    track(req, "out", { code: String(code) });
    res.writeHead(302, { ...SEC, Location: r.rows[0].url, "Cache-Control": "no-store", "Referrer-Policy": "origin" }); res.end();
  }

  // ---- admin: morning approval screen ----
  async function adminDeals(req, res, url) {
    if (req.method === "POST") {
      let body = ""; for await (const c of req) { body += c; if (body.length > 200000) break; }
      const f = new URLSearchParams(body), act = f.get("act");
      if (act === "public") await db.query("insert into settings (key,value) values ('deals_public',$1) on conflict (key) do update set value=$1", [f.get("v") === "on" ? "on" : "off"]);
      if (act === "intake") await fromIntake(+f.get("id"));
      if (act === "youtube") { const err = await setYoutube(String(f.get("slug") || ""), String(f.get("yt") || "").trim()); if (err) return send(res, 400, err + ". Go back and try again.", "text/plain; charset=utf-8"); }
      if (act === "live" || act === "skipped" || act === "pending") {
        const ids = f.getAll("id").map(Number).filter(Boolean);
        if (ids.length) await db.query("update deals set status=$1, decided_at=now() where id = any($2)", [act, ids]);
      }
      res.writeHead(303, { ...SEC, Location: "/admin/deals?s=" + encodeURIComponent(f.get("back") || "pending") }); return res.end();
    }
    await db.query("update deals set status='expired' where status in ('live','pending') and expires_at < now()");
    const s = ["pending", "live", "skipped", "expired"].includes(url.searchParams.get("s")) ? url.searchParams.get("s") : "pending";
    const counts = Object.fromEntries((await db.query("select status, count(*) n from deals group by 1")).rows.map(r => [r.status, +r.n]));
    const list = (await db.query("select * from deals where status=$1 order by off desc limit 400", [s])).rows;
    const pub = await isPublic();
    const intakes = (await db.query("select id, campaign, host, count, created_at, (select count(*) from deals where source_intake=intake.id) made from intake order by id desc limit 20")).rows;
    const row = d => `<label class="arow"><input type="checkbox" name="id" value="${d.id}" ${s === "pending" ? "checked" : ""}>
<img src="${esc(thumbOf(d))}" alt="" loading="lazy"><span class="ainfo"><b>${fmt(d.cur, d.now)}</b> <span class="small">was ${fmt(d.cur, d.was)} · save ${d.off}%</span><br>
<span>${esc(d.title)}</span><br><span class="small">${esc(d.category || "")} · SNO ${d.code} · price read ${esc(ukDate(d.checked_at))} · <a href="${esc(d.url)}" target="_blank" rel="noopener">check at the shop</a> · <a href="/d/${d.code}" target="_blank">page</a></span></span></label>`;
    const btns = { pending: [["live", "Post the ticked deals"], ["skipped", "Skip the ticked deals"]], live: [["pending", "Take the ticked deals down"]], skipped: [["live", "Post the ticked deals"]], expired: [] }[s];
    send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>SNO deals</title>
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/deals.css">
<main class="wrap" style="padding:24px 20px 60px;max-width:1000px"><a class="logo" href="/">SALE NOW ON</a> <span class="pill">Deals</span>
<a href="/admin" style="margin-left:12px;font-weight:700">← Admin</a> <a href="/admin/stats" style="margin-left:12px;font-weight:700">Analytics</a>
<div class="pubbox ${pub ? "on" : ""}"><div><b>Deals are ${pub ? "showing to everyone" : "a private preview"}.</b><br><span class="small">${pub ? "Anyone can see /deals and the deal pages." : "Only you, signed in, can see /deals and the deal pages. Turn this on once shops have agreed to their photos being used."}</span></div>
<form method="post"><input type="hidden" name="act" value="public"><input type="hidden" name="v" value="${pub ? "off" : "on"}"><input type="hidden" name="back" value="${s}">
<button class="btn" onclick="return confirm('${pub ? "Hide the deals from the public?" : "Show the deals to everyone?"}')">${pub ? "Hide from the public" : "Show to the public"}</button></form></div>
<p><a href="/deals" target="_blank">Open the deals hub →</a></p>
<nav class="cats">${["pending", "live", "skipped", "expired"].map(k => `<a class="${k === s ? "on" : ""}" href="?s=${k}">${{ pending: "Waiting for you", live: "Posted", skipped: "Skipped", expired: "Ended" }[k]} · ${counts[k] || 0}</a>`).join("")}</nav>
${list.length ? `<form method="post"><input type="hidden" name="back" value="${s}">
<div class="abar">${btns.map(([a, l]) => `<button class="btn" name="act" value="${a}">${l}</button>`).join("")}
<button type="button" class="btn ghost" onclick="document.querySelectorAll('.arow input').forEach(i=>i.checked=true)">Tick all</button>
<button type="button" class="btn ghost" onclick="document.querySelectorAll('.arow input').forEach(i=>i.checked=false)">Untick all</button></div>
<div class="alist">${list.map(row).join("")}</div></form>` : `<p class="lead">Nothing here.</p>`}
<h2 style="margin-top:34px">Shows</h2>
${(await listShows()).map(sh => `<form method="post" class="pubbox" style="margin:8px 0"><div><b>${esc(sh.title)} · ${esc(sh.date_label || "")}</b> <span class="small">${sh.n} deals · <a href="/show/${esc(sh.slug)}" target="_blank">open the show page</a></span></div>
<input type="hidden" name="act" value="youtube"><input type="hidden" name="slug" value="${esc(sh.slug)}"><input type="hidden" name="back" value="${s}">
<div class="row" style="display:flex;gap:8px;flex:1;min-width:260px"><input name="yt" placeholder="Paste the YouTube link once it's uploaded" value="${esc(sh.youtube || "")}" style="flex:1"><button class="btn">Save</button></div></form>`).join("") || '<p class="small">No shows yet.</p>'}
<h2 style="margin-top:34px">Make deals from a page you sent</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px">${intakes.map(i => `<tr style="border-bottom:1px solid #e2e2e2"><td style="padding:8px">${esc(i.campaign)}<br><span class="small">${esc(i.host)} · ${i.count} products · ${esc(ukDate(i.created_at))}</span></td>
<td style="padding:8px;text-align:right">${+i.made ? `<span class="small">${i.made} deals made</span> ` : ""}<form method="post" style="display:inline"><input type="hidden" name="act" value="intake"><input type="hidden" name="id" value="${i.id}"><button class="btn ghost">${+i.made ? "Refresh prices" : "Make deals"}</button></form></td></tr>`).join("")}</table>
</main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  // ---- show pages: every deal in a show, with a link to the moment it appears ----
  const ts = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const ytId = u => { let h; try { h = new URL(String(u || "")).hostname.replace(/^(www|m)\./, ""); } catch { return null; }
    if (!["youtube.com", "youtu.be", "youtube-nocookie.com"].includes(h)) return null;
    const m = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/|\/shorts\/)([\w-]{11})/.exec(String(u)); return m ? m[1] : null; };

  async function showPage(req, res, slug) {
    const g = await gate(req, res); if (!g.ok) return;
    const r = await db.query("select * from shows where slug=$1", [slug]); const sh = r.rows[0];
    if (!sh) return send(res, 404, page("Show not found", `<main class="wrap dz"><h1 style="font-size:40px">We couldn't find that show</h1><p><a class="btn" href="/shows">See all shows</a></p></main>`, { preview: g.preview }), "text/html; charset=utf-8");
    const codes = sh.items.map(i => +i.code);
    const imgs = Object.fromEntries((await db.query("select code, images from deals where code = any($1)", [codes])).rows.map(d => [d.code, d.images[0]]));
    if (!g.preview) track(req, "view");
    const yt = ytId(sh.youtube);
    const player = yt ? `<div class="vwrap"><iframe id="yt" src="https://www.youtube-nocookie.com/embed/${yt}?rel=0" title="${esc(sh.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
      : sh.video ? `<div class="vwrap"><video id="vid" controls playsinline preload="metadata" src="${esc(sh.video)}"></video></div>` : `<p class="lead">The video is coming soon.</p>`;
    const go = t => yt ? `https://www.youtube.com/watch?v=${yt}&t=${Math.floor(t)}s` : `#t=${Math.floor(t)}`;
    const sections = []; for (const it of sh.items) { let s = sections.find(x => x.name === it.section); if (!s) sections.push(s = { name: it.section, items: [] }); s.items.push(it); }
    const row = it => `<div class="srow" id="sno${it.code}"><a class="sthumb" href="/d/${it.code}"><img src="${esc(String(imgs[it.code] || "").replace("/n/z/", "/n/uv/"))}" alt="" loading="lazy"><b class="doff">${it.off}%</b></a>
<div class="sinfo"><a class="dname" href="/d/${it.code}">${esc(it.title)}</a><span class="dcode">SNO ${it.code}</span><span class="dprice"><b>${fmt(it.cur, it.now)}</b> <s>${fmt(it.cur, it.was)}</s></span></div>
<a class="watch" href="${go(it.t)}" data-t="${Math.floor(it.t)}" ${yt ? 'target="_blank" rel="noopener"' : ""}>▶ ${ts(it.t)}</a></div>`;
    send(res, 200, page(sh.title + " · " + (sh.date_label || ""), `<main class="wrap dz showpage">
<p class="dcat">${esc(sh.date_label || "")} · ${sh.items.length} deals · ${ts(+sh.duration || 0)}</p><h1 class="dh1">${esc(sh.title)}</h1>
<div class="sgrid"><div class="sleft">${player}
<h2 class="dh2">Jump to a part</h2><div class="chaps">${sh.chapters.map(c => `<a href="${go(c.t)}" data-t="${Math.floor(c.t)}" ${yt ? 'target="_blank" rel="noopener"' : ""}><b>${ts(c.t)}</b> ${esc(c.label)}</a>`).join("")}</div></div>
<div class="sright"><form class="codebox" id="findf"><label for="fc">Saw a deal in the show? Enter its code</label><div class="row"><input id="fc" inputmode="numeric" placeholder="e.g. 1132" autocomplete="off"><button class="btn">Find</button></div><p class="small" id="fmsg"></p></form>
${sections.map(s => `<h2 class="dh2">${esc(s.name)}</h2>${s.items.map(row).join("")}`).join("")}</div></div>
</main><script>
(function(){var v=document.getElementById("vid"),y=document.getElementById("yt");
function seek(t){if(v){v.currentTime=t;v.play();v.scrollIntoView({behavior:"smooth",block:"center"});return true}
 if(y){y.src="https://www.youtube-nocookie.com/embed/${yt || ""}?rel=0&autoplay=1&start="+t;y.scrollIntoView({behavior:"smooth",block:"center"});return true}return false}
document.querySelectorAll("[data-t]").forEach(function(a){a.addEventListener("click",function(e){if(seek(+a.dataset.t))e.preventDefault()})});
document.getElementById("findf").addEventListener("submit",function(e){e.preventDefault();var c=document.getElementById("fc").value.replace(/\\D/g,""),el=document.getElementById("sno"+c),m=document.getElementById("fmsg");
 document.querySelectorAll(".srow.hit").forEach(function(x){x.classList.remove("hit")});
 if(!el){m.textContent="Deal SNO "+c+" wasn't in this show. Try the deals page.";return}m.textContent="";el.classList.add("hit");el.scrollIntoView({behavior:"smooth",block:"center"});seek(+el.querySelector("[data-t]").dataset.t)});
if(v&&location.hash.indexOf("#t=")===0)v.currentTime=+location.hash.slice(3)})();
</script>`, { preview: g.preview, desc: `${sh.title}, ${sh.date_label}: ${sh.items.length} deals, with the moment each one appears.` }), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  async function showsList(req, res) {
    const g = await gate(req, res); if (!g.ok) return;
    const rows = (await db.query("select slug, title, date_label, duration, jsonb_array_length(items) n from shows order by created_at desc limit 60")).rows;
    send(res, 200, page("Shows", `<main class="wrap dz"><h1 class="dh1">The Weekend Sale Now On</h1><p class="lead">Every show, with every deal and the moment it appears.</p>
<div class="alist" style="margin-top:20px">${rows.map(r => `<a class="dcard" href="/show/${esc(r.slug)}" style="padding:14px 16px"><span class="dinfo"><span class="dname">${esc(r.title)} · ${esc(r.date_label || "")}</span><span class="dcode">${r.n} deals · ${ts(+r.duration || 0)}</span></span></a>`).join("") || '<p class="lead">The first show is coming soon.</p>'}</div></main>`, { preview: g.preview }), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  async function saveShow(b) {
    const slug = String(b.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
    if (!slug) return "Missing slug";
    const okVideo = v => !v || /^\/media\/shows\/[\w.-]+\.mp4$/.test(v) ? (v || null) : undefined;
    const video = okVideo(b.video); if (video === undefined) return "Video must be a file under /media/shows/";
    const yt = b.youtube ? (ytId(b.youtube) ? "https://www.youtube.com/watch?v=" + ytId(b.youtube) : undefined) : null; if (yt === undefined) return "That isn't a YouTube link";
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 3000).map(i => ({ code: +i.code, t: +i.t || 0, section: clean(i.section, 60), title: clean(i.title, 120), now: +i.now, was: +i.was, cur: clean(i.cur, 3) || "£", off: Math.round(+i.off || 0) })).filter(i => i.code);
    const chapters = (Array.isArray(b.chapters) ? b.chapters : []).slice(0, 200).map(c => ({ t: +c.t || 0, label: clean(c.label, 80) }));
    await db.query(`insert into shows (slug, title, date_label, video, youtube, duration, chapters, items) values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (slug) do update set title=$2, date_label=$3, video=coalesce($4, shows.video), youtube=coalesce($5, shows.youtube), duration=$6, chapters=$7, items=$8, updated_at=now()`,
      [slug, clean(b.title, 120) || "The Weekend Sale Now On", clean(b.date, 40), video, yt, +b.duration || 0, JSON.stringify(chapters), JSON.stringify(items)]);
    return null;
  }
  async function setYoutube(slug, url) {
    const id = ytId(url); if (url && !id) return "That isn't a YouTube link";
    await db.query("update shows set youtube=$2, updated_at=now() where slug=$1", [slug, id ? "https://www.youtube.com/watch?v=" + id : null]); return null;
  }
  const listShows = async () => (await db.query("select slug, title, date_label, youtube, jsonb_array_length(items) n from shows order by created_at desc limit 20")).rows;

  return { migrate, hub, dealPage, out, adminDeals, fromIntake, brandFree, showPage, showsList, saveShow, setYoutube, listShows };
};
