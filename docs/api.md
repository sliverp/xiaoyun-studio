# 接口和演示稿协议

浏览器登录后的操作使用同源 Cookie。写请求采用 JSON。外部弹幕桥使用单独的 X-Ingest-Key，不需要管理员密码，也不能控制直播。可以在导播台查看接入示例和设置该密钥。

## 常用接口

| 方法与地址 | 用途 |
| --- | --- |
| POST /api/login | `{ "password": "your-own-password" }` 登录，保存 Cookie |
| GET /api/state | 当前安全配置、导播、媒体、采集和服务就绪状态 |
| GET /api/events | SSE 状态变化，多端可订阅 |
| PUT /api/config | `{ "patch": {...}, "secrets": {...} }`；空密钥保留，null 删除 |
| POST /api/action | `{ "action": "live.start" }` 等操作 |
| GET /api/frame.jpg | 当前合成画面；渲染未就绪时 204 |
| POST /api/upload | 原始文件体，X-Filename 使用 UTF-8 百分号编码 |
| GET /api/assets | 可选素材和录音 |
| POST /api/comments | 弹幕批次，管理员 Cookie 或 X-Ingest-Key |
| POST /api/metrics | 指标采样，管理员 Cookie 或 X-Ingest-Key |
| GET /api/report?format=json | JSON、csv 或 md 报告 |
| GET /api/channels/status | 视频号连接和真实消息接收状态 |
| GET /api/channels/frame.jpg | 独立后台的私有扫码截图 |

动作包含 preview.start、live.start/pause/resume/restart/finish/stop、output.start/stop、presentation.open/next/prev/first、cue.play、chat.ask、sale.queue/hide、lottery.queue、channels.connect/disconnect/click。输出启动与 AI 启动互相独立。

弹幕样例：

```json
{"comments":[{"id":"unique-comment-id","nickname":"观众昵称","content":"这个能独立部署吗？","at":1792800000000}]}
```

时间采用 Unix 毫秒，接入时应保持当前时间；过期弹幕不会参与新回复。id 用于去重。不要用评论正文充当可信系统指令。指标支持 onlineUsers、totalViewers、views、likes、heat 等；有采样来源的入口可采用 fields，每项携带 value、at、source、path、raw、approximate，详见 channels-parser 的字段映射。没有采集到的数值不要补零。报告中 sampledPeakOnline 是在线采样峰值，platformPeakOnline 是已取得的平台峰值，peakOnline 取可用来源中的较大值；报告切面只覆盖当前进程，重启前应导出。

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
