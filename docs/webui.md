# WebUI 运维接口

WebUI 默认关闭；启用后默认在回环地址的 3012 端口监听。它直接读取网关进程内状态，与 3011 上的只读观测服务独立。上游未连接时页面仍可加载，显示端点离线与网关未就绪；`/api/state` 返回 200，原有 `/health` 未健康时仍返回 503。

## 面板用语表

| 用语 | 含义 |
|---|---|
| 上游 | 协议端（QQ 侧） |
| 下游 | 应用侧（机器人） |
| 放行 / 拦下 | 网关的判定结果，对应 `allowed` / `denied` |
| 已连接 / 未连接 | 端点是否建立连接 |
| 已就绪 / 未就绪 | 端点或路由是否已经可以转发；已连接仍可能未就绪 |
| 回包 | 上游对请求的答复；待回包表示仍在等待答复 |
| 登录凭据 / 退出登录 | 登录页输入的读取凭据，以及结束当前会话的操作 |
| 高级 YAML | 编辑策略 YAML 的页面；导航与页面标题一致 |

第五批统一上述用语，加载提示说明接下来会自动显示什么。端点与路由表单以中文为主标签，英文配置键单独放在更小、更淡的一行；环境变量字段只填变量名。后端返回的策略名称、错误与重载原因仍原样显示。

正文最大宽度为 1320px；概览卡片固定等高，时间最多显示两行，完整值保留在文本和悬停提示中。900px 及以下，双列改为单列，导航在内容上方换行。日志按时间、级别、来源和内容对齐，长内容可换行；540px 及以下内容另起一行，来源仍保留。深浅色共用尺寸与间距，浅色辅助文字加深以便阅读。

## 接口

所有响应（包括错误和静态资源）均为 `Cache-Control: no-store`。不支持的方法返回 405 和 Allow，未知 GET 路径返回 404。未开启编辑时 PUT /api/policies 始终为 404。

| 方法 | 路径 | 内容与认证 |
|---|---|---|
| GET | `/` | 未认证返回独立登录页（200）；通过读认证后返回面板 |
| GET | `/assets/app.js`、`/assets/style.css` | 通过读认证后读取；否则 401；仅这两个固定路径 |
| POST | `/api/login` | JSON `{ "token": "<READ_TOKEN>" }`；成功 204 并设置会话 cookie |
| POST | `/api/logout` | 删除当前会话并过期 cookie；204，未登录也幂等 |
| GET | `/api/state` | 健康、启动/最后事件时间、端点、路由两端就绪、待回包、状态表规模、计数、规则命中、传输问题、策略名称、最近重载；读认证 |
| GET | `/api/policies` | `{ yaml, parsed, reload, allow_policy_edit }`；yaml 是文件中 policies 值的 YAML 表示，parsed 是对应映射；读认证 |
| PUT | `/api/policies` | 仅编辑开启时存在；始终要求写认证 |
| GET | `/api/config`（允许查询串） | 文件中的端点、路由与策略名称；必须有有效登录会话 |
| PUT | `/api/config` | 编辑开启时可保存端点/路由；必须有有效登录会话；可请求重启 |
| GET | `/api/logs` | SSE 最近事件回放与实时推送；读认证 |

`reload` 在尚未重载时为 null，其后为 `{ ok, reason, time }`；包含文件监听、信号和页面保存触发的结果。策略 GET 读的是文件内容，运行策略名来自重载器；如果宿主手工修改了无效配置，旧内存策略继续运行，错误原因显示在重载结果中。策略 GET 也会先全量校验当前文件，无效时返回 400，避免回显外部误写的明文凭据字段。

## 认证与页面

配置了 `read_token_env` 时，未认证浏览器只拿到无面板结构、无运行数据的独立登录页。输入登录凭据后，以 JSON 提交到 `/api/login`；成功设置 cookie 并重新进入 `/`。静态外壳现在也受保护：面板 HTML、两个资源和全部读 API 共用读认证，先检查有效会话，再检查 `Authorization: Bearer <READ_TOKEN>`。脚本可以继续只带读取 Bearer；伪造、过期或重复的会话 cookie 不构成认证。缺失/错误/用途不符的登录 token 均为相同的 401，不记录或回显 token。

