"""Sale Now On category campaign video, built automatically from swept deals.

  python3 campaign.py DEALS.jsonl CAT_KEY "WOMEN'S DRESSES" --vo-text   # print the voiceover script
  python3 campaign.py DEALS.jsonl CAT_KEY "WOMEN'S DRESSES" [--vo vo.mp3] [--out DIR]

DEALS.jsonl: one deal per line (sweep output): title, now, was, off, cur, img, cat ...
Picks the 5 biggest savings that have an image, writes a HyperFrames project,
renders 9:16, makes a scroll-stop thumbnail and puts it on the front.
"""
import json, math, os, re, shutil, subprocess, sys, pathlib, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SKEL = HERE.parent / "sno-video-ad" / "engine" / "skeleton"
IMG = "https://assets.digitalcontent.marksandspencer.app/image/upload/w_1000,q_auto,f_jpg/"
UA = "SaleNowOnBot/0.1 (+https://salenowon.co.uk/bot)"
W, H = 1080, 1920

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
def words(n):
    n = int(n)
    if n < 20: return ONES[n]
    return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])

def money(v, cur="GBP"):
    sym = {"GBP": "£", "USD": "$", "EUR": "€"}.get(cur, "£")
    return sym + (f"{v:.2f}" if v % 1 else f"{int(v)}")

LINK = {"sleeve", "front", "rise", "leg", "waist", "back", "neck", "shoulder", "length"}
def short(title):  # "Sleeveless Button Front Denim Top" -> "Denim top"; "Gaines Balloon Sleeve Jacket" -> "Balloon sleeve jacket"
    w = re.sub(r"[^A-Za-z\- ]", " ", title).split()
    if len(w) <= 2: return " ".join(w).capitalize()
    k = 3 if w[-2].lower() in LINK else 2
    return " ".join(w[-k:]).capitalize()

def kind(title):  # "Midi Skater Dress" -> "skater dresses"
    w = re.sub(r"[^A-Za-z\- ]", " ", title).lower().split()
    if len(w) < 2: return None
    noun = w[-1]
    plural = noun if noun in ("jeans", "shorts", "pants", "trousers", "overalls", "leggings", "joggers") else noun + ("es" if noun.endswith(("s", "sh", "ch", "x")) else "s")
    return f"{w[-2]} {plural}"

def pick(deals, cat, n=5):
    ds = [d for d in deals if d["cat"] == cat and d.get("img") and d["now"] < d["was"]]
    ds.sort(key=lambda d: -d["off"])
    out, nouns = [], set()  # one of each garment first, so the ad shows the range
    for d in ds:
        noun = d["title"].lower().split()[-1].rstrip("s")
        if noun not in nouns: out.append(d); nouns.add(noun)
    out += [d for d in ds if d not in out]
    return out[:n]

def vo_text(label, ds):
    kinds = []
    for d in ds:
        k = kind(d["title"])
        if k and k not in kinds: kinds.append(k)
    listing = ", ".join(kinds[:3]) + " and more" if kinds else "big savings"
    top = max(d["off"] for d in ds)
    title = label.lower().replace("&", "and")
    return [f"{title[0].upper() + title[1:]}.", "Sale Now On.", listing[0].upper() + listing[1:] + ".",
            f"Up to {words(top)} percent off.", "Go to Sale Now On dot co dot uk."]

def segments(audio):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", audio, "-af", "silencedetect=noise=-35dB:d=0.22", "-f", "null", "-"],
                       capture_output=True, text=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio],
                               capture_output=True, text=True).stdout)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    segs, cur = [], 0.0
    for s, e in zip(starts, ends):
        if s - cur > 0.1: segs.append(cur)
        cur = e
    if dur - cur > 0.1: segs.append(cur)
    return segs, dur

