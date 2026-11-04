"""Upbeat, royalty-free music bed made from scratch: pad chords, a plucked arpeggio, kick and hats.
Usage: python3 musicbed.py SECONDS out.wav"""
import sys, wave, numpy as np
SR = 44100; BPM = 116; beat = 60 / BPM
dur = float(sys.argv[1]); n = int(SR * dur); t = np.arange(n) / SR
f = lambda m: 440 * 2 ** ((m - 69) / 12)
chords = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]]  # Cmaj7 Am7 Fmaj7 G
out = np.zeros(n)
bar = beat * 4
# pad: soft saw-ish chords, one per bar, smooth envelope
for b in range(int(dur / bar) + 1):
    s0 = int(b * bar * SR); s1 = min(n, int((b + 1) * bar * SR)); L = s1 - s0
    if L <= 0: break
    tt = np.arange(L) / SR; env = np.minimum(1, tt / 0.25) * np.minimum(1, (L / SR - tt) / 0.3)
    for m in chords[b % 4]:
        fr = f(m - 12)
        out[s0:s1] += 0.05 * env * (np.sin(2 * np.pi * fr * tt) + 0.3 * np.sin(2 * np.pi * 2 * fr * tt) + 0.1 * np.sin(2 * np.pi * 3 * fr * tt))
# pluck arpeggio on eighth notes
step = beat / 2
for k in range(int(dur / step)):
    s0 = int(k * step * SR); L = min(int(0.35 * SR), n - s0)
    if L <= 0: break
    ch = chords[int(k * step / bar) % 4]; m = ch[[0, 2, 1, 3, 2, 1, 3, 2][k % 8]] + 12
    tt = np.arange(L) / SR; env = np.exp(-tt * 9)
    out[s0:s0 + L] += 0.07 * env * np.sin(2 * np.pi * f(m) * tt) * (1 + 0.4 * np.sin(2 * np.pi * 2 * f(m) * tt))
# kick on every beat, hat on the offbeat
for k in range(int(dur / beat)):
    s0 = int(k * beat * SR); L = min(int(0.25 * SR), n - s0)
    tt = np.arange(L) / SR
    out[s0:s0 + L] += 0.35 * np.exp(-tt * 18) * np.sin(2 * np.pi * (50 + 90 * np.exp(-tt * 40)) * tt)
    h0 = int((k + 0.5) * beat * SR); HL = min(int(0.05 * SR), n - h0)
    if HL > 0: out[h0:h0 + HL] += 0.05 * np.exp(-np.arange(HL) / SR * 80) * np.random.default_rng(k).uniform(-1, 1, HL)
# fades and normalise
fade = int(1.5 * SR); out[:fade] *= np.linspace(0, 1, fade); out[-fade:] *= np.linspace(1, 0, fade)
out = out / np.max(np.abs(out)) * 0.8
st = np.stack([out, np.roll(out, 220) * 0.97], 1)  # light stereo width
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype("<i2").tobytes())
print("music", sys.argv[2], dur)
