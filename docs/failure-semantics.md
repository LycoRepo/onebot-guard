# 故障与观测

| 场景 | 行为 |
|---|---|
| 鉴权、主体、账号或范围错误 | 拒绝；账号事件不匹配时断开上游 |
| 未验证或离线的上游收到 Action | failed，retcode=1503，upstream_unavailable |
| 普通授权拒绝 | failed，retcode=1403，附规则原因；恢复原 echo |
| 非法 Action | failed，retcode=1400；无法解析 JSON 则断开 |
| 配额或待回包上限 | failed，retcode=1429 |
| Action 发出后断线、超时、路由关闭、进程退出 | 清除映射；尚连接的原调用者收到 retcode=1504 的结果未知；不自动重发 |
| 回包可见性校验失败 | retcode=1502，response_visibility_check_failed |
| 迟到、重复或未知 echo 的回包 | 丢弃并计数，不广播 |
| 下游离线事件 | 丢弃并计数，不缓存或补发 |
| 缓冲超限 | drop_events 丢普通事件；控制报文超限断开；disconnect_connection 全部断开 |
| 超大报文或二进制 WS 报文 | 断开并计数 |
| 无效热重载 | 旧策略完整保留，输出错误；连接继续使用旧策略 |
| 重启 | echo、去重、配额、计数全部清空 |

“结果未知”表示动作可能已被协议端执行。调用者需要自行判断，盲目重试可能产生重复副作用。WS 写入成功也不等于上游已执行，异步写失败同样断开并按结果未知处理。SIGINT/SIGTERM 关闭文件监听、定时器、连接和 HTTP 监听；SIGHUP 只重载策略。

日志默认不含正文。每条拒绝独立一行 JSON，带 route、direction、rule、reason、generation 和群/私聊 scope；即使一般日志级别设为 error，拒绝审计仍输出。连接日志包含网关方向和 OneBot 正向/反向术语。`pretty` 模式给一般日志增加可读前缀，拒绝审计仍是纯 JSON。凭据与报文整体不会写入日志。

`log.message_preview_chars > 0` 才启用截断正文预览。`observability.expose_message_preview: true` 还需该字符数大于 0 才让 `/stats` 返回最后正文预览。默认均不公开正文。

`GET /health` 返回各端点 connected/ready、缓冲字节、重连次数以及各 route ready 和 pending_requests；所有 route 上下游已就绪才返回 200，任一离线、未验证或关闭返回 503。该接口用于健康检查；Docker 的 unhealthy 标记自身不会自动重启进程，`restart: unless-stopped` 针对进程退出。

`GET /stats` 还返回放行/拒绝总数、按 route 和 rule 的命中数、传输问题计数、最后一条事件时间，以及 echo、身份探测、去重、限流表大小。计数以 route 的处理决策为单位；同一事件发给两条 route 会有两次决策，Action 发出与回包投递也分别计数。最后事件时间在验证上游账号后的事件到达时更新（包括后来被拒绝的事件）。应用队列恒为 0，WS 缓冲单独统计。接口只有 GET，其他方法 405，未知路径 404，绑定地址只能是 127.0.0.1 或 ::1。

限流表和去重表分别有 `max_state_entries` 上限；echo 全局最多 route 数 × max_pending_requests，身份探测最多上游端点数。WS 在写入前检查消息字节数与 bufferedAmount，并保守预留最大 14 字节的帧头和掩码；每次检查不突破配置上限。这不是进程 RSS 上限，TCP 内核缓冲、解析对象和运行时仍会占内存，容器内存限制负责最终边界。
