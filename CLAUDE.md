# CLAUDE.md — agent-friendly project docs

Personal macOS meeting + call recorder. Electron-vite + TypeScript + React app
with a **split engine**: a local Swift sidecar (ScreenCaptureKit + AVAudioEngine)
feeds chunked **whisper.cpp** transcription for everything (⌘⇧R hotkey, Record
Audio button, comm-app banner, in-person, phone calls). Recall.ai's Desktop SDK
is an **optional add-on** — when configured, it adds Zoom / Meet / Teams
auto-detection with per-participant labels via `recallai_streaming`. Anthropic
Claude (also optional) generates the summary on stop. Forked-by-reimplementation
from Recall's `muesli-public` reference app — same SDK shape, modernized stack.

**Lucas's machine** (`/Users/lucashe309/Developer/meepcall/`). macOS Apple Silicon
only — every other platform is intentionally out of scope.

The app boots and records fully locally with NO env vars set. `RECALLAI_*` and
`ANTHROPIC_API_KEY` are optional add-ons; `initSDK` early-returns when Recall
env vars aren't present (`recall-sdk.ts` `isRecallConfigured()`). Don't add new
code paths that hard-require Recall.

---

## Read this first

1. **Don't break the IPC contract.** `src/shared/types.ts` is the single source of
   truth for the renderer ↔ main API. Changes ripple through `preload/index.ts`,
   `main/ipc.ts`, and every renderer hook that touches `window.api`. Update all
   four together or you'll get silent runtime failures (preload exposes the
   surface, but if `ipc.ts` doesn't register a handler, `window.api.foo()` rejects
   with "no handler" at runtime — TypeScript won't catch it).

2. **`@recallai/desktop-sdk` `uploadRecording` is deprecated.** Don't add upload
   calls to `recording-ended` flows — the SDK auto-uploads now. The
   3-second-delay-then-upload pattern from Muesli was removed deliberately. If
   you see code recommending `RecallAiSdk.uploadRecording`, it's stale.

3. **`Authorization: Token <key>`** for Recall API — not `Bearer`. This is the
   single most likely thing to copy-paste wrong from generic API docs.

