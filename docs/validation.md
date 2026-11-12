# Validation and limits

The media engine renders its own isolated headless Chromium pages, mixes decoded audio in the server, and sends encoded media through FFmpeg. These checks exercise actual media; a UI status badge alone is not evidence that a streaming platform received a broadcast.

## Repeatable checks

Use Node.js 24 and run these commands from the repository:

```sh
npm ci
npm run check
npm test
npm run test:media
```

`check` syntax-checks repository-owned JavaScript, rejects harness runtime dependencies, and scans text for recognized credential formats and private workstation/deployment paths. It does not replace a full secret review or prove that every arbitrary credential has been found. `test` runs keyless behavior tests separately.

`test:media` requires Chromium and FFmpeg. Set `CHROMIUM_PATH` and `FFMPEG_PATH` when their executables are not found automatically. On a Linux container that does not support the Chromium sandbox, the image sets `CHROMIUM_NO_SANDBOX=1`; deploy this single-administrator service in an isolated container. The checks use only loopback listeners, including fixed ports 18359, 18360 and 19359 and dynamically allocated ports. Run one media aggregator at a time and leave the fixed ports free.

The current aggregator runs seven checks in sequence:

| Check | Evidence |
| --- | --- |
| `engine-smoke` | Real Chromium composite, pause/resume, browser recovery, local RTMP receipt and decoded MP4 audio |
| `pdf-smoke` | Authenticated PDF access, text extraction and completed page rendering |
| `app-smoke` | Two authenticated controllers sharing controls, composite avatar, monitoring and recording after logout, and a durable run created by real FFmpeg progress |
| `audio-monitor-smoke` | First-click Web Audio playback, audio handshake, explicit local mute, scene-list navigation closing browser audio, and preserved server recording |
| `audio-continuity-smoke` | Eight-second continuous tone under brief server/browser stalls, PCM clock accuracy, zero silent PCM holes and contiguous browser audio scheduling |
| `multistream-smoke` | Shared encoder, independent senders, peer outage/recovery and continuous recording |
| `workspace-smoke` | Six workspace categories, persona preview/apply/customization, cross-page drafts, save/discard, preserved cues, multiple video-channel account forms, separate broadcast history, escaped historical comments, keyboard navigation and mobile layout |

Run `npm run test:ux` for the workspace check alone. It opens an isolated authenticated controller, tests the actual forms against the HTTP app, and retains desktop/mobile screenshots and verification JSON in its reported temporary directory. It does not log into a real platform, call paid AI services or start an output. It also checks that clearing BGM remains a draft across asset refreshes and that layout changes wait for an explicit save.

Run `npm run test:audio` for the continuity check alone. Hardware audio is muted. The test measures PCM and actual Web Audio source scheduling while deliberately adding brief main-thread stalls. In a local macOS comparison, the old interval clock stretched an eight-second tone to 8,376 ms and inserted 17 browser scheduling gaps, up to 30.7 ms. With the monotonic mixer clock and buffered PCM player, the same test measured 7,999 ms, no silent PCM frames inside the tone, and zero scheduling gaps. This is a repeatable timing check, not a measurement of the user's physical audio device.

The media aggregator prints JSON with the temporary directory for each check. It retains MP4 recordings, the RTMP receiver's FLV file, a PDF screenshot, the actual application composite image, and verification JSON there for inspection. The third check starts the actual HTTP application in a separate temporary directory, logs in two independent controllers, verifies shared slide and pause/resume controls, plays an uploaded tone through a fixed cue, checks authenticated audio monitoring, logs one controller out while recording continues, and verifies owned processes exit on shutdown. Set `STUDIO_SMOKE_REPORT` to save the aggregate report to a chosen file. No production streaming destination, live platform session, microphone, OBS instance or model credential is used.

The browser audio-monitor check logs into an isolated controller and clicks an included prerecorded speech cue. It requires the monitor format handshake and a running AudioContext before the first cue request, measures nonzero PCM and actual Web Audio graph output, and checks playback without any encoding output. It then verifies that explicit local muting is respected and that closing local monitoring leaves server speech and recording running; the resulting MP4 must also contain nonzero decoded audio. The test browser mutes hardware output to avoid playing test sound on the workstation. This proves browser audio rendering and scheduling, not the user's physical speaker, operating-system volume or audio-device selection. Run this check alone with `node scripts/audio-monitor-smoke.mjs`.

## Actual local evidence

