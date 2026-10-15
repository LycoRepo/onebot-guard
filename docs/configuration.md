# 配置与运行

使用 Node.js 24 和 npm，复制 `config/gateway.example.yaml` 为被忽略的 `config/gateway.yaml`，替换 ACCOUNT_A、GROUP_ALLOWED、USER_ALLOWED 等占位符。ID 必须写成字符串。示例能真实加载，但其中显式允许的 `get_msg` 和 reply 段仍按当前限制拒绝，具体见 [权限](permissions.md)。

设置 `UPSTREAM_TOKEN` 与 `GATEWAY_TOKEN` 环境变量后执行 `npm start`。可用 `GATEWAY_CONFIG` 指定配置文件；默认路径为 `config/gateway.yaml`。凭据只通过 `token_env` 指向的环境变量读取，不能放在 YAML、URL 或示例命令中。日志级别由 `log.level` 配置。

| side | connection（网关视角） | 谁拨号 | OneBot 术语 |
|---|---|---|---|
| upstream | connect | 网关 → 协议端 | 正向 WebSocket |
| upstream | listen | 协议端 → 网关 | 反向 WebSocket |
| downstream | listen | 应用 → 网关 | 正向 WebSocket |
| downstream | connect | 网关 → 应用 | 反向 WebSocket |

`connect` 只接受无凭据、无查询参数、无 fragment 的 `ws://` 或 `wss://` URL。WSS 使用系统信任库并验证证书。`listen` 使用 host/port；可通过 `tls.cert_env` 和 `tls.key_env` 指向包含 PEM 内容的环境变量启用 TLS。当前没有自定义 CA、证书文件路径或关闭证书校验的开关。

所有监听连接要求 `Authorization: Bearer …`。上游反向连接还要求 `X-Client-Role: Universal` 和匹配 `expected_self_id` 的 `X-Self-ID`。上游正向连接仅执行一次固定的 `get_login_info` 账号验证，不探测其他 API；验证完成前不转发业务。下游身份由已鉴权端点的 `principal` 固定，拨号到应用时携带 Universal 和固定账号身份头。

| runtime 配置 | 默认值 | 达到上限后的行为 |
|---|---:|---|
| max_connections | 64 | 配置端点数超过时启动拒绝；每个端点最多一个会话 |
| max_message_bytes | 262144 | 入站超大报文断开；出站超大报文断开 |
| max_buffer_bytes_per_connection | 1048576 | 按 on_buffer_full 丢事件或断开 |
| on_buffer_full | drop_events | 普通事件可丢；控制报文不能丢，超限断开 |
| max_pending_requests | 64 | 每条 route 的待回包请求超限时明确失败 |
| request_timeout_ms | 30000 | 清理 echo，返回结果未知 |
| max_regex_input_chars | 4096 | 内容匹配超限按 on_error 处理，不截断后放行 |
| max_state_entries | 4096 | 去重淘汰最旧键；各限流表拒绝新键 |
| ping_interval_ms | 30000 | 下一轮仍未收到 pong 时断开 |
| handshake_timeout_ms | 10000 | WS 握手或账号探测超时失败 |
| reconnect.initial_ms / max_ms | 1000 / 30000 | 指数退避封顶 |
| reconnect.jitter | true | 退避时在半个窗口至完整窗口间随机 |

配置文件最大 1 MiB，单个规则数组最多 1024 项。未知字段、重复 YAML 键、YAML alias、非法引用和不安全正则报错；默认拒绝不能改成默认允许。限额值 0 表示该维度关闭，窗口为从首次使用开始的 60 秒。正则支持字符类与最多一个重复量词，禁止分组、分支、反向引用、Unicode 属性转义及 `?` 量词。

热重载读取同一个配置文件。`reload.policy_watch: true` 监听其所在目录，可识别原子替换，按 `debounce_ms` 防抖；Unix 还可发送 `SIGHUP`，例如 `docker compose kill -s HUP gateway`。Windows 使用文件变更入口。只允许修改 policies（含事件规则、Action 授权、limits）；端点、账号、凭据变量名、端口、路径、运行上限等必须重启。任意校验失败都保留整份旧策略。凭据环境变量仅启动时读取。

