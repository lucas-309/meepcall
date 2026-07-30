# CLAUDE.md — agent-friendly project docs

Personal macOS meeting + call recorder. Electron-vite + TypeScript + React app
with a **split engine**: a local Swift sidecar (ScreenCaptureKit + AVAudioEngine)
feeds chunked **whisper.cpp** transcription for everything (⌘⇧R hotkey, Record
Audio button, comm-app banner, in-person, phone calls). Recall.ai's Desktop SDK
is an **optional add-on** — when configured, it adds Zoom / Meet / Teams
auto-detection with per-participant labels via `recallai_streaming`. Anthropic
Claude (also optional) generates the summary on stop. Forked-by-reimplementation
from Recall's `muesli-public` reference app — same SDK shape, modernized stack.

**Lucas's machine** (`/Users/lucashe309/Developer/meepcall/`). macOS Apple
Silicon only — every other platform is intentionally out of scope.

The app boots and records fully locally with NO env vars set. `RECALLAI_*` and
`ANTHROPIC_API_KEY` are optional; `initSDK` early-returns when Recall env vars
aren't present (see `recall-sdk.ts` `isRecallConfigured()`). Don't add code
paths that hard-require Recall.

`AGENTS.md` is a 1-line stub pointing here for Codex CLI compatibility.

**Long-form reference** for the verbose gotchas and per-flag explanations lives
in `docs/AGENT_REFERENCE.md`. Read it on demand when a pointer below isn't
enough.

---

## Read this first

1. **Don't break the IPC contract.** `src/shared/types.ts` is the single source
   of truth for the renderer ↔ main API. Changes ripple through
   `preload/index.ts`, `main/ipc.ts`, and every renderer hook that touches
   `window.api`. Update all four together or you'll get silent runtime failures
   (preload exposes the surface, but if `ipc.ts` doesn't register a handler,
   `window.api.foo()` rejects with "no handler" at runtime — TypeScript won't
   catch it).

2. **`@recallai/desktop-sdk` `uploadRecording` is deprecated.** Don't add upload
   calls to `recording-ended` flows — the SDK auto-uploads now. The
   3-second-delay-then-upload pattern from Muesli was removed deliberately.

3. **`Authorization: Token <key>`** for Recall API — not `Bearer`. Single most
   likely thing to copy-paste wrong from generic API docs.

4. **`.env` keys must match the region.** Recall workspaces are region-scoped.
   401s with "Invalid API token" almost always = key/URL region mismatch:
   - `https://us-west-2.recall.ai` (US PAYG)
   - `https://us-east-1.recall.ai` (US Monthly)
   - `https://eu-central-1.recall.ai` (EU)
   - `https://ap-northeast-1.recall.ai` (Japan)

