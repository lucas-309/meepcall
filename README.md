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
- Ad-hoc recordings transcribe **on-device** with `whisper.cpp` (`ggml-large-v3-turbo.bin` by default — distilled from large-v3, ~99% of SOTA quality at medium-model speed). 3 s sliding window with 1 s overlap, text+time dedup across the overlap; mic and system audio captured as two separate streams labeled `You` / `Other`
- Comm-app watcher prompts when Discord/FaceTime/WhatsApp/Telegram/Signal/Skype/Webex opens
- AI summary on recording end, `claude-sonnet-4-6` streaming, with your typed Notes folded into the prompt
- Everything stored locally in `app.getPath('userData')/meetings.json`

Roadmap (not in v0.1): voice-activity-triggered record, calendar-triggered record, debug panel.

## Setup

Apple Silicon macOS 13+ only. The Recall Desktop SDK doesn't ship for anything else.

```bash
# 1. Prereqs (one-time). If you don't have Homebrew: brew.sh
brew install node pnpm cmake

# 2. Get the code
git clone https://github.com/lucas-309/meepcall.git
cd meepcall
pnpm install

# 3. Build the local audio engine + download the whisper model
#    (~5 min on first run; ~1.6 GB download)
pnpm prebuild:assets

# 4. Configure API keys
cp .env.example .env
#    Open .env in your editor and fill in:
#      - RECALLAI_API_KEY: required for Zoom/Meet/Teams auto-detect.
#        Sign up at recall.ai — new accounts get a few free hours.
#      - ANTHROPIC_API_KEY: optional. Only used for AI summaries
#        on call end. App runs fine without it.

# 5. Run
pnpm dev
```

**First launch:** macOS will prompt for **Microphone**, **Screen Recording**, and **Accessibility**. Approve all three, then **quit and relaunch** the app — Accessibility doesn't take effect without a fresh start.

**To record anything:** press `⌘⇧R` from anywhere on your machine. Press `⌘⇧R` again to stop. Works for phone calls (over iPhone Continuity), Discord, FaceTime, in-person meetings, your voice — anything that makes sound. The transcript scrolls in as you talk; the AI summary streams in once you stop. Zoom / Google Meet / Microsoft Teams calls additionally show a yellow banner — click **Record Meeting** for per-participant speaker labels via Recall.

That's it.

### Recall regions

Pick the URL for your Recall workspace in `.env`: `us-west-2.recall.ai` (PAYG), `us-east-1.recall.ai` (Monthly), `eu-central-1.recall.ai` (EU), `ap-northeast-1.recall.ai` (Japan). 401s with "Invalid API token" are almost always a region mismatch, not actually invalid keys.

### Setup details (advanced)

**Production-signed run with logs in your terminal:** `pnpm build:mac && pnpm prod`. Useful when you want logs attached to the terminal from a packaged build instead of the dev-mode Electron bundle. ⌃C cleanly quits.

**Distributable DMG:** `pnpm build:mac`. Configure your Apple Developer ID in `electron-builder.yml` for signing/notarization. Without one, electron-builder ad-hoc signs the .app and ships with `hardenedRuntime: false` (needed for the dyld loader to accept ad-hoc signed frameworks; fine for personal use, not for distribution outside your machine). `extraResources` binaries (`audio-helper`, `whisper-cli`, ONNX model) get auto-codesigned alongside the bundle.

**Sanity-check the upload-token server** (used only by the Recall meeting path):

```bash
curl http://localhost:13373/start-recording
# {"status":"success","upload_token":"..."}
```

**Sanity-check the Swift sidecar in isolation:**

```bash
./build/bin/audio-helper --source mic > /tmp/mic.raw 2> /tmp/mic.err &
sleep 3 && kill %1
ffplay -f s16le -ar 16000 -ac 1 /tmp/mic.raw   # play it back
```

### Tunable env vars

