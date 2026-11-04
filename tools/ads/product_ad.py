"""Single-product Sale Now On ad from several photos of one product, in 16:9 or 9:16.

Usage: python3 product_ad.py PRODUCT.json SIZE(16x9|9x16) --vo vo.mp3 --out DIR
PRODUCT.json: {"name": "Denim Shirt", "now": 181, "was": 369, "cur": "GBP", "images": ["https://...V1.jpg", ...]}
Timing follows the voiceover's six phrases: name / Sale Now On / Was / Now / You save / Go to.
"""
import json, pathlib, re, shutil, subprocess, sys, urllib.request
HERE = pathlib.Path(__file__).parent
SKEL = HERE / "out" / "women-s-dresses"
UA = "SaleNowOnBot/0.1 (+https://salenowon.co.uk/bot)"
sys.path.insert(0, str(HERE)); from campaign import segments, money

CSS_COMMON = """
:root { --red:#d7262d; --ink:#222; --grey:#6b6b6b; --line:#e2e2e2; }
* { margin:0; padding:0; box-sizing:border-box; }
html, body { overflow:hidden; background:#fff; }
#root { position:relative; width:100%; height:100%; font-family:"Poppins",sans-serif; color:var(--ink); }
.full { position:absolute; inset:0; } .redbg { background:var(--red); }
.wallrow { position:absolute; left:-200px; white-space:nowrap; font-weight:900; font-size:210px; line-height:1; color:rgba(255,255,255,.08); letter-spacing:-6px; }
.photo { position:absolute; overflow:hidden; border-radius:32px; border:2px solid var(--line); background:#fff; box-shadow:0 30px 80px rgba(0,0,0,.10); }
.photo img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; }
.photo img.first { opacity:1; }
.thumbs { position:absolute; display:flex; }
.thumbs div { overflow:hidden; border-radius:14px; border:2px solid var(--line); background:#fff; flex:0 0 auto; }
.thumbs img { width:100%; height:100%; object-fit:cover; display:block; }
.sel { position:absolute; border:6px solid var(--red); border-radius:18px; }
.badge { position:absolute; border-radius:50%; background:var(--red); color:#fff; display:flex; flex-direction:column; align-items:center; justify-content:center; font-weight:900; line-height:1; box-shadow:0 20px 50px rgba(215,38,45,.35); }
.badge i { font-style:normal; }
.pname { position:absolute; font-weight:900; color:var(--red); letter-spacing:-2px; white-space:nowrap; }
.plabel { position:absolute; font-weight:700; color:var(--grey); letter-spacing:1px; white-space:nowrap; }
.was { position:absolute; font-weight:700; color:var(--grey); white-space:nowrap; opacity:0; }
.was span { position:relative; display:inline-block; }
.strike { position:absolute; left:-8px; right:-8px; top:52%; height:10px; background:var(--red); border-radius:5px; transform-origin:0 50%; }
.now { position:absolute; font-weight:900; color:var(--red); letter-spacing:-8px; line-height:1; white-space:nowrap; opacity:0; }
.save { position:absolute; border-radius:100px; border:5px solid var(--red); color:var(--red); font-weight:900; display:flex; align-items:center; justify-content:center; white-space:nowrap; opacity:0; }
#i-title, #e-go { position:absolute; left:0; right:0; text-align:center; color:#fff; font-weight:900; }
#i-pill { position:absolute; left:50%; border-radius:100px; background:#fff; color:var(--red); font-weight:900; display:flex; align-items:center; justify-content:center; box-shadow:0 30px 80px rgba(0,0,0,.18); }
#e-go { opacity:0; } #e-go small { display:block; font-weight:700; }
.wm { position:absolute; left:0; right:0; text-align:center; font-weight:800; letter-spacing:2px; white-space:nowrap; pointer-events:none; }
.wm.onwhite { color:#c4c4c4; } .wm.onred { color:rgba(255,255,255,.5); }
.half { position:absolute; overflow:hidden; } .half.white { background:#fff; } .half.red { background:var(--red); }
.eimg { position:absolute; overflow:hidden; border-radius:28px; border:2px solid var(--line); box-shadow:0 24px 60px rgba(0,0,0,.10); }
.eimg img { width:100%; height:100%; object-fit:cover; display:block; }
.etxt { position:absolute; white-space:nowrap; line-height:1; }
.qr { position:absolute; background:#fff; border-radius:28px; box-shadow:0 30px 80px rgba(0,0,0,.2); }
.qr img { position:absolute; inset:7%; width:86%; height:86%; }
#adtag { position:absolute; right:28px; top:24px; background:#fff; color:#222; font-weight:800; font-size:28px; padding:4px 14px; border-radius:8px; border:2px solid #e2e2e2; }
"""

