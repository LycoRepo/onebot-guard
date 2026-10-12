# onebot-guard (Work in progress)

> 状态：**第二批已实现，含运维 WebUI、策略编辑与协议模拟端测试**。真实协议端兼容性与生产运行验证仍需部署方完成。

在 OneBot v11 协议实现端（QQ 侧）与机器人应用之间提供一层**可配置的策略网关**：
事件过滤与可见范围、Action 授权与资源范围、限流与去重、请求关联（`echo` 隔离）与运行观测。

## 定位

- **不绑定具体框架**：协议端可以是任意 OneBot v11 实现，下游可以是任意 OneBot v11 应用。
- **配置驱动**：谁能看到什么消息、谁能执行什么动作，全部写在配置里，可审计、可展开。
- **安全默认**：默认拒绝、拒绝优先于允许、未声明的能力默认关闭、凭据只从环境变量读取。
- **只绑回环**：默认只监听 `127.0.0.1`；跨机请走加密隧道或受限私有网络，不暴露裸 OneBot 端口。
- **有界**：缓冲、待回包请求、正则输入都有上限，慢下游不会把内存拖垮。

## 当前范围（第二批）

包含：单条链路的真实可用性、配置校验与加载、事件授权、Action 授权（含参数与资源范围）、
`echo` 请求关联与隔离、去重与限流、有界缓冲、故障语义、策略热重载、日志与 `/health`、`/stats`，
独立端口的运维 WebUI（状态面板、SSE 元数据日志、可选策略编辑），以及随批交付的单元测试与协议模拟端集成测试。
WebUI 默认关闭；编辑也默认关闭。开启后仅能修改 `policies`，经全量配置校验、同目录原子替换和策略热重载生效。

暂不包含：完整配置编辑、重启按钮、用户体系、历史指标持久化、主动会话调度、嵌入式 SDK、多副本部署、兼容性矩阵、完整示例库。

## 开发

```bash
npm ci                  # 安装依赖（Node >= 24）
cp config/gateway.example.yaml config/gateway.yaml   # 真实配置，已被 .gitignore 忽略
npm run typecheck       # tsc --noEmit
npm test                # node --test
docker compose up -d --build
```

Node 24 原生执行 TypeScript（类型剥离），因此运行不需要构建产物；**类型检查是独立门禁**，
必须在 CI 与本地都通过。

## 文档

- [架构](docs/architecture.md)
- [配置与运行](docs/configuration.md)
- [WebUI 接口与安全边界](docs/webui.md)
- [权限](docs/permissions.md)
- [故障与观测](docs/failure-semantics.md)

Compose 示例使用 Linux host 网络，监听地址由配置固定到回环；构建与启动前需设置环境变量凭据。
Windows 原生运行通过配置文件变更触发热重载；SIGHUP 在 Unix 上可用。

## 许可

MIT
