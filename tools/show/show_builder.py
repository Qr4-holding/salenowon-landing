"""The Weekend Sale Now On, version 2: livelier long-form 16:9 show.

  python3 show2.py script SHOW.json OUT            -> OUT/vo-script.txt (one line per paragraph) + OUT/vo-lines.json
  (make the voiceover from vo-script.txt, save as OUT/vo-all.mp3)
  python3 show2.py split OUT                       -> OUT/vo/vo{i}.wav, one per line
  python3 show2.py build SHOW.json OUT [--jobs 2] [--no-render] [--mix-only]

What it adds over v1: the back view as the second photo, a presenter line inside every section, a section strip and
deal counter, a "coming up next" ribbon, a drifting background, a Guess the Price moment, a different music track
for every part, a hit on every section change and a "ding" when each price lands, and a YouTube chapter list.
"""
import json, pathlib, re, shutil, subprocess, sys, urllib.request, concurrent.futures as cf
import segno
import os
HERE = pathlib.Path(__file__).parent; SKEL = HERE / "skel"  # hyperframes.json + package.json for each part
UA = "SaleNowOnBot/0.1 (+https://salenowon.co.uk/bot)"
W, H = 1920, 1080; SECS = 3.0
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
def words(n):
    n = int(n)
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " and " + words(n % 100))
def pounds(v):
    p = round(v * 100) % 100
    return words(int(v)) + " pounds" + (f" {words(p)}" if p else "")
money = lambda cur, v: (cur or "£") + (f"{v:.2f}" if v % 1 else f"{int(v)}")
esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
dur_of = lambda f: float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)], capture_output=True, text=True).stdout)
spoken = lambda name: name.lower().replace("&", "and")

# ---------------- the script ----------------
COMMENTS = ["This one's my favourite.", "That's a proper bargain.", "I love this one.", "Really good value, this.",
            "I'd snap this one up.", "Such a nice cut on this one.", "This is a great one for the weekend.", "One of my picks this week.",
            "Honestly, that's a steal.", "This would go with everything."]  # opinions only: never invented facts like "almost sold out"

def host_line(it, kind, n, second):
    """The host's line for one product: its price, a short description, or her opinion."""
    if kind == "price": t = f"Was {pounds(it['was'])}, now {pounds(it['now'])}."
    elif kind == "price_short": t = f"Now {pounds(it['now'])}."
    elif kind == "item":  # every normal product: its name, the Was price and the Sale Now On price
        was = words(int(it['was'])) if it['was'] == int(it['was']) else pounds(it['was'])
        joiner = ["now", "now only", "Sale Now On,"][n % 3]  # rotate the wording so a long show doesn't sound like a loop
        return f"The {re.sub(r'^the ', '', it['title'], flags=re.I)}. Was {was}, {joiner} {pounds(it['now'])}."
    elif kind == "featured":  # paid slot: the full description and both prices
        sp = second.get(str(it["code"])); back = bool(sp and sp[1] == "Back view")
        plural = it["title"].split()[-1].lower() in ("jeans", "shorts", "pants", "trousers", "leggings", "joggers", "overalls")
        return (f"Here {'are' if plural else 'is'} the {re.sub(r'^the ', '', it['title'], flags=re.I)}{', and that is the back view' if back else ''}. "
                f"Was {pounds(it['was'])}, Sale Now On, {pounds(it['now'])}. That's {words(it['off'])} percent off.")
    elif kind == "desc":
        sp = second.get(str(it["code"])); back = bool(sp and sp[1] == "Back view")
        plural = it["title"].split()[-1].lower() in ("jeans", "shorts", "pants", "trousers", "leggings", "joggers", "overalls")
        t = f"Here {'are' if plural else 'is'} the {re.sub(r'^the ', '', it['title'], flags=re.I)}{', and that is the back view' if back else ''}."
    else: t = COMMENTS[n % len(COMMENTS)]
    return t if len(t) / 15 <= 2.6 else COMMENTS[n % len(COMMENTS)]  # a normal product's line must fit its own 3 seconds

def plan_lines(show, second=None):
    """Every line the host says, in order, with where it goes: a line on every second product, rotating price / description / opinion."""
    second = second or {}
    secs = show["sections"]; L = []
    L.append(("open", None, "This is the Weekend Sale Now On. The biggest savings we found this week, all in one place."))
    intro = ["First up, {n}, and there are some proper bargains in here. Up to {u} percent off.",
             "Next, {n}. I love this lot. Up to {u} percent off.",
             "Now, {n}, and a few of these really caught my eye. Up to {u} percent off.",
             "Here come the {n}. Some lovely pieces in this one. Up to {u} percent off.",
             "And {n}. Great for the weekend. Up to {u} percent off.",
             "On to {n}. Up to {u} percent off, and worth a look."]
    outro = ["That's the {n}. My pick? The {t}, at {p}.", "That's all the {n}. If I had to choose one, it's the {t}.",
             "And that's the {n}. Don't miss the {t}, at {p}.", "That's the {n} done. My favourite was the {t}.",
             "That wraps up the {n}. The {t} is the one for me."]
    mid = ["Look at this one. Down from {was} to {now}.", "That's {off} percent off.", "Save {save} on this one.",
           "Under {cap} pounds. Not bad at all.", "One of the best in this section."]
    g = guess_item(show); kinds = ["price", "desc", "comment"]; n = 0
    for i, s in enumerate(secs):
        top = max(x["off"] for x in s["items"])
        L.append(("intro", i, intro[min(i, len(intro) - 1)].format(n=spoken(s["name"]), u=words(top))))
        for k, it in enumerate(s["items"]):  # every product gets a line; paid FEATURED slots get the full description
            L.append(("mid", i, k, host_line(it, "featured" if it.get("featured") else "item", n, second))); n += 1
        pick = max(s["items"], key=lambda x: (bool(x.get("featured")), x["off"]))
        L.append(("outro", i, outro[i % len(outro)].format(n=spoken(s["name"]), t=re.sub(r'^the ', '', pick["title"], flags=re.I), p=pounds(pick["now"]))))
        if i == 1 and show.get("guess"):
            L.append(("guess1", i, f"Time to play guess the price! This was {pounds(g['was'])}. What do you think it's down to? You've got five seconds."))
            L.append(("guess2", i, f"It's {pounds(g['now'])}! That's {words(g['off'])} percent off."))
    L.append(("close", None, "That's the show. Every deal is waiting at Sale Now On dot co dot uk. Scan the code on screen, or type in the deal code. See you next weekend."))
    return L

def guess_item(show):  # the most expensive item before the sale makes the best guessing game
    return max((it for s in show["sections"] for it in s["items"]), key=lambda x: x["was"])

def cmd_script(show_path, out):
    show = json.load(open(show_path)); out.mkdir(parents=True, exist_ok=True)
    second = json.load(open(out / "second-photo.json")) if (out / "second-photo.json").exists() else {}
    L = plan_lines(show, second)
    (out / "vo-script.txt").write_text("\n\n".join(x[-1] for x in L))
    (out / "vo-script-tts.txt").write_text(' <break time="0.8s" />\n\n'.join(x[-1] for x in L))  # what to send to the voice: a clear pause between lines
    json.dump(L, open(out / "vo-lines.json", "w"), indent=1); print(len(L), "lines ->", out / "vo-script.txt")

