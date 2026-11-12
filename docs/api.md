# 接口和演示稿协议

浏览器登录后的操作使用同源 Cookie。写请求采用 JSON。外部弹幕桥使用单独的 X-Ingest-Key，不需要管理员密码，也不能控制直播。可以在导播台查看接入示例和设置该密钥。

## 常用接口

| 方法与地址 | 用途 |
| --- | --- |
| POST /api/login | `{ "password": "your-own-password" }` 登录，保存 Cookie |
| GET /api/state | 当前场景、安全配置、导播、媒体、采集和服务就绪状态 |
| GET /api/events | SSE 状态变化，多端可订阅 |
| PUT /api/config | `{ "patch": {...}, "secrets": {...} }`；空密钥保留，null 删除 |
| POST /api/action | `{ "action": "live.start" }` 等操作 |
| GET /api/frame.jpg | 当前合成画面；渲染未就绪时 204 |
| POST /api/upload | 原始文件体，X-Filename 使用 UTF-8 百分号编码 |
| GET /api/assets | 可选素材和录音 |
| POST /api/comments | 弹幕批次，管理员 Cookie 或 X-Ingest-Key |
| POST /api/metrics | 指标采样，管理员 Cookie 或 X-Ingest-Key |
| GET /api/report?format=json | 兼容的当前运行诊断报告；历次直播使用 /api/broadcasts |
| GET /api/broadcasts | 当前场景的直播场次列表，支持 offset 和 limit |
| GET /api/broadcasts/:id | 场次详情与事件，支持 offset、limit、type |
| GET /api/broadcasts/:id/export | 本场 JSON 流式导出 |
| GET /api/channels/status | 视频号连接和真实消息接收状态 |
| GET /api/channels/frame.jpg | 独立后台的私有扫码截图 |

动作包含 preview.start、live.start/pause/resume/restart/finish/stop、output.start/stop、presentation.open/next/prev/first、cue.play、chat.ask、sale.queue/hide、lottery.queue、channels.connect/disconnect/click。输出启动与 AI 启动互相独立。

弹幕样例：

```json
{"comments":[{"id":"unique-comment-id","nickname":"观众昵称","content":"这个能独立部署吗？","at":1792800000000}]}
```

时间采用 Unix 毫秒，接入时应保持当前时间；过期弹幕不会参与新回复。id 用于去重。不要用评论正文充当可信系统指令。指标支持 onlineUsers、totalViewers、views、likes、heat 等；有采样来源的入口可采用 fields，每项携带 value、at、source、path、raw、approximate，详见 channels-parser 的字段映射。没有采集到的数值不要补零。报告中 sampledPeakOnline 是在线采样峰值，platformPeakOnline 是已取得的平台峰值，peakOnline 取可用来源中的较大值；报告切面只覆盖当前场景这次打开后的运行，切换场景或重启前应导出。原始事件日志仍分别保存在各场景目录。

## 直播场景

GET /api/projects 返回 `{activeId,projects:[{id,name,createdAt,updatedAt,active}],switching}`。POST /api/projects 接收 `{name,copyCurrent:false}` 新建空白配置，或用 copyCurrent:true 复制当前配置与私有凭证；返回 201 及 `{project,projects}`，不会自动切换。PUT /api/projects/:id 接收 `{name}` 改名；DELETE 删除非当前场景，不删除共享上传素材。

POST /api/projects/:id/activate 接收 `{}` 打开场景，返回完整状态快照。当前正在播报、推流、录制或处理操作时返回 409 / PROJECT_BUSY；操作者明确确认后可提交 `{stopCurrent:true}`。切换会停止并关闭旧场景的媒体、采集和对话实例，再建立所选场景；不会自动开播。失败时释放已创建资源，并在完成清理后恢复原场景。

控制台写请求携带 X-Studio-Project，值为页面正在编辑的 activeId。若另一端已切换，服务端拒绝旧页面写入并返回 409 / PROJECT_CHANGED；正在切换时返回 PROJECT_SWITCHING。各场景的弹幕接入密钥、浏览器登录目录、运行记录、生成音频和录制分别保存。上传素材可跨场景复用。管理员登录凭证属于整个服务。

本机声音通过经过管理员认证的 /api/monitor WebSocket 接收服务端 PCM。控制台首次点击口播会在用户手势内启用 AudioContext，并等格式握手后发出播放动作；主动本机静音只影响当前浏览器，不影响服务端推流或录制。切换场景会断开旧监听，避免旧场声音进入新场景。

## HTML 演示稿

