// Runs inside the retailer page the user is viewing. Self-contained: no outside references.
function snoExtract() {
 try {
  // A brand directory (e.g. revolve.com/designers): send the brand names and their page links instead of products.
  if (/\/(designers|brands)(\/|$)/i.test(location.pathname)) {
    const seen = new Map();
    for (const a of document.querySelectorAll("a[href]")) {
      const t = (a.textContent || "").replace(/\s+/g, " ").trim(), href = a.getAttribute("href") || "";
      let u; try { u = new URL(href, location.href); } catch (e) { continue; }
      if (u.hostname !== location.hostname || !t || t.length > 60 || /^(view all|see all|sale|new|home|designers)$/i.test(t)) continue;
      if (!/\/br\//.test(u.pathname)) continue;  // brand pages on Revolve look like /brand-name/br/abc123/
      const url = u.origin + u.pathname;
      if (!seen.has(url)) seen.set(url, { name: t, url });
    }
    const links = [...seen.values()];
    return { kind: "links", page_url: location.href, page_title: document.title, host: location.hostname, count: links.length, links: links.slice(0, 3000), products: [] };
  }
  const PRICE = /(£|\$|€)\s?(\d{1,3}(?:[,]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  const HASPRICE = /[£$€]\s?\d/;
  const toNum = s => parseFloat(String(s).replace(/,/g, ""));
  const prices = text => { const out = []; let m; PRICE.lastIndex = 0; while ((m = PRICE.exec(text))) out.push({ cur: m[1], v: toNum(m[2]) }); return out; };
  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  const struck = el => {
    if (!el || el.nodeType !== 1) return false;
    const t = el.tagName;
    if (t === "S" || t === "DEL" || t === "STRIKE") return true;
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
    if (/(^|[-_\s])(was|old|original|previous|strike|rrp|compare|before|list-?price)([-_\s]|$)/i.test(cls)) return true;
    const st = getComputedStyle(el);
    return /line-through/.test(st.textDecorationLine || st.textDecoration || "");
  };
  const bestImg = root => {
    const imgs = [...root.querySelectorAll("img")].filter(i => i.offsetWidth > 40 || i.getAttribute("width") > 40);
    const i = imgs[0] || root.querySelector("img");
    if (!i) { const s = root.querySelector("source[srcset]"); return s ? abs(s.getAttribute("srcset").split(/,\s+/).pop().trim().split(" ")[0]) : null; }
    const ss = i.getAttribute("srcset") || i.getAttribute("data-srcset");
    if (ss) { const last = ss.split(/,\s+/).map(x => x.trim().split(" ")[0]).filter(Boolean).pop(); if (last) return abs(last); }
    const cands = [i.currentSrc, i.getAttribute("data-src"), i.getAttribute("data-lazy-src"), i.getAttribute("data-original"), i.getAttribute("src")].filter(u => u && !/^data:/.test(u));
    return cands.length ? abs(cands[0]) : null;
  };
  // a photo caption like "(Image 0)" or "product image" is not a name
  const junkName = t => !t || t.length < 4 || /^[(\[]?\s*(image|img|photo|picture|product( image)?)\s*\d*\s*[)\]]?\.?$/i.test(t.trim()) || !/[a-z]{3}/i.test(t);
  const fromUrl = u => { try { const seg = new URL(u, location.href).pathname.split("/").filter(Boolean).pop() || ""; return /[a-z]-[a-z]/i.test(seg) ? seg.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : ""; } catch (e) { return ""; } };
  const nameIn = (box, img, url) => {
    let name = (img && img.getAttribute("alt")) || "";
    if (junkName(name)) name = "";
    if (!name) {
      name = [...box.querySelectorAll("a, h2, h3, h4, p, span, div")].map(e => (e.childElementCount ? "" : e.textContent.trim()))
        .filter(t => t && !HASPRICE.test(t) && t.length > 3 && t.length < 90 && !/%|off|sale|new|save/i.test(t) && !junkName(t))[0] || "";
    }
    if (!name && url) name = fromUrl(url);
    return name.replace(/\s+/g, " ").trim();
  };
  const products = new Map(); let skipped = 0;

  // 1. Price cards the shopper can see: a struck-through "was" price near a lower "now" price.
  const candidates = [...document.querySelectorAll("s, del, strike, [class*='was'], [class*='Was'], [class*='original'], [class*='Original'], [class*='previous'], [class*='Previous'], [class*='old'], [class*='strike'], [class*='rrp'], [class*='compare'], span, div")]
    .filter(el => el.children.length <= 2 && el.textContent.length < 40 && prices(el.textContent).length === 1 && struck(el));
  for (const wasEl of candidates) {
    let card = wasEl, hops = 0;
    while (card && hops < 10 && !(card.querySelector("img, source[srcset]") && (card.tagName === "A" || card.querySelector("a[href]")))) { card = card.parentElement; hops++; }
    if (!card || hops >= 10) { skipped++; continue; }
    const was = prices(wasEl.textContent)[0];
    const others = prices(card.innerText || card.textContent).filter(p => p.v < was.v && p.cur === was.cur);
    if (!others.length) { skipped++; continue; }
    const now = others.reduce((a, b) => (b.v < a.v ? b : a));
    const link = card.tagName === "A" ? card : card.querySelector("a[href]");
    const url = (abs(link.getAttribute("href")) || "").split("#")[0];
    if (!url || products.has(url)) continue;
    const img = card.querySelector("img");
    const name = nameIn(card, img, url);
    if (!name) { skipped++; continue; }
    products.set(url, { name: name.replace(/\s+/g, " ").trim(), was: was.v, now: now.v, cur: was.cur, off: Math.round(100 * (1 - now.v / was.v)), url, image: bestImg(card) });
  }

  // 1b. Product tiles: a link with a picture, inside the smallest box that shows two different prices.
  if (products.size < 3) {
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      if (!a.querySelector("img, picture")) continue;
      const url = (abs(a.getAttribute("href")) || "").split("#")[0];
      if (!url || seen.has(url) || products.has(url)) continue;
      seen.add(url);
      let box = a, hops = 0, ps = [];
      while (box && hops < 8) { ps = prices(box.innerText || ""); if (ps.length >= 2) break; box = box.parentElement; hops++; }
      if (!box || ps.length < 2 || ps.length > 4) continue;
      const tiles = new Set([...box.querySelectorAll("a[href]")].filter(x => x.querySelector("img, picture")).map(x => (abs(x.getAttribute("href")) || "").split("#")[0]));
      if (tiles.size > 1) continue; // box holds several products: not one tile
      const same = ps.filter(p => p.cur === ps[0].cur).map(p => p.v);
      const was = Math.max(...same), now = Math.min(...same);
      if (!(was > now)) continue;
      const name = nameIn(box, a.querySelector("img"), url);
      if (!name) { skipped++; continue; }
      products.set(url, { name, was, now, cur: ps[0].cur, off: Math.round(100 * (1 - now / was)), url, image: bestImg(box) });
    }
  }

  // 2. Product data the page ships with (e.g. Next.js pages): objects with a title, link and two prices.
  if (products.size < 3) {
    const nd = document.getElementById("__NEXT_DATA__");
    if (nd) {
      try {
        const walk = o => {
          if (Array.isArray(o)) return o.forEach(walk);
          if (!o || typeof o !== "object") return;
          const title = o.title || o.name || o.productName;
          const link = o.seoPath || o.url || o.href || o.productUrl;
          const p = o.price && typeof o.price === "object" ? o.price : o;
          const nowV = (p.listPrice && p.listPrice.amount) || p.currentPrice || p.nowPrice || p.salePrice;
          const wasV = p.previousPrice || p.wasPrice || p.originalPrice || p.rrp;
          if (title && link && nowV && wasV && +wasV > +nowV) {
            const url = abs(String(link).split("?")[0]);
            if (url && !products.has(url)) {
              const asset = (o.variants || []).flatMap(v => v.mediaAssets || []).find(a => a.type === "Main");
              products.set(url, { name: String(title), was: +wasV, now: +nowV, cur: p.currency === "GBP" ? "£" : (p.currency || "£"), off: Math.round(100 * (1 - nowV / wasV)), url,
                image: asset ? "https://assets.digitalcontent.marksandspencer.app/image/upload/w_1000,q_auto,f_jpg/" + asset.assetId : (o.image && (o.image.url || o.image)) || null });
            }
          }
          Object.values(o).forEach(walk);
        };
        walk(JSON.parse(nd.textContent));
      } catch (e) { /* page data not readable: ignore */ }
    }
  }
  const list = [...products.values()].filter(p => p.off >= 5 && p.off <= 95);
  return { page_url: location.href, page_title: document.title, host: location.hostname, count: list.length, skipped, products: list.slice(0, 200) };
 } catch (e) { return { error: String(e && e.message || e), count: 0, products: [] }; }
}
