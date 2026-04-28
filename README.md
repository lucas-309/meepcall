# Meepcall

A personal macOS meeting + call recorder for Apple Silicon, built on the [Recall.ai Desktop SDK](https://docs.recall.ai/docs/desktop-sdk). Detects Zoom / Google Meet / Microsoft Teams calls automatically, captures transcript live, and generates a structured AI summary the moment the call ends.

Also captures arbitrary desktop audio — phone calls (via iPhone Continuity), Discord, FaceTime, WhatsApp Web, anything that hits CoreAudio.

> Forked-by-reimplementation from Recall.ai's reference app [`muesli-public`](https://github.com/recallai/muesli-public). Same SDK integration shape, ported to **electron-vite + TypeScript + React** with typed IPC, a faithful UI port, and direct Anthropic SDK summarization in place of Muesli's OpenRouter path.

---

## Highlights

- 🎙 **Auto-detects Zoom / Google Meet / Microsoft Teams** via the Recall Desktop SDK — no bots, fully local.
- 📞 **Records phone calls and Discord / FaceTime / WhatsApp / Telegram / Signal / Skype / Webex** via desktop audio capture.
- ⌨️ **Global hotkey `⌘⇧R`** — toggles a recording from anywhere, even while another app is fullscreen.
- 📋 **Live transcript** streams into the editor as people speak (Recall's first-party `recallai_streaming` provider, so no AssemblyAI account needed).
- ✨ **AI summary** auto-generates on recording end via Anthropic's `claude-sonnet-4-6` Messages API with streaming.
- 🔭 **Comm-app watcher** — polls running processes and prompts you with a "Record Discord" button when Discord opens, "Record FaceTime" when FaceTime opens, etc.
- 🔒 **Hardened distribution** — Electron Fuses applied at pack time (RunAsNode disabled, ASAR-only loading, cookie encryption, embedded ASAR integrity).

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Electron 39 (Apple Silicon, macOS 13+) |
| Bundler | electron-vite + Vite 7 |
| Language | TypeScript everywhere — main, preload, renderer, shared |
| UI | React 19 + plain CSS ported from Muesli |
| Recording SDK | `@recallai/desktop-sdk` v2 (native binary auto-installed via postinstall) |
| AI summarization | `@anthropic-ai/sdk` direct → `claude-sonnet-4-6` streaming |
| Markdown | `react-markdown` for the AI summary card |
| Local persistence | JSON file under `app.getPath('userData')` (no SQLite) |
| Build / sign | `electron-builder` + `@electron/fuses` `afterPack` hook |

---

## Architecture

```
                   ┌─────────────────────────────────────┐
                   │   macOS — main process              │
                   │                                     │
   Recall SDK ◀────┤   recall-sdk.ts                     │
   (native binary) │   ├─ meeting-detected               │
                   │   ├─ realtime-event (transcript,    │
                   │   │   participants, video frames)   │
                   │   └─ recording-ended → AI summary   │
                   │                                     │
   localhost:13373 │   server.ts (Express + fetch)       │
   POST /sdk_upload│   └─ mints upload tokens for SDK    │
                   │                                     │
   anthropic API ◀─┤   ai-summary.ts (streaming Messages)│
                   │                                     │
   /usr/sbin/ps   ◀┤   app-watcher.ts (5s polling)       │
                   │                                     │
   ⌘⇧R           ◀─┤   index.ts globalShortcut           │
                   │                                     │
                   │   storage.ts ── userData/meetings.json
                   │   ipc.ts ── 11 typed channels       │
                   └────────────┬────────────────────────┘
                                │ contextBridge
                   ┌────────────┴────────────────────────┐
                   │   preload — exposes window.api      │
                   └────────────┬────────────────────────┘
                                │ window.api
                   ┌────────────┴────────────────────────┐
                   │   renderer (React)                  │
                   │   ├─ HomePage  (date-grouped cards) │
                   │   ├─ NoteEditor (live transcript +  │
                   │   │   streaming AI summary)         │
                   │   └─ Header (detection banners +    │
                   │       Record Audio / Record Meeting)│
                   └─────────────────────────────────────┘
```

Source layout:

```
src/
├─ main/
│  ├─ index.ts          # app lifecycle, IPC + hotkey wiring
│  ├─ recall-sdk.ts     # Recall SDK event handlers + recording flows
│  ├─ server.ts         # Express upload-token proxy
│  ├─ ai-summary.ts     # Anthropic streaming summary
│  ├─ ipc.ts            # ipcMain handlers (request + push)
│  ├─ storage.ts        # race-safe meetings.json store
│  ├─ state.ts          # in-process detected-meeting + recording state
│  ├─ window.ts         # BrowserWindow factory + sendToRenderer
│  ├─ app-watcher.ts    # macOS comm-app process poller
│  ├─ sdk-logger.ts     # event emitter for SDK call/event logs
│  └─ log.ts            # tagged + timestamped terminal logger
├─ preload/             # typed contextBridge surface
├─ renderer/            # React UI (pages, components, contexts, css)
└─ shared/types.ts      # types shared by main, preload, renderer
```

---

## Quick start

### Prerequisites

- macOS 13+ on Apple Silicon (the only platform the Recall Desktop SDK supports as of v2)
- Node 18+ and `pnpm` 10
- A Recall.ai workspace + API key — [sign up](https://recall.ai)
- An Anthropic API key — [console](https://console.anthropic.com/settings/keys)

### Setup

```bash
git clone https://github.com/<your-handle>/meepcall
cd meepcall
pnpm install     # also runs the Recall SDK postinstall to download the native binary
cp .env.example .env
```

Edit `.env`:

```dotenv
# Pick the URL that matches your Recall.ai workspace region
RECALLAI_API_URL=https://us-west-2.recall.ai   # or us-east-1 / eu-central-1 / ap-northeast-1
RECALLAI_API_KEY=<your-recall-api-key>
ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
pnpm dev
```

First launch: macOS will prompt for **Accessibility**, **Screen Recording**, **Microphone**, and **Input Monitoring** (the last for the global hotkey). Approve all four. You may need to quit + relaunch after granting Accessibility for it to take effect.

Sanity check before joining a real meeting:

```bash
curl http://localhost:13373/start-recording
# => {"status":"success","upload_token":"..."}
```

### Build a `.dmg`

```bash
pnpm build:mac
```

DMG drops in `dist/`. Configure your Apple Developer ID in `electron-builder.yml` for signed/notarized builds.

---

## Usage

### Auto-detected meetings

1. Start a Zoom / Google Meet / MS Teams call.
2. Within ~5s the Recall SDK fires `meeting-detected` → macOS notification + the **Record Meeting** button in the header lights up + a yellow banner appears on the home page.
3. Click **Record Meeting** (once — there's an idempotency guard but don't tempt it).
4. The new note opens with a pulsing **● Live Transcript** card. Speak. Entries stream in.
5. Leave the call → AI summary streams into the **AI Summary** card below.

### Phone calls / Discord / FaceTime / arbitrary desktop audio

Three paths, in order of convenience:

1. **Global hotkey `⌘⇧R`** — works from anywhere, even with the app hidden.
2. **Comm-app banner** — when Discord/FaceTime/WhatsApp/etc. is detected running, the home banner says "Discord running — click Record Discord" and the header button changes label.
3. **`Record Audio` button** — always available; prompts for a title.

In all three cases the app captures *all* desktop audio (system + mic). Kill background music first.

### Inside a note

- **Title** is contenteditable — click, type, Tab/Enter to save.
- **Live Transcript card** scrolls itself; newest line has a blue accent.
- **AI Summary card** shows the rendered markdown. `↻ Regenerate` re-runs the summary against the same transcript.
- **Floating ▣ stop button** ends the recording.
- **✨ AI Summary button** triggers a manual summary generation if the auto one didn't run.

---

## Terminal output

The main process logs colored, timestamped lines. Tags grep cleanly:

```
14:32:01 [boot]     Recall starting · region=https://us-west-2.recall.ai · key=✓ · anthropic=✓
14:32:01 [recall]   Initializing Recall.ai SDK
14:32:01 [server]   Upload-token server listening on http://localhost:13373
14:32:01 [hotkey]   Registered CommandOrControl+Shift+R — toggles recording from anywhere
14:32:01 [watcher]  Watching for comm apps every 5s
14:32:02 [recall]   Permissions granted (accessibility + screen-capture + microphone)
14:32:30 [recall]   Comm apps running: Discord
14:32:35 [server]   Minting upload token via https://us-west-2.recall.ai…
14:32:35 [server]   Upload token minted (uVuZ0cqA…)
14:32:35 [recall]   Recording STARTED: window=2AAF29B0… note=meeting-1777343...
14:32:42 [recall]   Realtime event: transcript.data
14:32:42 [recall]   Transcript [Lucas]: hello can you hear me
14:35:10 [recall]   Recording ENDED: window=2AAF29B0…
14:35:10 [ai]       Generating summary for note=meeting-... (12 entries, model=claude-sonnet-4-6)
14:35:14 [ai]       Summary done: 478 chars · in=1234 out=312 cache_read=0
```

---

## Cost notes

- **Recall.ai** bills per recording-hour. Always-on recording adds up fast — use the hotkey or the auto-detect flow rather than leaving things running. Check your dashboard for your tier's exact rate.
- **AssemblyAI / `recallai_streaming`** transcription is metered per minute of audio.
- **Anthropic Claude Sonnet 4.6** at $3/$15 per million tokens. Each summary is roughly 1k input + 500 output ≈ ¢1. Negligible.
- The system prompt for summaries has `cache_control` set, but it's only ~175 tokens — below Sonnet 4.6's 2048-token cacheable minimum, so it's a no-op until the prompt grows.

---

## What's deferred

These were intentional MVP cuts — wired at the data layer, not in the UI:

- **Debug panel** with raw SDK event log + participants list + per-participant video frames (data flows; no UI).
- **In-call detection** for arbitrary apps (Discord/FaceTime exposes presence but not "in-call" state without window-title scraping).
- **Voice-activity-triggered auto-record** — only record when someone is actually speaking.
- **Calendar-triggered auto-record** — read Google/Apple calendar and arm at meeting start.
- **Sidebar share/export buttons** (Copy link, Email, Slack) from Muesli's UI — visual placeholders only.

---

## Acknowledgements

- [Recall.ai](https://recall.ai) for the Desktop SDK + the [Muesli sample app](https://github.com/recallai/muesli-public) this codebase is derived from. Their CSS and IPC channel naming ride along here verbatim.
- [Anthropic](https://anthropic.com) Claude Sonnet 4.6 for summary generation.

## License

MIT — see [LICENSE](./LICENSE).
