# PDF read-aloud — MVP plan

This document defines scope, architecture, and acceptance criteria for the first shippable version of a web app that displays a PDF, reads it aloud, and highlights the current word (with subtle sentence context).

## Product goals (MVP)

- User uploads a PDF (drag-and-drop or file picker).
- The app renders the PDF in the browser with a **full-page** (or near full-page) viewer.
- User presses **Play** to hear the text; **Pause** stops speech. No other transport controls in MVP.
- While audio plays, the UI shows:
  - a **clear highlight** on the **current word** (soft yellow),
  - a **lighter tint** on the **current sentence** (or line span used as sentence proxy).
- Layout: **PDF fills the view** with a **slim bottom bar** for play/pause (and minimal chrome such as filename if desired).
- **Online-only** is acceptable for MVP (no requirement for offline PDF or TTS).
- **Accessibility** (keyboard layers, screen reader polish) is **out of scope** for MVP unless trivially free.

## Non-goals (MVP)

- No OCR for scanned/image-only PDFs (MVP may show a clear error: “No selectable text”).
- No URL fetch for PDFs (upload only).
- No voice picker in UI (single default system voice; document extension point for a settings page later).
- No skip-by-word, scrubber, speed control, or click-to-jump in MVP.
- No native/Electron packaging (web app only); shell can be a later phase.
- No cloud TTS or paid APIs in MVP (reduces keys, billing, and alignment work).

## Recommended stack

| Layer | Choice | Rationale |
|--------|--------|-----------|
| Runtime | **Browser** | PDF rendering + speech without install. |
| Tooling | **Vite + TypeScript** | Fast dev, aligns with common small-app setup. |
| PDF render + text | **PDF.js** (`pdfjs-dist`) | Mature; provides text content and positions for mapping words to boxes. |
| Speech | **Web Speech API** (`speechSynthesis`) | No backend; good enough for MVP playback. |
| UI | **Plain DOM or minimal framework** | MVP is one screen; avoid framework churn unless the team already standardizes on one. |

## Technical design

### 1. PDF loading and rendering

- On file select: read the `File` as `ArrayBuffer`, pass to `getDocument`.
- Render pages to **canvas** (or PDF.js default viewer pattern) and build a **text layer** (transparent spans positioned over the canvas) so highlights can align with glyphs.
- Support **vertical scroll** through multiple pages.

### 2. Text extraction and reading order

- For each page, use PDF.js **getTextContent** (and text markers from the text layer) to obtain strings with **transforms** and widths.
- Normalize whitespace; split into **words** while preserving **character offsets** into a flat document string (or per-page string with a page index).
- **Reading order:** MVP assumes **single-column, top-to-bottom** flow. Note limitation for multi-column PDFs (future: column detection / structure tree).

### 3. Highlight model

- Precompute a list of entities, e.g. `{ pageIndex, wordIndex, sentenceId, bbox }` where `bbox` is in **viewport/text-layer coordinates** for overlay divs.
- **Active word:** soft yellow background on the corresponding text-layer span or an absolutely positioned highlight `div`.
- **Active sentence:** low-opacity background spanning the sentence’s word range (or a single rounded overlay behind the word row).
- Recompute positions on **window resize** and **zoom** if zoom is exposed; MVP may ship **fixed 100% zoom** first to reduce scope.

### 4. Speech and synchronization

- Build one **plain-text** string for TTS in reading order; maintain a **map from character index → word entity** (and sentence).
- Use `SpeechSynthesisUtterance` with the default voice (or first `speechSynthesis.getVoices()` match for `lang: 'en-US'` if you need a stable default).
- **Sync strategy (MVP, “as good as practical”):**
  - Use `utterance.onboundary` when the browser fires it (`speechSynthesisBoundary` / `word` where supported) to advance the active word.
  - Implement a **fallback estimator** (e.g. elapsed time × estimated characters per second, tuned per utterance length) so the highlight **keeps moving** if boundaries are sparse or missing.
  - Document known **browser variance**; accept small drift on long paragraphs for MVP.

### 5. State and controls

- States: `idle` | `playing` | `paused`.
- **Play:** if idle or paused from start, start from first word (or first visible page — pick one rule and document it); if paused mid-stream, **resume** if the platform allows, otherwise **restart from current word** (document behavior).
- **Pause:** cancel or pause synthesis per browser capability; freeze highlight index.

### 6. Failure modes (user-visible)

- **Empty / image-only PDF:** message that selectable text is required.
- **Very large PDF:** optional soft cap or lazy per-page extraction to avoid blocking the main thread (MVP: simple async chunking if needed).
- **No voices / blocked autoplay:** show a message; require explicit user gesture (Play) before speaking.

## Acceptance criteria (checklist)

- [ ] User can upload a PDF and see pages rendered in the browser.
- [ ] Extracted text matches what is visibly selectable on a **simple text PDF** test file.
- [ ] Play starts speech from the beginning of extracted text; Pause stops it.
- [ ] During playback, **one word** is highlighted in soft yellow and its **sentence** (or proxy span) has a lighter tint.
- [ ] Highlight advances through the document in sync with speech **within reasonable tolerance** (manual test on Chrome + one other browser).
- [ ] Bottom bar layout does not obscure critical PDF controls; Play/Pause is always reachable.
- [ ] README or inline copy states limitations: no OCR, upload-only, Web Speech sync limitations.

## Milestones

1. **Spike:** one hard-coded page + one moving fake highlight (no TTS) to validate coordinates.
2. **Render path:** upload → PDF.js → multi-page scroll + text layer.
3. **Extract path:** build word list + sentence grouping + char map.
4. **TTS path:** utterance + boundary + fallback estimator + highlight updates.
5. **Hardening:** error states, basic performance check on a 20-page text PDF.

## Post-MVP (backlog pointer)

- Click word to start; speed and voice UI; keyboard shortcuts.
- Better sync via **cloud TTS with timestamps** or server-side alignment.
- OCR for scans; URL open; offline/cache; Electron wrapper.
- Multi-column reading order and structure-aware extraction.

## Open decisions (resolve when scaffolding the repo)

- **Exact default:** start speech from page 1 vs first visible page.
- **Framework:** vanilla TS vs React (team preference only).
- **Zoom:** ship at 100% only for MVP vs minimal zoom buttons.

---

*Derived from discovery: upload-only PDF, overlay + bottom bar, play/pause only, word + sentence highlight (yellow + tint), precise sync as practical with Web Speech, online-only, no MVP accessibility mandate.*
