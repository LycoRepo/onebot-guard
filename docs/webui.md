# WebUI 运维接口

WebUI 默认关闭；启用后默认在回环地址的 3012 端口监听。它直接读取网关进程内状态，与 3011 上的只读观测服务独立。上游未连接时页面仍可加载，显示端点离线与网关未就绪；`/api/state` 返回 200，原有 `/health` 未健康时仍返回 503。

## 接口

所有响应（包括错误和静态资源）均为 `Cache-Control: no-store`。不支持的方法返回 405 和 Allow，未知 GET 路径返回 404。未开启编辑时 PUT /api/policies 始终为 404。

| 方法 | 路径 | 内容与认证 |
|---|---|---|
| GET | `/` | 无运行数据的 HTML 外壳，公开读取 |
| GET | `/assets/app.js`、`/assets/style.css` | 磁盘上的原生资源，公开读取；仅这两个固定路径 |
| GET | `/api/state` | 健康、启动/最后事件时间、端点、路由两端就绪、待回包、状态表规模、计数、规则命中、传输问题、策略名称、最近重载；读认证 |
| GET | `/api/policies` | `{ yaml, parsed, reload, allow_policy_edit }`；yaml 是文件中 policies 值的 YAML 表示，parsed 是对应映射；读认证 |
| PUT | `/api/policies` | 仅编辑开启时存在；始终要求写认证 |
| GET | `/api/logs` | SSE 最近事件回放与实时推送；读认证 |

`reload` 在尚未重载时为 null，其后为 `{ ok, reason, time }`；包含文件监听、信号和页面保存触发的结果。策略 GET 读的是文件内容，运行策略名来自重载器；如果宿主手工修改了无效配置，旧内存策略继续运行，错误原因显示在重载结果中。策略 GET 也会先全量校验当前文件，无效时返回 400，避免回显外部误写的明文凭据字段。

## 认证与页面

配置了 `read_token_env` 时，三个 GET API 都要求 `Authorization: Bearer <READ_TOKEN>`；不配置则仅依赖回环绑定。非回环缺少读取凭据声明时配置校验失败。写接口要求 `Authorization: Bearer <WRITE_TOKEN>`，与读凭据独立。缺失、错误、用途不符的 token 返回 401；token 环境变量为空时启动失败。摘要长度固定，使用 Node crypto 的 timingSafeEqual 比较，不记录或回显 token 值。

静态外壳不包含配置或运行信息，因此允许未认证浏览器加载并输入凭据。这是对“读接口认证”与“页面内输入 token”并存要求的保守解释，已记录在交接待确认项。API 不使用 cookie、URL token 或跨域授权；无 CORS 放行。页面使用 fetch 读取 SSE，以便携带 Bearer 头。所有服务内容采用同源 CSP，动态文本用 textContent 写入，YAML 编辑区用 value，避免把日志或策略作为 HTML 执行。

页面包含总览、端点卡片、路由表、状态表规模、规则命中、传输问题、日志和策略区。每三秒刷新状态；策略文本只在主动加载时刷新，避免覆盖未保存编辑。只读模式隐藏保存控件；保存失败在编辑框旁显示后端具体原因。凭据输入用 password，读取凭据只存本标签页会话，写凭据不持久保存。清除按钮删除会话凭据。界面支持键盘和系统深浅色，不使用 CDN、框架、打包器或构建步骤。

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