按第三批澄清，登录页使用一个最小内联脚本，只负责 JSON 登录、显示错误和成功后 `location.replace('/')`。它不加载 `/assets/*` 或任何外部资源。服务端对实际返回的脚本和样式文本在运行时分别计算 SHA-256，放入该响应的 CSP hash 白名单；先规范化 HTML 换行，避免 Windows 换行与浏览器解析结果不同。不使用 unsafe-inline 或 unsafe-eval；面板页 CSP 保持第二批原值。

cookie 格式为 `guard_session=<随机 ID>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<秒数>`。**不设置 Secure**：当前部署是明文 HTTP，加上后浏览器不会回传 cookie，页面无法使用。HTTP 上 cookie 也以明文传输，建议部署在 HTTPS 反向代理或加密隧道后面；本服务不终结 TLS，也不增加 HSTS。HttpOnly 阻止脚本读取 cookie，SameSite=Strict 限制跨站携带。ID 使用 `node:crypto` 生成 32 字节随机数，与 token 及其摘要无关；不写入磁盘、日志或浏览器存储。

会话仅保存在当前进程的有界 Map。`session_ttl_minutes` 默认 720，范围 5..43200；固定有效期、不滑动续期，Max-Age 与之对应。`max_sessions` 默认 64，范围 1..1024；满时淘汰最早创建的会话，访问不改变淘汰顺序。每次检查/创建会话清理过期记录；重启、退出登录、淘汰或过期后凭据失效。再次登录替换当前 cookie 对应会话。退出登录/淘汰立即断开相关 SSE；每次推送及保活前重验有效期，过期后不再发送事件，最迟下一次 15 秒保活关闭空闲流。页面读接口收到 401 后返回 `/` 登录入口。

登录失败按 socket 来源 IP 计数，忽略 X-Forwarded-For 等代理头。`login_attempts_per_min` 默认 10，范围 0..1000，0 关闭；达到失败上限后的请求返回 429，窗口为第一次失败起 60 秒。成功登录不清除当前窗口已累计的失败。来源表最多 1024 项，过期清理，满时淘汰最旧来源；代理后的浏览器共享代理 IP 的额度。此内存限流不承诺抵御分布式攻击。

有副作用的 login/logout/PUT 请求必须使用 `Content-Type: application/json`（允许 charset 参数），否则 415。有 Origin 时必须等于当前 HTTP Host 的同源 Origin，否则 403；不信任 Forwarded/X-Forwarded-*，不开放 CORS。无 Origin 的脚本登录仍须提供正确的 body token；脚本写策略需要会话 cookie 或可选的写凭据。退出登录按工单明确要求保持未登录 204：没有有效会话时仅清空客户端 cookie，没有服务器会话副作用。HTTPS 反向代理须在验证外部同源后把上游 Origin 与上游 HTTP Host 配成一致；不要任意放行外部 Origin。

写接口由登录会话授权，可选的写凭据仅供脚本调用；关闭编辑时 PUT 始终为 404。使用 SHA-256 定长摘要和 timingSafeEqual 比较凭据。

面板保留概览、端点、路由、过滤规则、实时日志和高级 YAML 六个页面，每三秒刷新状态，策略文本不自动覆盖未保存编辑。登录凭据输入已移到登录页，不再保存在 sessionStorage；面板显示登录状态和退出登录按钮。fetch 和 SSE 使用同源 cookie；保存策略直接用登录会话，不再需要单独输入写凭据。面板严格 CSP 保持第二批原值，动态文本使用 textContent、编辑区使用 value。无 CDN、框架、打包器或构建步骤。

## 策略写入与失败

请求 Content-Type 必须是 application/json，body 只能有 policies 字符串字段。字符串内容是直接的策略名称映射，不再包一层 policies：

```json
{"policies":"default_policy:\n  events:\n    default: deny\n  actions:\n    default: deny\n"}
```

策略名称必须与 routes 引用一致。处理顺序为：

1. 解析提交的 YAML，拒绝重复键、alias 和非映射。
2. 读取同一配置文件，使用 YAML Document API 替换 policies 节点，其余源文本与注释保留。
3. 调用 validateConfig 校验整份新文档，并拒绝非策略配置漂移。
4. 同目录独占创建临时文件，写入后 rename 原子替换。
5. 调用已有策略重载器，返回 `{ ok: true, reload: { ok, reason, time } }`。