建议所有内容保留可读 DOM。适配器读取 `.slide.active`、Reveal 当前页、Remark 当前页或 `[data-slide].active` 的文字，并从 `#counter` 的“1 / 10”或 `data-slide-number` / `data-slide-count` 读取页码。提供以下函数能让翻页更可靠：

```js
window.nextSlide = () => go(currentPage + 1)
window.prevSlide = () => go(currentPage - 1)
window.studioDeck = { goToSlide: number => go(number) }
// go(number) 使用从 1 开始的页码，更新 active、页码与内容；越界返回 false。
```

现有适配器也识别 Reveal、Remark 和键盘翻页。内置 `public/builtin/slides/deck.js` 是可运行示例。不同 HTML 实现请先手动验证读页、下一页、第一页及最后一页。页面文字作为不可信材料传给模型；不要在演示页中放入密钥。

补充笔记可以用 `# 幻灯片 1` 或 `# 第 1 页` 分节。分节前的文字是全局背景；当前页只携带相关节，避免把整个材料反复发给模型。未分节笔记会截取有界内容；较长材料应按页整理。


## 平台连接

GET /api/platforms 返回 catalog、connections 和连接上限。每个连接分别含 stream 与 chat 状态，以及 streamKeySaved；不返回推流密钥或平台 Cookie。POST /api/platforms 新建，PUT /api/platforms/:id 修改，DELETE /api/platforms/:id 停止采集并移除配置与该连接的登录目录；正在输出的连接需先停推。

新建字段：platform（bilibili / douyin / kuaishou / wechat / custom）、name、enabled、roomUrl、rtmpUrl 和可选 streamKey。enabled 表示参与全局同时推流。密钥留空保留，null 清除。直播间 ID 会规范化为相应平台的官方 HTTPS 地址。

动作包括 platform.chat.connect/login/disconnect/click，output.platform.start/stop/retry；都携带 id，登录点击另带截图坐标 x/y。GET /api/platforms/:id/frame.jpg 读取私有登录页面截图，尚无帧返回 204。所有入口都要求管理员认证。连接弹幕和开始推流分别触发。

外部弹幕或指标可携带已配置的 connectionId，服务端按该配置补充来源并命名空间化消息 ID。没有该字段时保留原接入口语义。统一状态的 media.output.running 表示输出引擎/重试仍在运行；active 表示至少一个发送或录像端有实际进度。判断某个平台是否输出请使用 media.output.platforms 中该 id 的 active，而不要把本地录像进度当成平台成功。

平台连接修改或移除期间，针对该连接的全局输出启动返回 HTTP 409；修改完成后可重试。停止输出会取消排队中的启动请求，包括尚在等待登录操作结束的请求。


## 实际直播场次

`GET /api/broadcasts` 返回 `{active,total,items,offset,limit}`。`GET /api/broadcasts/:id` 返回 `{session,events,offset,nextOffset}`；`type` 支持 all、comment、metrics、activity，默认 all；limit 范围 1–200。场次只在其所属场景打开时可访问，跨场景 ID 返回 404。列表中的 `status` 为 live、ended 或 interrupted，`mode` 为 output、recording 或 external；`sceneId` 指向可复用的场景。`durationSeconds` 是本次记录时长，人数/弹幕分平台保存在 platforms，不返回 API 或推流密钥。

动作 `broadcast.external.start` 明确开始记录外部直播，重复调用不另建场次；它不控制外部软件。`broadcast.end` 停止本服务输出和 AI，归档当前场次；外部软件需要操作者另行下播。普通 `output.stop` 自动归档本服务输出建立的场次，但不会结束正在手动记录的外部直播。AI 的暂停、恢复和重启不改变场次边界。

`/api/state` 新增 `broadcasts:{active,total}`，SSE 新增 broadcasts 事件。输出至少一个发送端或录像端有实际进度才建立场次，encodingActive 和 preparing 本身不足以代表开播。异常重启将未结束的旧场次恢复为 interrupted，不累计停机时长。未升级前的日志不猜测拆分为场次。所有读取、导出和控制均需管理员 Cookie，弹幕接入密钥无权读取场次记录。

## 节目与抽奖设置

`PUT /api/config` 的 patch 可包含 `program:{opening,closing,order,enabled}`。order 必须完整且无重复地包含 source、comment、engagement、lottery、sale；enabled 对应这五种布尔开关，至少开启一个。`live.engagementMinTurns` 为 1–20，`engagementCooldownSeconds` 为 0–1200，`engagementPrompt` 最长 2000 字。