During development on macOS with Node.js 24.14.1, the short engine check passed with a 640 × 360 composite at a requested 10 frames per second. An earlier three-check run, before the audio-monitor and multi-stream checks were added, obtained 119,639 bytes at a local RTMP receiver, an MP4 of 118,315 bytes, and decoded audio RMS 0.0453. It observed 39 encoded frames and approximately 8.7 captured frames per second. Its 2.2-second generated tone finished after approximately 2.66 seconds including a 350-millisecond pause. The same check deliberately terminated only its own Chromium process, then verified browser recovery and restoration of HTML page 2 through the standalone `studioDeck.goToSlide` interface. That engine, PDF and application run completed in approximately 40 seconds.

The separate two-page PDF check passed on macOS: the private uploaded PDF was fetched with renderer authentication, rendered to a real canvas, and exposed the current page's text. Navigation waited for page 2's rendering to complete and successfully returned to page 1. PDF support does not imply native PowerPoint/PPTX parsing; convert a PPTX to PDF or a supported HTML presentation first.

The actual application check passed with two authenticated controller sessions. Shared page navigation and pause/resume worked, and recording continued after the first controller logged out. The second controller received 133 server events and 1,224,960 bytes of monitored PCM with RMS 0.0367. The MP4 contained 327,953 bytes and decoded audio RMS 0.0366. A screenshot sample from the avatar region contained 3,714 dark character pixels and no green pixels out of 10,925 sampled pixels. Shutdown closed the application's own encoder, Chromium and audio mixer while the event stream was open. These are measured checks from a short local run, not long-duration guarantees.

The separate browser-monitor check passed on macOS using the included prerecorded audience-interaction cue. The first trusted click waited for its audio handshake and a running AudioContext before submitting the cue. Monitoring also worked without recording or RTMP output. The browser received 403,200 bytes of PCM and scheduled 105 chunks, with measured Web Audio output RMS 0.0639; no page errors occurred. Explicit local muting persisted for the next cue, while server speech continued. Closing monitoring during the second cue preserved recording, whose MP4 contained 207,987 bytes with decoded audio RMS 0.0188. Hardware audio remained muted throughout this isolated check.

Media unit tests cover PCM playback completion, retained playback position during pause/backpressure, speech/BGM ducking, pending audio cancellation, rejection of unsafe presentation addresses and RTMP separator injection, render-token isolation, reconnect cancellation, operator audio monitoring, and closing during browser recovery. Other tests cover the director, providers, authentication, configuration and comment ingestion. Project tests cover first migration without changing legacy files, independent settings and keys, referenced-audio copying, busy-switch confirmation, stale-controller writes, failed initialization cleanup and rollback, startup failure, and private recording/renderer-token isolation. They do not use production data or credentials.

Program and deck screenshots share an explicit queue that activates each target before capturing it. Native deck operations retain that activation through asynchronous HTML/PDF rendering; during navigation the encoder continues sending the last valid composite frame. A capture deadline terminates only the engine's own browser and uses the existing bounded recovery process, rather than waiting indefinitely for Chromium. Focus ordering, concurrent deck controls, capture timeout and preservation of the last valid frame have focused regression tests. Failed media checks also emit JSON with the failed stage and completed checks so the CI artifact remains useful.

Shutdown waits for an in-flight Chromium launch to finish and release its profile before returning, including concurrent shutdown callers. A focused delayed-launch regression covers that ordering. An isolated macOS check also cancelled two real Chromium launches in succession using the same temporary profile; both owned browser processes had exited when shutdown returned, and the profile reopened without a singleton-lock error.

## Linux CI and operational checks

The multi-platform output check uses one H.264/AAC encoder feeding independent FFmpeg packet-copy senders, as described by FFmpeg's [streamcopy documentation](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffmpeg.texi). It starts a real local RTMP receiver and MP4 recording, adds a second receiver while encoding continues, disconnects the first receiver, and verifies that the other sender and recording keep progressing with the same process IDs. It then verifies independent automatic recovery and stopping one platform without stopping the other. This test uses fresh loopback ports and a local TCP proxy to simulate an outage; it does not connect to any public livestreaming service.

An earlier four-check macOS run, before browser audio monitoring was added to the aggregator, completed in approximately 60 seconds. The multi-platform test received 251,407 bytes before the first platform's outage, 85,952 bytes after recovery, and 312,923 bytes at the second receiver. The continuous MP4 contained 436,812 bytes with decoded audio RMS 0.0619. These measurements establish local transport behavior, not approval or successful publication by a third-party platform. All selected platforms share resolution, codecs and bitrate; outbound bandwidth is consumed separately for each platform. Each sender's stdin is bounded to 2 MiB, and three consecutive failed reconnects require an operator retry. A failing sender cannot apply backpressure to the shared encoder or healthy senders.

The GitHub Actions workflow defines a Node.js 24 syntax/unit job, a Docker media job, and an optional-ASR image build with offline Python dependency imports. The ASR check does not download the recognition model or verify transcription accuracy. The media job builds the production image with Debian Chromium, FFmpeg and CJK fonts, then runs the same real media checks without external network access. A configured workflow is not a completed Linux validation; inspect that repository's successful workflow run and its verification artifact before claiming the Linux check passed.