校验与可预期文件系统失败返回 400 `{ ok: false, error }`，错误 Content-Type 返回 415；不暴露底层文件路径或 YAML 源片段。校验失败、临时写入失败及 rename 失败都保留原文件字节和内存策略；临时文件会清理。重载失败时用原始字节再次原子替换恢复文件，保持旧策略。保存过程无 await，不允许进程内请求、监听和信号回调交错进入事务。

原子替换要求目录可写。默认 Compose 的只读目录挂载不会被自动改成可写。操作系统崩溃、持续 I/O 故障或外部进程同时改文件，无法由单进程保证跨文件与内存的完全事务；若恢复本身失败，接口明确报出“策略重载及文件恢复失败”，不会谎报原文件未变。这一无法绝对满足的边界记录在 handoff/open-questions.md。本批没有持久化事务日志、多进程写锁或配置历史备份。

## SSE 与有界性

事件类型为 denied、session_open、session_close、transport_issue、reload。初始发送 `: connected` 注释帧，随后回放最近最多 50 条且受字节预算约束的后缀，然后持续推送；空缓冲也立即建立连接。每 15 秒发保活注释。断线重连会重新回放最近记录，不承诺断线期间完整历史、不使用 Last-Event-ID 恢复。

缓冲容量为 log_ring_size；只保留已列出的元数据字段，普通字符串最多 512 字符。消息正文默认不进入 SSE，只有 observability.expose_message_preview 为 true 时才携带遵循 log.message_preview_chars 的 preview（最多 4096 字符）。原有逐条拒绝审计日志的预览开关不变。

WebUI 最多 16 个 HTTP 连接，请求体和配置文件各最多 1 MiB。SSE 回放通常最多 32 KiB（单条大记录可占用更大的剩余预算），响应缓冲上限 64 KiB；写入返回背压或超出预算时立即断开，不累计发送队列。断开和服务停止清理订阅与保活计时器，前端日志 DOM 也按 log_ring_size 淘汰最旧记录。WebUI 关闭时缓冲容量为零。

## 端点、路由保存与重启

端点页保留上游/下游布局，编辑连接方式及对应的地址、环境变量名、账号或主体、重连/只读选项。connect 只显示 url，listen 只显示 host/port；上游不显示主体/只读，下游不显示账号。`token_env` 填环境变量名，例如 `ENDPOINT_TOKEN`，不是凭据值。环境变量需要由部署方预先注入；保存校验不会读取新变量的值，缺失凭据会导致重启后的启动失败。

路由页可增删路由、编辑 ID，并从端点与策略名称列表选择上游、下游和策略。至少保留一条路由，每个下游只能绑定一条路由，全部端点必须被路由引用；服务端 `validateConfig` 是唯一校验权威。端点页与路由页共用一份草稿和顶部吸附操作条，三秒状态轮询不会覆盖草稿。关闭编辑时表单只读。没有登录会话的回环/Bearer 面板仍显示运行状态，但配置编辑不可用；启用读取凭据并登录后才能编辑。

`GET /api/config` 从磁盘读取并全量校验，返回：

```json
{
  "endpoints": {
    "up": {"id":"up","side":"upstream","connection":"connect","protocol":"onebot_v11","url":"ws://example.invalid","token_env":"UPSTREAM_TOKEN","expected_self_id":"ACCOUNT_A","reconnect":true,"used":true},
    "down": {"id":"down","side":"downstream","connection":"listen","protocol":"onebot_v11","host":"127.0.0.1","port":3010,"token_env":"DOWNSTREAM_TOKEN","principal":"APP_A","readonly":false,"reconnect":true,"used":true}
  },
  "routes": [{"id":"routeA","upstream":"up","downstream":"down","policy":"main"}],
  "policies": ["main"]
}
```

端点是 ID 到定义的映射；`used` 表示文件中的路由是否引用该端点。只返回当前连接方式与 side 对应的字段，不返回环境变量取值、TLS 字段、文件路径、策略内容或其它配置段。文件内容无效时返回 400，不回显无效文件。这里读的是已保存配置，`/api/state` 仍代表运行实例，保存未重启时两者可能不同。