Compose 示例使用 Linux host 网络，实际端口由配置中的 `host: 127.0.0.1` 绑定，不发布公网端口。这样可以连接宿主回环上的协议端，同时让 `/health`、`/stats` 始终保持回环监听。该部署示例面向 Linux Docker Engine；Docker Desktop 的 host 网络能力需要另行启用，不承诺跨平台部署兼容。容器以 node 用户运行，内存限制 256 MiB，日志滚动。配置目录只读挂载，支持宿主原子替换文件后由目录监听触发重载；真实配置不复制到镜像。

```bash
npm ci
npm run typecheck
npm test
docker compose build
docker compose up -d
```

Compose 在解析时要求上述两个环境变量已设置，构建验证可以注入临时随机值；不需配置真实账号或建立真实连接。

## WebUI

`webui` 是独立的运维 HTTP 服务，与回环只读的 `observability` 使用不同端口。省略整个块时不开监听；所有未知键仍报错，凭据只接受环境变量名。

| webui 配置 | 默认值 | 约束 |
|---|---|---|
| enabled | false | 关闭时不监听、不保留 WebUI 事件 |
| host | 127.0.0.1 | 允许 ::1；其它地址必须声明 read_token_env |
| port | 3012 | 0..65535；0 用于临时端口测试，部署时使用独立端口 |
| read_token_env | null | 配置后面板、资源和读 API 要求有效会话或读取 Bearer；非回环必填 |
| allow_policy_edit | false | 关闭时 PUT /api/policies 返回 404 |
| write_token_env | null | 编辑开启时必填；写操作始终使用独立的写凭据 |
| log_ring_size | 200 | 1..10000 条，满时淘汰最旧记录 |
| session_ttl_minutes | 720 | 5..43200 分钟；固定有效期，不滑动续期 |
| max_sessions | 64 | 1..1024；满时淘汰最早创建的会话 |
| login_attempts_per_min | 10 | 0..1000；每来源 IP 每分钟失败上限，0 关闭 |

启用的服务所需环境变量未设置或为空，启动失败；不降级为免认证。建议读写指向不同环境变量并设置不同值。应用比较的是 SHA-256 定长摘要，使用 `timingSafeEqual`。读 token 不能替代写 token，写请求不叠加读 token 检查。`observability.host` 仍只允许 `127.0.0.1` 和 `::1`。

访问 WebUI 的 `/`，未认证时只显示独立登录页；读取 token 换取内存会话后才加载面板 HTML/CSS/JS、状态、策略和 SSE。读 token 不再存入 sessionStorage；写 token 仍独立走 Bearer，保留在当前标签页 sessionStorage，登出时清除。不把凭据放进 URL。新会话选项省略时在会话模块应用默认值，不向旧版规范化配置对象添加键，保留原有的精确默认值契约。详见 [接口与安全边界](webui.md)。

保存仅接受策略映射；先解析 YAML，读取当前文件并用 Document API 替换 policies，再对完整文档调用 `validateConfig()`（含 routes 引用），通过后同目录临时文件写入并 rename 原子替换，最后主动调用策略重载。解析、校验、写入或 rename 失败不会改变原文件；重载失败时恢复原文件。非策略段与注释保留，非策略配置漂移则拒绝保存并提示重启。正文与配置文件均限制为 1 MiB。

Compose 默认的 `./config:/app/config:ro` 保持只读，能使用观测面板但不能通过页面保存策略。需要编辑时，部署方须为配置目录提供写权限（原子 rename 要求目录可写，不能只挂载单个文件），并向容器显式注入选择的 WebUI 凭据环境变量；本批不自动修改部署挂载和外部访问边界。跨机访问使用加密隧道或有 TLS 的受限反向代理；本批 WebUI 自身仅提供 HTTP。
