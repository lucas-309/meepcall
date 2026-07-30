# Agent reference

Long-form reference for things that are too verbose to live in `CLAUDE.md`.
The top-level `CLAUDE.md` links into this file by gotcha number / flag name.

---

## Tunable `MEEPCALL_*` flags (long form)

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

Other one-shot local capture flag:

- **`DISABLE_MIC=1`** — skip the mic helper entirely and transcribe only
  system audio. Useful when Mac speaker playback is otherwise captured by
  both sources. Example: `DISABLE_MIC=1 pnpm dev`.

`pnpm dev` already prints what you need to debug the common failures
without setting anything: first-samples log per source, RMS voice-floor
warns, route_change events, backpressure-drop reports with recent
inference times, streak-filter suppressions, and `[boot] Cleaned N
orphaned recordings…` on startup.

---

## Known gotchas (long form)

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
