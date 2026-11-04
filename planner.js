// Event planner: sort every deal by kind of item, colour, brand and shop; filter with live counts; pick items into a
// sale event; mark paid FEATURED slots; then ask for the show video. Admin only.
const SECS_ITEM = 7.9, SECS_FEATURED = 13, SECS_SECTION = 13, SECS_OPEN_CLOSE = 18; // measured on show v6

const KINDS = [ // checked against the product name, last matching word wins ("Shirt Dress" is a dress)
  ["Dresses", /^(dress|dresses|gown|gowns|kaftan|kaftans|midi|maxi)$/],
  ["Jeans", /^(jean|jeans)$/],
  ["Trousers", /^(trouser|trousers|pant|pants|jogger|joggers|legging|leggings|culotte|culottes|chino|chinos)$/],
  ["Shorts", /^(short|shorts)$/],
  ["Skirts", /^(skirt|skirts|skort)$/],
  ["Tops & shirts", /^(top|tops|tee|tees|t|cami|camisole|vest|vests|blouse|blouses|shirt|shirts|overshirt|bodysuit|corset|tank|bralette|bustier|polo)$/],
  ["Knitwear", /^(jumper|jumpers|sweater|sweaters|cardigan|cardigans|knit|sweatshirt|sweat|hoodie|hoodies|pullover|crewneck)$/],
  ["Jackets & coats", /^(jacket|jackets|coat|coats|blazer|blazers|gilet|parka|trench|bomber|puffer|shacket|waistcoat)$/],
  ["Jumpsuits", /^(jumpsuit|jumpsuits|playsuit|playsuits|romper|rompers|overall|overalls|boilersuit|dungarees)$/],
  ["Sets", /^(set|sets|co-ord|coord)$/],
  ["Shoes", /^(boot|boots|trainer|trainers|sneaker|sneakers|sandal|sandals|heel|heels|shoe|shoes|loafer|loafers|mule|mules|pump|pumps|flats|slides)$/],
  ["Bags", /^(bag|bags|tote|clutch|purse|backpack|crossbody)$/],
  ["Accessories", /^(scarf|scarves|hat|hats|cap|beanie|belt|belts|earring|earrings|necklace|bracelet|bangle|bangles|ring|rings|sunglasses|wallet|gloves|socks|tights)$/],
  ["Swimwear", /^(bikini|swimsuit|swimwear)$/],
  ["Lingerie & nightwear", /^(bra|bras|knicker|knickers|brief|briefs|thong|pyjama|pyjamas|robe|nightdress|slip)$/],
];
const COLOURS = [ // colour families, matched against words in the name and the shop's link
  ["Black", /^(black|jet|onyx|noir|ebony)/],
  ["White & cream", /^(white|ivory|cream|ecru|off-white|offwhite|vanilla|milk|chalk|oat)/],
  ["Red", /^(red|burgundy|wine|claret|cherry|scarlet|crimson|merlot|oxblood|bordeaux)/],
  ["Pink", /^(pink|blush|rose|fuchsia|magenta|coral|peach|salmon)/],
  ["Orange", /^(orange|rust|terracotta|tangerine|copper|burnt)/],
  ["Yellow & gold", /^(yellow|gold|mustard|lemon|butter|ochre)/],
  ["Green", /^(green|khaki|olive|sage|mint|emerald|forest|lime|moss|pistachio)/],
  ["Blue", /^(blue|navy|indigo|cobalt|teal|turquoise|aqua|sky|denim|bluestone|chambray|wash)/],
  ["Purple", /^(purple|lilac|lavender|violet|plum|mauve|aubergine|grape)/],
  ["Brown & neutral", /^(brown|chocolate|tan|camel|beige|stone|taupe|mocha|nude|sand|toffee|caramel|coffee|cognac|chestnut|neutral)/],
  ["Grey & silver", /^(grey|gray|charcoal|silver|slate|pewter|ash|graphite)/],
  ["Print & pattern", /^(leopard|animal|zebra|snake|floral|flower|stripe|striped|check|checked|plaid|polka|spot|paisley|print|printed|graffiti|jacquard|jacqaurd)/],
];
const SHOP_NAMES = { "mintvelvet.com": "Mint Velvet", "www.marksandspencer.com": "M&S", "www.revolve.com": "Revolve", "www.fwrd.com": "FWRD" };

