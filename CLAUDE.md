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

`AGENTS.md` is a symlink to this file — keep them aligned.

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

### Tunable flags (full list lives in source)

Every `MEEPCALL_*` env var is read close to where it takes effect — grep for
the var to find its exact default and rationale. The non-obvious ones:

- **`MEEPCALL_TRANSLATE_ENGINE`** = `haiku` (default) or `local`. See
  `translator.ts` / `nllb-translate.ts`.
- **`MEEPCALL_NLLB_DTYPE`** = `q8` (default) / `fp32`. Auto-falls-back to
  fp32 on quantized-graph crash signals (SIGTRAP/SIGABRT/SIGBUS/SIGSEGV) in
  `onnxruntime-node`. Set explicitly to skip the q8 attempt.
- **`MEEPCALL_USE_DEFAULT_INPUT=1`** — opt OUT of the built-in-mic
  override. Default behavior binds the input AU to the built-in Mac mic via
  CoreAudio (sidesteps the AirPods A2DP zero-sample bug). Set this only if
  you actually want the AirPods/USB-headset mic.
- **`MEEPCALL_MIC_GAIN`** — software post-tap gain on mic, default `4.0`
  (~12 dB), tuned for built-in MacBook mic ~50 cm from speaker. Set to `1`
  for close mics. Saturation arithmetic, no wraparound clicks.
- **`MEEPCALL_PHRASE_VAD=1`** — silero-vad chunker (1–5 s phrase
  boundaries). Off by default because silero correctly flags music as
  non-speech, which is wrong for music transcription.
- **`MEEPCALL_USE_RECALL_FOR_ADHOC=1`** — route ⌘⇧R through Recall's
  `prepareDesktopAudioRecording`. Costs Recall credits.
- **`MEEPCALL_COMPARE_MODE=1`** — local + shadow Recall in parallel; Recall
  transcripts go to terminal only.
- Diagnostics: `MEEPCALL_DEBUG_WHISPER=1` (log every whisper segment +
  which filter dropped it), `MEEPCALL_WHISPER_NO_FILTERS=1` (bypass
  hallucination + dedup; correctness gates still run).

`pnpm dev` already prints what you need to debug the common failures
without setting anything: first-samples log per source, RMS voice-floor
warns, route_change events, backpressure-drop reports with recent
inference times, streak-filter suppressions, and `[boot] Cleaned N
orphaned recordings…` on startup.

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

1. **macOS Accessibility permission requires app restart.** First grant
   doesn't take effect until next launch. SDK fires no events until granted.

2. **The SDK ships TypeScript types** at
   `node_modules/@recallai/desktop-sdk/index.d.ts`. Trust them — don't
   redefine `RealtimeEvent` etc.

3. **`pnpm.onlyBuiltDependencies`** in `package.json` must include
   `@recallai/desktop-sdk` or the postinstall (`setup.js` that downloads
   the native binary) gets blocked by pnpm's default-deny.

4. **Electron Fuses are applied via `build/afterPack.js`**, not by a
   forge/builder plugin. We deviated from Muesli's
   `@electron-forge/plugin-fuses` because we use electron-builder.

5. **`window.api.checkForDetectedMeeting()` only returns current state**;
   the source of truth for "is a meeting detected right now" is the
   `meeting-detection-status` push channel.

6. **Cache-control on the AI summary system prompt is a no-op today.**
   Sonnet 4.6 needs ≥2048 tokens for caching; our prompt is ~175 tokens.
   Left in for forward-compat.

7. **`meeting-detected` only fires for Zoom/Meet/Teams/Slack.**
   Discord/FaceTime/WhatsApp/etc. are NOT detected by the SDK — surfaced
   via `app-watcher.ts` polling and routed to the local engine.

8. **Idempotency guard in `createMeetingNoteAndRecord`**: double-clicks
   return the existing note id instead of creating a duplicate. Both the
   notification handler AND the in-app button can fire.