def build(ds, label, out, vo=None):
    out = pathlib.Path(out); (out / "assets").mkdir(parents=True, exist_ok=True)
    for f in ("hyperframes.json", "package.json"): shutil.copy(SKEL / f, out / f)
    hf = json.load(open(out / "hyperframes.json")); hf["registryItems"] = []; json.dump(hf, open(out / "hyperframes.json", "w"), indent=2)
    json.dump({"id": out.name, "name": out.name, "createdAt": "2026-11-03T13:00:00Z"}, open(out / "meta.json", "w"))
    for i, d in enumerate(ds):
        p = out / "assets" / f"p{i}.jpg"
        if not p.exists():
            req = urllib.request.Request(d["img"] if d["img"].startswith("http") else IMG + d["img"], headers={"User-Agent": UA})
            p.write_bytes(urllib.request.urlopen(req, timeout=30).read())
    # timings: from the voiceover's phrases, or a fixed rhythm when silent
    if vo:
        shutil.copy(vo, out / "assets" / "vo.mp3"); segs, vdur = segments(str(out / "assets" / "vo.mp3"))
        if len(segs) < 5: segs = [0, vdur * .12, vdur * .25, vdur * .7, vdur * .82]
        T = segs[:5]; T[0] = 0; total = max(vdur + 1.2, T[4] + 3.0)
        # give the product cards room: stretch between "list" and "up to"
        cards_start, cards_end = T[2] - 0.1, max(T[3] - 0.1, T[2] + 1.6 * len(ds))
        shift = cards_end - (T[3] - 0.1)
        if shift > 0:
            T[3] += shift; T[4] += shift; total += shift
            delay_tail = shift
        else: delay_tail = 0
    else:
        T = [0, 1.2, 2.6, 0, 0]; cards_start = 2.5; cards_end = cards_start + 1.7 * len(ds)
        T[3] = cards_end + 0.1; T[4] = T[3] + 1.6; total = T[4] + 3.0; delay_tail = 0; vdur = 0
    step = (cards_end - cards_start) / len(ds)
    starts = [cards_start + i * step for i in range(len(ds))]
    top = max(d["off"] for d in ds); cur = ds[0].get("cur", "GBP")
    wall = label.split()[-1].replace("'S", "")
    css = open(HERE / "campaign.css").read()
    h = [f'<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width={W}, height={H}" />',
         '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>', f"<style>{css}</style></head><body>",
         f'<div id="root" data-composition-id="main" data-start="0" data-duration="{total:.2f}" data-width="{W}" data-height="{H}">',
         f'<div id="intro" class="clip full redbg" data-start="0" data-duration="{starts[0] + 0.4:.2f}" data-track-index="1" style="z-index:2" data-layout-allow-occlusion data-layout-allow-overlap>']
    h += [f'<div class="wallrow" data-layout-allow-overflow data-layout-ignore style="top:{r * 200 - 60}px">' + (wall + " ") * 8 + "</div>" for r in range(10)]
    t1, t2 = (label.split(" ", 1) + [""])[:2]
    h.append(f'<div id="i-title">{t1}<br>{t2}</div><div id="i-pill">SALE NOW ON</div></div>')
    for i, d in enumerate(ds):
        s = starts[i]; dur = (starts[i + 1] if i + 1 < len(ds) else cards_end) - s + 0.4
        dots = "".join(f'<div class="dot{" on" if j == i else ""}"></div>' for j in range(len(ds)))
        h.append(f'''<div id="c{i}" class="clip full" data-start="{s:.2f}" data-duration="{dur:.2f}" data-track-index="{2 + i}" style="z-index:{3 + i};background:#fff" data-layout-allow-occlusion data-layout-allow-overlap><div class="cin full">
<div class="hdr"><b>{label}</b><span>SALE NOW ON</span></div><div class="imgbox"><img src="assets/p{i}.jpg" alt="" /></div>
<div class="badge"><b>{d["off"]}%</b><i>OFF</i></div><div class="name">{short(d["title"])}</div>
<div class="prices"><div class="was">{money(d["was"], cur)}<div class="strike"></div></div><div class="now">{money(d["now"], cur)}</div></div>
<div class="dots">{dots}</div></div></div>''')
    es = cards_end
    h.append(f'<div id="end" class="clip full redbg" data-start="{es:.2f}" data-duration="{total - es:.2f}" data-track-index="9" style="z-index:9" data-layout-allow-occlusion data-layout-allow-overlap>')
    h += [f'<div class="wallrow" data-layout-allow-overflow data-layout-ignore style="top:{r * 200 - 60}px">' + "SALE " * 8 + "</div>" for r in range(10)]
    h.append(f'''<div id="e-up">UP TO</div><div id="e-pct">{top}%</div><div id="e-off">OFF</div>
<div id="e-go"><small>Go to</small><b>SALE NOW ON .co.uk</b></div><div id="e-code">Search: {label}</div></div>
<div id="adtag" class="clip" data-start="0" data-duration="{total:.2f}" data-track-index="10" style="z-index:20">Ad</div>''')
    if vo:
        h.append(f'<audio id="vo" class="clip" src="assets/vo.mp3" data-start="0" data-duration="{vdur:.2f}" data-track-index="11" data-volume="1"></audio>')
    h.append("</div><script>\nwindow.__timelines = window.__timelines || {};\nconst tl = gsap.timeline({ paused: true });")
    h.append(f'tl.fromTo(".wallrow", {{ x: 0 }}, {{ x: -260, duration: {total:.2f}, ease: "none" }}, 0);')
    h.append('tl.fromTo("#i-title", { opacity: 0, scale: 1.4 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.6)" }, 0.02);')
    h.append(f'tl.fromTo("#i-pill", {{ opacity: 0, scale: 0.3, rotation: -8 }}, {{ opacity: 1, scale: 1, rotation: -3, duration: 0.35, ease: "back.out(2.2)" }}, {T[1] - 0.05:.2f});')
    for i in range(len(ds)):
        s = starts[i]
        h.append(f'''tl.fromTo("#c{i} .cin", {{ x: {W} }}, {{ x: 0, duration: 0.35, ease: "power3.out", immediateRender: false }}, {s:.2f});
tl.fromTo("#c{i} .badge", {{ scale: 0, rotation: -30 }}, {{ scale: 1, rotation: 0, duration: 0.3, ease: "back.out(2.5)", immediateRender: false }}, {s + 0.35:.2f});
tl.fromTo("#c{i} .strike", {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.25, ease: "power2.out", immediateRender: false }}, {s + 0.4:.2f});
tl.fromTo("#c{i} .now", {{ opacity: 0, y: 40 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: "back.out(1.8)", immediateRender: false }}, {s + 0.5:.2f});''')
    h.append(f'''tl.fromTo("#end", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.2, immediateRender: false }}, {es:.2f});
tl.fromTo("#e-up", {{ opacity: 0, y: 40 }}, {{ opacity: 1, y: 0, duration: 0.3, immediateRender: false }}, {T[3]:.2f});
tl.fromTo("#e-pct", {{ opacity: 0, scale: 0.4 }}, {{ opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)", immediateRender: false }}, {T[3] + 0.25:.2f});
tl.fromTo("#e-off", {{ opacity: 0, y: 40 }}, {{ opacity: 1, y: 0, duration: 0.3, immediateRender: false }}, {T[3] + 0.6:.2f});
tl.fromTo("#e-go", {{ opacity: 0, y: 120 }}, {{ opacity: 1, y: 0, duration: 0.4, ease: "back.out(1.6)", immediateRender: false }}, {T[4] - 0.05:.2f});
tl.fromTo("#e-code", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.3, immediateRender: false }}, {T[4] + 0.6:.2f});
window.__timelines["main"] = tl;
tl.seek(0);
</script></body></html>''')
    (out / "index.html").write_text("\n".join(h))
    # if the cards stretched past the voice, nudge the voice's last two phrases later by padding
    if vo and delay_tail > 0:
        a = out / "assets" / "vo.mp3"; tmp = out / "assets" / "vo_src.mp3"; shutil.move(a, tmp)
        cut = segs[3] - 0.05
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-filter_complex",
                        f"[0]atrim=0:{cut},asetpts=PTS-STARTPTS[a];[0]atrim={cut},asetpts=PTS-STARTPTS,adelay={int(delay_tail * 1000)}|{int(delay_tail * 1000)}[b];[a][b]concat=n=2:v=0:a=1[o]",
                        "-map", "[o]", str(a)], check=True)
        newdur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(a)], capture_output=True, text=True).stdout)
        txt = (out / "index.html").read_text().replace(f'data-duration="{vdur:.2f}" data-track-index="11"', f'data-duration="{newdur:.2f}" data-track-index="11"')
        (out / "index.html").write_text(txt)
    return out, total

