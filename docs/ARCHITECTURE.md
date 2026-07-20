# nodruma Architecture

Portable C++20 drum extraction / resynthesis engine. Phase 1 is headless:
`libnodruma` + `nodruma` CLI. No plugin hosting in the engine yet.

## Current status (early testers)

Working end-to-end: **split groove → classify → recreate** kick/snare/hat.

- Split quality is strong on typical drum breaks.
- Hit classification uses onset-aligned sub/LF/HF bands (fewer kick→snare errors).
- Near-duplicate chops from dense flux peaks are still an open issue.
- Snare recreation (layer mix) tracks chops closely on test material.
- Hat recreation is usable on short HF hits; long/bleed-y chops vary.
- Kick path is the most involved; still being shaped.
- `unknown` chops are exported but skipped by `--extract`.

Tester guide: [USAGE.md](USAGE.md).

## Pipeline

1. **Analysis** — differentiate input → short STFT → **squared spectral flux**
   (no frame normalization, no half-wave rectification) → adaptive smooth →
   cubic upsample to sample rate → onset peaks.
2. **Extraction** — larger STFT; soft spectral masks per layer
   (`transient`, `foundation`, `tone`, `noise`, `perc_noise`, `residue`)
   using model band priors × time gates around the primary onset.
3. **Match** — amplitude envelopes + foundation pitch track (ZC / half-cycle).
4. **Resynthesis** — model-dependent:
   - `kick` → Stage-3 cleaned body playback (see Kick path below)
   - `snare` / `hat` → mix gated STFT layers (foundation/tone/noise/…) with
     model gains; snare reinforces wire noise, hat HP-filters LF bleed
5. **Mix + post** — gains, light stereo width (snare/hat), peak hard-limit.

## Groove split (transient chopping)

`split_groove` / CLI `nodruma split` is separate from kick-primary onset detect:

1. Pre-emphasize / differentiate → short STFT
2. Squared spectral flux with rising bin weights (HFC-ish) plus LF blend
3. Adaptive smooth → upsample → robust threshold (`median + MAD`, floored by P90)
4. Local-max peaks with `min_gap`; snap to amplitude attack
5. Segment to next onset / `max_hit`; classify kick/snare/hat from an
   onset-aligned ~80 ms spectrum (sub / LF / mid / HF / air + centroid), with
   hard vetoes so strong sub/LF cannot land on snare
6. Export one-shots + `hits.json`; optional `--extract` re-runs `process` per hit

API: `include/nodruma/split.hpp`, implementation `src/core/split.cpp`.

## Fast morph path

`Engine::analyze_and_extract` fills `AnalysisCache` (envelopes + pitch + layers).
`Engine::resynthesize` rebuilds audio from cache + `ModelParams` without STFT.
CLI: `process --write-session cache.bin` then `morph --session cache.bin --params p.json`.

## Models (`IModel`)

| id | name | focus |
|----|------|--------|
| `kick` | kick/ada.1 | low foundation, click transient |
| `snare` | snare/v1 | mid body + strong noise |
| `hat` | hat/v1 | short HF noise burst |

Models only supply band priors, oscillator recipes, pitch ranges, and default params.
Shared DSP lives in `src/core/`.

## Public API

- C++: `nodruma::Engine`, `Session`, `IModel`, `ModelParams`, `AudioBuffer`
- C ABI: `include/nodruma/nodruma.h` for future plugin hosts

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
./build/nodruma process --model kick --in kick.wav --out out.wav
```

## Kick path

Analysis / cleanup used for kick isolation and export:

1. **Prelim ZC pitch** on mild LP → sample-and-hold `freq = sr / (2 · width)`  
2. **Stage-3 cleanup** (TPT multipass @ `2×pitch`, tail 7.5/40 Hz, limiter) on a
   working copy — used for isolation, not as the export waveform  
3. **Re-measure widths on cleaned audio**, then **extend decay** by appending
   `mean(last, prev)` half-cycle width 4×  
4. **Export the Stage-3 cleaned body**: pitch-tracked LP keeps the
   fundamental/low-end; length follows cleaned-amp decay (~140–420 ms). Soft
   raised-cosine end fade only. Tail filters blend in a short mid-event window.
   Peak normalize + hard clip (no soft-knee mush).  
5. Still open: subtractive crossfade vs bed, median-filter hop rebuild, richer
   user envelope segments, forward–backward IIR on the tail-filter copy.

Modules: `pitch_zc.*`, `body_cleanup.*`, wired from `synth.cpp` analyze path.

## Dependencies

- C++20 compiler
- CMake ≥ 3.20
- Vendored `third_party/dr_wav.h` (WAV I/O for CLI / tests)
- In-tree FFT (radix-2) — no external FFT library required