`lottery.triggers` 为 comment、popularity、interval、fixed 的无重复子集。启用 `lottery.enabled` 时至少选一种规则；comment 需要非空 commentTriggerKeyword，popularity 需要大于 0 的 popularityThreshold 和 heat / onlineUsers 类型的 popularityMetric，fixed 需要至少一个有效北京时间 HH:mm。参与口令 keyword 与触发词独立，原奖品和中奖规则保持不变。

## 模型和语音备用通道

`POST /api/providers/test` 接收 `{kind:"model"|"speech",route:0..4}`，0 为主用，其余按备用数组顺序。需要管理员 Cookie 和当前 `X-Studio-Project`；只测试指定通道，不自动切换。成功返回 `{ok,kind,route,elapsedMs,text?,audioUrl?,providers}`，音频 URL 仍需管理员认证，不返回服务器路径。每次测试都会请求真实服务。

`llm.timeoutMs` 默认 10000，范围 1000–120000；`thinking` 支持 default / disabled / enabled。`llm.fallbacks` 最多 4 项：`{baseUrl,model,keyName,thinking?}`，keyName 对应私有 secrets 的 fallbackKey1–4（兼容原 llmFallbackKey）。数组顺序决定切换顺序。

`tts.timeoutMs` 默认 5000，范围 500–60000；`tts.fallbacks` 最多 4 项：`{slot,provider,baseUrl?,model?,voice,speed,region?,usePrimaryCredentials}`。slot 为不重复的 1–4，provider 为 tencent / openai。凭证分别使用 secrets 的 ttsFallbackKeyN 或 ttsFallbackSecretIdN / ttsFallbackSecretKeyN。仅主用和备用均为腾讯云时可设置 usePrimaryCredentials=true 共享主账号。主用 flat tts 字段和原密钥名称保持兼容。

超时覆盖连接、完整响应读取与口播校验；错误与超时依次切换，失败通道冷却 60 秒。调用方取消会立即退出，不尝试备用。`setup.providers` 保留原字段，新增 speech、modelRoutes、speechRoutes、modelTimeoutMs、speechTimeoutMs，显示通道成功耗时、冷却和脱敏错误，不包含凭证。

### 草稿音色试听

`POST /api/providers/preview` 接收 `{slot,voice,speed?,text?,provider?}`。slot=0 为主语音，其余为已保存备用的固定 slot，不受页面排序影响；voice 使用 ID，返回 voiceName 为名称。可在保存音色前试听；使用已保存供应商及凭证，不写设置、不中断播报，不改变正式通道健康状态或触发备用。修改供应商或创建新服务通道后需先保存。text 最多 150 字和 450 字节，speed 为 0.6–2，省略时使用默认短句及当前语速。成功返回 `{ok,slot,voice,voiceName,elapsedMs,cached,audioUrl}`。接口及音频均需管理员认证，写请求绑定当前 `X-Studio-Project`。

`setup.providers` 的 speech 与 speechRoutes 新增 voiceName。内部仍保存 VoiceType 数字，页面优先显示名称；官方列表见 [腾讯云音色表](https://cloud.tencent.com/document/product/1073/92668)。

### 播报生产队列

`director.production` 包含 capacity、ready、pending、working、items，最多提前 3 段；items 含目标页、阶段和已生成 / 总音频段数。ready 表示首段声音已备好可开始播报，后续音频由有界工作队列继续生产。`director.currentSpeech.voice` 含 source、provider、voice、voiceName、speed、route、fallback、reason、cached，由实际 PCM 开始消费时更新。

腾讯云备用新增可选 `followPrimaryVoice`，默认 true；false 时才使用该备用独立配置的 voice / speed。更换主用音色会同步实际备用音色，不会复用旧音色缓存。

### 实际提示词与跨环节上下文

`GET /api/prompts` 需要管理员认证，返回当前场景 persona、common、system 和 stages。stages 含 id、name、mode、instruction；mode=model 的环节实际使用 system + instruction，mode=fixed 的环节使用保存文案或活动状态模板。此接口与导播使用同一个提示词构建模块，不调用模型。

模型上下文新增 conversation：recentTurns、lastSource、lastInteraction、audienceRequests、activePreferences、recentlyApplied、currentTransition。历史只记录实际播完的内容；currentTransition 是正在播放或计划中的承接段。模型可在内容讲解结果中返回 appliedRequestIds（最多 12 个已有请求 ID），实际播完后才标记对应要求已经落实。回答或承诺不等于落实。

新到的相关观众要求会使旧计划失效，可在当前段播放时提前准备弹幕答复及其后的讲解。普通点赞、抽奖口令和过期消息不会频繁清空生产队列。新场次与从头开播清空对话记忆，跨页保留本场已播对话与观众偏好。