def layout(size):
    if size == "16x9":
        W, H = 1920, 1080
        L = dict(photo=(40, 20, 693, 1040), thumb=(110, 165, 10, "column", 755, 20), badge=(560, 40, 190, 62, 28),
                 name=(920, 140, 104), label=(924, 268, 34), was=(920, 380, 96), now=(914, 490, 250), save=(920, 800, 640, 120, 62),
                 title=(330, 170), pill=(640, 760, 170, 92), go=(230, 140, 150), eprice=(760, 70))
    else:
        W, H = 1080, 1920
        L = dict(photo=(140, 190, 800, 1150), thumb=(110, 165, 20, "row", 160, 1365), badge=(800, 140, 210, 70, 30),
                 name=(80, 70, 70), label=(80, 1000000, 30), was=(130, 1585, 84), now=(480, 1550, 180), save=(240, 1745, 600, 92, 50),
                 title=(620, 150), pill=(1010, 820, 190, 104), go=(700, 110, 86), eprice=(1150, 60))
    return W, H, L

def build(prod, size, out, vo):
    out = pathlib.Path(out); (out / "assets").mkdir(parents=True, exist_ok=True)
    for f in ("hyperframes.json", "package.json"): shutil.copy(SKEL / f, out / f)
    hf = json.load(open(out / "hyperframes.json")); hf["registryItems"] = []; json.dump(hf, open(out / "hyperframes.json", "w"), indent=2)
    json.dump({"id": out.name, "name": out.name, "createdAt": "2026-11-03T17:00:00Z"}, open(out / "meta.json", "w"))
    imgs = prod["images"]
    for i, u in enumerate(imgs):
        p = out / "assets" / f"v{i}.jpg"
        if not p.exists(): p.write_bytes(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30).read())
    if prod.get("qr"): shutil.copy(prod["qr"], out / "assets" / "qr.svg")
    shutil.copy(vo, out / "assets" / "vo.mp3"); segs, vdur = segments(str(out / "assets" / "vo.mp3"))
    if len(segs) < 6: segs = [vdur * f for f in (0, .1, .22, .45, .62, .82)]
    T = segs[:6]; total = vdur + 1.3
    W, H, L = layout(size)
    wmf = 34 if size == "16x9" else 40; wmt = H - wmf - 22
    wm = lambda tone, x=0: f'<div class="wm {tone}" style="top:{wmt}px;font-size:{wmf}px;left:{x}px" data-layout-allow-occlusion data-layout-allow-overlap>SaleNowOn.co.uk</div>'
    cur = prod.get("cur", "GBP"); was, now = prod["was"], prod["now"]; off = round(100 * (1 - now / was)); save = was - now
    name = prod["name"]; NAME = name.upper()
    p_start, e_start = T[2] - 0.15, T[5] - 0.15
    n = len(imgs); step = (e_start - p_start) / n
    css = f"html, body {{ width:{W}px; height:{H}px; }}" + CSS_COMMON
    h = [f'<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width={W}, height={H}" />',
         '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>', f"<style>{css}</style></head><body>",
         f'<div id="root" data-composition-id="main" data-start="0" data-duration="{total:.2f}" data-width="{W}" data-height="{H}">']
    wall = name.split()[-1].upper()
    rows = lambda word: "".join(f'<div class="wallrow" data-layout-allow-overflow data-layout-ignore style="top:{r * 200 - 60}px">' + (word + " ") * 10 + "</div>" for r in range(H // 200 + 2))
    tt, tf = L["title"]; pt, pw, ph, pf = L["pill"]
    h.append(f'<div id="intro" class="clip full redbg" data-start="0" data-duration="{p_start + 0.4:.2f}" data-track-index="1" style="z-index:2" data-layout-allow-occlusion data-layout-allow-overlap>{rows(wall)}'
             f'<div id="i-title" style="top:{tt}px;font-size:{tf}px;letter-spacing:-5px;line-height:.95">{"<br>".join(NAME.split(" ", 1))}</div>'
             f'<div id="i-pill" style="top:{pt}px;width:{pw}px;margin-left:-{pw // 2}px;height:{ph}px;font-size:{pf}px;letter-spacing:-3px">SALE NOW ON</div>{wm("onred")}</div>')
    # product scene
    px, py, pw_, ph_ = L["photo"]; tw, th, gap, direction, tx, ty = L["thumb"]
    bx, by, bd, bf, bi = L["badge"]
    pics = "".join(f'<img id="v{i}" class="{"first" if i == 0 else ""}" src="assets/v{i}.jpg" alt="" />' for i in range(n))
    thumbs = "".join(f'<div style="width:{tw}px;height:{th}px;{"margin-bottom" if direction == "column" else "margin-right"}:{gap if i < n - 1 else 0}px"><img src="assets/v{i}.jpg" alt="" /></div>' for i in range(n))
    nx, ny, nf = L["name"]; lx, ly, lf = L["label"]; wx, wy, wf = L["was"]; ox, oy, of = L["now"]; sx, sy, sw, sh, sf = L["save"]
    hdr = (f'<div class="pname" style="left:{nx}px;top:{ny}px;font-size:{nf}px">{NAME}</div>'
           + (f'<div class="plabel" style="left:{lx}px;top:{ly}px;font-size:{lf}px">SALE NOW ON · {off}% OFF</div>' if size == "16x9" else
              f'<div class="plabel" style="right:80px;top:{ny + 22}px;font-size:{lf}px">SALE NOW ON</div>'))
    h.append(f'<div id="prod" class="clip full" data-start="{p_start:.2f}" data-duration="{e_start - p_start + 0.4:.2f}" data-track-index="2" style="z-index:3;background:#fff" data-layout-allow-occlusion data-layout-allow-overlap><div class="pin full">'
             f'{hdr}<div class="photo" style="left:{px}px;top:{py}px;width:{pw_}px;height:{ph_}px" data-layout-allow-occlusion data-layout-allow-overlap>{pics}</div>'
             f'<div class="thumbs" style="left:{tx}px;top:{ty}px;flex-direction:{direction}">{thumbs}</div>'
             f'<div id="sel" class="sel" style="left:{tx - 4}px;top:{ty - 4}px;width:{tw + 8}px;height:{th + 8}px" data-layout-allow-occlusion data-layout-allow-overlap></div>'
             f'<div class="badge" style="left:{bx}px;top:{by}px;width:{bd}px;height:{bd}px" data-layout-allow-occlusion data-layout-allow-overlap><b style="font-size:{bf}px;letter-spacing:-2px">{off}%</b><i style="font-size:{bi}px">OFF</i></div>'
             f'<div class="was" style="left:{wx}px;top:{wy}px;font-size:{wf}px">{"Was " if size == "16x9" else ""}<span>{money(was, cur)}<div class="strike"></div></span></div>'
             f'<div class="now" style="left:{ox}px;top:{oy}px;font-size:{of}px">{money(now, cur)}</div>'
             f'<div class="save" style="left:{sx}px;top:{sy}px;width:{sw}px;height:{sh}px;font-size:{sf}px">You save {money(save, cur)}</div>{wm("onwhite", 900 if size == "16x9" else 0)}</div></div>')
    # split end card (also the opening thumbnail): the photo fills the white half, the copy sits on the red half
    if size == "16x9":
        A = dict(white=(0, 0, 960, H), red=(960, 0, 960, H), img=(120, 0, 720, 1080), badge=(700, 40, 170, 56, 26),
                 name=(960, 60, 960, 64), price=(960, 150, 960, 150, 60), go=(960, 360, 960, 40, 84), qr=(1300, 610, 280), scan=(960, 905, 960, 34))
    else:
        A = dict(white=(0, 0, W, 960), red=(0, 960, W, 960), img=(220, 0, 640, 960), badge=(760, 40, 170, 56, 26),
                 name=(0, 995, W, 60), price=(0, 1070, W, 140, 60), go=(0, 1240, W, 40, 84), qr=(400, 1500, 280), scan=(0, 1795, W, 34))
    hx = lambda k: "left:{}px;top:{}px;width:{}px;height:{}px".format(*A[k])
    ctr = lambda k, extra="": f'left:{A[k][0]}px;top:{A[k][1]}px;width:{A[k][2]}px;text-align:center;{extra}'
    qr = (f'<div class="qr" style="left:{A["qr"][0]}px;top:{A["qr"][1]}px;width:{A["qr"][2]}px;height:{A["qr"][2]}px"><img src="assets/qr.svg" alt="" /></div>'
          f'<div class="etxt" style="{ctr("scan")}color:#fff;font-weight:800;font-size:{A["scan"][3]}px">Scan for this deal</div>') if prod.get("qr") else ""
    gx, gy, gw, gs1, gs2 = A["go"]; pf, wf2 = A["price"][3], A["price"][4]
    h.append(f'<div id="end" class="clip full" data-start="{e_start:.2f}" data-duration="{total - e_start:.2f}" data-track-index="3" style="z-index:9" data-layout-allow-occlusion data-layout-allow-overlap>'
             f'<div id="e-white" class="half white" style="{hx("white")}" data-layout-allow-occlusion data-layout-allow-overlap>'
             f'<div class="eimg" style="{hx("img")};border:0;border-radius:0;box-shadow:none"><img src="assets/v0.jpg" alt="" style="object-fit:contain" /></div>'
             f'<div class="badge" style="left:{A["badge"][0]}px;top:{A["badge"][1]}px;width:{A["badge"][2]}px;height:{A["badge"][2]}px" data-layout-allow-occlusion data-layout-allow-overlap><b style="font-size:{A["badge"][3]}px;letter-spacing:-2px">{off}%</b><i style="font-size:{A["badge"][4]}px">OFF</i></div></div>'
             f'<div id="e-red" class="half red" style="{hx("red")}" data-layout-allow-occlusion data-layout-allow-overlap>{rows("SALE")}</div>'
             f'<div id="e-copy" class="etxt" style="{ctr("name")}color:#fff;font-weight:900;font-size:{A["name"][3]}px;letter-spacing:-2px">{NAME}</div>'
             f'<div id="e-price" class="etxt" style="{ctr("price")}color:#fff;font-weight:900"><span style="font-size:{pf}px;letter-spacing:-6px">{money(now, cur)}</span>'
             f'<span style="position:relative;display:inline-block;margin-left:28px;font-size:{wf2}px;font-weight:700;opacity:.8">{money(was, cur)}<div class="strike" style="transform:none;background:#fff"></div></span></div>'
             f'<div id="e-go" class="etxt" style="left:{gx}px;top:{gy}px;width:{gw}px;text-align:center;color:#fff;font-weight:900;line-height:1.05;letter-spacing:-3px"><small style="display:block;font-size:{gs1}px;font-weight:700;letter-spacing:0;margin-bottom:12px">Go to</small><span style="font-size:{gs2}px">SALE NOW ON<br>.co.uk</span></div>'
             f'{qr}{wm("onred", 960 if size == "16x9" else 0)}</div>'
             f'<div id="adtag" class="clip" data-start="0" data-duration="{total:.2f}" data-track-index="10" style="z-index:20">Ad</div>'
             f'<audio id="vo" class="clip" src="assets/vo.mp3" data-start="0" data-duration="{vdur:.2f}" data-track-index="11" data-volume="1"></audio>')
    js = ["window.__timelines = window.__timelines || {};", "const tl = gsap.timeline({ paused: true });",
          f'tl.fromTo(".wallrow", {{ x: 0 }}, {{ x: -260, duration: {total:.2f}, ease: "none" }}, 0);',
          'tl.fromTo("#i-title", { opacity: 0, scale: 1.4 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.6)" }, 0.02);',
          f'tl.fromTo("#i-pill", {{ opacity: 0, scale: 0.3, rotation: -8 }}, {{ opacity: 1, scale: 1, rotation: -3, duration: 0.35, ease: "back.out(2.2)" }}, {max(T[1] - 0.05, 0.4):.2f});',
          f'tl.fromTo("#prod .pin", {{ y: {H} }}, {{ y: 0, duration: 0.4, ease: "power3.out", immediateRender: false }}, {p_start:.2f});',
          f'tl.fromTo("#prod .badge", {{ scale: 0, rotation: -30 }}, {{ scale: 1, rotation: 0, duration: 0.3, ease: "back.out(2.5)", immediateRender: false }}, {p_start + 0.45:.2f});',
          f'tl.fromTo("#v0", {{ scale: 1.08 }}, {{ scale: 1, duration: {step + 0.3:.2f}, ease: "none", immediateRender: false }}, {p_start:.2f});']
    for i in range(1, n):
        s = p_start + i * step
        off_px = f"y: {i * (th + gap)}" if direction == "column" else f"x: {i * (tw + gap)}"
        js += [f'tl.fromTo("#v{i}", {{ scale: 1.08 }}, {{ scale: 1, duration: {step + 0.3:.2f}, ease: "none", immediateRender: false }}, {s:.2f});',
               f'tl.fromTo("#v{i}", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.3, ease: "power1.out", immediateRender: false }}, {s:.2f});',
               f'tl.to("#sel", {{ {off_px}, duration: 0.3, ease: "power2.out" }}, {s:.2f});']
    js += [f'tl.fromTo("#prod .was", {{ opacity: 0, y: 30 }}, {{ opacity: 1, y: 0, duration: 0.3, immediateRender: false }}, {T[2]:.2f});',
           f'tl.fromTo("#prod .strike", {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.3, ease: "power2.out", immediateRender: false }}, {T[3] - 0.1:.2f});',
           f'tl.fromTo("#prod .now", {{ opacity: 0, scale: 0.4 }}, {{ opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)", immediateRender: false }}, {T[3]:.2f});',
           f'tl.fromTo("#prod .save", {{ opacity: 0, y: 40 }}, {{ opacity: 1, y: 0, duration: 0.35, ease: "back.out(1.8)", immediateRender: false }}, {T[4]:.2f});',
           f'tl.fromTo("#end", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.2, immediateRender: false }}, {e_start:.2f});',
           f'tl.fromTo("#e-white", {{ {"x" if size == "16x9" else "y"}: -{W if size == "16x9" else 960} }}, {{ {"x" if size == "16x9" else "y"}: 0, duration: 0.4, ease: "power3.out", immediateRender: false }}, {e_start:.2f});',
           f'tl.fromTo("#e-red", {{ {"x" if size == "16x9" else "y"}: {W if size == "16x9" else 960} }}, {{ {"x" if size == "16x9" else "y"}: 0, duration: 0.4, ease: "power3.out", immediateRender: false }}, {e_start:.2f});',
           f'tl.fromTo("#e-copy, #e-price", {{ opacity: 0, y: 60 }}, {{ opacity: 1, y: 0, duration: 0.35, ease: "back.out(1.6)", immediateRender: false }}, {e_start + 0.2:.2f});',
           f'tl.fromTo("#e-go", {{ opacity: 0, y: 80 }}, {{ opacity: 1, y: 0, duration: 0.4, ease: "back.out(1.6)", immediateRender: false }}, {e_start + 0.3:.2f});',
           f'tl.fromTo("#end .qr", {{ opacity: 0, scale: 0.5 }}, {{ opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)", immediateRender: false }}, {e_start + 0.6:.2f});' if prod.get("qr") else "",
           'window.__timelines["main"] = tl;', "tl.seek(0);"]
    h.append("</div><script>\n" + "\n".join(js) + "\n</script></body></html>")
    (out / "index.html").write_text("\n".join(h))
    return out, T, p_start, e_start, total

def main():
    a = sys.argv[1:]; prod = json.load(open(a[0])); size = a[1]
    vo = a[a.index("--vo") + 1]; out = pathlib.Path(a[a.index("--out") + 1])
    out, T, ps, es, total = build(prod, size, out, vo)
    print("phrases", [round(t, 2) for t in T], "product", round(ps, 2), "end", round(es, 2))
    if "--no-render" in a: return
    chk = subprocess.run("npx hyperframes check", shell=True, cwd=out, capture_output=True, text=True)
    if "Check passed" not in chk.stdout + chk.stderr: print(chk.stdout[-2500:]); sys.exit("check failed")
    slug = re.sub(r"[^a-z0-9]+", "-", prod["name"].lower()).strip("-")
    final = out / f"sno-{slug}-{size}-voice.mp4"
    subprocess.run("npx hyperframes render -o raw.mp4 --quiet", shell=True, cwd=out, check=True, capture_output=True)
    # the finished end card is also the scroll-stop opening frame
    at = round(total - 0.1, 2)
    subprocess.run(f"npx hyperframes snapshot --at {at} --no-end --keep -o thumbs", shell=True, cwd=out, check=True, capture_output=True)
    th = next((out / "thumbs").glob("at-*.png")); shutil.copy(th, out / f"thumb-{size}.png")
    W, H = (1920, 1080) if size == "16x9" else (1080, 1920)
    fc = (f"[0:v]scale={W}:{H},format=yuv420p,setsar=1,fps=30[a];[1:v]format=yuv420p,setsar=1,fps=30[b];"
          "[a][b]xfade=transition=fade:duration=0.35:offset=0.85[v];[1:a]adelay=850|850[au]")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-loop", "1", "-t", "1.2", "-framerate", "30", "-i", str(out / f"thumb-{size}.png"),
                    "-i", str(out / "raw.mp4"), "-filter_complex", fc, "-map", "[v]", "-map", "[au]", "-c:a", "aac", "-b:a", "192k",
                    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-movflags", "+faststart", str(final)], check=True)
    print("VIDEO", final); print("THUMB", out / f"thumb-{size}.png")

if __name__ == "__main__":
    main()