4. **Two transcription paths.** For Zoom/Meet/Teams (the `meeting-detected`
   path), Recall's first-party `recallai_streaming` provider transcribes
   server-side and pushes `transcript.data` events through the SDK. For ad-hoc
   recordings (the ⌘⇧R / Record Audio / comm-app paths), a local Swift sidecar
   (`build/bin/audio-helper`) emits 16 kHz mono Int16 PCM, Node feeds it
   through a sliding-window chunker (3 s wide, 2 s step, 1 s overlap) into
   `build/bin/whisper-cli` (whisper.cpp) with `ggml-large-v3-turbo.bin`. The 1 s
   overlap gives whisper context across cut boundaries; segments inside the
   overlap region are dropped at emit time to prevent duplicate entries.
   When `MEEPCALL_PHRASE_VAD=1` is set, the chunker switches to silero-vad
   (`build/models/silero-vad.onnx`) phrase-boundary detection instead.
   The mic and system audio are captured as **separate** helper processes so
   we can label them `"You"` and `"Other"` respectively (whisper itself
   doesn't diarize).

5. **`.env` keys must match the region.** Recall workspaces are region-scoped.
   401s with "Invalid API token" almost always = key/URL region mismatch, not
   actually invalid key. Region URLs:
   - `https://us-west-2.recall.ai` (US PAYG)
   - `https://us-east-1.recall.ai` (US Monthly)
   - `https://eu-central-1.recall.ai` (EU)
   - `https://ap-northeast-1.recall.ai` (Japan)

---

## Architecture

```
main process
├── recall-sdk.ts          Recall SDK init + meeting-detected listeners +
│                          createMeetingNoteAndRecord (Zoom/Meet/Teams ONLY)
├── audio-capture.ts       local recording engine: spawns two audio-helper
│                          sidecars per recording (mic + system), chunks via
│                          3s/2s/1s sliding window (or silero-vad phrase
│                          boundaries when MEEPCALL_PHRASE_VAD=1), drives
│                          whisper, fires transcript-updated. Also routes
│                          to Recall ad-hoc / compare modes via env flags.
├── audio-helper/          Swift source (ScreenCaptureKit + AVAudioEngine);
│                          built into build/bin/audio-helper via build.sh.
│                          Mic side handles AVAudioEngineConfigurationChange
│                          to rebuild the tap when AirPods/route change.
├── silero-vad.ts          onnxruntime-node wrapper around silero-vad.onnx;
│                          per-source LSTM-stateful frame-by-frame VAD used
│                          only when MEEPCALL_PHRASE_VAD=1.
├── whisper.ts             whisper-cli wrapper. Per-source serial queue,
│                          hallucination filter (loop detectors), text+time
│                          dedup ring buffer, "You" / "Other" labeling.
├── post-recording.ts      shared "after stop" pipeline (recordingComplete,
│                          generate summary, fire recording-completed) used
│                          by both the Recall and the local paths
├── wav.ts                 30-line WAV header writer for chunk files
├── assets.ts              resolves bin/ and models/ paths (dev vs packaged)
├── server.ts              Express server on :13373 + mintUploadToken (still
│                          used by createMeetingNoteAndRecord for the meeting
│                          path; unused on ad-hoc)
├── ai-summary.ts          Anthropic SDK direct, claude-sonnet-4-6 streaming,
│                          system prompt has cache_control (no-op until prompt
│                          exceeds Sonnet 4.6's 2048-token minimum)
├── ipc.ts                 ipcMain handlers — request/invoke + push channels
├── storage.ts             race-safe meetings.json store with caching + queued
│                          ops (port of Muesli's fileOperationManager)
├── state.ts               singleton: detectedMeeting, activeMeetingIds, recordings
├── window.ts              BrowserWindow factory + sendToRenderer helper
├── app-watcher.ts         5s poll of `osascript` for running comm apps (macOS)
├── sdk-logger.ts          EventEmitter for SDK API calls + events (forwarded
│                          to renderer over `sdk-log` channel)
├── log.ts                 tagged + timestamped colored terminal logger
└── index.ts               app lifecycle, IPC registration, ⌘⇧R global hotkey

preload
└── index.ts               typed contextBridge.exposeInMainWorld('api', …)

renderer (React)
├── App.tsx                routing state (home | editor) + provider setup
├── pages/
│   ├── HomePage.tsx       date-grouped MeetingCards + detection banners
│   └── NoteEditor.tsx     header + LiveTranscript card + AISummary card
├── components/
│   ├── Header.tsx         search + Record Audio + Record Meeting buttons
│   └── MeetingCard.tsx
├── state/
│   ├── MeetingsContext    auto-reloads on push events (transcript-updated etc.)
│   └── RecordingContext   meetingDetected + commAppsRunning state
└── assets/
    ├── recall.css         Muesli's index.css verbatim (1,036 lines)
    ├── note-editor.css    Muesli's editor styles verbatim
    └── extras.css         our additions: cards, banners, summary styling

shared
└── types.ts               Meeting, MeetingsData, IPC channel surface, etc.
```

### Key data flows

**Meeting auto-detect → recording**:

```
Recall SDK fires meeting-detected
  → state.detectedMeeting = evt
  → notification + sendToRenderer('meeting-detection-status', {detected:true})
  → user clicks Record Meeting in Header
  → window.api.joinDetectedMeeting()
  → recall-sdk.ts joinDetectedMeeting() → createMeetingNoteAndRecord()
    → mintUploadToken() (direct fn call, not HTTP)
    → state.addRecording(windowId, noteId, platform)
    → write new meeting to meetings.json
    → RecallAiSdk.startRecording({windowId, uploadToken})
    → SDK fires recording-started → state confirms
    → sendToRenderer('open-meeting-note', id) → renderer navigates
```

**Live transcript flow**:

```
Recall SDK fires realtime-event (every speech utterance)
  → if event === 'transcript.data':
    → log to terminal UNCONDITIONALLY (debug visibility)
    → if state.activeMeetingIds[windowId]?.noteId:
      → scheduleOperation: append to meeting.transcript[]
      → sendToRenderer('transcript-updated', noteId)
      → MeetingsContext.reload() → re-renders LiveTranscript card
```

**Recording end → AI summary** (shared by both engines):

```
recall-sdk.updateNoteWithRecordingInfo OR audio-capture.stopManualRecording
  → runPostRecording(noteId)        ← src/main/post-recording.ts
    → marks recordingComplete + recordingEndTime
    → if transcript.length > 0:
      → generateMeetingSummary(meeting, onProgress)
        → Anthropic streaming Messages API
        → onProgress fires per token → sendToRenderer('summary-update')
        → renderer's NoteEditor renders streaming markdown
      → meeting.content = summary; hasSummary = true; persist
    → sendToRenderer('recording-completed', meetingId)
```

**Phone-call / ad-hoc recording (local engine)**:

```
⌘⇧R hotkey OR Record Audio button OR comm-app banner click
  → audio-capture.startAdHocRecording(label)
    → if MEEPCALL_USE_RECALL_FOR_ADHOC=1: route to startRecallAdHocRecording
    → else: randomUUID() recordingId; create note in meetings.json
    → spawn audio-helper --source mic   (AVAudioEngine → stdout PCM)
    → spawn audio-helper --source system (SCStream     → stdout PCM)
    → 3 s sliding window with 1 s overlap (or silero phrase boundaries
      when MEEPCALL_PHRASE_VAD=1): write WAV → whisper-cli → entries
    → text+time dedup against a 3 s ring buffer to suppress overlap dupes
    → entries appended with speaker="You" (mic) or "Other" (system)
    → sendToRenderer('transcript-updated', noteId) per chunk
    → if MEEPCALL_COMPARE_MODE=1: also start a parallel Recall shadow
      recording — its transcripts print to terminal only (no note).
  ⌘⇧R again
  → audio-capture.stopManualRecording(recordingId)
    → SIGTERM both helpers → drain residual buffers → final whisper pass
    → if compare mode: also stop the shadow Recall recording
    → runPostRecording(noteId) (shared with the meeting path above)
```

Triggers for the local engine:
1. Header `Record Audio` button → `startAdHocRecording(label)`
2. `⌘⇧R` global hotkey → toggles record/stop
3. Comm-app banner (Discord/FaceTime/etc detected) → same button, label changes

**Note-taking + AI summary fold-in**:

```
NoteEditor.tsx renders a NotesEditor card above the LiveTranscript
  → user types into a controlled textarea (local state)
  → 400 ms debounced autosave via updateMeeting → saveMeetingsData IPC
  → debounced save flushes on blur and on unmount as well
ai-summary.ts buildUserContent
  → if meeting.notes is non-empty, prepend a "User's typed notes
    (HIGH SIGNAL — weight heavily)" block before the transcript
  → system prompt instructs Claude to prefer notes on factual conflicts
```

---

## Commands

```bash
# one-time: build the Swift sidecar + fetch/build whisper-cli + whisper model
# + silero-vad ONNX model. (Requires cmake — `brew install cmake` if missing.)
# ~5 min on first run (1.6 GB whisper download dominates).
pnpm prebuild:assets

pnpm dev            # electron-vite dev server + Electron window (hot reload)
pnpm prod           # launch dist/mac-arm64/meepcall.app's main exec with
                    # stdout/stderr attached to terminal — for prod-build logs
pnpm build          # typecheck + bundle main/preload/renderer
pnpm build:mac      # prebuild:assets + bundle + electron-builder DMG (macOS)
pnpm typecheck      # tsc --noEmit on both node + web tsconfigs

# also available individually:
pnpm build:audio-helper   # swiftc → build/bin/audio-helper
pnpm fetch:whisper-assets # build/bin/whisper-cli + whisper model + silero-vad

# sanity test the upload-token endpoint (must have pnpm dev running AND Recall
# env vars set; otherwise this returns an error):
curl http://localhost:13373/start-recording

# sanity test the audio-helper in isolation (mic mode for 3s):
./build/bin/audio-helper --source mic > /tmp/mic.raw 2> /tmp/mic.err &
sleep 3 && kill %1
ffplay -f s16le -ar 16000 -ac 1 /tmp/mic.raw   # play it back

# stop the dev server
# Ctrl-C in terminal, OR ⌘Q on the Electron window
```

---

## Env vars

All env vars are optional. The app boots and records fully locally with
nothing set.

`.env` (gitignored):

```
# Recall.ai (optional add-on) — Zoom/Meet/Teams auto-detect with
# per-participant labels. Both URL + KEY must be set together.
RECALLAI_API_URL=https://us-west-2.recall.ai   # see region notes above
RECALLAI_API_KEY=<recall key — must match URL region>

# Anthropic (optional add-on) — AI summaries on call end.
ANTHROPIC_API_KEY=sk-ant-...
```

`.env.example` is committed with placeholders, `RECALLAI_API_URL` deliberately
left blank. **Never commit .env.** If the user pastes keys into a chat, tell
them to rotate.

Behavior with missing keys:
- No `RECALLAI_*` → `initSDK` skips `RecallAiSdk.init`, no meeting auto-detect,
  no banner. ⌘⇧R / Record Audio still work end-to-end via the local engine.
- No `ANTHROPIC_API_KEY` → app boots fine (lazy init in `ai-summary.ts`).
  `Generate AI Summary` calls throw with a clear error.

### Tunable runtime flags (also env vars)

- `WHISPER_MODEL` — `ggml-large-v3-turbo.bin` (default), or any other whisper.cpp
  model name in `build/models/`. Keep matched to `WHISPER_MODEL_NAME` for the
  fetch script.
- `WHISPER_LANGUAGE` — `auto` (default, multilingual) or ISO code.
- `MEEPCALL_NO_SPEECH_THOLD` — `0.6` default; lower for music, higher for
  silence-tolerant speech.
- `MEEPCALL_PHRASE_VAD=1` — opt-in chunker that uses silero-vad for natural
  phrase-boundary chunks (1–5 s). Off by default because silero correctly
  flags music as non-speech, which is the wrong call for music transcription.
- `MEEPCALL_DEBUG_WHISPER=1` — log every whisper segment + filter decision.
- `MEEPCALL_WHISPER_NO_FILTERS=1` — bypass hallucination + dedup filters.
- `MEEPCALL_USE_RECALL_FOR_ADHOC=1` — route ⌘⇧R / Record Audio through
  `RecallAiSdk.prepareDesktopAudioRecording` instead of the local engine.
  Costs Recall credits.
- `MEEPCALL_COMPARE_MODE=1` — local + shadow Recall recording in parallel.
  Local writes the note as normal; Recall transcripts print to terminal only.
- `MEEPCALL_RECALL_LANG` / `MEEPCALL_RECALL_MODE` — per-run override for the
  `recallai_streaming` provider config. Defaults `en` + `prioritize_low_latency`
  (the only combo Desktop SDK supports for Recall's own provider).

---

## Conventions

- **Logger**: use `log.recall(...)` / `log.local(...)` / `log.server(...)` /
  `log.ai(...)` / `log.ok(tag, ...)` / `log.warn(tag, ...)` / `log.err(tag, ...)`
  from `src/main/log.ts`. **`log.recall` is reserved for actual Recall.ai SDK
  events**; the local Swift + whisper pipeline uses `log.local` (blue tag).
  Reading the terminal: `[recall]` = Recall SDK, `[local]` = local engine.
  Don't add raw `console.log` to main process — it bypasses the timestamp +
  tag formatting.

- **IPC channels**: lowercase-kebab-case (`meeting-detection-status`,
  `transcript-updated`, `comm-apps-running`). Match Muesli's naming where it
  carries over.

- **State mutation**: always go through `state` singleton (`src/main/state.ts`).
  Don't keep parallel state in other modules.

- **File writes to meetings.json**: use `scheduleOperation((data) => ...)` from
  `storage.ts`. Direct `fs.writeFile` will race with concurrent SDK events.

- **Renderer navigation**: not a router. `App.tsx` has `view: 'home' | 'editor'`.
  `onOpenMeeting(id)` switches to editor view. Future agents who want react-router:
  the IPC channel `open-meeting-note` already broadcasts the meeting id from
  main; the renderer just needs to listen.

- **TypeScript**: `JSX.Element` doesn't exist as a global type in React 19 —
  import `type { JSX }` from `'react'` explicitly in any component file that
  annotates return types.

- **No `react-markdown` for transcript**, only for AI summary content.
  Transcript entries are plain text segments with speaker labels.

---

## Known gotchas

1. **macOS Accessibility permission requires app restart.** First grant doesn't
   take effect until the next launch. SDK fires no events until granted.

2. **The SDK ships TypeScript types** at
   `node_modules/@recallai/desktop-sdk/index.d.ts`. Trust them — don't redefine
   `RealtimeEvent` etc.

3. **`pnpm.onlyBuiltDependencies`** in `package.json` must include
   `@recallai/desktop-sdk` or the postinstall (`setup.js` that downloads the
   native binary) gets blocked by pnpm's default-deny.

4. **Electron Fuses are applied via `build/afterPack.js`**, not by a
   forge/builder plugin. We deviated from Muesli's `@electron-forge/plugin-fuses`
   because we use electron-builder, not forge.

5. **`window.api.checkForDetectedMeeting()` only returns the current state**;
   the source of truth for "is a meeting detected right now" is the
   `meeting-detection-status` push channel that `RecordingContext` subscribes to.

6. **Cache-control on the AI summary system prompt is a no-op today.** Sonnet
   4.6 needs ≥2048 tokens for caching to kick in; our prompt is ~175 tokens.
   Left it in for forward-compat.

7. **The Recall SDK's `meeting-detected` only fires for Zoom/Meet/Teams/Slack.**
   Discord/FaceTime/WhatsApp/etc. are NOT detected by the SDK — they're surfaced
   via our own `app-watcher.ts` polling and trigger ad-hoc recording, which
   now goes through the **local engine** (`audio-capture.ts`), not Recall.

8. **Idempotency guard at the top of `createMeetingNoteAndRecord`**: if the user
   double-clicks Record Meeting, the second call returns the existing note id
   instead of creating a duplicate. Don't remove this — both Muesli's
   notification click handler AND the in-app button can fire.

9. **whisper.cpp hallucinations on silence/music.** Three known patterns:
   (a) prior-leak ghost lines — `"Thank you."`, `"Thanks for watching."`, `"you"`,
   bracketed annotations like `[BLANK_AUDIO]`, `[Music]`. Caught by `HALLUCINATION_RE`.
   (b) char-loop loops — same char repeated 10+ times in a row (Sinhala
   `වවවවවවවවවව`, `eeeeeeeeee`). Caught by `CHAR_LOOP_RE`.
   (c) token-loop loops — short token repeated 6+ times (`ʔ ʔ ʔ ʔ ʔ ʔ`).
   Caught by `TOKEN_LOOP_RE`.
   Thresholds are deliberately tuned to NOT catch song lyric patterns
   ("yeahhhhh", "no no no no"). Plus a 3-second-window text+time dedup ring
   buffer in `createWhisperSession` to suppress duplicate emissions caused
   by sliding-window overlap. `MEEPCALL_DEBUG_WHISPER=1` shows every drop.

10. **Two audio-helper child processes per recording.** Mic and system audio
    are captured by separate sidecars so we can label transcript entries
    `"You"` vs `"Other"`. Killing one doesn't kill the other; `stopManualRecording`
    SIGTERMs both, then awaits the residual chunk's whisper transcription
    before triggering the AI summary.

11. **`extraResources` in `electron-builder.yml`** copies `audio-helper`,
    `whisper-cli`, `ggml-large-v3-turbo.bin`, and `silero-vad.onnx` into
    `meepcall.app/Contents/Resources/`. `electron-builder` auto-codesigns
    Mach-O binaries it finds there. If you add another helper or model, add
    it to `extraResources` AND verify with `codesign -dvv` after `pnpm build:mac`.

12. **`hardenedRuntime: false` in `electron-builder.yml`.** Without an Apple
    Developer ID, electron-builder ad-hoc signs both the .app and the bundled
    Electron Framework, but their adhoc identities aren't recognized as
    matching by macOS Sequoia's hardened-runtime loader (`mapping process and
    mapped file (non-platform) have different Team IDs`). Disabling hardened
    runtime is fine for personal use; **don't flip it back on without a real
    Developer ID** or the prod app will crash at launch with EXC_CRASH.

13. **AirPods / device route changes.** `AudioHelper.swift`'s `MicCapture`
    subscribes to `AVAudioEngineConfigurationChange`. On notification, it
    tears down the stale tap+converter and rebuilds from the new device's
    input format with up to 5×200 ms retries (sample-rate transitions can
    leave the input at `0` for ~100 ms). The system source uses SCStream and
    is independent of input route changes.

14. **FaceTime audio is protected by macOS.** Apple deliberately excludes
    FaceTime's audio output from ScreenCaptureKit captures. Even with all
    permissions granted, FaceTime calls won't transcribe — neither side.
    Use Discord/Zoom/Meet/iPhone-Continuity calls instead. (BlackHole virtual
    audio device is a workaround if a user really needs it.)

15. **Recall ad-hoc speaker labels are `Host`/`Guest`, not real names.** The
    `recallai_streaming` provider only knows participant names when it has
    a meeting platform context. `prepareDesktopAudioRecording` sessions are
    anonymous, so transcripts come back tagged `Host` (mic) and `Guest`
    (system). Documented in the SDK docs; not a bug.

---

## Deferred / out-of-scope

Wired at the data layer but no UI for these:
- **Debug panel** — SDK event log + raw participant data + per-participant video
  frames (`video-frame` IPC channel exists, no consumer in the renderer).
- **Sidebar share/export buttons** (Copy link, Email, Slack) from Muesli's HTML —
  visual only, never wired.
- **Voice-activity-triggered auto-record** — discussed but not built.
- **Calendar-triggered auto-record** — same.
- **In-call detection** for Discord/FaceTime — only "app running" is detected.

Explicitly **not** going to do:
- Windows / Linux build
- Auto-update (`electron-updater` isn't a dep)
- Tests / CI
- Per-user account system
- Provider-picker UI. The meeting path uses `recallai_streaming` (`server.ts`)
  — env-var override via `MEEPCALL_RECALL_LANG` / `MEEPCALL_RECALL_MODE`,
  or edit `server.ts` to swap to `deepgram_streaming` / `assembly_ai_v3_streaming`.
  The ad-hoc path uses local whisper.cpp by default (`whisper.ts` → `whisper-cli`
  with `ggml-large-v3-turbo.bin`); flip `MEEPCALL_USE_RECALL_FOR_ADHOC=1` to
  route through Recall instead.

---

## Useful artifacts

- `/tmp/muesli/` — local checkout of the upstream sample app for reference
  (read-only). If something seems weirdly designed, it might be a Muesli
  decision we inherited.
- `.mcp.json` — `recall-docs` MCP server (Inkeep) at project scope. Use the
  MCP for Recall API questions instead of WebFetch.

## Files this doc is current for

Last verified against:
- `src/main/index.ts` — global hotkey `⌘⇧R`, audio-helper teardown on quit
- `src/main/recall-sdk.ts` — `isRecallConfigured()` guard, meeting-detected flow,
  Recall ad-hoc + compare-mode entry points, `MEEPCALL_RECALL_*` overrides
- `src/main/audio-capture.ts` — local recording engine, sliding-window chunker,
  silero-vad opt-in, ad-hoc / compare flag dispatching
- `src/main/silero-vad.ts` — onnxruntime-node wrapper for silero VAD
- `src/main/whisper.ts` — whisper-cli wrapper, hallucination + dedup, debug knobs
- `src/main/post-recording.ts` — shared "after stop" pipeline
- `src/main/audio-helper/AudioHelper.swift` — ScreenCaptureKit + AVAudioEngine,
  AVAudioEngineConfigurationChange handling for AirPods/route swaps
- `src/main/ai-summary.ts` — Anthropic SDK direct, claude-sonnet-4-6 streaming,
  notes-folded-into-prompt
- `src/main/server.ts` — `recallai_streaming` provider for meeting path,
  `Token` auth, `MEEPCALL_RECALL_*` env overrides
- `src/main/log.ts` — `[recall]` vs `[local]` tag split
- `src/renderer/src/pages/NoteEditor.tsx` — NotesEditor + LiveTranscript + AISummary
- `src/renderer/src/components/Header.tsx` — comm-app-aware Record Audio button
- `electron-builder.yml` — `hardenedRuntime: false`, `extraResources` model list
- `package.json` — `pnpm prod` script, `onnxruntime-node` dep

If you change those files in ways that break these claims, update this doc.

`AGENTS.md` is a symlink to this file — keep them aligned.
