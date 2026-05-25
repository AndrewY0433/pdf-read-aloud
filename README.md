# PDF read-aloud

Small web app: upload a PDF, read it aloud in the browser, and highlight the current word.

## Speech engines

Two engines ship with the app, switchable from a toggle in the bottom bar:

- **Neural (Kokoro)** — _default._ Runs [Kokoro 82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) (Apache‑2.0) 100% locally in the browser via Transformers.js + ONNX Runtime Web. WebGPU is used automatically when available (`fp32`); otherwise it falls back to multithreaded WASM (`q8`, ~85 MB one-time download, cached by the browser). Quality is far above any built-in voice; word highlighting is interpolated from the chunk's playback position.
- **Browser** — uses the OS's `speechSynthesis` voices. Instant, no download, but lower quality and noticeably robotic.

Your choice is remembered across page loads.

## Limitations (MVP)

- **Upload only** — no opening PDFs from a URL.
- **No OCR** — text must be selectable in the PDF. Image-only or scanned documents show a clear error.
- **Reading order** — assumes roughly single-column, top-to-bottom text; multi-column layouts may read out of visual order.
- **Online dev/build** — the app is static, but the Kokoro model weights are fetched from the Hugging Face Hub on first use. Subsequent loads are served from the browser cache.
- **First-chunk latency** — Kokoro synthesises sentence-by-sentence; expect ~0.5–2s of silence before the first chunk plays. The next chunks pre-render in the background while the current one is playing.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL shown in the terminal (usually `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
```

## CI

Every push and pull request runs [GitHub Actions](.github/workflows/ci.yml): TypeScript typecheck, Vitest unit tests, production build, and Playwright e2e tests (Chromium).

## Controls

- **Play** — starts from the beginning when idle; **Pause** pauses speech (resume with Play).
- **Space** — toggle play / pause.
- **+ / −** — adjust playback speed.
- **Click any word** — restart playback from that word.
- **Upload** — choose another PDF.
- **Neural / Browser** — switch TTS engines on the fly.
- **Progress bar** — thin bar at the bottom of the viewer; hover to see which page you are on out of the total (e.g. “Page 12 of 240”).

## Todo
- [ ] **Voice selection** — pick a voice per engine (Kokoro voices and browser `speechSynthesis` voices).
- [ ] **Reformat `app.ts`** — split the monolithic `mount()` into smaller modules (chrome, resize handlers, playback wiring).

## Stack

Vite, TypeScript, PDF.js (`pdfjs-dist`), [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) (Transformers.js + ONNX Runtime Web), Web Speech API.