9. **whisper.cpp hallucinations on silence/music.** Layered defense in
   `audio-capture.ts` + `whisper.ts` + `whisper-server.ts`:
   (a) pre-whisper RMS silence skip (`MEEPCALL_SILENCE_RMS_SKIP`,
   default 0.001), (b) decoder-internal confidence gates
   (`--no-speech-thold`, `--logprob-thold`, `--entropy-thold`,
   `--no-fallback`), (c) per-segment regexes + `KNOWN_HALLUCINATION_PHRASES`
   list (Chinese streaming-channel intros, subtitle credits, YouTube CTAs,
   `Zither Harp`), (d) cross-chunk streak filter (suppress Nth identical
   short utterance, default 2). Defaults are zero-config for the two
   primary use cases (Chinese meetings + music). The streak filter
   thresholds are tuned NOT to catch song-lyric repetition.

10. **Two audio-helper processes per recording.** Mic + system are separate
    sidecars so we can label `"You"`/`"Other"`. `stopManualRecording`
    SIGTERMs both, awaits residual whisper transcription, then runs
    `runPostRecording`.

    **Speaker-bleed dedup is bidirectional and destructive.** When the user
    is on speakers, mic captures speaker output AND user voice — both
    whisper instances transcribe similar content. Dedup compares: exact
    normalized equality, OR substring containment, OR ≥3 shared tokens
    with ≥60% overlap. On a system entry arrival we destructively remove
    matching recent mic entries from the persisted transcript (brief
    flicker, intentional). If a real read-back gets caught (paraphrase
    with high overlap), accept it — cleaner default beats occasional loss.

11. **`extraResources` in `electron-builder.yml`** copies `audio-helper`,
    `whisper-cli`, `ggml-large-v3-turbo.bin`, `silero-vad.onnx`, and
    `nllb-worker.mjs` into the app bundle. `electron-builder` auto-codesigns
    Mach-O binaries it finds there. If you add another helper or model,
    add it AND verify with `codesign -dvv` after `pnpm build:mac`.
    `asarUnpack` keeps `@huggingface/**` + `onnxruntime-node/**` outside
    the asar so Transformers.js can mmap them.

12. **`hardenedRuntime: false` in `electron-builder.yml`.** Without an
    Apple Developer ID, ad-hoc identities don't satisfy Sequoia's
    hardened-runtime loader (`mapping process and mapped file (non-platform)
    have different Team IDs`). Disabling is fine for personal use; **don't
    flip back on without a real Developer ID** or the prod app crashes at
    launch with EXC_CRASH.

13. **AirPods specifically.** macOS routes them in A2DP (no real mic) and
    sometimes hands the mic API zero-filled buffers when an app requests
    mic. The Swift helper sidesteps this by binding the input AU directly
    to the built-in Mac mic via
    `kAudioOutputUnitProperty_CurrentDevice` before `engine.start()`.
    AirPods stay clean A2DP for output, built-in mic captures voice.
    `MEEPCALL_USE_DEFAULT_INPUT=1` opts out. `MicCapture` also handles
    `AVAudioEngineConfigurationChange` with up to 5×200 ms retries
    (sample-rate transitions can return 0 for ~100 ms).

14. **FaceTime audio is protected by macOS.** Apple excludes FaceTime
    output from ScreenCaptureKit. FaceTime calls won't transcribe — neither
    side. Use Discord/Zoom/Meet/iPhone-Continuity. (BlackHole virtual
    audio device is a workaround.)

15. **Recall ad-hoc speaker labels are `Host`/`Guest`, not real names.**
    `prepareDesktopAudioRecording` sessions are anonymous.

16. **NLLB worker pins `intra_op_num_threads: 1`** to dodge BFCArena
    SIGTRAPs on q8 quantized graphs in onnxruntime-node 1.24.3, and pins
    the Transformers.js cache to `~/.cache/meepcall/nllb` (NOT
    node_modules-local — survives `pnpm install`). Worker forks via
    `child_process.fork` with `ELECTRON_RUN_AS_NODE=1`; parent restarts
    on crash up to 3× per session, then permanent-fails.

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
