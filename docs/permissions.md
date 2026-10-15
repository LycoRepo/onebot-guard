# 事件与 Action 权限

事件先检查 `events.deny.scopes`，再检查 `events.allow`，拒绝优先，未声明默认拒绝。范围字段可组合 post_type、message_type、meta_event_type、notice_type、request_type、group_ids、user_ids。未知事件必须显式授权 post_type，允许后保留未知字段。

只有普通消息进入内容规则：指定关键词、受限正则、消息段类型、自己发出的消息和显式列出的其他机器人。其他机器人默认不整体屏蔽。心跳、生命周期、通知和请求不执行消息内容匹配；心跳与生命周期也不消耗消息限额或去重，但仍须显式授权。Action 回包走关联路径，不受事件过滤或入站消息限额影响。

授权和账号验证异常始终拒绝。`on_error: skip` 仅适用于内容匹配内部异常及内容输入上限，不能跳过范围、身份或 Action 权限。消息字符串包含 CQ 码且启用段类型过滤时保守拒绝；建议上游发送消息段数组。

每个 Action 必须通过固定端点主体、route、已验证账号、名称、目标、参数、消息段和发送额度检查。顶层只能包含 action、params、echo；额外账号字段不能切换身份。下游 `readonly: true` 拒绝全部发送。

| 支持的 Action | 检查 |
|---|---|
| get_login_info / get_version_info / get_status | 明确 allow，且 params 为空 |
| get_group_list | 明确 allow，params 为空；回包仅保留无需发送者条件即可看见消息的群，涉及拒绝范围的群移除 |
| send_group_msg | group_id 明确在对应规则 group_ids 内 |
| send_private_msg | user_id 明确在对应规则 user_ids 内 |
| send_msg | 明确 message_type=group/private；执行同样目标检查，拒绝同时传群与用户 |

消息段还须列在 `segment_types` 中。text 只接受字符串 text；at 只接受 qq，并要求 user_ids 授权该用户；`@全体` 需单独开启 `allow_at_all`。image/record/video 只接受 file，远程 HTTP(S) 媒体需 `allow_remote_media`，本地路径或无主机的 file URL 需 `allow_local_files`，两者默认关闭；媒体 URL 内不能有用户名或密码。网络文件路径、未知 URI scheme、base64 和首尾空白的文件值一律拒绝，不能用本地文件开关绕开远程媒体开关。打开媒体开关意味着信任协议端的网络或文件访问权限。发送 CQ 字符串要求 `auto_escape: true`，否则拒绝；这个开关让协议端将其视为普通文本。

没有可信的消息归属索引，因此 `get_msg`、历史读取与 reply 引用统一拒绝，即使配置显式 allow。合并转发、卡片、未实现段类型、别名、`_async`、`_rate_limited` 等变体、管理接口及实现端扩展同样拒绝。显式 allow 只能开放已实现的能力，不能赋予未知接口安全语义。
