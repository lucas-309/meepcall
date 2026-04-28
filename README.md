# meepcall

> macOS meeting + call recorder. Auto-records Zoom/Meet/Teams; one hotkey for everything else.

**meepcall** captures audio from your meetings and calls, streams a live transcript into a local note, and writes an AI summary the moment the call ends. Zoom/Meet/Teams get auto-detected. Phone calls (over iPhone Continuity), Discord, FaceTime, WhatsApp, anything else — `⌘⇧R` from anywhere.

It runs on your machine. Notes + transcripts live in your `userData` dir. The only outbound calls are to [Recall.ai](https://recall.ai) (recording + transcription) and [Anthropic](https://anthropic.com) (summary).

```
meeting / mic → Recall SDK → live transcript → meetings.json → Anthropic summary
```

## Why

Wanted a personal meeting recorder I controlled — local notes, my API keys, no SaaS — and crucially one that also works for phone calls, Discord, and FaceTime, not just calendar meetings.

Recall.ai ships a [reference desktop app](https://github.com/recallai/muesli-public) that demonstrates their SDK. I forked the integration shape (event handlers, IPC channel names, CSS) but rebuilt the rest on a modernized stack: electron-vite + TypeScript + React 19, with the Anthropic SDK direct instead of Muesli's OpenRouter path.

## What it does

- Auto-detect Zoom / Google Meet / Microsoft Teams via the Recall Desktop SDK — no bots
- Live transcript via Recall's first-party `recallai_streaming` provider
- AI summary on recording end, `claude-sonnet-4-6` streaming
- `⌘⇧R` global hotkey toggles ad-hoc recording from anywhere — works for phone calls, Discord, FaceTime, etc.
- Comm-app watcher prompts when Discord/FaceTime/WhatsApp/Telegram/Signal/Skype/Webex opens
- Everything stored locally in `app.getPath('userData')/meetings.json`

Roadmap (not in v0.1): voice-activity-triggered record, calendar-triggered record, debug panel.

## Setup

Apple Silicon macOS 13+ only. The Recall Desktop SDK doesn't ship for anything else.

```bash
git clone https://github.com/lucas-309/meepcall.git
cd meepcall
pnpm install
cp .env.example .env
# edit .env — see below
pnpm dev
```

`.env`:

```
RECALLAI_API_URL=https://us-west-2.recall.ai   # match your workspace region
RECALLAI_API_KEY=<recall key>
ANTHROPIC_API_KEY=sk-ant-...
```

Region URL options: `us-west-2` (PAYG), `us-east-1` (Monthly), `eu-central-1` (EU), `ap-northeast-1` (Japan). 401s with "Invalid API token" are almost always a region mismatch, not actually invalid keys.

First launch: macOS will prompt for Accessibility, Screen Recording, Microphone, and Input Monitoring. Approve all four. **Quit and relaunch** after granting Accessibility — the SDK doesn't see the grant until a fresh start.

Sanity check the upload-token server:

```bash
curl http://localhost:13373/start-recording
# {"status":"success","upload_token":"..."}
```

Build a DMG with `pnpm build:mac`. Configure your Apple Developer ID in `electron-builder.yml` first if you want it signed and notarized.

## Usage

**Calendar meetings.** Start your Zoom/Meet/Teams call. Within a few seconds you'll get a macOS notification + a yellow banner in the app. Click Record Meeting. The note opens with a live transcript card; on hangup the AI summary streams in below.

**Everything else.** Press `⌘⇧R` to toggle. Or click Record Audio in the header. Or, if Discord/FaceTime/etc. is running, the comm-app banner will offer to record that specific app. All three paths capture *all* desktop audio (mic + system) — kill background music first.

**Inside a note.** Title is contenteditable. Live transcript scrolls itself. AI summary card has a `↻ Regenerate` button. Floating ▣ stops the recording.

## Cost

Recall bills per recording-hour and per transcribed minute — don't leave it running. Anthropic Sonnet 4.6 is ~$3/$15 per million tokens; each summary is roughly 1k in / 500 out, ~¢1.

## Note

Recall's SDK only auto-detects Zoom/Meet/Teams/Slack. Discord/FaceTime/WhatsApp aren't surfaced as "meetings" — they're surfaced via process polling and trigger ad-hoc desktop-audio recording. That means **no per-participant audio streams** for those — diarization is acoustic clustering on the mixed mic stream, output as `Speaker 0`, `Speaker 1`, …

Self-recording calls without all parties' consent may be illegal in your jurisdiction (two-party consent states in the US, GDPR in EU, etc.). Use at your own risk.

## License

MIT. Recall SDK integration shape and CSS adapted from [`muesli-public`](https://github.com/recallai/muesli-public) (Recall.ai's reference app).