module.exports = function planner({ db, esc, clean, send, SEC }) {
  const words = t => String(t || "").toLowerCase().replace(/[^a-z0-9-]+/g, " ").split(/[\s-]+/).filter(Boolean);
  function kindOf(name) {
    let k = "Other";
    for (const w of words(name)) for (const [label, re] of KINDS) if (re.test(w)) k = label;
    return k;
  }
  function colourOf(name, url) {
    let slug = ""; try { slug = new URL(url).pathname; } catch {}
    const m = /-in-([a-z-]+)\//.exec(slug); // Revolve: /...-in-bluestone/dp/...
    const pool = [...(m ? words(m[1]) : []), ...words(name), ...words(slug)];
    for (const w of pool) for (const [label, re] of COLOURS) if (re.test(w)) return label;
    return "Not stated";
  }
  let brandList = null; // [{name, lower}] longest first
  async function brands() {
    if (!brandList) brandList = (await db.query("select name from brands")).rows.map(r => ({ name: r.name, lower: r.name.toLowerCase() })).sort((a, b) => b.lower.length - a.lower.length);
    return brandList;
  }
  async function brandOf(raw, host) {
    if (host && host !== "www.revolve.com" && host !== "www.fwrd.com") return SHOP_NAMES[host] || host.replace(/^www\./, ""); // own-brand shops
    const r = String(raw || "").toLowerCase().trim();
    for (const b of await brands()) if (r.endsWith(" " + b.lower) || r === b.lower) return b.name;
    return "Unknown";
  }

  async function migrate() {
    await db.query(`
      create table if not exists brands (name text primary key, url text, shop text, contact_email text, status text not null default 'not contacted',
        notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      alter table deals add column if not exists kind text;
      alter table deals add column if not exists colour text;
      alter table deals add column if not exists brand text;
      alter table deals add column if not exists raw_name text;
      create table if not exists sale_events (id serial primary key, name text not null, show_date date, status text not null default 'draft',
        items jsonb not null default '[]', featured jsonb not null default '{}', notes text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
  }

  // sort every deal that hasn't been sorted yet (or all, after the brand list changes)
  async function classify(all = false) {
    const rows = (await db.query(`select d.id, d.url, d.title, d.shop, d.raw_name, i.products, i.campaign, i.page_url from deals d left join intake i on i.id = d.source_intake
      ${all ? "" : "where d.kind is null or d.kind = 'Other' or d.brand is null or d.brand = 'Unknown'"}`)).rows;
    let n = 0;
    for (const d of rows) {
      const junk = t => !t || /^[(\[]?\s*(image|img|photo|picture|product( image)?)\s*\d*\s*[)\]]?\.?$/i.test(String(t).trim()) || !/[a-z]{3}/i.test(t);
      const cands = [d.raw_name, ((d.products || []).find(p => p.url === d.url) || {}).name, d.title];
      const raw = cands.find(t => !junk(t)) || d.title || "";  // a photo caption like "(Image 0)." is not a name: use the cleaned title
      let kind = kindOf(raw);
      if (kind === "Other" && /denim|jean/i.test(`${d.campaign} ${d.page_url}`) && /flare|bootcut|skinny|straight|wide|crop|boyfriend|mom|barrel|baggy|slim|rise/i.test(raw)) kind = "Jeans"; // style-only jean names from a denim page
      await db.query("update deals set kind=$2, colour=$3, brand=$4, raw_name=$5 where id=$1",
        [d.id, kind, colourOf(raw, d.url), await brandOf(raw, d.shop), clean(raw, 200)]); n++;
    }
    return n;
  }

  async function importBrands(list, shop) {
    let n = 0;
    for (const b of (Array.isArray(list) ? list : []).slice(0, 5000)) {
      const name = clean(b.name, 80), url = /^https:\/\//.test(String(b.url || "")) ? clean(String(b.url).split("?")[0], 300) : null;
      if (!name) continue;
      await db.query(`insert into brands (name, url, shop) values ($1,$2,$3) on conflict (name) do update set url=coalesce(excluded.url, brands.url), shop=excluded.shop, updated_at=now()`, [name, url, clean(shop, 60) || "Revolve"]);
      n++;
    }
    brandList = null; const sorted = await classify(true);
    return { ok: true, brands: n, deals_sorted: sorted };
  }

  // ---------- the planner page ----------
  const money = (c, v) => (c || "£") + (v % 1 ? (+v).toFixed(2) : String(+v));
  const qs = (f, over) => { const o = { ...f, ...over }; return "?" + Object.entries(o).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"); };
  function where(f, skip) {
    const w = ["d.status in ('pending','live')", "(d.expires_at is null or d.expires_at > now())"], a = [];
    const add = (sql, v) => { a.push(v); w.push(sql.replace("$", "$" + a.length)); };
    if (f.kind && skip !== "kind") add("d.kind = $", f.kind);
    if (f.colour && skip !== "colour") add("d.colour = $", f.colour);
    if (f.brand && skip !== "brand") add("d.brand = $", f.brand);
    if (f.shop && skip !== "shop") add("d.shop = $", f.shop);
    if (f.status && skip !== "status") add("d.status = $", f.status);
    if (+f.off) add("d.off >= $", +f.off);
    if (+f.save) add("(d.was - d.now) >= $", +f.save);
    if (+f.max) add("d.now <= $", +f.max);
    if (f.q) { a.push("%" + f.q + "%"); w.push(`(d.title ilike $${a.length} or d.raw_name ilike $${a.length})`); }
    return { sql: w.join(" and "), args: a };
  }

  async function page(req, res, url) {
    const f = Object.fromEntries(["kind", "colour", "brand", "shop", "status", "off", "save", "max", "q", "event"].map(k => [k, clean(url.searchParams.get(k), 80)]));
    const counts = async field => { const w = where(f, field); return (await db.query(`select ${field} v, count(*) n from deals d where ${w.sql} group by 1 order by 2 desc`, w.args)).rows; };
    const [kinds, colours, brandsC, shops] = await Promise.all([counts("kind"), counts("colour"), counts("brand"), counts("shop")]);
    const w = where(f); const total = (await db.query(`select count(*) n from deals d where ${w.sql}`, w.args)).rows[0].n;
    const list = (await db.query(`select d.* from deals d where ${w.sql} order by d.off desc, d.now asc limit 300`, w.args)).rows;
    const events = (await db.query("select id, name, show_date, status, jsonb_array_length(items) n from sale_events order by id desc limit 30")).rows;
    const evSel = +f.event || (events[0] && events[0].id) || 0;
    const inEvent = new Set(evSel ? ((await db.query("select items from sale_events where id=$1", [evSel])).rows[0] || { items: [] }).items : []);
    const chips = (field, rows, label) => `<div class="pf"><b>${label}</b>${f[field] ? `<a class="on" href="${qs(f, { [field]: "" })}">${esc(f[field])} ✕</a>` : ""}${rows.filter(r => r.v !== f[field]).slice(0, field === "brand" ? 25 : 20).map(r => `<a href="${qs(f, { [field]: r.v })}">${esc(SHOP_NAMES[r.v] || r.v || "Not sorted")} <i>${r.n}</i></a>`).join("")}</div>`;
    const thumb = d => String((d.images || [])[0] || "").replace("/images/p4/n/z/", "/images/p4/n/uv/").replace(/(\/cdn\/shop\/[^"]*[?&])width=\d+/, "$1width=300");
    const row = d => `<label class="arow${inEvent.has(d.code) ? " inev" : ""}"><input type="checkbox" name="code" value="${d.code}" ${inEvent.has(d.code) ? "disabled" : ""}><img src="${esc(thumb(d))}" alt="" loading="lazy">
<span class="ainfo"><b>${money(d.cur, d.now)}</b> <span class="small">was ${money(d.cur, d.was)} · ${d.off}% off · save ${money(d.cur, Math.round(d.was - d.now))}</span><br><span>${esc(d.title)}</span><br>
<span class="small">${esc(d.kind || "")} · ${esc(d.colour || "")} · ${esc(d.brand || "")} · ${esc(SHOP_NAMES[d.shop] || d.shop || "")} · SNO ${d.code} · ${d.status === "live" ? "posted" : "waiting for approval"}${inEvent.has(d.code) ? " · <b>in this event</b>" : ""}</span></span></label>`;
    const est = n => Math.round((SECS_OPEN_CLOSE + n * SECS_ITEM + Math.ceil(n / 20) * SECS_SECTION) / 60);
    send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>SNO event planner</title>
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/deals.css"><style>
.pf{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}.pf b{min-width:92px;font-size:13px;color:#6b6b6b}
.pf a{border:1.5px solid #e2e2e2;border-radius:20px;padding:4px 12px;font-size:13px;font-weight:600;color:#222;text-decoration:none;background:#fff}.pf a i{font-style:normal;color:#d7262d;margin-left:4px}
.pf a.on{border-color:#d7262d;color:#d7262d}.nums{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:10px 0}.nums label{font-size:12px;color:#6b6b6b;font-weight:600}.nums input{width:120px}
.arow.inev{opacity:.55}.evbar{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1.5px solid #e2e2e2;padding:10px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.big{font-size:28px;font-weight:900;color:#d7262d}</style>
<main class="wrap" style="padding:20px 20px 60px;max-width:1100px"><a class="logo" href="/">SALE NOW ON</a> <span class="pill">Event planner</span>
<a href="/admin/deals" style="margin-left:12px;font-weight:700">Deals</a> <a href="/admin/events" style="margin-left:12px;font-weight:700">Events</a> <a href="/admin/stats" style="margin-left:12px;font-weight:700">Analytics</a>
<p style="margin:14px 0 4px"><span class="big">${total}</span> items match · enough for about a ${est(+total)}-minute show</p>
${chips("kind", kinds, "Kind of item")}${chips("colour", colours, "Colour")}${chips("brand", brandsC, "Brand")}${chips("shop", shops, "Shop")}
<form class="nums" method="get">${["kind", "colour", "brand", "shop", "status", "event"].map(k => f[k] ? `<input type="hidden" name="${k}" value="${esc(f[k])}">` : "").join("")}
<label>At least % off<br><input name="off" inputmode="numeric" value="${esc(f.off)}" placeholder="e.g. 30"></label>
<label>At least £ saved<br><input name="save" inputmode="numeric" value="${esc(f.save)}" placeholder="e.g. 20"></label>
<label>Now under £<br><input name="max" inputmode="numeric" value="${esc(f.max)}" placeholder="e.g. 150"></label>
<label>Name contains<br><input name="q" value="${esc(f.q)}" placeholder="e.g. midi"></label>
<button class="btn">Apply</button> <a href="/admin/planner" style="align-self:center">Clear all</a></form>
<form method="post" action="/admin/planner/add">${Object.entries(f).map(([k, v]) => v ? `<input type="hidden" name="f_${k}" value="${esc(v)}">` : "").join("")}
<div class="evbar"><b>Put ticked items into</b>
<select name="event">${events.map(e => `<option value="${e.id}" ${e.id === evSel ? "selected" : ""}>${esc(e.name)}${e.show_date ? " · " + e.show_date.toISOString().slice(0, 10) : ""} (${e.n})</option>`).join("")}<option value="new" ${events.length ? "" : "selected"}>A new event…</option></select>
<input name="newname" placeholder="New event name, e.g. Black Dress Sale" style="width:260px">
<button class="btn" name="act" value="ticked">Add ticked</button><button class="btn ghost" name="act" value="all">Add all ${Math.min(+total, 300)} shown</button>
<button type="button" class="btn ghost" onclick="document.querySelectorAll('.arow input:not(:disabled)').forEach(i=>i.checked=true)">Tick all</button></div>
<div class="alist" style="margin-top:12px">${list.map(row).join("") || '<p class="lead">Nothing matches. Clear a filter.</p>'}</div></form>
${+total > 300 ? '<p class="small">Showing the 300 biggest savings. Narrow the filters to see the rest.</p>' : ""}</main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  async function body(req) { let b = ""; for await (const c of req) { b += c; if (b.length > 400000) break; } return new URLSearchParams(b); }

  async function add(req, res) {
    const f = await body(req); let ev = f.get("event");
    if (ev === "new") {
      const name = clean(f.get("newname"), 80) || "New sale event";
      ev = (await db.query("insert into sale_events (name) values ($1) returning id", [name])).rows[0].id;
    }
    ev = +ev; let codes = f.getAll("code").map(Number).filter(Boolean);
    if (f.get("act") === "all") {
      const filt = Object.fromEntries([...f.keys()].filter(k => k.startsWith("f_")).map(k => [k.slice(2), f.get(k)]));
      const w = where(filt); codes = (await db.query(`select d.code from deals d where ${w.sql} order by d.off desc limit 300`, w.args)).rows.map(r => r.code);
    }
    if (ev && codes.length) await db.query(`update sale_events set items = (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements(items || $2::jsonb) x), updated_at=now() where id=$1`, [ev, JSON.stringify(codes)]);
    const back = Object.fromEntries([...f.keys()].filter(k => k.startsWith("f_")).map(k => [k.slice(2), f.get(k)])); back.event = ev;
    res.writeHead(303, { ...SEC, Location: "/admin/planner" + qs(back, {}) }); res.end();
  }

  // ---------- events ----------
  async function eventsPage(req, res, url) {
    const m = /^\/admin\/events\/(\d+)$/.exec(url.pathname);
    if (req.method === "POST") {
      const f = await body(req), id = +(m ? m[1] : f.get("id")), act = f.get("act");
      if (act === "create") { const r = await db.query("insert into sale_events (name, show_date) values ($1, $2) returning id", [clean(f.get("name"), 80) || "New sale event", f.get("date") || null]); res.writeHead(303, { ...SEC, Location: "/admin/events/" + r.rows[0].id }); return res.end(); }
      if (act === "save") await db.query("update sale_events set name=$2, show_date=$3, notes=$4, updated_at=now() where id=$1", [id, clean(f.get("name"), 80), f.get("date") || null, clean(f.get("notes"), 500)]);
      if (act === "remove") await db.query("update sale_events set items = (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(items) x where x::int <> all($2::int[])), updated_at=now() where id=$1", [id, f.getAll("code").map(Number)]);
      if (act === "featured") { const fe = {}; for (const [k, v] of f) if (k.startsWith("x_") && +v > 1) fe[k.slice(2)] = Math.min(3, +v); await db.query("update sale_events set featured=$2, updated_at=now() where id=$1", [id, JSON.stringify(fe)]); }
      if (act === "request") await db.query("update sale_events set status='requested', updated_at=now() where id=$1 and jsonb_array_length(items) > 0", [id]);
      if (act === "draft") await db.query("update sale_events set status='draft', updated_at=now() where id=$1", [id]);
      if (act === "delete") { await db.query("delete from sale_events where id=$1", [id]); res.writeHead(303, { ...SEC, Location: "/admin/events" }); return res.end(); }
      res.writeHead(303, { ...SEC, Location: "/admin/events/" + id }); return res.end();
    }
    const head = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>SNO events</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/deals.css">
<main class="wrap" style="padding:20px 20px 60px;max-width:1000px"><a class="logo" href="/">SALE NOW ON</a> <span class="pill">Events</span> <a href="/admin/planner" style="margin-left:12px;font-weight:700">Event planner</a> <a href="/admin/deals" style="margin-left:12px;font-weight:700">Deals</a>`;
    const statusLabel = s => ({ draft: "Draft", requested: "Video requested: waiting to be built", building: "Video being built", ready: "Video ready" }[s] || s);
    if (!m) {
      const evs = (await db.query("select id, name, show_date, status, jsonb_array_length(items) n from sale_events order by coalesce(show_date, '2100-01-01'), id")).rows;
      return send(res, 200, head + `<h1 style="font-size:34px;margin:16px 0">Sale events</h1>
<form method="post" class="pubbox"><input type="hidden" name="act" value="create"><input name="name" placeholder="Event name, e.g. Red Dress Sale" required style="flex:1;min-width:220px"><input type="date" name="date"><button class="btn">Create event</button></form>
<div class="alist" style="margin-top:14px">${evs.map(e => `<a class="dcard" style="padding:14px 16px" href="/admin/events/${e.id}"><span class="dinfo"><span class="dname">${esc(e.name)}</span><span class="dcode">${e.show_date ? e.show_date.toISOString().slice(0, 10) + " · " : ""}${e.n} items · ${statusLabel(e.status)}</span></span></a>`).join("") || '<p class="lead">No events yet. Create one, or add items from the event planner.</p>'}</div></main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
    }
    const ev = (await db.query("select * from sale_events where id=$1", [+m[1]])).rows[0];
    if (!ev) return send(res, 404, "No such event", "text/plain");
    const items = ev.items.length ? (await db.query("select * from deals where code = any($1) order by kind, off desc", [ev.items])).rows : [];
    const byKind = {}; for (const d of items) (byKind[d.kind || "Other"] ||= []).push(d);
    const feat = ev.featured || {}; const nf = Object.keys(feat).length;
    const secs = SECS_OPEN_CLOSE + (items.length - nf) * SECS_ITEM + Object.values(feat).reduce((a, x) => a + SECS_FEATURED * (x / 2.5), 0) + Object.keys(byKind).length * SECS_SECTION;
    const expiringSoon = items.filter(d => d.expires_at && new Date(d.expires_at) - Date.now() < 3 * 86400000).length;
    const waiting = items.filter(d => d.status !== "live").length;
    const thumb = d => String((d.images || [])[0] || "").replace("/images/p4/n/z/", "/images/p4/n/uv/").replace(/(\/cdn\/shop\/[^"]*[?&])width=\d+/, "$1width=300");
    send(res, 200, head + `<form method="post" class="pubbox" style="margin-top:16px"><input type="hidden" name="act" value="save">
<input name="name" value="${esc(ev.name)}" style="flex:1;min-width:220px;font-weight:800"><input type="date" name="date" value="${ev.show_date ? ev.show_date.toISOString().slice(0, 10) : ""}"><input name="notes" value="${esc(ev.notes || "")}" placeholder="Notes" style="flex:1;min-width:160px"><button class="btn ghost">Save</button></form>
<p style="margin:12px 0"><b style="font-size:26px;color:#d7262d">${items.length}</b> item${items.length === 1 ? "" : "s"} in ${Object.keys(byKind).length} section${Object.keys(byKind).length === 1 ? "" : "s"} · about <b>${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s</b> of show · ${nf} featured · <b>${statusLabel(ev.status)}</b></p>
${waiting ? `<p class="small" style="color:#a31c22">${waiting} of these items are still waiting for approval. They are approved automatically when the video is built.</p>` : ""}
${expiringSoon ? `<p class="small" style="color:#a31c22">${expiringSoon} items expire within 3 days: send their pages again from Chrome to refresh the prices before the show.</p>` : ""}
<form method="post">
<div class="abar">${ev.status === "draft" ? `<button class="btn" name="act" value="request" onclick="return confirm('Request the show video for these ${items.length} items?')">Create the show video</button>` : `<button class="btn ghost" name="act" value="draft">Back to draft</button>`}
<button class="btn ghost" name="act" value="featured">Save featured slots</button><button class="btn ghost" name="act" value="remove">Remove ticked</button>
<a class="btn ghost" href="/admin/planner?event=${ev.id}">Add more items</a><button class="btn ghost" name="act" value="delete" onclick="return confirm('Delete this event? The deals stay.')">Delete event</button></div>
${Object.entries(byKind).map(([k, ds]) => `<h2 style="margin:22px 0 8px">${esc(k)} · ${ds.length}</h2><div class="alist">${ds.map(d => `<label class="arow"><input type="checkbox" name="code" value="${d.code}"><img src="${esc(thumb(d))}" alt="" loading="lazy">
<span class="ainfo"><b>${money(d.cur, d.now)}</b> <span class="small">was ${money(d.cur, d.was)} · ${d.off}% off</span><br><span>${esc(d.title)}</span><br><span class="small">${esc(d.colour || "")} · ${esc(d.brand || "")} · SNO ${d.code}</span></span>
<select name="x_${d.code}" title="Paid featured slot" style="margin-left:auto"><option value="1">Normal</option><option value="2" ${feat[d.code] == 2 ? "selected" : ""}>Featured 2×</option><option value="3" ${feat[d.code] == 3 ? "selected" : ""}>Featured 3×</option></select></label>`).join("")}</div>`).join("") || '<p class="lead">No items yet. Use the event planner to add some.</p>'}
</form></main>`, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  }

  // for the show builder: an event's items in show order, with featured marks; marks the items live when requested
  async function eventFeed(id) {
    const ev = (await db.query("select * from sale_events where id=$1", [id])).rows[0]; if (!ev) return null;
    const items = ev.items.length ? (await db.query("select code, title, kind, colour, brand, now::float, was::float, cur, off, images, checked_at, status from deals where code = any($1) order by kind, off desc", [ev.items])).rows : [];
    const sections = []; for (const d of items) { let s = sections.find(x => x.name === (d.kind || "Other")); if (!s) sections.push(s = { name: d.kind || "Other", items: [] }); if (ev.featured[d.code]) d.featured = ev.featured[d.code]; s.items.push(d); }
    return { id: ev.id, title: "The Weekend Sale Now On", event: ev.name, date: ev.show_date ? ev.show_date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" }) : "", status: ev.status, sections };
  }
  async function setEventStatus(id, status) {
    if (!["building", "ready", "draft", "requested"].includes(status)) return false;
    if (status === "building") await db.query("update deals set status='live', decided_at=now() where code in (select (x #>> '{}')::int from sale_events, jsonb_array_elements(items) x where sale_events.id=$1) and status='pending'", [id]);
    await db.query("update sale_events set status=$2, updated_at=now() where id=$1", [id, status]); return true;
  }

  return { migrate, classify, importBrands, page, add, eventsPage, eventFeed, setEventStatus, kindOf, colourOf };
};