def _mono(f):
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(float) / 32768

def _db(x):
    import numpy as np
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9) if len(x) else -120.0

def cmd_split_words(out):
    """Cut the voiceover into lines with word timings, at the QUIETEST point between lines, with short fades.
    A fixed margin around the words is not safe: when the voice runs two lines together, it cuts into the next word."""
    import numpy as np
    L = json.load(open(out / "vo-lines.json")); src = out / "vo-all.mp3"; (out / "vo").mkdir(exist_ok=True)
    w = json.load(open(out / "words.json")); w = w.get("words", w) if isinstance(w, dict) else w
    w = [x for x in w if x.get("type", "word") == "word"]
    norm = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())
    pos, spans = 0, []
    for x in L:
        toks = [t for t in re.sub(r"<[^>]+>", " ", x[-1]).split() if norm(t)]
        got = w[pos:pos + len(toks)]
        if [norm(g["text"]) for g in got] != [norm(t) for t in toks]: sys.exit(f"transcript doesn't match line {len(spans)}: {x[-1]!r}")
        spans.append((got[0]["start"], got[-1]["end"])); pos += len(toks)
    a = _mono(src); sr = 16000; total = len(a) / sr; fr = int(0.02 * sr)
    def quietest(t0, t1):  # 20 ms frame with the least energy between t0 and t1
        t0, t1 = max(0, t0), min(total, t1)
        if t1 - t0 < 0.02: return (t0 + t1) / 2, -120
        best = min(range(int(t0 * sr), int(t1 * sr) - fr, fr // 2), key=lambda k: np.mean(a[k:k + fr] ** 2))
        return (best + fr / 2) / sr, _db(a[best:best + fr])
    cuts = [0.0]; levels = []; joined = []
    for k in range(len(spans) - 1):
        t, lvl = quietest(spans[k][1] - 0.05, spans[k + 1][0] + 0.05)
        cuts.append(t); levels.append(round(lvl, 1))
        if lvl > -45: joined.append(k)
    cuts.append(total)
    json.dump({"cuts": cuts, "levels": levels}, open(out / "vo" / "cuts.json", "w"))  # sound level at each cut, for the pre-check
    for k in range(len(L)):
        st, en = cuts[k], cuts[k + 1]
        # atrim + asetpts so the fades are timed from the start of THIS clip (an output-side -ss keeps the original clock)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af",
                        f"atrim=start={st:.3f}:end={en:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.015,afade=t=out:st={max(0, en - st - 0.04):.3f}:d=0.04",
                        str(out / "vo" / f"vo{k}.wav")], check=True)
    if joined:
        print("NO CLEAN GAP after lines", joined, "(the voice ran them together): regenerate with pauses between lines")
    precheck_vo(out)

def precheck_vo(out):
    """Refuse a voiceover where any line starts or ends mid-word (stutter / cut-off), or is far from its expected length."""
    L = json.load(open(out / "vo-lines.json")); bad = []
    cutinfo = json.load(open(out / "vo" / "cuts.json")) if (out / "vo" / "cuts.json").exists() else None
    for k, x in enumerate(L):
        clip = _mono(out / "vo" / f"vo{k}.wav"); n = int(0.06 * 16000)
        # skip the 15 / 40 ms fades themselves; measure just inside them
        head, tail = _db(clip[240:240 + n]), _db(clip[-(640 + n):-640])
        dur = len(clip) / 16000; words_n = len(re.sub(r"<[^>]+>", " ", x[-1]).split())
        level = _db(clip); loud = sum(1 for i in range(0, len(clip) - 320, 320) if _db(clip[i:i + 320]) > -35) * 0.02
        if level < -32 or loud < 0.12 * words_n: bad.append(f"line {k} is silent or nearly silent ({level:.0f} dB, {loud:.1f} s of speech): {x[-1][:50]}")
        if cutinfo:  # cut by us: the cut points themselves must be in silence
            if k > 0 and cutinfo["levels"][k - 1] > -45: bad.append(f"line {k} starts with a cut through speech ({cutinfo['levels'][k - 1]} dB): {x[-1][:50]}")
            if k < len(L) - 1 and cutinfo["levels"][k] > -45: bad.append(f"line {k} ends with a cut through speech ({cutinfo['levels'][k]} dB): {x[-1][:50]}")
        else:  # one clip per line: its edges must be quiet
            if head > -40 and k > 0: bad.append(f"line {k} starts mid-speech ({head:.0f} dB): {x[-1][:50]}")
            if tail > -40: bad.append(f"line {k} ends mid-speech ({tail:.0f} dB): {x[-1][:50]}")
        if dur < 0.18 * words_n or dur > 0.75 * words_n + 1.5: bad.append(f"line {k} is {dur:.1f} s for {words_n} words: {x[-1][:50]}")
    if bad: print("VOICE PRE-CHECK FAILED"); [print("  " + b) for b in bad]; sys.exit(1)
    print(f"voice pre-check passed: {len(L)} lines, all start and end in silence")

def cmd_split(out):
    L = json.load(open(out / "vo-lines.json")); n = len(L); src = out / "vo-all.mp3"; (out / "vo").mkdir(exist_ok=True)
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(src), "-af", "silencedetect=noise=-35dB:d=0.25", "-f", "null", "-"], capture_output=True, text=True).stderr
    gaps = list(zip(map(float, re.findall(r"silence_start: ([\d.]+)", r)), map(float, re.findall(r"silence_end: ([\d.]+)", r))))
    total = dur_of(src); chars = [len(x[-1]) for x in L]; cps = sum(chars) / total
    # choose the n-1 cuts that best match each line's expected length: dynamic programme over gaps in order
    mids = [(a + b) / 2 for a, b in gaps]; wgap = [b - a for a, b in gaps]
    exp_end = []; acc = 0
    for c in chars: acc += c / cps; exp_end.append(acc)
    best = {}
    def cost(k, j):  # line k ends at gap j
        return abs(mids[j] - exp_end[k]) - 2.0 * wgap[j]
    import functools
    @functools.lru_cache(None)
    def f(k, j):  # min cost placing cut for line k at gap j, with earlier cuts before j
        c = cost(k, j)
        if k == 0: return c, (j,)
        cands = [(f(k - 1, i)[0], i) for i in range(j)]
        if not cands: return 1e9, ()
        v, i = min(cands); return v + c, f(k - 1, i)[1] + (j,)
    v, cut = min(f(n - 2, j) for j in range(len(mids)))
    bounds = [0] + [mids[j] for j in cut] + [total]
    lens = []
    for i in range(n):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ss", f"{bounds[i]:.3f}", "-to", f"{bounds[i + 1]:.3f}", "-af",
                        "silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse",
                        str(out / "vo" / f"vo{i}.wav")], check=True)
        lens.append(round(dur_of(out / "vo" / f"vo{i}.wav"), 2))
    exp = [round(c / cps, 2) for c in chars]
    print("line lengths:", lens); print("expected    :", exp)
    bad = [i for i, (a, b) in enumerate(zip(lens, exp)) if abs(a - b) > max(1.2, 0.35 * b)]
    if bad: sys.exit(f"split looks wrong for lines {bad}: check before building")