def thumbnail(ds, label, out):
    top = max(d["off"] for d in ds)
    imgs = "".join(f'<div class="p" style="{pos}"><img src="assets/p{i}.jpg"></div>' for i, pos in
                   enumerate(["left:40px;transform:rotate(-6deg)", "left:375px;top:1100px;z-index:2", "left:710px;transform:rotate(6deg)"][:len(ds)]))
    wall = "".join(f'<div class="w" style="top:{r * 195 - 40}px">' + "SALE " * 8 + "</div>" for r in range(7))
    page = (HERE / "thumb.tpl.html").read_text().replace("{{WALL}}", wall).replace("{{PCT}}", f"{top}%").replace("{{IMGS}}", imgs).replace("{{LABEL}}", label)
    f = out / "thumb.html"; f.write_text(page)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={"width": W, "height": H})
        pg.goto("file://" + str(f.resolve())); pg.wait_for_timeout(700); pg.screenshot(path=str(out / "thumb-9x16.png")); b.close()
    return out / "thumb-9x16.png"

def main():
    a = sys.argv[1:]; deals = [json.loads(l) for l in open(a[0]) if l.strip()]
    cat, label = a[1], a[2].upper()
    ds = pick(deals, cat)
    if len(ds) < 3: sys.exit(f"only {len(ds)} deals with images in {cat}; need 3")
    if "--vo-text" in a: print(" ".join(vo_text(label, ds))); return
    vo = a[a.index("--vo") + 1] if "--vo" in a else None
    name = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    out = pathlib.Path(a[a.index("--out") + 1]) if "--out" in a else HERE / "out" / name
    out, total = build(ds, label, out, vo)
    chk = subprocess.run("npx hyperframes check", shell=True, cwd=out, capture_output=True, text=True)
    if "Check passed" not in chk.stdout + chk.stderr: print(chk.stdout[-1500:]); sys.exit("check failed")
    subprocess.run("npx hyperframes render -o raw.mp4 --quiet", shell=True, cwd=out, check=True, capture_output=True)
    th = thumbnail(ds, label, out)
    final = out / f"sno-{name}-9x16{'-voice' if vo else '-silent'}.mp4"
    fc = "[0:v]scale=1080:1920,format=yuv420p,setsar=1,fps=30[a];[1:v]format=yuv420p,setsar=1,fps=30[b];[a][b]xfade=transition=fade:duration=0.35:offset=0.85[v]"
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-t", "1.2", "-framerate", "30", "-i", str(th), "-i", str(out / "raw.mp4")]
    if vo: cmd += ["-filter_complex", fc + ";[1:a]adelay=850|850[au]", "-map", "[v]", "-map", "[au]", "-c:a", "aac", "-b:a", "192k"]
    else: cmd += ["-filter_complex", fc, "-map", "[v]"]
    subprocess.run(cmd + ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-movflags", "+faststart", str(final)], check=True)
    json.dump([{k: d[k] for k in ("title", "now", "was", "off", "url")} for d in ds], open(out / "deals-used.json", "w"), indent=1)
    print("VIDEO", final); print("THUMB", th)

if __name__ == "__main__":
    main()
