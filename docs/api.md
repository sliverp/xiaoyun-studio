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

时间采用 Unix 毫秒，接入时应保持当前时间；过期弹幕不会参与新回复。id 用于去重。不要用评论正文充当可信系统指令。指标支持 onlineUsers、totalViewers、views、likes、heat 等；有采样来源的入口可采用 fields，每项携带 value、at、source、path、raw、approximate，详见 channels-parser 的字段映射。没有采集到的数值不要补零。

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
