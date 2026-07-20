# nodruma

**No Drama Drums** — portable C++ tool to chop drum grooves and recreate
kick / snare / hat one-shots. Experimental, headless.

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Binary: `./build/nodruma`

```bash
./build/nodruma help
./build/nodruma help split
```

## Live demo (WASM)

Browser MPC kit builder under [`webapp/`](webapp/): drop a groove (WAV, MP3, OGG,
FLAC, M4A, …), play pads with keys `1–9`, keep / rename / discard, export a ZIP
drumkit. Decode runs in-browser at 44.1 kHz so device sample rate doesn’t change
the engine.

```bash
./webapp/scripts/build_wasm.sh
python3 -m http.server 8080 -d webapp
```

GitHub Pages deploys from `main` via [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
(enable Pages → GitHub Actions in repo settings).

## What works today

| Feature | Status |
|---------|--------|
| Groove chop (`split`) via spectral flux | Good on typical breaks |
| Classify kick / snare / hat | Improved (onset-aligned sub/LF/HF); duplicates still common |
| Recreate **snare** from chop | Strong (layer mix) |
| Recreate **hat** from chop | Decent on short hats |
| Recreate **kick** from one-shot / mix | Usable; still improving |
| Morph params from session cache | Kick-oriented |

Generated files go under `./output/` (gitignored).

## Tester recipes

### 1. Split a groove and recreate hits

```bash
mkdir -p output
./build/nodruma split \
  --in your_groove.wav \
  --out-dir output/split/demo \
  --extract
```

Then listen to:

- `output/split/demo/00N_*.wav` — raw chops  
- `output/split/demo/extracted/00N_*_nodruma.wav` — recreated  
- `output/split/demo/hits.json` — onset / kind / confidence  

### 2. Rebuild a single one-shot

```bash
./build/nodruma process --model snare --in snare_chop.wav --out output/snare_out.wav
./build/nodruma process --model kick  --in kick.wav       --out output/kick_out.wav \
  --dump-layers output/layers/kick
```

### 3. Kick morph (analyze once, tweak gains)

```bash
./build/nodruma process --model kick --in kick.wav \
  --out output/kick_out.wav --write-session output/kick.bin
./build/nodruma morph --session output/kick.bin --model kick --out output/kick_morph.wav
```

## Commands (short)

| Command | Purpose |
|---------|---------|
| `process` | Analyze + resynthesize one WAV |
| `split` | Chop groove → WAVs + optional `--extract` |
| `detect` | Kick-oriented onset dump |
| `morph` | Resynth from session cache |
| `info` / `version` / `help` | Meta |

Full flag lists: `nodruma help <command>` or [docs/USAGE.md](docs/USAGE.md).

## Docs

- [docs/USAGE.md](docs/USAGE.md) — tester guide, flags, tips  
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — DSP pipeline  

## Layout

- `include/nodruma/` — public C++ / C API  
- `src/core/` — FFT, onset, split, STFT, extract, synth, engine  
- `src/models/` — kick / snare / hat  
- `tools/nodruma_cli/` — CLI  
- `webapp/` — WASM MPC demo (GitHub Pages)  
- `tests/` — unit tests  
- `output/` — local generations (gitignored)  

## License

Released under the Apache 2.0 license.
