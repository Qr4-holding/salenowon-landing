const SERVER = "https://salenowon.co.uk";
const DEFAULT_KEY = ""; // never commit the key: paste it once in the extension's Settings box
const $ = id => document.getElementById(id);
let payload = null;

function money(cur, v) { return cur + (v % 1 ? v.toFixed(2) : v); }
function show(el, on) { el.hidden = !on; }

async function getKey() {
  const s = await chrome.storage.local.get("key");
  return s.key || DEFAULT_KEY;
}

async function read() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) { $("status").textContent = "Open a retailer's sale page first, then click the button."; return; }
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snoExtract });
  } catch (e) { $("status").textContent = "This page can't be read. Try the retailer's sale page itself."; return; }
  payload = res && res.result;
  if (payload && payload.error) { $("status").textContent = "The reader hit a problem on this page: " + payload.error; return; }
  if (payload && payload.kind === "links" && payload.count) {
    show($("status"), false); show($("found"), true);
    $("count").textContent = payload.count; document.querySelector(".big").lastChild.textContent = " brands found";
    $("skipped").textContent = (payload.host || "") + " · brand names and their page links";
    const ul = $("preview"); ul.textContent = "";
    payload.links.slice(0, 12).forEach(l => { const li = document.createElement("li"); const n = document.createElement("div"); n.className = "n"; n.textContent = l.name; li.append(n); ul.append(li); });
    $("campaign").value = "Revolve designers"; return;
  }
  if (!payload || !payload.count) {
    $("status").textContent = "No sale products with a Was and Now price found on this page. Scroll down so the products load, then click again.";
    return;
  }
  show($("status"), false); show($("found"), true);
  $("count").textContent = payload.count;
  $("skipped").textContent = (payload.host || "") + (payload.skipped ? " · " + payload.skipped + " items without a clear Was price left out" : "");
  const ul = $("preview"); ul.textContent = "";
  payload.products.slice().sort((a, b) => b.off - a.off).slice(0, 12).forEach(p => {
    const li = document.createElement("li");
    const img = document.createElement("img"); if (p.image) img.src = p.image; img.alt = "";
    const n = document.createElement("div"); n.className = "n"; n.textContent = p.name;
    const pr = document.createElement("div"); pr.className = "p";
    const b = document.createElement("b"); b.textContent = money(p.cur, p.now);
    const s = document.createElement("s"); s.textContent = " " + money(p.cur, p.was);
    pr.append(b, s, document.createTextNode(" " + p.off + "%"));
    li.append(img, n, pr); ul.append(li);
  });
  const guess = (payload.page_title || "").split(/[|\-–]/)[0].replace(/sale/ig, "").trim();
  $("campaign").value = guess.slice(0, 40);
}

$("send").addEventListener("click", async () => {
  const name = $("campaign").value.trim();
  if (!name) { $("campaign").focus(); return; }
  $("send").disabled = true; show($("result"), false);
  try {
    const r = await fetch(SERVER + "/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SNO-Key": await getKey() },
      body: JSON.stringify(Object.assign({ campaign: name }, payload))
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("Server said " + r.status));
    $("result").className = "result ok";
    $("result").textContent = "Sent " + payload.count + (payload.kind === "links" ? " brands" : " products") + " as \"" + name + "\". You can close this.";
  } catch (e) {
    $("result").className = "result err"; $("result").textContent = "Not sent: " + e.message;
  } finally { show($("result"), true); $("send").disabled = false; }
});

$("dash").addEventListener("click", async () => {
  $("dash").textContent = "Opening…";
  try {
    const r = await fetch(SERVER + "/api/admin-link", { method: "POST", headers: { "X-SNO-Key": await getKey() } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || ("Server said " + r.status));
    chrome.tabs.create({ url: j.url }); window.close();
  } catch (e) { $("dash").textContent = "Open my dashboard"; $("result").className = "result err"; $("result").textContent = "Could not open the dashboard: " + e.message; show($("result"), true); }
});
$("settings").addEventListener("click", async () => { $("key").value = await getKey(); show($("settingsBox"), $("settingsBox").hidden); });
$("saveKey").addEventListener("click", async () => { await chrome.storage.local.set({ key: $("key").value.trim() }); show($("settingsBox"), false); });

read();
