# meepcall

> macOS meeting + call recorder. Auto-records Zoom/Meet/Teams; one hotkey for everything else.

**meepcall** captures audio from your meetings and calls, streams a live transcript into a local note, and writes an AI summary the moment the call ends. Zoom/Meet/Teams get auto-detected. Phone calls (over iPhone Continuity), Discord, FaceTime, WhatsApp, anything else — `⌘⇧R` from anywhere.

It runs on your machine. Notes + transcripts live in your `userData` dir. The only outbound calls are to [Recall.ai](https://recall.ai) (Zoom/Meet/Teams recording + server-side transcription) and [Anthropic](https://anthropic.com) (summary). Ad-hoc recordings transcribe entirely on-device — no audio leaves the machine.

```
Zoom/Meet/Teams  → Recall SDK ─┐
⌘⇧R / phone / app → Swift sidecar (ScreenCaptureKit + AVAudioEngine)
                                → whisper.cpp ─┴─→ meetings.json → Anthropic summary
```

## Why

Wanted a personal meeting recorder I controlled — local notes, my API keys, no SaaS — and crucially one that also works for phone calls, Discord, and FaceTime, not just calendar meetings.

Recall.ai ships a [reference desktop app](https://github.com/recallai/muesli-public) that demonstrates their SDK. I forked the integration shape (event handlers, IPC channel names, CSS) but rebuilt the rest on a modernized stack: electron-vite + TypeScript + React 19, with the Anthropic SDK direct instead of Muesli's OpenRouter path. Then I added a second engine alongside it — a Swift ScreenCaptureKit sidecar feeding local whisper.cpp — so anything outside the Recall-supported platforms still gets transcribed.

## What it does

- Auto-detect Zoom / Google Meet / Microsoft Teams via the Recall Desktop SDK — no bots, no calendar scraping
- Live server-side transcript on those platforms via Recall's first-party `recallai_streaming` provider, with per-participant diarization
- `⌘⇧R` global hotkey toggles ad-hoc recording from anywhere — works for phone calls, Discord, FaceTime, in-person, anything that makes sound
- Ad-hoc recordings transcribe **on-device** with `whisper.cpp` (`ggml-medium.bin` by default, multilingual). 3 s sliding window with 1 s overlap; mic and system audio captured as two separate streams labeled `You` / `Other`
- Comm-app watcher prompts when Discord/FaceTime/WhatsApp/Telegram/Signal/Skype/Webex opens
- AI summary on recording end, `claude-sonnet-4-6` streaming, with your typed Notes folded into the prompt
- Everything stored locally in `app.getPath('userData')/meetings.json`

Roadmap (not in v0.1): voice-activity-triggered record, calendar-triggered record, debug panel.

## Setup

Apple Silicon macOS 13+ only. The Recall Desktop SDK doesn't ship for anything else.

```bash
brew install cmake          # one-time, needed to build whisper-cli from source
git clone https://github.com/lucas-309/meepcall.git
cd meepcall
pnpm install
pnpm prebuild:assets        # builds the Swift sidecar + whisper-cli, downloads ~1.5 GB model
cp .env.example .env
# edit .env — see below
pnpm dev
```

`pnpm prebuild:assets` is required before the first `pnpm dev`. It builds `build/bin/audio-helper` (the ScreenCaptureKit + AVAudioEngine sidecar) and `build/bin/whisper-cli`, and downloads `build/models/ggml-medium.bin` (~1.5 GB) from Hugging Face. Idempotent — re-runs are no-ops once the files are in place.

`.env`:

```
RECALLAI_API_URL=https://us-west-2.recall.ai   # match your workspace region
RECALLAI_API_KEY=<recall key>
ANTHROPIC_API_KEY=sk-ant-...
```

Region URL options: `us-west-2` (PAYG), `us-east-1` (Monthly), `eu-central-1` (EU), `ap-northeast-1` (Japan). 401s with "Invalid API token" are almost always a region mismatch, not actually invalid keys. The Anthropic key is optional at boot — the app runs without it; only `Generate AI Summary` will fail.

First launch: macOS will prompt for Accessibility, Screen Recording, Microphone, and Input Monitoring. Approve all four. **Quit and relaunch** after granting Accessibility — the SDK doesn't see the grant until a fresh start.

Sanity check the upload-token server (used by the Recall meeting path):

```bash
curl http://localhost:13373/start-recording
# {"status":"success","upload_token":"..."}
```

Sanity check the Swift sidecar in isolation:

```bash
./build/bin/audio-helper --source mic > /tmp/mic.raw 2> /tmp/mic.err &
sleep 3 && kill %1
ffplay -f s16le -ar 16000 -ac 1 /tmp/mic.raw   # play it back
```

Build a DMG with `pnpm build:mac`. Configure your Apple Developer ID in `electron-builder.yml` first if you want it signed and notarized. `electron-builder` auto-codesigns the bundled `audio-helper` and `whisper-cli` binaries from `extraResources`.

### Tunable env vars

- `WHISPER_MODEL` — `ggml-medium.bin` (default), `ggml-small.bin`, `ggml-base.en.bin`, `ggml-large-v3.bin`. Must match what `pnpm fetch:whisper-assets` downloaded (set `WHISPER_MODEL_NAME=…` there).
- `WHISPER_LANGUAGE` — `auto` (default, multilingual) or any ISO code (`en`, `es`, `ja`, …) to skip per-chunk detection.
- `MEEPCALL_NO_SPEECH_THOLD` — `0.6` default; lower (`0.3`–`0.4`) for music, higher (`0.7`–`0.8`) to suppress hallucinations on quiet audio.
- `MEEPCALL_DEBUG_WHISPER=1` — log every segment whisper produces and what filtered it.
- `MEEPCALL_WHISPER_NO_FILTERS=1` — bypass hallucination + dedup filters (overlap-skip still runs).
- `MEEPCALL_USE_RECALL_FOR_ADHOC=1` — route ad-hoc recordings through Recall's `prepareDesktopAudioRecording` instead of the local engine. Costs Recall credits; useful for A/B-ing transcript quality.
- `MEEPCALL_COMPARE_MODE=1` — run both engines in parallel on ad-hoc recordings. Local writes to the note as normal; Recall transcripts print to the terminal with `[recall]` tags. Costs Recall credits for the duration.

## Usage

**Calendar meetings.** Start your Zoom/Meet/Teams call. Within a few seconds you'll get a macOS notification + a yellow banner in the app. Click Record Meeting. The note opens with a live transcript card (per-participant labels, server-side); on hangup the AI summary streams in below.

**Everything else.** Press `⌘⇧R` to toggle. Or click Record Audio in the header. Or, if Discord/FaceTime/etc. is running, the comm-app banner will offer to record that specific app. All three paths spawn two Swift sidecars per recording — one on the mic, one on the system audio output — and feed both into local whisper.cpp in parallel. Mic segments are labeled `You`, system segments `Other`. Kill background music first; whisper hallucinates lyrics into transcripts otherwise.

**Inside a note.** Title is contenteditable. Type into the Notes card while recording — its contents get folded into the AI summary prompt at end-of-call. Live transcript scrolls itself. AI summary card has a `↻ Regenerate` button. Floating ▣ stops the recording.

## Cost

Two paths, two cost models:

- **Zoom/Meet/Teams (Recall path)** — Recall bills per recording-hour and per transcribed minute. Don't leave it running.
- **Ad-hoc / phone / Discord / FaceTime (local path)** — free at runtime. whisper.cpp runs on-device. The model download is one-time (~1.5 GB).

Anthropic Sonnet 4.6 is ~$3/$15 per million tokens; each summary is roughly 1k in / 500 out, well under a cent.

## Note

Recall's SDK only auto-detects Zoom/Meet/Teams/Slack. Discord/FaceTime/WhatsApp/phone calls aren't surfaced as "meetings" — they're surfaced via process polling and trigger ad-hoc recording through the local engine. That means **no per-participant audio streams** for those — instead, mic and system audio are recorded as two separate streams and labeled `You` / `Other`. If two people are talking on the other end of a Discord call, both will show up under `Other`. whisper.cpp itself doesn't diarize.

Self-recording calls without all parties' consent may be illegal in your jurisdiction (two-party consent states in the US, GDPR in EU, etc.). Use at your own risk.

## License

MIT. Recall SDK integration shape and CSS adapted from [`muesli-public`](https://github.com/recallai/muesli-public) (Recall.ai's reference app).
