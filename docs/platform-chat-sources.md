# Platform chat adapters: sources and verification

The integrated adapters run each connection's own headless Chromium profile. The official page performs authentication, signatures, heartbeats and acknowledgements; the collector observes allowlisted WebSocket responses through CDP. It does not send comments, likes, follows, gifts, orders or platform start/stop-live actions. The WeChat adapter reuses the existing read-only video-channel backend collector inside the new connection's separate directory.

## Reviewed primary projects

| Project | Reviewed revision | License | Relevant behavior |
| --- | --- | --- | --- |
| [xfgryujk/blivedm](https://github.com/xfgryujk/blivedm) | `3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6` | MIT | Bilibili WebSocket framing and JSON comments. Its sample documents anonymous username masking; it is not published to PyPI. |
| [Akegarasu/blivedm-go](https://github.com/Akegarasu/blivedm-go) | `957b543d2bfa8c2ac8a7af2fb42ae73eb92443b2` | MIT | The current `pb/events.proto` describes `dm_v2` comment id, text and 64-bit user information. The adapter decodes only those fields. |
| [ymstar/dyhub](https://github.com/ymstar/dyhub) | `d8aaca990dbf646ef2f01279fa7c0358dca2c572` | MIT for browser code; separate AGPL signature assets | Browser/CDP observation and the limited Douyin protobuf message definitions. Its whole package is not imported. |
| [atvkh/kuaishou-live-mate](https://github.com/atvkh/kuaishou-live-mate) | `febc0a89780e3b7c15650915bf3eb5fe5f2fe0ca` | MIT | Kuaishou WebSocket feed framing, chat fields and gzip handling. Its desktop GUI, posting and automatic-like behavior are not included. |

The small decoder implementation and limited schemas are adapted against those MIT references; their notices are preserved in [licenses/platform-chat-MIT.txt](../licenses/platform-chat-MIT.txt). Protobuf decoding uses the maintained [protobufjs](https://github.com/protobufjs/protobuf.js) dependency; compression uses Node.js built-ins.

[DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher) was inspected as protocol research and is AGPL-3.0. Its full protocol, generated code, signature scripts and other executable assets are not distributed here. Its current [schema](https://github.com/saermart/DouyinLiveWebFetcher/blob/main/douyin.proto) independently confirms `RoomUserSeqMessage` fields 3, 6 and 7 as signed int64 varints. The decoder rejects changed wire types for those counters, skips unavailable counters, and preserves valid comments from other messages in the batch.

The current [bilibili-live-ws](https://github.com/simon300000/bilibili-live-ws) 7.x API is an official Open Live client requiring platform-returned `websocket_info`; it is not a room-number-only web collector. This application therefore does not depend on older tutorials for that package. The archived [THMonster/danmaku](https://github.com/THMonster/danmaku) was not selected as a maintained dependency. The [official Kuaishou live-open integration](https://github.com/KwaiVideoTeam/kuaishou-liveopen-api) requires its own application onboarding and user authorization; QR login here does not grant those API permissions.

## Limits and evidence

Bilibili decoding supports traditional `DANMU_MSG` arrays and current `dm_v2` bodies. Heartbeat popularity is stored as heat, not online viewers. Douyin chat, likes and room counters are selected from known fields; unknown messages are omitted. Kuaishou feed comments and displayed counters are supported; rounded counters retain approximation metadata. AES-encrypted Kuaishou feed payloads produce an explicit unsupported-format error. No arbitrary “nickname: text” DOM parser or invented metrics are used.

Login and room navigation are restricted to official platform hosts. Login controls include trusted child frames with screenshot-coordinate translation. Cookies remain in private per-connection profiles and are never returned by state APIs. Safety challenges remain visible and require operator action. Opening a browser, receiving a heartbeat, or decoding an unknown frame does not prove that comments are being collected.

`node --test test/platform-chat.test.mjs test/channels.test.mjs` exercises synthetic protocol fixtures and owned-browser lifecycle. `node scripts/platform-login-smoke.mjs` performs a separate network-enabled assessment of the four official login pages using temporary profiles and no accounts; it stores screenshots and sanitized JSON, then closes browsers and removes their profiles. Set `STUDIO_LOGIN_SMOKE_DIR=/report` to write only the JPEG files and `report.json` to a mounted report directory; browser profiles still use a separate temporary directory. A completed assessment can include platform/network failures and exits successfully when the harness and browser cleanup completed; inspect each platform result rather than treating the exit code as four successful logins.

`qrVisible` checks that a visible login image or canvas has a loaded black-and-white pattern, excluding blank loading graphics and small placeholder logos. Cross-origin images that cannot be inspected remain unverified and need screenshot inspection. This does not decode the QR, establish its validity, or prove account authentication. A page or QR screenshot is not a successful account login, live-comment test or outbound broadcast test. Linux headless suitability follows the browser/CDP architecture; actual login and chat still require an authorized account, active room, platform access and a successful test on the intended host.