# ---------------- visuals ----------------
CSS = """
:root { --red:#d7262d; --ink:#222; --grey:#6b6b6b; --line:#e2e2e2; }
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:1920px; height:1080px; overflow:hidden; background:#fff; }
#root { position:relative; width:100%; height:100%; font-family:"Poppins",sans-serif; color:var(--ink); }
.full { position:absolute; inset:0; } .redbg { background:var(--red); }
.wallrow { position:absolute; left:-200px; white-space:nowrap; font-weight:900; font-size:210px; line-height:1; color:rgba(255,255,255,.08); letter-spacing:-6px; }
.wallrow.g { color:rgba(0,0,0,.028); }
.ctr { position:absolute; left:0; right:0; text-align:center; color:#fff; font-weight:900; white-space:nowrap; }
.pa, .pb { position:absolute; overflow:hidden; border-radius:26px; border:2px solid var(--line); background:#fff; box-shadow:0 24px 60px rgba(0,0,0,.10); }
.pa img, .pb img { width:100%; height:100%; object-fit:cover; display:block; }
.pb { opacity:0; } .pb i { position:absolute; left:12px; bottom:12px; font-style:normal; background:rgba(255,255,255,.92); border-radius:20px; padding:2px 12px; font-size:22px; font-weight:700; color:var(--grey); }
.badge { position:absolute; width:150px; height:150px; border-radius:50%; background:var(--red); color:#fff; display:flex; flex-direction:column; align-items:center; justify-content:center; font-weight:900; line-height:1; box-shadow:0 16px 40px rgba(215,38,45,.35); }
.badge b { font-size:50px; letter-spacing:-2px; } .badge i { font-style:normal; font-size:22px; }
.lab { position:absolute; left:1110px; top:56px; border:2px solid var(--line); border-radius:40px; padding:6px 20px; font-size:28px; font-weight:700; color:var(--grey); white-space:nowrap; background:#fff; }
.next { position:absolute; left:1110px; top:50px; background:var(--red); color:#fff; border-radius:40px; padding:10px 26px; font-size:30px; font-weight:800; white-space:nowrap; opacity:0; box-shadow:0 12px 30px rgba(215,38,45,.3); }
.nm { position:absolute; left:1110px; top:140px; width:760px; font-size:64px; font-weight:900; letter-spacing:-2px; line-height:1.05; }
.was { position:absolute; left:1110px; top:350px; font-size:60px; font-weight:700; color:var(--grey); white-space:nowrap; }
.was span { position:relative; display:inline-block; }
.strike { position:absolute; left:-8px; right:-8px; top:52%; height:8px; background:var(--red); border-radius:4px; transform-origin:0 50%; }
.now { position:absolute; left:1100px; top:420px; font-size:200px; font-weight:900; color:var(--red); letter-spacing:-8px; line-height:1; white-space:nowrap; opacity:0; }
.qrb { position:absolute; left:1110px; top:660px; width:290px; height:290px; border:3px solid var(--red); border-radius:24px; background:#fff; }
.qrb img { position:absolute; left:25px; top:25px; width:240px; height:240px; }
.code { position:absolute; left:1430px; top:670px; width:440px; font-size:30px; font-weight:700; color:var(--grey); line-height:1.3; }
.code b { display:block; font-size:72px; color:var(--red); font-weight:900; letter-spacing:-2px; line-height:1.1; margin:6px 0 10px; }
.code small { display:block; font-size:22px; font-weight:600; }
.bar { position:absolute; left:0; right:0; top:1000px; height:80px; background:var(--red); color:#fff; display:flex; align-items:center; justify-content:space-between; padding:0 40px; font-weight:800; font-size:30px; white-space:nowrap; }
.strip { display:flex; gap:8px; font-size:22px; font-weight:700; }
.strip span { padding:5px 14px; border-radius:20px; color:rgba(255,255,255,.75); }
.strip span.on { background:#fff; color:var(--red); }
.cnt { font-size:26px; font-weight:800; }
.feat { position:absolute; left:20px; bottom:20px; background:var(--red); color:#fff; border-radius:16px; padding:8px 18px; font-size:34px; font-weight:900; letter-spacing:2px; line-height:1.05; z-index:3; }
.feat small { display:block; font-size:18px; font-weight:700; letter-spacing:0; opacity:.9; }
.cd { position:absolute; left:1300px; top:520px; width:300px; height:300px; border-radius:50%; border:10px solid var(--red); color:var(--red); font-size:190px; font-weight:900; display:flex; align-items:center; justify-content:center; opacity:0; background:#fff; }
"""

def wall(word, grey=False, rows=7):
    return "".join(f'<div class="wallrow{" g" if grey else ""}" data-layout-allow-overflow data-layout-ignore style="top:{r * 200 - 60}px">' + (word + " ") * 10 + "</div>" for r in range(rows))

def bar(show, cur, n_from, n_total):
    strip = "".join(f'<span class="{"on" if i == cur else ""}">{esc(s["name"])}</span>' for i, s in enumerate(show["sections"]))
    return f'<div class="bar"><b>SALE NOW ON .co.uk</b><div class="strip">{strip}</div><span class="cnt">Deal {n_from} of {n_total}</span></div>'

def project(out, html, js, total):
    out.mkdir(parents=True, exist_ok=True)
    for f in ("hyperframes.json", "package.json"): shutil.copy(SKEL / f, out / f)
    hf = json.load(open(out / "hyperframes.json")); hf["registryItems"] = []; json.dump(hf, open(out / "hyperframes.json", "w"), indent=2)
    json.dump({"id": out.name, "name": out.name, "createdAt": "2026-11-04T12:00:00Z"}, open(out / "meta.json", "w"))
    (out / "index.html").write_text(f'''<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width={W}, height={H}" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><style>{CSS}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{total:.2f}" data-width="{W}" data-height="{H}">
{html}
<div id="adtag" class="clip" data-start="0" data-duration="{total:.2f}" data-track-index="60" style="z-index:90;position:absolute;right:28px;top:24px;background:#fff;color:#222;font-weight:800;font-size:28px;padding:4px 14px;border-radius:8px;border:2px solid #e2e2e2">Ad</div>
</div><script>
window.__timelines = window.__timelines || {{}};
const tl = gsap.timeline({{ paused: true }});
tl.fromTo(".wallrow", {{ x: 0 }}, {{ x: -420, duration: {total:.2f}, ease: "none" }}, 0);
{js}
window.__timelines["main"] = tl; tl.seek(0);
</script></body></html>''')

