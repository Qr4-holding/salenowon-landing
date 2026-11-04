"""Pick each product's second photo: the back view when we can tell (main photo shows a face, another doesn't), else photo 4.
Usage: python backview.py PICS_DIR CODES... -> prints JSON {code: [index, label]}"""
import sys, json, pathlib, cv2
P = pathlib.Path(sys.argv[1])
fc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
pf = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
def face(f):
    im = cv2.imread(str(f))
    if im is None: return None
    g = cv2.cvtColor(cv2.resize(im, (483, 725)), cv2.COLOR_BGR2GRAY)
    flip = cv2.flip(g, 1)
    return any(len(c.detectMultiScale(x, 1.1, 6, minSize=(28, 28))) for c in (fc, pf) for x in (g, flip))
out = {}
for c in sys.argv[2:]:
    ex = [j for j in range(6) if (P / f"{c}-{j}.jpg").exists() and (P / f"{c}-{j}.jpg").stat().st_size > 2000]
    if face(P / f"{c}-0.jpg"):
        back = next((j for j in (3, 1, 2, 4) if j in ex and face(P / f"{c}-{j}.jpg") is False), None)
        out[c] = [back, "Back view"] if back is not None else [3 if 3 in ex else 1, "Another look"]
    else:
        out[c] = [3 if 3 in ex else 1, "Another look"]
print(json.dumps(out))