5. **Two transcription paths.**
   - Zoom/Meet/Teams (`meeting-detected`) → Recall's `recallai_streaming`,
     server-side, pushed through SDK as `transcript.data` events
     (`recall-sdk.ts`, `server.ts`).
   - Ad-hoc (⌘⇧R / Record Audio / comm-app banner) → Swift sidecar
     (`build/bin/audio-helper`) emits 16 kHz mono Int16 PCM, Node chunks 2 s
     fixed windows (or silero phrase boundaries when `MEEPCALL_PHRASE_VAD=1`),
     posts to per-source whisper-server processes
     (`audio-capture.ts`, `whisper-server.ts`, `whisper.ts`). Mic and system
     are **separate** helper + server processes so transcripts are labeled
     `"You"` / `"Other"` (whisper itself doesn't diarize).

6. **Three translation modes** for non-English transcripts (CJK, Cyrillic,
   Arabic, Hebrew, Devanagari, Thai, Greek, Latin-with-diacritics) — see
   `translator.ts` for the trigger regex and dispatcher:
   - **default Haiku 4.5** (Anthropic, ASR-error-correction prompt, 10-line
     context window, ~1–2 s/line). Best on noisy whisper output.
   - **NLLB-200-distilled-600M local** (`MEEPCALL_TRANSLATE_ENGINE=local`).
     Forked Node child process for crash isolation
     (`nllb-translate.ts` + `scripts/nllb-worker.mjs`). Sub-second/line, no
     API key, no ASR correction. q8 default; auto-fallback to fp32 on
     onnxruntime quantized-graph crash signals.
   - **disabled** if no `ANTHROPIC_API_KEY` and engine isn't `local`.

---

## Architecture

Source layout (run `ls src/main` for the canonical list — every file has a
top-of-file comment explaining its role):

- **Recording engines** — `recall-sdk.ts` (meeting auto-detect),
  `audio-capture.ts` (local Swift + whisper pipeline, chunker, cross-source
  bleed dedup, backpressure, RMS silence skip).
- **Audio helper** — `audio-helper/AudioHelper.swift` builds to
  `build/bin/audio-helper`. ScreenCaptureKit for system, AVAudioEngine for
  mic, route-change handling for AirPods, built-in-mic override by default.
- **Transcription** — `whisper-server.ts` (per-source whisper.cpp HTTP
  server, resident model), `whisper.ts` (HTTP client + hallucination
  filters + streak filter + language allow-list).
- **Translation** — `translator.ts` (dispatch + Haiku path),
  `nllb-translate.ts` + `scripts/nllb-worker.mjs` (local engine).
- **Post-recording** — `post-recording.ts` (shared "after stop" pipeline:
  marks recordingComplete, runs AI summary, fires `recording-completed`).
  Used by both Recall and local paths.
- **Persistence** — `storage.ts` (race-safe `meetings.json` store with
  `scheduleOperation` queue, `cleanOrphanedRecordings()` boot sweep).
- **Glue** — `state.ts` (singleton), `window.ts`, `ipc.ts`, `log.ts`
  (`[recall]` vs `[local]` tag split), `app-watcher.ts` (osascript poll for
  comm apps), `assets.ts` (dev vs packaged path resolution),
  `sdk-logger.ts`, `server.ts` (`:13373` mintUploadToken),
  `ai-summary.ts` (Anthropic SDK direct, claude-sonnet-4-6 streaming,
  notes folded into prompt).
- **Renderer** — `App.tsx` view router (`'home' | 'editor'`, no
  react-router), `pages/`, `components/`, `state/MeetingsContext` (auto-
  reloads on push events), `state/RecordingContext`, CSS in `assets/`
  (recall.css + note-editor.css are Muesli's verbatim, extras.css is ours).
- **Shared** — `src/shared/types.ts` is the IPC + data-model contract.

---

## Commands

```bash
# one-time: builds Swift sidecar + whisper-cli + whisper model + silero
# (~7 min on first run, ~1.6 GB whisper download). Requires cmake.
pnpm prebuild:assets

# opt-in: NLLB-200 q8 prefetch (~840 MB) — only needed for local translate
pnpm fetch:nllb-model

pnpm dev              # electron-vite dev server + Electron window
pnpm prod             # launch packaged app with terminal stdout/stderr
pnpm build            # typecheck + bundle main/preload/renderer
pnpm build:mac        # prebuild:assets + bundle + electron-builder DMG
pnpm typecheck        # tsc --noEmit on node + web
pnpm build:audio-helper       # swiftc → build/bin/audio-helper
pnpm fetch:whisper-assets     # whisper-cli + ggml model + silero

# isolated audio-helper smoke test (3 s mic capture)
./build/bin/audio-helper --source mic > /tmp/mic.raw 2> /tmp/mic.err &
sleep 3 && kill %1
ffplay -f s16le -ar 16000 -ac 1 /tmp/mic.raw

# upload-token endpoint sanity (needs `pnpm dev` + Recall env vars)
curl http://localhost:13373/start-recording
```

---

## Env vars

All env vars are optional. `.env` (gitignored) — `.env.example` is committed
with placeholders. **Never commit .env.** If the user pastes keys into a
chat, tell them to rotate.

```
RECALLAI_API_URL=https://us-west-2.recall.ai   # match key region (see above)
RECALLAI_API_KEY=<recall key>
ANTHROPIC_API_KEY=sk-ant-...
```

Behavior with missing keys:
- No `RECALLAI_*` → `initSDK` skips `RecallAiSdk.init`. ⌘⇧R / Record Audio
  still work via the local engine.
- No `ANTHROPIC_API_KEY` → boots fine. `Generate AI Summary` throws with a
  clear error.

### Tunable flags

Every `MEEPCALL_*` flag is read close to where it takes effect — grep for the
name to find its default + rationale. Defaults are zero-config for the two
primary use cases (Chinese meetings + music). The non-obvious ones, by name:
`MEEPCALL_TRANSLATE_ENGINE`, `MEEPCALL_NLLB_DTYPE`, `MEEPCALL_USE_DEFAULT_INPUT`,
`MEEPCALL_MIC_GAIN`, `MEEPCALL_PHRASE_VAD`, `MEEPCALL_USE_RECALL_FOR_ADHOC`,
`MEEPCALL_COMPARE_MODE`, `MEEPCALL_SILENCE_RMS_SKIP`, `MEEPCALL_DEBUG_WHISPER`,
`MEEPCALL_WHISPER_NO_FILTERS`. Long-form explanations + caveats in
`docs/AGENT_REFERENCE.md` § "Tunable `MEEPCALL_*` flags".

`pnpm dev` already prints what you need to debug the common failures without
setting anything: first-samples per source, RMS voice-floor warns,
route_change events, backpressure-drop reports, streak-filter suppressions,
and `[boot] Cleaned N orphaned recordings…` on startup.

---

## Conventions

- **Logger**: use `log.recall(...)` for actual Recall SDK events,
  `log.local(...)` for the Swift+whisper pipeline. Other tags:
  `log.server` / `log.ai` / `log.ok` / `log.warn` / `log.err`. No raw
  `console.log` in main process.
- **IPC channels**: lowercase-kebab-case (`meeting-detection-status`,
  `transcript-updated`, `comm-apps-running`).
- **State mutation**: go through `state.ts` singleton. Don't keep parallel
  state in other modules.
- **`meetings.json` writes**: use `scheduleOperation((data) => ...)` from
  `storage.ts`. Direct `fs.writeFile` will race with concurrent SDK events.
- **TypeScript**: `JSX.Element` isn't a global in React 19 — import
  `type { JSX }` from `'react'` in any component file annotating returns.
- **`react-markdown`** is for AI summary content only; transcript entries
  render as plain text.

---

## Known gotchas

One-line index. Long form (with file paths, error strings, and rationale)
lives in `docs/AGENT_REFERENCE.md` § "Known gotchas".

1. macOS Accessibility permission requires app restart before SDK fires events.
2. `@recallai/desktop-sdk` ships TypeScript types — trust them, don't redefine.
3. `pnpm.onlyBuiltDependencies` must list `@recallai/desktop-sdk` or postinstall is blocked.
4. Electron Fuses are applied via `build/afterPack.js`, not a forge/builder plugin.
5. `window.api.checkForDetectedMeeting()` only returns current state — `meeting-detection-status` push channel is the truth.
6. Cache-control on AI summary prompt is a no-op today (Sonnet 4.6 needs ≥2048 tokens).
7. `meeting-detected` only fires for Zoom/Meet/Teams/Slack — Discord/FaceTime/etc. go through `app-watcher.ts`.
8. `createMeetingNoteAndRecord` has an idempotency guard for double-clicks (notification + button can both fire).
9. whisper.cpp hallucinations on silence/music — layered defense (RMS skip + decoder thresholds + regex list + cross-chunk streak filter).
10. Two audio-helper processes per recording (mic + system) — bleed dedup is bidirectional and destructive on the mic side.
11. `extraResources` in `electron-builder.yml` triggers auto-codesigning of bundled Mach-O binaries.
12. `hardenedRuntime: false` is required without an Apple Developer ID — don't flip back on or prod crashes EXC_CRASH at launch.
13. AirPods A2DP zero-sample bug — Swift helper binds the input AU to the built-in mic explicitly.
14. FaceTime audio is excluded from ScreenCaptureKit by macOS — won't transcribe.
15. Recall ad-hoc speaker labels are `Host`/`Guest`, not real names.
16. NLLB worker pins `intra_op_num_threads: 1` and a non-`node_modules` cache path; parent restarts crashes up to 3×.

---

## Deferred / out-of-scope

Wired at the data layer but no UI:
- Debug panel (SDK event log + per-participant video frames — `video-frame`
  IPC channel exists, no consumer).
- Sidebar share/export buttons (Copy link, Email, Slack — visual only in
  Muesli's HTML, never wired).
- Voice-activity / calendar-triggered auto-record.
- In-call detection for Discord/FaceTime (only "app running" is detected).

Explicitly **not** going to do: Windows/Linux build, auto-update, tests/CI,
per-user accounts, provider-picker UI. To swap providers, edit `server.ts`
(meeting path: `recallai_streaming` → `deepgram_streaming` /
`assembly_ai_v3_streaming`) or `MEEPCALL_USE_RECALL_FOR_ADHOC=1` for the
ad-hoc path.

---

## Useful artifacts

- `/tmp/muesli/` — local checkout of upstream sample app (read-only). If
  something seems weirdly designed, it might be a Muesli decision we
  inherited.
- `.mcp.json` — `recall-docs` MCP server (Inkeep) at project scope. Use the
  MCP for Recall API questions instead of WebFetch.
- `docs/AGENT_REFERENCE.md` — long-form gotchas + flags.