At commit `f7a104c`, the [completed Linux workflow](https://github.com/sliverp/xiaoyun-studio/actions/runs/40534472944) passed source checks, all 136 behavior tests, the ASR image imports, and all five media checks. Its `linux-media-verification` artifact records Linux with Node.js 24.22.1 and an aggregate media duration of 68,690 milliseconds. The local RTMP receiver obtained 140,418 bytes. Browser monitoring measured Web Audio output RMS 0.0837, respected explicit mute, and preserved an MP4 with decoded audio RMS 0.0186. The multi-stream recording contained 429,574 bytes and continued across the simulated peer outage. These are results for that revision; later changes require their own checks. Temporary paths in the JSON refer to the finished CI container; the uploaded artifact preserves the verification JSON, not all temporary media files.

These short checks do not prove 24/48-hour uptime, 1080p performance, a cloud instance's capacity, external RTMP compatibility, model/TTS availability or a real video-channel login. Before a long event, run an extended test on the intended host and verify CPU/memory, capture/encoding rate, audible speech, reconnection behavior, scheduled overlays, slide progression and receipt by the actual streaming platform. Record only with the operator's authorization and keep credentials, audience data and recordings outside the public repository.


## Scene and broadcast regression coverage

Reusable scene configuration retains its existing ProjectLibrary IDs and data paths. BroadcastSessions tests cover actual sink progress versus mere preparation, reconnects retaining one run, next output creating a new run, separate platform metrics with missing/zero values, bounded event pagination, persisted history, local recording references, and crash replay without counting downtime. HTTP tests verify authentication, comment deduplication within each run, fresh counters on a later run, filtered/streamed exports, scene switching and copying without copying run history.

The browser workspace check records two isolated external runs, refreshes the controller without creating a third, checks archived comments and metrics, verifies HTML-like comment text remains inert, and checks the sixth workspace category on desktop and mobile. The audio monitor check returns to the scene list while a real recording is active: all browser AudioContexts must close and scheduling must stop, while the same server broadcast and recording continue. Reopening the scene must wait for an explicit audio action.


Program scheduling tests exercise optional opening/closing, reordered whole-turn playback, independent engagement, disabled manual/automatic stages, explicit single and multiple lottery rules, simultaneous-trigger deduplication, metric selection and trigger preservation under comment overflow. Store tests verify legacy rule migration and atomic validation. The browser workspace test edits and persists rule selections and stage order, checks disabled activity buttons and the finish-without-goodbye label, and reloads the scene to verify saved choices.

## Provider failover and voice selection

The provider change passes 181 unit tests on macOS and in the Linux release image. Coverage includes a stalled response body, non-cooperative SDK timeouts, invalid model JSON and director protocol, cancellation without fallback, cooldown expiry, credential changes, independent speech credentials, voice-specific cache files, and private test APIs. Browser checks cover ordered model and speech backups, voice selection, credential removal when reusing a deleted slot, persistence, discard, mobile layout, and manual playback of a generated preview.

Real short requests were sent to both configured DeepSeek services and Tencent TextToVoice for the main and backup voices. The resulting WAV files were decoded with FFmpeg and verified to contain non-silent audio. Live service latency is a sample rather than a guarantee. No external stream was started for these checks. Existing media integration checks cover actual local RTMP receipt, recording, PDF rendering, audio monitoring and multiple simultaneous outputs.

The 2.0 voice and audition update passes 185 unit tests. It checks all 18 official basic 2.0 voices, stable-slot credential selection, preview failure without live cooldown changes, cached named audio, administrator and scene guards, and auditioning without saving any draft. Actual short WAV previews for 云小团、云嘉瑜、云大围 were synthesized and decoded successfully.

## Render page recovery

Recovery tests cover a closed page in an otherwise connected browser, a startup `Session closed` error, stale events from retired pages, waiting for profile release, bounded child cleanup, server-side retry after cooldown, and cgroup memory thresholds. The engine integration check closes the actual program tab during local RTMP output and recording, injects one failed replacement startup, and verifies recovery of the current slide with the same encoder. It then separately kills the owned browser and checks reconnection. These checks use isolated local receivers and do not start a third-party broadcast. The current unit suite contains 219 tests.

渐进语音：`node scripts/speech-pipeline-smoke.mjs` 使用本地延迟响应与实际PCM播放验证首块先播、后续合成、两路请求上限、三块解码上限与分块衔接静音。`node scripts/manual-sale-smoke.mjs` 覆盖当前整段结束后插入秒杀、取消、倒计时与移动端。测试不访问付费模型或语音服务。
