# nodruma webapp (WASM MPC demo)

Drop a drum loop in the browser → chop / classify → MPC-style pads → export a kit ZIP.

## Local build

Requires [Emscripten](https://emscripten.org/) (`emcmake` / `emcc` on `PATH`).

```bash
./webapp/scripts/build_wasm.sh
python3 -m http.server 8080 -d webapp
# open http://localhost:8080
```

## Using the demo

- **Drag & drop** one or more audio files anywhere on the page (first load replaces; later drops append).
- **Load audio** / **Add more** for the file picker (multi-select supported).
- Each source is **split + classified + recreated** automatically, then placed on pads.
- Keys `1`–`9` play the current bank. Export downloads `samples/*.wav` + `kit.json`.

## Notes

- Engine is linked as a library from the repo root (`nodruma_core`); bridge code lives only under `webapp/wasm/`.
- Generated `nodruma.js` / `nodruma.wasm` are build artifacts (gitignored); CI builds them for GitHub Pages.
