# The Weekend Sale Now On: show builder

Builds the long-form 16:9 show from a week's deals: title card, category sections, 3-second products, paid FEATURED
slots, host lines, music per part, sound cues, closing card with QR, YouTube chapters and a show index for
salenowon.co.uk/show/SLUG.

## Steps

```
python3 show_builder.py script SHOW.json OUT     # writes OUT/vo-script.txt (one line per paragraph) and OUT/vo-lines.json
# make the voice from OUT/vo-script.txt -> OUT/vo-all.mp3, and its word timings -> OUT/words.json
python3 backview.py OUT/pics CODE... > OUT/second-photo.json   # optional: picks the back view (needs opencv 4)
python3 show_builder.py split OUT                # cuts one clip per line AT THE QUIETEST POINT between lines
python3 show_builder.py build SHOW.json OUT --jobs 2
```

## The checks (the build stops if any fails)

| check | when | catches |
|---|---|---|
| voice pre-check | after split, and again at the start of build | a cut through speech (stutter or cut-off word), a silent clip, a line far from its expected length |
| timing pre-check | before rendering | two host lines overlapping, a host line running onto the next product |
| render retry | during rendering | a part that failed to render (retried once, then stop) |
| final check | after mixing | picture and sound different lengths, any silent gap over 0.5 s |
| listening check | after mixing | transcribes the host's voice track (OUT/voice-only.wav) and compares it word for word with the script; a slip counts only if heard again on a second listen |

## What went wrong before, and the rule that now prevents it

- Host lines longer than their product: a normal product only gets short lines (fit in 3 s). Long descriptions go
  on FEATURED (paid) products, whose slot stretches until the host has finished.
- Cutting the voice on pauses: a pause inside a line ("Next, shorts. Up to...") moved every later cut. Cuts now use
  word timings.
- Cutting a fixed margin around the words: when the voice runs two lines together (0.08 s apart) the margin lands
  inside the next word, which you hear as a stutter. Cuts now go at the quietest point between lines, and the level
  at every cut must be below -45 dB.
- Fades timed from the start of the whole recording: every clip after the first faded to silence. Clips are cut with
  atrim + asetpts so fades are timed from the clip, and the pre-check now fails silent clips.
- A `<break>` pause tag is not reliable with eleven_v4: do not depend on it.
