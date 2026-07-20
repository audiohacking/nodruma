# nodruma webapp (WASM MPC demo)

Drop a drum loop in the browser → chop / classify → MPC-style pads → export a kit ZIP.

## Local build

Requires [Emscripten](https://emscripten.org/) (`emcmake` / `emcc` on `PATH`).

```bash
./webapp/scripts/build_wasm.sh
python3 -m http.server 8080 -d webapp
# open http://localhost:8080
```

Keys `1`–`9` play the current bank. Use bank arrows for more pads. Export downloads `samples/*.wav` + `kit.json`.

## Notes

- Engine is linked as a library from the repo root (`nodruma_core`); bridge code lives only under `webapp/wasm/`.
- Generated `nodruma.js` / `nodruma.wasm` are build artifacts (gitignored); CI builds them for GitHub Pages.
