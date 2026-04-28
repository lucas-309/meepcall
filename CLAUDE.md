# CLAUDE.md — agent-friendly project docs

Personal macOS meeting + call recorder. Electron-vite + TypeScript + React app
with a **split engine**: Recall.ai's Desktop SDK handles Zoom / Meet / Teams
meeting auto-detection (it owns the `meeting-detected` event + per-participant
transcripts on those platforms), and a local Swift sidecar (ScreenCaptureKit +
AVAudioEngine) feeds chunked **whisper.cpp** transcription for everything else
(⌘⇧R hotkey, Record Audio button, comm-app banner, in-person, phone calls).
Anthropic Claude generates the summary on stop. Forked-by-reimplementation from
Recall's `muesli-public` reference app — same SDK shape, modernized stack.

**Lucas's machine** (`/Users/lucashe309/Developer/recall/`). macOS Apple Silicon
only — every other platform is intentionally out of scope.

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
   (`build/bin/audio-helper`) emits 16 kHz mono Int16 PCM, Node chunks every
   5 s, and `build/bin/whisper-cli` (whisper.cpp) transcribes locally with
   `ggml-base.en.bin`. The mic and system audio are captured as **separate**
   helper processes so we can label them `"You"` and `"Other"` respectively
   (whisper itself doesn't diarize).

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
│                          sidecars per recording (mic + system), chunks every
│                          5s, drives whisper, fires transcript-updated
├── audio-helper/          Swift source (ScreenCaptureKit + AVAudioEngine);
│                          built into build/bin/audio-helper via build.sh
├── whisper.ts             whisper-cli wrapper. Per-source serial queue,
│                          hallucination filter, "You" / "Other" labeling.
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
    → randomUUID() recordingId; create note in meetings.json
    → spawn audio-helper --source mic   (AVAudioEngine → stdout PCM)
    → spawn audio-helper --source system (SCStream     → stdout PCM)
    → every 5s of stdout per source: write WAV → whisper-cli → entries
    → entries appended with speaker="You" (mic) or "Other" (system)
    → sendToRenderer('transcript-updated', noteId) per chunk
  ⌘⇧R again
  → audio-capture.stopManualRecording(recordingId)
    → SIGTERM both helpers → drain residual buffers → final whisper pass
    → runPostRecording(noteId) (shared with the meeting path above)
```

Triggers for the local engine:
1. Header `Record Audio` button → `startAdHocRecording(label)`
2. `⌘⇧R` global hotkey → toggles record/stop
3. Comm-app banner (Discord/FaceTime/etc detected) → same button, label changes

---

## Commands

```bash
# one-time: build the Swift sidecar + fetch/build whisper-cli + model
# (requires cmake — `brew install cmake` if missing). ~30s on M-series.
pnpm prebuild:assets

pnpm dev            # electron-vite dev server + Electron window
pnpm build          # typecheck + bundle main/preload/renderer
pnpm build:mac      # prebuild:assets + bundle + electron-builder DMG (macOS)
pnpm typecheck      # tsc --noEmit on both node + web tsconfigs

# also available individually:
pnpm build:audio-helper   # swiftc → build/bin/audio-helper
pnpm fetch:whisper-assets # build/bin/whisper-cli + build/models/ggml-base.en.bin

# sanity test the upload-token endpoint (must have pnpm dev running)
curl http://localhost:13373/start-recording
# → {"status":"success","upload_token":"..."}

# sanity test the audio-helper in isolation (mic mode for 3s):
./build/bin/audio-helper --source mic > /tmp/mic.raw 2> /tmp/mic.err &
sleep 3 && kill %1
ffplay -f s16le -ar 16000 -ac 1 /tmp/mic.raw   # play it back

# stop the dev server
# Ctrl-C in terminal, OR ⌘Q on the Electron window
```

---

## Env vars

`.env` (gitignored):

```
RECALLAI_API_URL=https://us-west-2.recall.ai   # see region notes above
RECALLAI_API_KEY=<recall key — must match URL region>
ANTHROPIC_API_KEY=sk-ant-...
```

`.env.example` is committed with placeholders. **Never commit .env.** If the
user pastes keys into a chat, tell them to rotate.

App boots successfully without `ANTHROPIC_API_KEY` (lazy init in `ai-summary.ts`).
Summary calls throw with a clear error if the key is missing — the rest of the
app works without it.

---

## Conventions

- **Logger**: use `log.recall(...)` / `log.server(...)` / `log.ai(...)` /
  `log.ok(tag, ...)` / `log.warn(tag, ...)` / `log.err(tag, ...)` from
  `src/main/log.ts`. Don't add raw `console.log` to main process — it bypasses
  the timestamp + tag formatting.

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

9. **whisper.cpp hallucinations on silence.** `base.en` regularly emits
   `"Thank you."`, `"Thanks for watching."`, or `"you"` on silent chunks. We
   filter those in `whisper.ts` (regex + same-as-previous dedup) and pass
   `--no-speech-thold 0.6` to the binary. If a real utterance happens to match
   the filter regex, it gets dropped — accept it for v1.

10. **Two audio-helper child processes per recording.** Mic and system audio
    are captured by separate sidecars so we can label transcript entries
    `"You"` vs `"Other"`. Killing one doesn't kill the other; `stopManualRecording`
    SIGTERMs both, then awaits the residual chunk's whisper transcription
    before triggering the AI summary.

11. **`extraResources` in `electron-builder.yml`** copies `audio-helper`,
    `whisper-cli`, and `ggml-base.en.bin` into `Recall.app/Contents/Resources/`.
    `electron-builder` auto-codesigns Mach-O binaries it finds there using the
    inherited entitlements. If you add another helper, add it to `extraResources`
    AND verify with `codesign -dvv` after `pnpm build:mac`.

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
- Alternate transcription providers in the UI. The meeting path uses
  `recallai_streaming` (`server.ts`); the ad-hoc path uses local whisper.cpp
  (`whisper.ts` → `whisper-cli` with `ggml-base.en.bin`). Swap there if you
  want a different provider.

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
- `src/main/recall-sdk.ts` — meeting-detected flow ONLY (ad-hoc moved out)
- `src/main/audio-capture.ts` — local recording engine (Swift sidecar + chunks)
- `src/main/whisper.ts` — whisper-cli wrapper, hallucination filter, mic/system
- `src/main/post-recording.ts` — shared "after stop" pipeline
- `src/main/audio-helper/AudioHelper.swift` — ScreenCaptureKit + AVAudioEngine
- `src/main/ai-summary.ts` — Anthropic SDK direct, claude-sonnet-4-6 streaming
- `src/main/server.ts` — `recallai_streaming` provider for meeting path, `Token` auth
- `src/renderer/src/pages/NoteEditor.tsx` — LiveTranscript + AISummary cards
- `src/renderer/src/components/Header.tsx` — comm-app-aware Record Audio button

If you change those files in ways that break these claims, update this doc.
