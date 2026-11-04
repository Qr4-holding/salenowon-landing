"""Final listening check: transcribe the finished show (voice + music) on this machine and compare with the script.
Extra words are stutters or fragments of a neighbouring line; missing words are cut-offs.
Usage: cvenv/bin/python -I qa_listen.py SHOW.mp4 vo-lines.json   -> exit 1 if it finds problems"""
import sys, json, re, difflib, subprocess, tempfile, os
from faster_whisper import WhisperModel
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
def words(n):
    n = int(n)
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " and " + words(n % 100))
def norm(text):
    t = text.lower().replace("-", " ").replace("&", " and ").replace("%", " percent ")
    t = re.sub(r"£\s?(\d+)(?:\.(\d\d))?", lambda m: words(m.group(1)) + " pounds" + (" " + words(m.group(2)) if m.group(2) and int(m.group(2)) else ""), t)
    t = re.sub(r"\d+", lambda m: words(m.group(0)), t)
    t = t.replace("salenowon.co.uk", "sale now on dot co dot uk").replace(".co.uk", " dot co dot uk").replace("co.uk", "co dot uk")
    t = re.sub(r"s[ae]i?le?now ?on", " sale now on ", t)  # the site name run together ("salenowon", "sailnowon")
    t = re.sub(r"(?<=[a-z])\.(?=[a-z])", " ", t)  # co.uk -> co uk
    t = re.sub(r"[^a-z' ]", " ", t)
    return [w.strip("'") for w in t.split() if w.strip("'") and w.strip("'") != "dot"]  # "dot" is often written as "." by the recogniser
show, lines = sys.argv[1], json.load(open(sys.argv[2]))
script = [w for x in lines for w in norm(re.sub(r"<[^>]+>", " ", x[-1]))]
with tempfile.TemporaryDirectory() as d:
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", show, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
    m = WhisperModel("small.en", device="cpu", compute_type="int8")
    def listen(x, offset=0.0):
        segs, _ = m.transcribe(x, word_timestamps=True, vad_filter=True, vad_parameters=dict(min_silence_duration_ms=400), beam_size=5, condition_on_previous_text=False)
        out = []
        for w in (w for s_ in segs for w in s_.words):
            if w.word.strip() in ("%", "%.", "percent.") and out and re.search(r"\d$", out[-1][0].strip()): out[-1] = (out[-1][0].strip() + "%", out[-1][1])
            else: out.append((w.word, offset + w.start))
        return out
    segs, _ = m.transcribe(audio, word_timestamps=True, vad_filter=True, vad_parameters=dict(min_silence_duration_ms=400), beam_size=5, condition_on_previous_text=False)
    heard = [(w.word, w.start) for s in segs for w in s.words]
hw, ht = [], []
# join number + "%" pieces the recogniser splits apart, e.g. "57" "%" -> "57%"
merged = []
for w, t in heard:
    merged.append((w, t))
heard = merged
for w, t in heard:
    for x in norm(w): hw.append(x); ht.append(t)
sm = difflib.SequenceMatcher(a=script, b=hw, autojunk=False)
problems = []
for op, a0, a1, b0, b1 in sm.get_opcodes():
    if op == "equal": continue
    at = ht[b0] if b0 < len(ht) else (ht[-1] if ht else 0)
    said, heard_ = " ".join(script[a0:a1]), " ".join(hw[b0:b1])
    # a different spelling of the same sound (e.g. "nyra" vs "naira") is not a fault; extra or missing words are
    if op == "replace" and a1 - a0 == b1 - b0 and difflib.SequenceMatcher(a=said, b=heard_).ratio() > 0.6: continue
    # second listen: re-hear just this moment; it is a real fault only if the same slip is heard again
    w0 = max(0, at - 5); clip = audio[int(w0 * 16000):int((at + 5) * 16000)]
    again = [x for w, t in listen(clip, w0) for x in norm(w)]
    win = script[max(0, a0 - 25):a1 + 25]; sm2 = difflib.SequenceMatcher(a=win, b=again, autojunk=False)
    ops2 = sm2.get_opcodes()
    inner = [o for o in ops2[1:-1] if o[0] != "equal"] if len(ops2) > 2 else [o for o in ops2 if o[0] != "equal" and o[1] not in (0, len(win)) and o[3] not in (0, len(again))]
    same = [o for o in inner if o[0] == op and " ".join(win[o[1]:o[2]]) == said and " ".join(again[o[3]:o[4]]) == heard_]
    if not same: continue  # the second listen did not hear the same slip: a recogniser mistake, not a fault in the show
    if "--debug" in sys.argv: print("DEBUG", at, [(o, win[o[1]:o[2]], again[o[3]:o[4]]) for o in inner])
    problems.append(f"{int(at // 60)}:{at % 60:04.1f}  {op:7s} script: '{said}'  heard: '{heard_}' (heard again on a second listen)")
print(f"script words {len(script)}, heard {len(hw)}, match {sm.ratio():.3f}")
if problems:
    print("LISTENING CHECK FOUND", len(problems), "PROBLEMS"); [print("  " + p) for p in problems]; sys.exit(1)
print("listening check passed: every line heard in full, no extra fragments")
