# 2026-09-21 手机 WebSocket 默认准入修复

## 1. 变更摘要

测试服未配置 `REMOTE_CONTROL_RESOURCE_DEPLOYMENT_EVIDENCE_FILE` 时，原服务端把“没有集群发布证明”当作“禁止新手机连接”，导致 `/api/remote/v1/ws` 持续返回429。手机不能订阅目录事件，表现为桌面任务在手机侧栏不自动出现、手动刷新可见。

修复将普通连接准入与历史连接导入分开：

| 部署证明配置 | 新手机连接 | 历史连接导入 |
| --- | --- | --- |
| 未配置、空字符串或全空白 | 按Redis账号配额正常预留、确认 | 不执行；证明快照仍为空 |
| 已配置且有效 | 按Redis账号配额正常预留、确认 | 仅按真实证明及原切换窗口执行 |
| 已配置但未加载、缺失、无效、过期或刷新陈旧 | 拒绝需要新逻辑名额的连接，沿用429信封 | 不执行 |

既有槽位换票/续租规则保持。全账号默认8个mobile逻辑槽位、15秒预留、90秒活动及恢复租约、代次校验、请求限流、票据鉴权都保留。Redis异常仍503，不放行无法计数的连接。未配置文件不代表集群已经验收，也不虚构历史连接清单。

## 2. 接口、认证和响应

协议无变更，客户端继续使用原接口；不新增必填参数、能力开关或响应字段。

```http
POST /api/remote/v1/connection-tickets HTTP/1.1
Host: lobsterai-server-test.youdao.com
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <mobileDeviceId>.<deviceKey>
Content-Type: application/json

{"protocolVersion":1}
```

已协商 `projectionVersion` 的客户端继续提交原值，不因本修复降级。成功响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "wsUrl": "wss://lobsterai-server-test.youdao.com/api/remote/v1/ws?ticket=<one-time-ticket>",
    "expiresAt": "2026-09-21T09:01:00Z",
    "protocolVersion": 1
  }
}
```

使用返回的 `wsUrl` 建立连接，升级成功为HTTP101；随后按原协议接收 `hello`、订阅 `catalog`，由 `catalog.changed` 触发目录刷新。票据仍60秒且一次性消费，失败重连重新申请。登录Cookie不能替代原JWT和设备凭据要求。

实际超额仍使用HTTP429、`code=47011`、`reason=RATE_LIMITED`、`limitKind=mobile_connections`、`retryable=true`、`retryAfterMs=30000`。握手响应体读取受客户端网络库能力约束，本修复不依赖iOS新增解析代码。

## 3. 客户端行动项

- iOS、Electron无需新增协议代码或同步升级；本次未修改客户端代码。
- 服务端升级后，现有App自动重连即可重新尝试订阅；若App在后台或未继续重连，回到前台再连接。
- 目录恢复应核对 `hello → subscribed(catalog) → catalog.changed → GET /sessions`，并确认首页侧栏出现新任务。HTTP101本身不能证明目录刷新已完成。
- 保留当前任务和草稿，不因实时连接恢复而重新提交业务命令。

## 4. 配置和发布

`test`、`prod`均继承公共默认策略：`REMOTE_RESOURCE_PROTECTION_ENABLED=true`，`REMOTE_RESOURCE_MOBILE_CONNECTIONS=8`，部署证明路径默认空。当前未配置文件的测试服无需额外挂载文件或增加参数。

发布服务端新包并完成所有服务节点的滚动替换，无新增SQL，无需清理Redis。旧节点在空路径下仍可能拒绝新连接，滚动过程中可能暂时出现429，全部更新后再验收。桌面本地任务保持原运行行为。

所有节点必须理解并维护相同账号预算，才能声明全局连接上限。若混有更早不维护账号预算的版本，须先完成兼容升级和存量核对；需要历史宽限迁移时，仍使用真实受控证明和清单。不能通过关闭资源保护、清空连接key或虚构证明修复本问题。

服务端按加载状态变化输出 `[RemoteMobileAdmission] Deployment evidence state=...`：`not_configured`表示普通配额模式，`ready`表示有效证明，`evidence_unavailable`表示显式证明不可用。不记录文件内容、路径或凭据；该加载日志不替代握手时的时效检查。

## 5. 验证范围

本地按仓库约定只编译主代码与测试源码，不执行服务端测试、不连接真实Redis或MySQL。回归测试源码覆盖默认准入策略与真实证明状态分离、显式无效证明、Redis拒绝/故障及原有错误信封。Mockito边界校验不等同于Redis Lua并发、真实WebSocket握手或手机端到端验收；后者需部署后核对。
