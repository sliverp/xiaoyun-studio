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

`test:media` requires Chromium and FFmpeg. Set `CHROMIUM_PATH` and `FFMPEG_PATH` when their executables are not found automatically. On a Linux container that does not support the Chromium sandbox, the image sets `CHROMIUM_NO_SANDBOX=1`; deploy this single-administrator service in an isolated container. The checks use only loopback listeners: ports 18359, 18360 and 19359. Run one media check at a time and leave those ports free.

The media aggregator prints JSON with the temporary directory for each check. It retains MP4 recordings, the RTMP receiver's FLV file, a PDF screenshot, the actual application composite image, and verification JSON there for inspection. The third check starts the actual HTTP application in a separate temporary directory, logs in two independent controllers, verifies shared slide and pause/resume controls, plays an uploaded tone through a fixed cue, checks authenticated audio monitoring, logs one controller out while recording continues, and verifies owned processes exit on shutdown. Set `STUDIO_SMOKE_REPORT` to save the aggregate report to a chosen file. No production streaming destination, live platform session, microphone, OBS instance or model credential is used.

The browser audio-monitor check logs into an isolated controller and clicks an included prerecorded speech cue. It requires the monitor format handshake and a running AudioContext before the first cue request, measures nonzero PCM and actual Web Audio graph output, and checks playback without any encoding output. It then verifies that explicit local muting is respected and that closing local monitoring leaves server speech and recording running; the resulting MP4 must also contain nonzero decoded audio. The test browser mutes hardware output to avoid playing test sound on the workstation. This proves browser audio rendering and scheduling, not the user's physical speaker, operating-system volume or audio-device selection. Run this check alone with `node scripts/audio-monitor-smoke.mjs`.

## Actual local evidence

During development on macOS with Node.js 24.14.1, the short engine check passed with a 640 × 360 composite at a requested 10 frames per second. In the final three-check run, a local RTMP receiver obtained 119,639 bytes, the MP4 contained 118,315 bytes, and the decoded recording had audio RMS 0.0453. The check observed 39 encoded frames and approximately 8.7 captured frames per second. Its 2.2-second generated tone finished after approximately 2.66 seconds including a 350-millisecond pause. The same check deliberately terminated only its own Chromium process, then verified browser recovery and restoration of HTML page 2 through the standalone `studioDeck.goToSlide` interface. The full engine, PDF and application aggregator completed in approximately 40 seconds.

The separate two-page PDF check passed on macOS: the private uploaded PDF was fetched with renderer authentication, rendered to a real canvas, and exposed the current page's text. Navigation waited for page 2's rendering to complete and successfully returned to page 1. PDF support does not imply native PowerPoint/PPTX parsing; convert a PPTX to PDF or a supported HTML presentation first.

The actual application check passed with two authenticated controller sessions. Shared page navigation and pause/resume worked, and recording continued after the first controller logged out. The second controller received 133 server events and 1,224,960 bytes of monitored PCM with RMS 0.0367. The MP4 contained 327,953 bytes and decoded audio RMS 0.0366. A screenshot sample from the avatar region contained 3,714 dark character pixels and no green pixels out of 10,925 sampled pixels. Shutdown closed the application's own encoder, Chromium and audio mixer while the event stream was open. These are measured checks from a short local run, not long-duration guarantees.

The separate browser-monitor check passed on macOS using the included prerecorded audience-interaction cue. The first trusted click waited for its audio handshake and a running AudioContext before submitting the cue. Monitoring also worked without recording or RTMP output. The browser received 403,200 bytes of PCM and scheduled 105 chunks, with measured Web Audio output RMS 0.0639; no page errors occurred. Explicit local muting persisted for the next cue, while server speech continued. Closing monitoring during the second cue preserved recording, whose MP4 contained 207,987 bytes with decoded audio RMS 0.0188. Hardware audio remained muted throughout this isolated check.

Media unit tests cover PCM playback completion, retained playback position during pause/backpressure, speech/BGM ducking, pending audio cancellation, rejection of unsafe presentation addresses and RTMP separator injection, render-token isolation, reconnect cancellation, operator audio monitoring, and closing during browser recovery. Other tests cover the director, providers, authentication, configuration and comment ingestion.

Program and deck screenshots share an explicit queue that activates each target before capturing it. Native deck operations retain that activation through asynchronous HTML/PDF rendering; during navigation the encoder continues sending the last valid composite frame. A capture deadline terminates only the engine's own browser and uses the existing bounded recovery process, rather than waiting indefinitely for Chromium. Focus ordering, concurrent deck controls, capture timeout and preservation of the last valid frame have focused regression tests. Failed media checks also emit JSON with the failed stage and completed checks so the CI artifact remains useful.

Shutdown waits for an in-flight Chromium launch to finish and release its profile before returning, including concurrent shutdown callers. A focused delayed-launch regression covers that ordering. An isolated macOS check also cancelled two real Chromium launches in succession using the same temporary profile; both owned browser processes had exited when shutdown returned, and the profile reopened without a singleton-lock error.

## Linux CI and operational checks

The multi-platform output check uses one H.264/AAC encoder feeding independent FFmpeg packet-copy senders, as described by FFmpeg's [streamcopy documentation](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffmpeg.texi). It starts a real local RTMP receiver and MP4 recording, adds a second receiver while encoding continues, disconnects the first receiver, and verifies that the other sender and recording keep progressing with the same process IDs. It then verifies independent automatic recovery and stopping one platform without stopping the other. This test uses fresh loopback ports and a local TCP proxy to simulate an outage; it does not connect to any public livestreaming service.

The four-check macOS run completed in approximately 60 seconds. The multi-platform test received 251,407 bytes before the first platform's outage, 85,952 bytes after recovery, and 312,923 bytes at the second receiver. The continuous MP4 contained 436,812 bytes with decoded audio RMS 0.0619. These measurements establish local transport behavior, not approval or successful publication by a third-party platform. All selected platforms share resolution, codecs and bitrate; outbound bandwidth is consumed separately for each platform. Each sender's stdin is bounded to 2 MiB, and three consecutive failed reconnects require an operator retry. A failing sender cannot apply backpressure to the shared encoder or healthy senders.

The GitHub Actions workflow defines a Node.js 24 syntax/unit job, a Docker media job, and an optional-ASR image build with offline Python dependency imports. The ASR check does not download the recognition model or verify transcription accuracy. The media job builds the production image with Debian Chromium, FFmpeg and CJK fonts, then runs the same real media checks without external network access. A configured workflow is not a completed Linux validation; inspect that repository's successful workflow run and its verification artifact before claiming the Linux check passed.

These short checks do not prove 24/48-hour uptime, 1080p performance, a cloud instance's capacity, external RTMP compatibility, model/TTS availability or a real video-channel login. Before a long event, run an extended test on the intended host and verify CPU/memory, capture/encoding rate, audible speech, reconnection behavior, scheduled overlays, slide progression and receipt by the actual streaming platform. Record only with the operator's authorization and keep credentials, audience data and recordings outside the public repository.