`PUT /api/config` 的 JSON 体恰好包含三个必填字段：

```json
{"endpoints":{"up":{"side":"upstream","connection":"connect","protocol":"onebot_v11","url":"ws://example.invalid","token_env":"UPSTREAM_TOKEN","expected_self_id":"ACCOUNT_A","reconnect":true},"down":{"side":"downstream","connection":"listen","protocol":"onebot_v11","host":"127.0.0.1","port":3010,"token_env":"DOWNSTREAM_TOKEN","principal":"APP_A","readonly":false,"reconnect":true}},"routes":[{"id":"routeA","upstream":"up","downstream":"down","policy":"main"}],"restart":false}
```

请求端点定义不包含 GET 的 `id`/`used` 展示字段。先把 endpoints/routes 合并到当前磁盘文档，调用完整 `validateConfig`；通过后用 YAML Document 的 range 切片，只替换两个顶层值，同目录临时文件 rename 原子落盘。两个值之外的注释、换行、缩进与配置字节原样保留。任何校验拒绝和临时文件写入/rename 失败都不改变原文件，不改变运行内存；不热重载端点/路由。

保存成功返回 200 `{"ok":true,"restart":false,"restart_required":true,"message":"改动已保存，端点与路由重启后生效"}`。保存并重启返回 202 `{"ok":true,"restart":true,"restart_required":true,"message":"已保存，正在重启；端点与路由改动重启后生效"}`。仅在响应 finish 后延迟 200 ms 调用注入的钩子；生产 CLI 先复用幂等 `stop()` 关闭监听、会话、SSE、网关和观测服务，再退出 0，由容器 `restart: unless-stopped` 启动新实例。直接在宿主运行 CLI 时退出后需要外部进程管理器或手动启动。

WebUI 的重启钩子默认 undefined，嵌入式 `startGateway` 也默认不注入；此时 `restart:true` 返回 400，文件不动，可改用保存后手动重启。重启已安排时重复配置 PUT 返回 400，避免重复调用或覆盖待生效文件。测试只注入记录钩子，绝不退出测试进程。本批不新增、修改或移除 TLS 配置；GET 不展示 TLS，已有 TLS 字段未原样提交的写入会被拒绝，避免面板静默删除证书配置。

新接口 GET/PUT 均要求登录会话，无会话（包括只带 Bearer）返回 401。PUT 在 `allow_policy_edit:false` 时优先返回 404，文件不变；GET 仍可只读。GET/PUT 有 Origin 时均严格检查同源，不同源返回 403。PUT 必须 `application/json`，否则 415；不支持的方法返回 405，开启编辑时 Allow 为 GET, PUT。请求体/配置文件最多 1 MiB；坏 JSON、形状、未知键、字段值、引用或原子写入失败返回 400 `{ok:false,error}`，页面显示服务端原因。

操作顺序：登录 → 编辑端点及路由 → 点击「保存」或「保存并重启」。提交中禁用表单与按钮。「保存」后仍用旧端点/路由，必须随后重启；未重启前策略保存或文件监听仍会按原有规则拒绝结构漂移，保留旧策略，不能用策略重载代替重启。需要先完成策略编辑再保存端点，或者重启后再编辑策略。

「保存并重启」响应成功后页面显示“网关正在重启…”，停止普通状态轮询和 SSE 重连，单独轮询实例。新实例不保留旧内存会话；发现旧会话 401（或实例启动时间已改变）后显示“网关已重启，请重新登录”，停留约 1.8 秒供用户阅读，再进入 `/` 登录页。重新登录后重建 SSE；重启会断开旧 SSE 且丢弃旧内存日志环，不承诺恢复停机期间日志。实例未回来时持续显示等待，不假报成功。

## 范围

可以编辑 policies、现有端点的连接配置与路由；其它运行参数不在面板编辑范围。没有端点增删界面、用户体系、历史指标、导出和持久化日志。本批不接真实协议端，协议行为仍以模拟端测试覆盖。HTTP 服务自身不提供 TLS，跨机部署的加密与访问限制由部署方配置。