def product_slot(show, sec_i, k, it, s, a, b, n_in_sec, deal_no, n_total, upnext, dur=SECS, photos=None):
    nxt = (f'<div class="next" data-layout-allow-occlusion data-layout-allow-overlap>Coming up next: {esc(upnext)}</div>' if upnext else "")
    html = f'''<div id="p{k}" class="clip full" data-start="{s:.2f}" data-duration="{dur + 0.4:.2f}" data-track-index="{3 + k}" style="z-index:{3 + k};background:#fff" data-layout-allow-occlusion data-layout-allow-overlap><div class="pin full">{wall("SALE", True, 6)}
<div class="pa" style="left:70px;top:50px;width:600px;height:900px" data-layout-allow-occlusion data-layout-allow-overlap>{"".join(f'<img class="fx{j}" src="{u}" alt="" style="position:absolute;inset:0;{"" if j == 0 else "opacity:0"}" />' for j, u in enumerate(photos)) if photos else f'<img src="{a}" alt="" />'}
{'<div class="feat" data-layout-allow-occlusion data-layout-allow-overlap>FEATURED<small>Paid placement</small></div>' if it.get("featured") else ""}</div>
{f'<div class="pb" style="left:700px;top:330px;width:380px;height:570px" data-layout-allow-occlusion data-layout-allow-overlap><img src="{b[0]}" alt="" /><i>{b[1]}</i></div>' if b else ""}
<div class="badge" style="left:560px;top:20px" data-layout-allow-occlusion data-layout-allow-overlap><b>{it["off"]}%</b><i>OFF</i></div>
<div class="lab">{esc(show["sections"][sec_i]["name"])} · {k + 1} of {n_in_sec}</div>{nxt}
<div class="nm">{esc(it["title"])}</div>
<div class="was">Was <span>{money(it["cur"], it["was"])}<div class="strike"></div></span></div>
<div class="now">{money(it["cur"], it["now"])}</div>
<div class="qrb"><img src="assets/qr-{it["code"]}.svg" alt="" /></div>
<div class="code">Scan, or enter the deal code at SaleNowOn.co.uk<b>SNO {it["code"]}</b><small>Prices set by the shop and can change · checked {esc(it.get("checked", ""))}</small></div>
{bar(show, sec_i, deal_no, n_total)}</div></div>'''
    js = [f'tl.fromTo("#p{k} .pin", {{ x: {W} }}, {{ x: 0, duration: 0.35, ease: "power3.out", immediateRender: false }}, {s:.2f});',
          f'tl.fromTo("#p{k} .pa img", {{ scale: 1.07 }}, {{ scale: 1, duration: {dur + 0.4:.2f}, ease: "none", immediateRender: false }}, {s:.2f});',
          f'tl.fromTo("#p{k} .badge", {{ scale: 0, rotation: -30 }}, {{ scale: 1, rotation: 0, duration: 0.3, ease: "back.out(2.5)", immediateRender: false }}, {s + 0.35:.2f});',
          f'tl.fromTo("#p{k} .strike", {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.25, immediateRender: false }}, {s + 0.45:.2f});',
          f'tl.fromTo("#p{k} .now", {{ opacity: 0, scale: 0.5 }}, {{ opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)", immediateRender: false }}, {s + 0.55:.2f});']
    if photos and len(photos) > 1:  # featured: cycle through the shop's photos
        step = dur / len(photos)
        for j in range(1, len(photos)): js.append(f'tl.fromTo("#p{k} .fx{j}", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.4, immediateRender: false }}, {s + j * step:.2f});')
    if b: js.append(f'tl.fromTo("#p{k} .pb", {{ opacity: 0, x: 60 }}, {{ opacity: 1, x: 0, duration: 0.35, ease: "power2.out", immediateRender: false }}, {s + 0.8:.2f});')
    if upnext: js += [f'tl.fromTo("#p{k} .next", {{ opacity: 0, x: 80 }}, {{ opacity: 1, x: 0, duration: 0.4, ease: "back.out(1.8)", immediateRender: false }}, {s + 1.0:.2f});',
                      f'tl.to("#p{k} .lab", {{ opacity: 0, duration: 0.2 }}, {s + 1.0:.2f});']
    return html, js, [(s + 0.6, "ding")]

# ---------------- audio pieces ----------------
def sfx(out):
    import numpy as np, wave
    SR = 44100; out.mkdir(parents=True, exist_ok=True)
    def save(name, x):
        x = x / max(1e-9, np.max(np.abs(x))) * 0.9; st = np.stack([x, x], 1)
        with wave.open(str(out / f"{name}.wav"), "wb") as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype("<i2").tobytes())
    t = np.arange(int(SR * 0.9)) / SR  # section hit: boom + noise sweep
    hit = np.exp(-t * 6) * np.sin(2 * np.pi * (45 + 120 * np.exp(-t * 30)) * t) + 0.25 * np.random.default_rng(1).uniform(-1, 1, len(t)) * np.exp(-t * 9)
    save("hit", hit)
    t = np.arange(int(SR * 0.6)) / SR  # price ding
    save("ding", np.exp(-t * 7) * (np.sin(2 * np.pi * 1568 * t) + 0.6 * np.sin(2 * np.pi * 2093 * t) + 0.2 * np.sin(2 * np.pi * 3136 * t)))
    t = np.arange(int(SR * 0.12)) / SR  # countdown tick
    save("tick", np.exp(-t * 40) * np.sin(2 * np.pi * 1000 * t))
    t = np.arange(int(SR * 1.4)) / SR  # reveal: bright chord stab
    save("reveal", np.exp(-t * 2.5) * sum(np.sin(2 * np.pi * f * t) for f in (523.25, 659.25, 783.99, 1046.5)) + 0.4 * np.exp(-t * 20) * np.random.default_rng(2).uniform(-1, 1, len(t)))

STYLES = [dict(bpm=116, key=0, prog=0), dict(bpm=124, key=2, prog=1), dict(bpm=108, key=-3, prog=2), dict(bpm=128, key=5, prog=3),
          dict(bpm=112, key=-1, prog=1), dict(bpm=120, key=3, prog=0), dict(bpm=100, key=-5, prog=2), dict(bpm=132, key=1, prog=3)]

