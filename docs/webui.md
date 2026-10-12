# WebUI 运维接口

WebUI 默认关闭；启用后默认在回环地址的 3012 端口监听。它直接读取网关进程内状态，与 3011 上的只读观测服务独立。上游未连接时页面仍可加载，显示端点离线与网关未就绪；`/api/state` 返回 200，原有 `/health` 未健康时仍返回 503。

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
| GET | `/api/logs` | SSE 最近事件回放与实时推送；读认证 |

`reload` 在尚未重载时为 null，其后为 `{ ok, reason, time }`；包含文件监听、信号和页面保存触发的结果。策略 GET 读的是文件内容，运行策略名来自重载器；如果宿主手工修改了无效配置，旧内存策略继续运行，错误原因显示在重载结果中。策略 GET 也会先全量校验当前文件，无效时返回 400，避免回显外部误写的明文凭据字段。

## 认证与页面

配置了 `read_token_env` 时，未认证浏览器只拿到无面板结构、无运行数据的独立登录页。输入读取 token 后，以 JSON 提交到 `/api/login`；成功设置 cookie 并重新进入 `/`。静态外壳现在也受保护：面板 HTML、两个资源和全部读 API 共用读认证，先检查有效会话，再检查 `Authorization: Bearer <READ_TOKEN>`。脚本可以继续只带读取 Bearer；伪造、过期或重复的会话 cookie 不构成认证。缺失/错误/用途不符的登录 token 均为相同的 401，不记录或回显 token。

按第三批澄清，登录页使用一个最小内联脚本，只负责 JSON 登录、显示错误和成功后 `location.replace('/')`。它不加载 `/assets/*` 或任何外部资源。服务端对实际返回的脚本和样式文本在运行时分别计算 SHA-256，放入该响应的 CSP hash 白名单；先规范化 HTML 换行，避免 Windows 换行与浏览器解析结果不同。不使用 unsafe-inline 或 unsafe-eval；面板页 CSP 保持第二批原值。

cookie 格式为 `guard_session=<随机 ID>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<秒数>`。**不设置 Secure**：当前部署是明文 HTTP，加上后浏览器不会回传 cookie，页面无法使用。HTTP 上 cookie 也以明文传输，建议部署在 HTTPS 反向代理或加密隧道后面；本服务不终结 TLS，也不增加 HSTS。HttpOnly 阻止脚本读取 cookie，SameSite=Strict 限制跨站携带。ID 使用 `node:crypto` 生成 32 字节随机数，与 token 及其摘要无关；不写入磁盘、日志或浏览器存储。

会话仅保存在当前进程的有界 Map。`session_ttl_minutes` 默认 720，范围 5..43200；固定有效期、不滑动续期，Max-Age 与之对应。`max_sessions` 默认 64，范围 1..1024；满时淘汰最早创建的会话，访问不改变淘汰顺序。每次检查/创建会话清理过期记录；重启、登出、淘汰或过期后凭据失效。再次登录替换当前 cookie 对应会话。登出/淘汰立即断开相关 SSE；每次推送及保活前重验有效期，过期后不再发送事件，最迟下一次 15 秒保活关闭空闲流。页面读接口收到 401 后返回 `/` 登录入口。

登录失败按 socket 来源 IP 计数，忽略 X-Forwarded-For 等代理头。`login_attempts_per_min` 默认 10，范围 0..1000，0 关闭；达到失败上限后的请求返回 429，窗口为第一次失败起 60 秒。成功登录不清除当前窗口已累计的失败。来源表最多 1024 项，过期清理，满时淘汰最旧来源；代理后的浏览器共享代理 IP 的额度。此内存限流不承诺抵御分布式攻击。

有副作用的 login/logout/PUT 请求必须使用 `Content-Type: application/json`（允许 charset 参数），否则 415。有 Origin 时必须等于当前 HTTP Host 的同源 Origin，否则 403；不信任 Forwarded/X-Forwarded-*，不开放 CORS。无 Origin 的脚本登录仍须提供正确的 body token，写入仍须提供写 Bearer。登出按工单明确要求保持未登录 204：没有有效会话时仅清空客户端 cookie，没有服务器会话副作用。HTTPS 反向代理须在验证外部同源后把上游 Origin 与上游 HTTP Host 配成一致；不要任意放行外部 Origin。

未声明 `read_token_env` 时保持回环边界模式，登录端点为 404，面板和读取无需会话；非回环缺少该声明仍校验失败。已声明但环境变量为空时启动失败，不降级为免认证。写接口始终独立要求 `Authorization: Bearer <WRITE_TOKEN>`，cookie 不能替代它；关闭编辑时 PUT 始终为 404。使用 SHA-256 定长摘要和 timingSafeEqual 比较凭据。

面板保留总览、端点、路由、状态表、规则命中、传输问题、日志和策略区，每三秒刷新状态，策略文本不自动覆盖未保存编辑。读取 token 输入已移到登录页，不再保存在 sessionStorage；面板显示登录状态和登出按钮。fetch 和 SSE 使用同源 cookie；写 token 使用 password 输入，只存当前标签页 sessionStorage，通过 Bearer 保存策略，登出清除。面板严格 CSP 保持第二批原值，动态文本使用 textContent、编辑区使用 value。无 CDN、框架、打包器或构建步骤。

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

## 范围

只编辑 policies；不能改端点、账号、端口、凭据变量名或其它运行参数，没有重启按钮、用户体系、历史指标、导出和持久化日志。本批不接真实协议端，协议行为仍以模拟端测试覆盖。HTTP 服务自身不提供 TLS，跨机部署的加密与访问限制由部署方配置。