- `WHISPER_MODEL` — `ggml-large-v3-turbo.bin` (default), `ggml-medium.bin`, `ggml-small.bin`, `ggml-base.en.bin`, or `ggml-large-v3.bin` (true SOTA but ~3 GB; per-chunk inference often exceeds the 2 s pipeline step on M1/M2, so transcripts fall behind speech). Must match what `pnpm fetch:whisper-assets` downloaded (set `WHISPER_MODEL_NAME=…` there).
- `WHISPER_LANGUAGE` — `auto` (default, multilingual) or any ISO code (`en`, `es`, `ja`, …) to skip per-chunk detection.
- `MEEPCALL_NO_SPEECH_THOLD` — `0.6` default; lower (`0.3`–`0.4`) for music, higher (`0.7`–`0.8`) to suppress hallucinations on quiet audio.
- `MEEPCALL_PHRASE_VAD=1` — opt-in phrase-boundary chunking via silero-vad instead of the fixed sliding window. Cuts at natural speech pauses (1–5 s chunks). Best for pure conversational audio; on continuous music silero correctly identifies non-speech and the chunker falls through to a 5 s max-cap, so music transcription degrades — leave off for mixed voice/music workflows.
- `MEEPCALL_DEBUG_WHISPER=1` — log every segment whisper produces and what filtered it.
- `MEEPCALL_WHISPER_NO_FILTERS=1` — bypass hallucination + dedup filters.
- `MEEPCALL_USE_RECALL_FOR_ADHOC=1` — route ad-hoc recordings through Recall's `prepareDesktopAudioRecording` instead of the local engine. Costs Recall credits; useful for A/B-ing transcript quality.
- `MEEPCALL_COMPARE_MODE=1` — run both engines in parallel on ad-hoc recordings. Local writes to the note as normal; Recall transcripts print to the terminal with `[recall]` tags. Costs Recall credits for the duration.
- `MEEPCALL_RECALL_LANG` / `MEEPCALL_RECALL_MODE` — per-run override for the `recallai_streaming` provider config. Defaults `en` / `prioritize_low_latency` (the only combo the Desktop SDK supports for Recall's own provider). For multilingual real-time you'd swap the provider to Deepgram or AssemblyAI in `src/main/server.ts`, not just flip these.

## Usage

**Calendar meetings.** Start your Zoom/Meet/Teams call. Within a few seconds you'll get a macOS notification + a yellow banner in the app. Click Record Meeting. The note opens with a live transcript card (per-participant labels, server-side); on hangup the AI summary streams in below.

**Everything else.** Press `⌘⇧R` to toggle. Or click Record Audio in the header. Or, if Discord/FaceTime/etc. is running, the comm-app banner will offer to record that specific app. All three paths spawn two Swift sidecars per recording — one on the mic, one on the system audio output — and feed both into local whisper.cpp in parallel. Mic segments are labeled `You`, system segments `Other`. Music in the background gets transcribed too (whisper handles sung lyrics with `♪` markers); fine if that's what you want, mute it if you don't.

**Inside a note.** Title is contenteditable. Type into the Notes card while recording — its contents get folded into the AI summary prompt at end-of-call. Live transcript scrolls itself. AI summary card has a `↻ Regenerate` button. Floating ▣ stops the recording.

## Cost

Two paths, two cost models:

- **Zoom/Meet/Teams (Recall path)** — `$0.50/hr` for the Desktop SDK recording + `$0.15/hr` for `recallai_streaming` transcription = **~$0.65/hr** while a Recall recording is active. Prorated to the second; nothing is billed when the SDK is just listening for meetings or when a banner appears and you ignore it. New Recall accounts come with a few hours of free credits. If you switch the provider in `server.ts` to a third-party (Deepgram, AssemblyAI), the `$0.15/hr` line goes away and you pay that provider directly via your own API key.
- **Ad-hoc / phone / Discord / FaceTime (local path)** — **$0** at runtime. whisper.cpp + silero-vad run on-device. One-time ~1.6 GB model download.

Anthropic Sonnet 4.6 is ~$3/$15 per million tokens; each summary is roughly 1k in / 500 out, well under a cent.

## Note

Recall's SDK only auto-detects Zoom/Meet/Teams/Slack. Discord/FaceTime/WhatsApp/phone calls aren't surfaced as "meetings" — they're surfaced via process polling and trigger ad-hoc recording through the local engine. That means **no per-participant audio streams** for those — instead, mic and system audio are recorded as two separate streams and labeled `You` / `Other`. If two people are talking on the other end of a Discord call, both will show up under `Other`. whisper.cpp itself doesn't diarize.

Self-recording calls without all parties' consent may be illegal in your jurisdiction (two-party consent states in the US, GDPR in EU, etc.). Use at your own risk.

## License

MIT. Recall SDK integration shape and CSS adapted from [`muesli-public`](https://github.com/recallai/muesli-public) (Recall.ai's reference app).