def music_part(seconds, style, dest):
    import numpy as np, wave
    SR = 44100; n = int(SR * seconds); out = np.zeros(n); beat = 60 / style["bpm"]; bar_ = beat * 4
    f = lambda m: 440 * 2 ** ((m + style["key"] - 69) / 12)
    progs = [[[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]],
             [[62, 65, 69, 72], [58, 62, 65, 69], [60, 64, 67, 71], [57, 60, 64, 67]],
             [[57, 60, 64, 67], [53, 57, 60, 64], [60, 64, 67, 71], [55, 59, 62, 67]],
             [[60, 64, 67, 72], [55, 59, 62, 67], [57, 60, 64, 69], [53, 57, 60, 65]]]
    chords = progs[style["prog"]]
    for bno in range(int(seconds / bar_) + 1):
        s0 = int(bno * bar_ * SR); s1 = min(n, int((bno + 1) * bar_ * SR)); L = s1 - s0
        if L <= 0: break
        tt = np.arange(L) / SR; env = np.minimum(1, tt / 0.2) * np.minimum(1, (L / SR - tt) / 0.25)
        for m in chords[bno % 4]:
            fr = f(m - 12); out[s0:s1] += 0.05 * env * (np.sin(2 * np.pi * fr * tt) + 0.3 * np.sin(2 * np.pi * 2 * fr * tt))
        bass = f(chords[bno % 4][0] - 24)
        for q in range(4):
            q0 = s0 + int(q * beat * SR); QL = min(int(beat * 0.9 * SR), n - q0)
            if QL > 0: tq = np.arange(QL) / SR; out[q0:q0 + QL] += 0.12 * np.exp(-tq * 5) * np.sin(2 * np.pi * bass * tq)
    step = beat / 2; pat = [[0, 2, 1, 3, 2, 1, 3, 2], [0, 1, 2, 3, 3, 2, 1, 0], [0, 3, 1, 2, 0, 3, 2, 1], [3, 2, 0, 1, 3, 2, 1, 2]][style["prog"]]
    for k in range(int(seconds / step)):
        s0 = int(k * step * SR); L = min(int(0.3 * SR), n - s0)
        if L <= 0: break
        m = chords[int(k * step / bar_) % 4][pat[k % 8]] + 12; tt = np.arange(L) / SR
        out[s0:s0 + L] += 0.07 * np.exp(-tt * 10) * np.sin(2 * np.pi * f(m) * tt)
    for k in range(int(seconds / beat)):
        s0 = int(k * beat * SR); L = min(int(0.25 * SR), n - s0); tt = np.arange(L) / SR
        out[s0:s0 + L] += 0.35 * np.exp(-tt * 18) * np.sin(2 * np.pi * (50 + 90 * np.exp(-tt * 40)) * tt)
        if k % 2: c0 = s0; CL = min(int(0.12 * SR), n - c0); out[c0:c0 + CL] += 0.12 * np.exp(-np.arange(CL) / SR * 30) * np.random.default_rng(k).uniform(-1, 1, CL)
        h0 = int((k + 0.5) * beat * SR); HL = min(int(0.05 * SR), n - h0)
        if HL > 0: out[h0:h0 + HL] += 0.05 * np.exp(-np.arange(HL) / SR * 80) * np.random.default_rng(k + 99).uniform(-1, 1, HL)
    fade = int(0.3 * SR); out[:fade] *= np.linspace(0, 1, fade); out[-fade:] *= np.linspace(1, 0, fade)
    out = out / np.max(np.abs(out)) * 0.8; st = np.stack([out, np.roll(out, 220) * 0.97], 1)
    with wave.open(str(dest), "wb") as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype("<i2").tobytes())

# ---------------- build ----------------
def fetch(url, dest):
    if dest.exists() and dest.stat().st_size > 2000: return True
    try: dest.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30).read()); return True
    except Exception: return False

def render(p):
    chk = subprocess.run("npx hyperframes check", shell=True, cwd=p, capture_output=True, text=True)
    if "Check passed" not in chk.stdout + chk.stderr: return p.name, "check failed:\n" + chk.stdout[-1500:]
    r = subprocess.run("npx hyperframes render -o part.mp4 --quiet", shell=True, cwd=p, capture_output=True, text=True)
    return p.name, "ok" if r.returncode == 0 else "render failed: " + (r.stderr or r.stdout)[-800:]

