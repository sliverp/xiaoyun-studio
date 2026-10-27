# Sources and licenses

Studio server, UI, compositor, state machine and direct API integration: Copyright (c) 2026 sliverp, MIT.

The project was extracted from the Xiaoyun Live work at https://github.com/sliverp/xiaoyun-live. Selected previous pure logic, public character art and reviewed demonstration recordings originate there. MIT copyright notices from biliye and sliverp are retained in LICENSE. The original speech plugin is https://github.com/biliye/dsh-voice-call (0.2.1, MIT). This application has no DSH or Cordis runtime dependency.

The bundled character is project demonstration artwork; product names and marks remain their owners’ property. Replace it for unrelated brand use. The green backdrop is removed at rendering time, and expressions switch directly rather than cross-fading.

Bundled background recordings are CC0. Composer, performer, original source and processing details are in public/builtin/bgm/LICENSE.txt. Provider SDK and Chromium/FFmpeg licenses are distributed by their respective packages and system distributions. FFmpeg codec licensing depends on the binary and use case; Docker uses Debian’s FFmpeg package.

Private stream keys, API credentials, browser sessions, audience identifiers, historical reports and the operator’s live presentation content are not included in this repository. The migration command copies presentation material to ignored local storage without changing the original installation.

The passive Bilibili, Douyin and Kuaishou chat adapters credit the MIT implementations in xfgryujk/blivedm, Akegarasu/blivedm-go, ymstar/dyhub and atvkh/kuaishou-live-mate. Full retained MIT notices are in [licenses/platform-chat-MIT.txt](licenses/platform-chat-MIT.txt); reviewed revisions, protocol scope and verification limits are in [docs/platform-chat-sources.md](docs/platform-chat-sources.md). DouyinLiveWebFetcher was reviewed as protocol research; its AGPL signature scripts, full schema and generated code are not distributed here. The decoder uses protobufjs under its package license and Node.js compression APIs.
