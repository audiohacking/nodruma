# nodruma usage (early testers)

Headless CLI. Build first (`cmake` + `cmake --build`), then use `./build/nodruma`.

```bash
./build/nodruma help
./build/nodruma help split
./build/nodruma version
./build/nodruma info
```

## Groove → chops → recreate

Primary early-tester workflow:

```bash
./build/nodruma split --in your_groove.wav --out-dir output/split/mygroove --extract
```

| Output | Meaning |
|--------|---------|
| `NNN_kick.wav` / `_snare.wav` / `_hat.wav` / `_unknown.wav` | Transient chops |
| `hits.json` | Onsets, kind, confidence, LF/HF ratios |
| `extracted/NNN_<kind>_nodruma.wav` | Recreated hit (`process` per model) |

**Unknown** hits are chopped but **not** extracted. Process them by hand:

```bash
./build/nodruma process --model snare --in output/split/mygroove/003_unknown.wav \
  --out output/split/mygroove/extracted/003_manual_snare.wav
```

### Split knobs

| Flag | Default | Tip |
|------|---------|-----|
| `--threshold` | `1.0` | Lower (e.g. `0.7`) if hits are missed |
| `--min-gap` | `0.048` | Raise if double-triggers |
| `--max-hit` | `0.42` | Cap one-shot length (seconds) |
| `--no-classify` | off | Skip kick/snare/hat labels |
| `--prefix` | none | Prefix filenames |

Chopping uses STFT spectral flux (HFC + LF blend) and a robust median/MAD
threshold. Classification uses an **onset-aligned ~80 ms** spectrum (sub / LF /
mid / HF / air) with vetoes so strong sub/LF prefers kick over snare. See
Architecture → Groove split.

## Single-hit recreate

```bash
./build/nodruma process --model kick|snare|hat --in in.wav --out out.wav
```

Optional:

- `--dump-layers dir` — write mask layers (useful for debugging)
- `--write-session cache.bin` — save analysis for `morph`
- `--params p.json` — override gains / envelopes

### What each model does

| Model | Recreation path |
|-------|-----------------|
| `kick` | Stage-3 cleaned body (pitch-tracked LF) |
| `snare` | Gated STFT layers + wire/noise reinforce |
| `hat` | Short HF layers, LF bleed filtered |

## Kick morph

```bash
./build/nodruma process --model kick --in in.wav --out out.wav --write-session s.bin
./build/nodruma morph --session s.bin --out morph.wav [--params p.json]
```

## Known limits (honest)

- Classification is much better on kick-vs-snare after onset-aligned scoring,
  but dense grooves can still mislabel edge cases.
- Double-triggers / near-duplicate chops are common — dedupe is not done yet
  (raise `--min-gap` as a temporary workaround).
- Kick body quality is still improving on mixed sources.
- Hats on long/bleed-y chops can be thin or odd.
- `unknown` is not auto-recreated.
- No GUI / plugin host yet — CLI + C API only.

Feedback that helps: which groove, which hit index, chop vs extracted, and what
sounds wrong (body / crack / length / bleed / wrong label).