def cmd_build(show_path, out, a):
    show = json.load(open(show_path)); L = json.load(open(out / "vo-lines.json")); vod = out / "vo"
    precheck_vo(out)  # no stutters or cut-off words before we spend time rendering
    vlen = [dur_of(vod / f"vo{i}.wav") for i in range(len(L))]
    idx = lambda kind, sec=None: next(i for i, x in enumerate(L) if x[0] == kind and (sec is None or x[1] == sec))
    jobs = int(a[a.index("--jobs") + 1]) if "--jobs" in a else 2
    pics = out / "pics"; pics.mkdir(exist_ok=True)
    for s in show["sections"]:
        for it in s["items"]:
            c = it["checked_at"][:10] if it.get("checked_at") else ""
            it["checked"] = f"{int(c[8:10])} {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][int(c[5:7]) - 1]}" if c else ""
    want = [(it["code"], j, it["images"][j]) for s in show["sections"] for it in s["items"] for j in range(5) if j < len(it["images"])]
    with cf.ThreadPoolExecutor(8) as ex: list(ex.map(lambda w: fetch(w[2], pics / f"{w[0]}-{w[1]}.jpg"), want))
    second = json.load(open(out / "second-photo.json")) if (out / "second-photo.json").exists() else {}  # from backview.py
    def assets(p, items):
        (p / "assets").mkdir(parents=True, exist_ok=True); m = {}
        for it in items:
            c = it["code"]; segno.make(f"https://salenowon.co.uk/d/{c}", error="m").save(str(p / "assets" / f"qr-{c}.svg"), scale=10, border=0, dark="#222222", light=None)
            main = pics / f"{c}-0.jpg"; shutil.copy(main, p / "assets" / main.name)
            sp = second.get(str(c)); back = (pics / f"{c}-{sp[0]}.jpg", sp[1]) if sp and sp[0] is not None and (pics / f"{c}-{sp[0]}.jpg").exists() else None
            if not back: back = next(((pics / f"{c}-{j}.jpg", "Another look") for j in (3, 1) if (pics / f"{c}-{j}.jpg").exists() and (pics / f"{c}-{j}.jpg").stat().st_size > 2000), None)
            if back: shutil.copy(back[0], p / "assets" / back[0].name)
            allp = []
            for j in range(5):
                f = pics / f"{c}-{j}.jpg"
                if f.exists() and f.stat().st_size > 2000: shutil.copy(f, p / "assets" / f.name); allp.append(f"assets/{f.name}")
            m[c] = (f"assets/{main.name}", (f"assets/{back[0].name}", back[1]) if back else None, allp)
        return m
    n_total = sum(len(s["items"]) for s in show["sections"]); parts = []; deal_no = 1
    # opening
    p = out / "part-00-open"; d0 = max(5.5, vlen[0] + 0.8)
    project(p, f'''<div id="op" class="clip full redbg" data-start="0" data-duration="{d0:.2f}" data-track-index="1" data-layout-allow-occlusion data-layout-allow-overlap>{wall("SALE")}
<div id="o1" class="ctr" style="top:230px;font-size:64px;letter-spacing:14px;font-weight:800">THE WEEKEND</div>
<div id="o2" class="ctr" style="top:310px;font-size:230px;letter-spacing:-8px;line-height:1">SALE NOW ON</div>
<div id="o3" class="ctr" style="top:610px"><span style="display:inline-block;background:#fff;color:#d7262d;border-radius:80px;padding:14px 50px;font-size:64px;letter-spacing:-2px">{esc(show["date"])}</span></div>
<div id="o4" class="ctr" style="top:790px;font-size:40px;font-weight:700">{n_total} deals · {" · ".join(esc(s["name"]) for s in show["sections"])}</div>
<div class="ctr" style="top:1010px;font-size:34px;font-weight:800;color:rgba(255,255,255,.5)" data-layout-ignore>SaleNowOn.co.uk</div></div>''',
            '''tl.fromTo("#o1", { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.4 }, 0.1);
tl.fromTo("#o2", { opacity: 0, scale: 1.4 }, { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(1.6)" }, 0.25);
tl.fromTo("#o3", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2.2)" }, 0.8);
tl.fromTo("#o4", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.4 }, 1.3);''', d0)
    parts.append(dict(path=p, dur=d0, chapter="Intro", events=[(0.3, "vo", 0), (0.0, "hit", None)]))
    g = guess_item(show)
    for i, s in enumerate(show["sections"]):
        s["items"] = [it for it in s["items"] if (pics / f"{it['code']}-0.jpg").exists()]
        p = out / f"part-{i + 1:02d}-{re.sub('[^a-z]+', '-', s['name'].lower()).strip('-')}"; m = assets(p, s["items"])
        vi = idx("intro", i); card = max(2.6, vlen[vi] + 0.4); top = max(x["off"] for x in s["items"])
        ns = show["sections"][i + 1] if i + 1 < len(show["sections"]) else None
        upnext = "Guess the price!" if (i == 1 and show.get("guess")) else (f'{ns["name"]} · up to {max(x["off"] for x in ns["items"])}% off' if ns else None)
        html = [f'''<div id="sc" class="clip full redbg" data-start="0" data-duration="{card + 0.4:.2f}" data-track-index="1" style="z-index:1" data-layout-allow-occlusion data-layout-allow-overlap>{wall(s["name"].split()[0].upper())}
<div class="ctr" style="top:250px;font-size:44px;letter-spacing:8px;font-weight:800;color:rgba(255,255,255,.85)">THE WEEKEND SALE NOW ON · PART {i + 1} OF {len(show["sections"])}</div>
<div id="s1" class="ctr" style="top:360px;font-size:200px;letter-spacing:-7px;line-height:1">{esc(s["name"].upper())}</div>
<div id="s2" class="ctr" style="top:640px"><span style="display:inline-block;background:#fff;color:#d7262d;border-radius:80px;padding:12px 48px;font-size:70px;letter-spacing:-2px">Up to {top}% off · {len(s["items"])} deals</span></div></div>''']
        js = ['tl.fromTo("#s1", { opacity: 0, x: -200 }, { opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }, 0.05);',
              'tl.fromTo("#s2", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2.2)" }, 0.5);']
        ev = [(0.0, "hit", None), (0.3, "vo", vi)]
        said = {x[2]: li for li, x in enumerate(L) if x[0] == "mid" and x[1] == i}
        durs = []  # a product stays up for its paid multiple, and always long enough for the host to finish her line
        for k, it in enumerate(s["items"]):
            d = SECS * float(it.get("featured") or 1)
            if k in said: d = max(d, 0.6 + vlen[said[k]] + 0.45)
            durs.append(round(d, 2))
        starts_k = [card + sum(durs[:k]) for k in range(len(durs))]
        for k, it in enumerate(s["items"]):
            st = starts_k[k]; a_, b_, allp = m[it["code"]]
            hh, jj, ee = product_slot(show, i, k, it, st, a_, b_, len(s["items"]), deal_no, n_total, None,
                                      dur=durs[k], photos=allp[:4] if it.get("featured") else None)
            html.append(hh); js += jj; ev += [(t, kind, None) for t, kind in ee]; deal_no += 1
            if k in said: ev.append((st + 0.6, "vo", said[k]))
        total = card + sum(durs)
        oi = next((li for li, x in enumerate(L) if x[0] == "outro" and x[1] == i), None)
        if oi is not None:  # category outro: the host's pick, with what's coming next
            pick = max(s["items"], key=lambda x: (bool(x.get("featured")), x["off"])); od = max(3.2, vlen[oi] + 1.0); o0 = total
            nx = f'<div class="ctr" style="top:900px;font-size:40px;font-weight:800">Coming up next: {esc(upnext)}</div>' if upnext else ""
            html.append(f'''<div id="ow" class="clip full redbg" data-start="{o0:.2f}" data-duration="{od:.2f}" data-track-index="30" style="z-index:30" data-layout-allow-occlusion data-layout-allow-overlap>{wall(s["name"].split()[0].upper())}
<div class="pa" style="left:160px;top:120px;width:500px;height:750px;border-color:#fff"><img src="{m[pick["code"]][0]}" alt="" /></div>
<div class="ctr" style="left:760px;right:80px;text-align:left;top:180px;font-size:44px;font-weight:800;color:rgba(255,255,255,.85)">That's the {esc(s["name"].lower())}</div>
<div class="ctr" style="left:760px;right:80px;text-align:left;top:250px;font-size:96px;letter-spacing:-3px;line-height:1">MY PICK</div>
<div class="ctr" style="left:760px;right:80px;text-align:left;top:380px;font-size:60px;letter-spacing:-2px;line-height:1.05;white-space:normal">{esc(pick["title"])}</div>
<div class="ctr" style="left:760px;right:80px;text-align:left;top:560px"><span style="display:inline-block;background:#fff;color:#d7262d;border-radius:70px;padding:10px 40px;font-size:80px;letter-spacing:-2px">{money(pick["cur"], pick["now"])}</span> <span style="font-size:44px;opacity:.8;margin-left:16px"><s>{money(pick["cur"], pick["was"])}</s></span></div>
<div class="ctr" style="left:760px;right:80px;text-align:left;top:720px;font-size:40px;font-weight:700">Deal code SNO {pick["code"]}</div>
{nx}</div>''')
            js += [f'tl.fromTo("#ow", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.25, immediateRender: false }}, {o0:.2f});',
                   f'tl.fromTo("#ow .pa", {{ opacity: 0, x: -80 }}, {{ opacity: 1, x: 0, duration: 0.4, ease: "power3.out", immediateRender: false }}, {o0 + 0.1:.2f});']
            ev += [(o0, "hit", None), (o0 + 0.3, "vo", oi)]; total = o0 + od
        project(p, "\n".join(html), "\n".join(js), total)
        parts.append(dict(path=p, dur=total, chapter=f'{s["name"]} (up to {top}% off)', events=ev,
                          items=[(starts_k[k], it, s["name"]) for k, it in enumerate(s["items"])]))
        if i == 1 and show.get("guess"):  # Guess the Price (off unless the show asks for it)
            p = out / "part-01b-guess"; m = assets(p, [g]); a_, b_, _ = m[g["code"]]
            g1, g2 = idx("guess1"), idx("guess2"); t_count = vlen[g1] + 0.6; t_rev = t_count + 5.0; gd = t_rev + max(3.2, vlen[g2] + 1.2)
            cds = "".join(f'<div class="cd" id="cd{n}" data-layout-allow-occlusion data-layout-allow-overlap>{n}</div>' for n in (5, 4, 3, 2, 1))
            html = f'''<div id="gp" class="clip full" data-start="0" data-duration="{gd:.2f}" data-track-index="1" style="background:#fff" data-layout-allow-occlusion data-layout-allow-overlap>{wall("GUESS", True, 6)}
<div class="pa" style="left:70px;top:50px;width:600px;height:900px"><img src="{a_}" alt="" /></div>
{f'<div class="pb" style="left:700px;top:330px;width:380px;height:570px;opacity:1"><img src="{b_[0]}" alt="" /><i>{b_[1]}</i></div>' if b_ else ""}
<div id="gt" style="position:absolute;left:1110px;top:60px;background:#d7262d;color:#fff;border-radius:50px;padding:12px 34px;font-size:56px;font-weight:900;letter-spacing:-1px;white-space:nowrap">GUESS THE PRICE</div>
<div class="nm" style="top:190px">{esc(g["title"])}</div>
<div class="was" id="gw" style="top:390px;font-size:80px">Was <span>{money(g["cur"], g["was"])}<div class="strike" id="gs"></div></span></div>
{cds}
<div id="gn" class="now" style="top:520px;font-size:240px">{money(g["cur"], g["now"])}</div>
<div id="gb" class="badge" style="left:540px;top:10px;width:190px;height:190px;opacity:0" data-layout-allow-occlusion data-layout-allow-overlap><b style="font-size:62px">{g["off"]}%</b><i>OFF</i></div>
<div id="gc" class="code" style="top:800px;left:1110px;width:760px;opacity:0">Find it with deal code <b style="display:inline;margin:0 0 0 10px">SNO {g["code"]}</b></div>
{bar(show, None, "?", n_total).replace("Deal ? of " + str(n_total), "Guess the price")}</div>'''
            js = [f'tl.fromTo("#gt", {{ opacity: 0, scale: 0.4 }}, {{ opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2.2)" }}, 0.1);',
                  f'tl.fromTo("#gw", {{ opacity: 0, y: 30 }}, {{ opacity: 1, y: 0, duration: 0.4 }}, 0.6);',
                  f'tl.fromTo("#gs", {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.3, immediateRender: false }}, {t_rev - 0.1:.2f});',
                  f'tl.fromTo("#gn", {{ opacity: 0, scale: 0.3 }}, {{ opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2.4)", immediateRender: false }}, {t_rev:.2f});',
                  f'tl.fromTo("#gb", {{ opacity: 0, scale: 0, rotation: -40 }}, {{ opacity: 1, scale: 1, rotation: 0, duration: 0.4, ease: "back.out(2.5)", immediateRender: false }}, {t_rev + 0.35:.2f});',
                  f'tl.fromTo("#gc", {{ opacity: 0, y: 30 }}, {{ opacity: 1, y: 0, duration: 0.4, immediateRender: false }}, {t_rev + 0.9:.2f});']
            gev = [(0.0, "hit", None), (0.3, "vo", g1), (t_rev, "reveal", None), (t_rev + 0.5, "vo", g2)]
            for q, nn in enumerate((5, 4, 3, 2, 1)):
                t = t_count + q
                js += [f'tl.fromTo("#cd{nn}", {{ opacity: 0, scale: 1.5 }}, {{ opacity: 1, scale: 1, duration: 0.2, immediateRender: false }}, {t:.2f});',
                       f'tl.to("#cd{nn}", {{ opacity: 0, duration: 0.15 }}, {t + 0.85:.2f});']
                gev.append((t, "tick", None))
            project(p, html, "\n".join(js), gd)
            parts.append(dict(path=p, dur=gd, chapter="Guess the price", events=gev, items=[(t_rev, g, "Guess the price")]))
    # closing
    p = out / "part-99-close"; firsts = [s["items"][0] for s in show["sections"] if s["items"]][:3]; m = assets(p, firsts)
    segno.make("https://salenowon.co.uk/deals", error="m").save(str(p / "assets" / "qr-deals.svg"), scale=10, border=0, dark="#222222", light=None)
    vc = idx("close"); dc = max(8.0, vlen[vc] + 1.6)
    pics_html = "".join(f'<div class="pa" style="left:{60 + j * 300}px;top:{150 + (j % 2) * 120}px;width:300px;height:450px;transform:rotate({[-5, 3, -2][j]}deg)"><img src="{m[it["code"]][0]}" alt="" /></div>' for j, it in enumerate(firsts))
    project(p, f'''<div id="cl" class="clip full" data-start="0" data-duration="{dc:.2f}" data-track-index="1" data-layout-allow-occlusion data-layout-allow-overlap>
<div id="cw" class="full" style="right:auto;width:1000px;background:#fff" data-layout-allow-occlusion data-layout-allow-overlap>{pics_html}
<div style="position:absolute;left:80px;top:800px;font-size:50px;font-weight:900;color:#d7262d;letter-spacing:-2px;line-height:1.1">Every deal from today's show,<br>with its deal code</div></div>
<div id="cr" class="full redbg" style="left:1000px" data-layout-allow-occlusion data-layout-allow-overlap>{wall("SALE")}
<div style="position:absolute;left:0;right:0;top:90px;text-align:center;color:#fff;font-weight:700;font-size:44px">Go to</div>
<div style="position:absolute;left:0;right:0;top:150px;text-align:center;color:#fff;font-weight:900;font-size:110px;letter-spacing:-4px;line-height:1">SALE NOW ON<br>.co.uk</div>
<div class="qrb" style="left:310px;top:440px;width:300px;height:300px;border-color:#fff"><img src="assets/qr-deals.svg" alt="" style="left:30px;top:30px" /></div>
<div style="position:absolute;left:0;right:0;top:770px;text-align:center;color:#fff;font-weight:800;font-size:40px">Scan for all this week's deals</div>
<div id="c2" style="position:absolute;left:0;right:0;top:880px;text-align:center;color:#fff;font-weight:900;font-size:60px;letter-spacing:-2px">See you next weekend</div>
<div style="position:absolute;left:0;right:0;top:1010px;text-align:center;font-size:34px;font-weight:800;color:rgba(255,255,255,.5)" data-layout-ignore>SaleNowOn.co.uk</div></div></div>''',
            '''tl.fromTo("#cw", { x: -1000 }, { x: 0, duration: 0.45, ease: "power3.out" }, 0);
tl.fromTo("#cr", { x: 920 }, { x: 0, duration: 0.45, ease: "power3.out" }, 0);
tl.fromTo("#cl .qrb", { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)" }, 0.6);
tl.fromTo("#c2", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.4 }, 1.4);''', dc)
    parts.append(dict(path=p, dur=dc, chapter="All the deals and the QR code", events=[(0.0, "hit", None), (0.3, "vo", vc)]))
    print("parts:", [(x["path"].name, round(x["dur"], 1)) for x in parts], "total", round(sum(x["dur"] for x in parts), 1), "s")
    # timing pre-check: inside each part no two lines overlap, and every product line ends before its product leaves
    problems = []
    for x in parts:
        vos = sorted((t, vlen[v]) for t, kind, v in x["events"] if kind == "vo")
        for (t1, d1), (t2, _) in zip(vos, vos[1:]):
            if t1 + d1 > t2 + 0.02: problems.append(f"{x['path'].name}: line at {t1:.1f}s runs into the next line at {t2:.1f}s")
        if vos and vos[-1][0] + vos[-1][1] > x["dur"] + 0.02: problems.append(f"{x['path'].name}: last line runs past the end of the part")
        its = x.get("items") or []
        for n_, (t0, it, _) in enumerate(its):
            t_end = its[n_ + 1][0] if n_ + 1 < len(its) else x["dur"]
            for t, d in vos:
                if t0 <= t < t_end and t + d > t_end + 0.02: problems.append(f"{x['path'].name}: host line for {it['title'][:30]} runs onto the next product")
    if problems: print("TIMING PRE-CHECK FAILED"); [print("  " + p_) for p_ in problems]; sys.exit(1)
    print("timing pre-check passed: no overlapping lines, every line fits its product")
    if "--no-render" in a: return
    if "--mix-only" not in a:
        todo = [x["path"] for x in parts if "--resume" not in a or not (x["path"] / "part.mp4").exists()]
        with cf.ThreadPoolExecutor(jobs) as ex: results = list(ex.map(render, todo))
        for name, res in results: print(name, res)
        bad = [n for n, r in results if r != "ok"]
        if bad:  # one retry each, one at a time, before giving up
            for p in [x["path"] for x in parts if x["path"].name in bad]: name, res = render(p); print("retry", name, res)
            if any(not (x["path"] / "part.mp4").exists() for x in parts): sys.exit("some parts did not render: see above")
    # ---- join and mix ----
    lst = out / "parts.txt"; lst.write_text("".join(f"file '{x['path'].resolve()}/part.mp4'\n" for x in parts))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out / "video.mp4")], check=True)
    total = dur_of(out / "video.mp4"); sfx(out / "sfx"); (out / "music").mkdir(exist_ok=True)
    starts, t = [], 0.0
    for x in parts: starts.append(t); x["real"] = dur_of(x["path"] / "part.mp4"); t += x["real"]
    ins = ["-i", str(out / "video.mp4")]; fl = []; mus, voc, fx = [], [], []
    def add(file):
        ins.extend(["-i", str(file)]); return len(ins) // 2 - 1
    for k, x in enumerate(parts):
        mf = out / "music" / f"m{k}.wav"; music_part(x["real"] + 0.05, STYLES[k % len(STYLES)], mf)
        j = add(mf); ms = int(starts[k] * 1000); fl.append(f"[{j}:a]adelay={ms}|{ms}[mu{k}]"); mus.append(f"[mu{k}]")
        for e, (tt, kind, val) in enumerate(x["events"]):
            j = add(vod / f"vo{val}.wav" if kind == "vo" else out / "sfx" / f"{kind}.wav"); ms = int((starts[k] + tt) * 1000)
            lab = f"e{k}_{e}"; vol = {"vo": 1.0, "hit": 0.5, "ding": 0.22, "tick": 0.35, "reveal": 0.45}[kind]
            fl.append(f"[{j}:a]aresample=44100,aformat=channel_layouts=stereo,volume={vol},adelay={ms}|{ms}[{lab}]")
            (voc if kind == "vo" else fx).append(f"[{lab}]")
    fl.append("".join(mus) + f"amix=inputs={len(mus)}:normalize=0:dropout_transition=0,volume=0.32,apad=whole_dur={total:.2f}[music]")
    fl.append("".join(voc) + f"amix=inputs={len(voc)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.2f}[voice]")
    fl.append("".join(fx) + f"amix=inputs={len(fx)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.2f}[fx]")
    fl.append("[voice]asplit=3[vk][vm][vstem];[music][vk]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[duck]")
    fl.append(f"[duck][vm][fx]amix=inputs=3:normalize=0,alimiter=limit=0.95,atrim=0:{total:.2f}[aout]")
    final = out / f"sno-weekend-show-v2-{re.sub('[^a-z0-9]+', '-', show['date'].lower())}-16x9.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", ";".join(fl), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final),
                    "-map", "[vstem]", "-ac", "1", "-ar", "16000", str(out / "voice-only.wav")], check=True)  # the host alone, exactly as placed: for the listening check
    ch = [f"{int(s // 60)}:{int(s % 60):02d} {x['chapter']}" for s, x in zip(starts, parts)]
    (out / "youtube-chapters.txt").write_text("\n".join(ch) + "\n"); print("\n".join(ch))
    # show index for salenowon.co.uk/show/SLUG: every deal with the second it appears
    idx_items = [dict(code=it["code"], t=round(starts[k] + lt, 1), section=sec, title=it["title"], now=it["now"], was=it["was"], cur=it["cur"], off=it["off"])
                 for k, x in enumerate(parts) for lt, it, sec in x.get("items", [])]
    json.dump(dict(slug=re.sub("[^a-z0-9]+", "-", show["date"].lower()).strip("-"), title=show["title"], date=show["date"], duration=round(total, 1),
                   chapters=[dict(t=round(s_, 1), label=x["chapter"]) for s_, x in zip(starts, parts)], items=idx_items),
              open(out / "show-index.json", "w"), indent=1)
    print("SHOW", final, round(dur_of(final), 1), "s")
    # final gates: picture and sound the same length, no silent gaps, and the host heard in full (listening check)
    vd = float(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=duration", "-of", "csv=p=0", str(final)], capture_output=True, text=True).stdout)
    ad = float(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=duration", "-of", "csv=p=0", str(final)], capture_output=True, text=True).stdout)
    gaps = re.findall(r"silence_start: ([\d.]+)", subprocess.run(["ffmpeg", "-hide_banner", "-i", str(final), "-af", "silencedetect=noise=-45dB:d=0.5", "-vn", "-f", "null", "-"], capture_output=True, text=True).stderr)
    if abs(vd - ad) > 0.1 or gaps: sys.exit(f"FINAL CHECK FAILED: picture {vd:.2f}s, sound {ad:.2f}s, silent gaps at {gaps}")
    py = pathlib.Path(os.environ.get("QA_PYTHON", str(HERE.parent / "cvenv" / "bin" / "python")))  # a Python with faster-whisper
    if "--no-listen" not in a and py.exists():
        r = subprocess.run([str(py), "-I", str(HERE / "qa_listen.py"), str(out / "voice-only.wav"), str(out / "vo-lines.json")], capture_output=True, text=True)
        print("\n".join(l for l in r.stdout.splitlines() if l.strip()))
        if r.returncode: sys.exit("LISTENING CHECK FAILED: do not publish this show")
    print("ALL CHECKS PASSED")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "script": cmd_script(a[1], pathlib.Path(a[2]))
    elif a[0] == "split": (cmd_split_words if (pathlib.Path(a[1]) / "words.json").exists() else cmd_split)(pathlib.Path(a[1]))
    elif a[0] == "build": cmd_build(a[1], pathlib.Path(a[2]), a)
