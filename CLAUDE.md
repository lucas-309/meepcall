# CLAUDE.md — agent-friendly project docs

Personal macOS meeting + call recorder. Electron-vite + TypeScript + React app
that wraps Recall.ai's Desktop SDK for meeting detection / recording / live
transcript, with Anthropic Claude for AI summarization. Forked-by-reimplementation
from Recall's `muesli-public` reference app — same SDK shape, modernized stack.

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

4. **The transcript provider is `recallai_streaming`**, NOT `assembly_ai_v3_streaming`.
   Muesli's default required AssemblyAI credentials configured in the workspace.
   We swapped to Recall's first-party streaming. If you see 400s about
   "AssemblyAI credentials not configured", check `src/main/server.ts`.

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
├── recall-sdk.ts          Recall SDK init + 8 event listeners + recording flows
├── server.ts              Express server on :13373 + mintUploadToken() (called
│                          directly by main, NOT via loopback HTTP — Muesli's
│                          axios-to-localhost pattern was simplified)
├── ai-summary.ts          Anthropic SDK direct, claude-sonnet-4-6 streaming,
│                          system prompt has cache_control (no-op until prompt
│                          exceeds Sonnet 4.6's 2048-token minimum)
├── ipc.ts                 11 ipcMain handlers — request/invoke + push channels
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

**Recording end → AI summary**:

```
SDK fires recording-ended
  → updateNoteWithRecordingInfo(windowId)
    → finds meeting by recordingId
    → marks recordingComplete + recordingEndTime
    → if transcript.length > 0:
      → generateMeetingSummary(meeting, onProgress)
        → Anthropic streaming Messages API
        → onProgress fires per token → sendToRenderer('summary-update')
        → renderer's NoteEditor renders streaming markdown
      → meeting.content = summary; hasSummary = true; persist
    → sendToRenderer('recording-completed', meetingId)
```

**Phone-call / ad-hoc recording**:

Same shape but uses `RecallAiSdk.prepareDesktopAudioRecording()` for the
windowId and synthesizes a meeting note. Triggers:
1. Header `Record Audio` button → `startAdHocRecording(label)`
2. `⌘⇧R` global hotkey → toggles record/stop
3. Comm-app banner (Discord/FaceTime/etc detected) → same button, label changes

---

## Commands

```bash
pnpm dev            # electron-vite dev server + Electron window
pnpm build          # typecheck + bundle main/preload/renderer
pnpm build:mac      # bundle + electron-builder DMG (macOS)
pnpm typecheck      # tsc --noEmit on both node + web tsconfigs
pnpm typecheck:node # main + preload + shared only
pnpm typecheck:web  # renderer only

# sanity test the upload-token endpoint (must have pnpm dev running)
curl http://localhost:13373/start-recording
# → {"status":"success","upload_token":"..."}

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
   via our own `app-watcher.ts` polling and trigger ad-hoc recording (which uses
   `prepareDesktopAudioRecording` to capture all desktop audio).

8. **Idempotency guard at the top of `createMeetingNoteAndRecord`**: if the user
   double-clicks Record Meeting, the second call returns the existing note id
   instead of creating a duplicate. Don't remove this — both Muesli's
   notification click handler AND the in-app button can fire.

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
- Alternate transcription providers in the UI (provider is hardcoded to
  `recallai_streaming` in `server.ts`; swap there if you want AssemblyAI back)

---

## Useful artifacts

- `/tmp/muesli/` — local checkout of the upstream sample app for reference
  (read-only). If something seems weirdly designed, it might be a Muesli
  decision we inherited.
- `.mcp.json` — `recall-docs` MCP server (Inkeep) at project scope. Use the
  MCP for Recall API questions instead of WebFetch.

## Files this doc is current for

Last verified against:
- `src/main/index.ts` — global hotkey `⌘⇧R`, app-watcher startup, IPC + SDK init
- `src/main/recall-sdk.ts` — meeting flows, transcript handler, ad-hoc recording
- `src/main/ai-summary.ts` — Anthropic SDK direct, claude-sonnet-4-6 streaming
- `src/main/server.ts` — `recallai_streaming` provider, `Token` auth
- `src/renderer/src/pages/NoteEditor.tsx` — LiveTranscript + AISummary cards
- `src/renderer/src/components/Header.tsx` — comm-app-aware Record Audio button

If you change those files in ways that break these claims, update this doc.
