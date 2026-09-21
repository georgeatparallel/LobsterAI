# App WebSocket 连接限制：服务端集成指南（2026-09-21）

**变更摘要与适用项目：** lobsterai-server 已实现按账号＋空间默认3个App连接、超限HTTP设备管理、角色预算和回收；LobsterAI桌面沿用既有WS协议，iOS/未来Android需接入新超限管理界面。本次没有修改App或桌面源码，不涉及Portal/Admin必需变更，也没有MySQL DDL。

**服务端验证记录：** `./gradlew compileJava compileTestJava bootJar -x test --offline` 与主Lua `luac -p` 通过；按仓库约定未执行服务端测试。未部署、未执行真实Redis并发、四节点/真机/故障注入/压测，未配置网关/Grafana。下面的接口需在服务端实际发布、能力返回支持后使用。

本文描述本次服务端新增的 App 连接管理 HTTP 接口。App 的产品额度为每账号、每空间默认 3 个逻辑连接；桌面端独立计算 5 个。空间来自当前登录 JWT；同企业的不同用户各自计数。不要把页面当前条数当额度用量，或继续在 App 上显示跨空间合计 8 个。

**接入状态：服务端代码已提供接口；iOS 源码本次未修改，以下为 App 待接入内容。** 服务端新准入协议、Redis 与集群发布条件须同时满足才能使用。排空旧连接后可使用默认规则接入，迁移证据文件允许为空；如配置了证据文件，则必须是有效的 v2 证据。功能开关开启不能代替集群排空与实际发布核验。部署后应以 `/api/remote/v1/capabilities` 的实际响应判断能力。

本次未执行服务端测试、实际部署、多节点压测、网关/Grafana配置；没有新增 MySQL DDL。编译/静态检查不等于真机或集群验收。没有有效v2迁移证据而同账号仍有活跃v1占位时，会同时拦截新App和新桌面远控准入，App列表/断开暂不可用；桌面本地执行保持独立。

## 1. 能力发现、鉴权与兼容

`GET /api/remote/v1/capabilities` 保持原响应，新增可选内容：

```json
{
  "capabilities": ["mobile_connection_management_v1"],
  "mobileConnectionPolicy": {
    "limit": 3,
    "scope": "account_scope",
    "availability": "available",
    "managementAvailable": true,
    "retryAfterMs": null
  }
}
```

上例仅摘录 `data` 中相关字段。`capabilities` 包含该能力且 `managementAvailable=true` 时使用下列接口。旧服务端没有能力时显示通用超限提示及重试，不循环调用不存在的接口；旧客户端仍可使用原 WS、ticket 与桌面 v2 设备管理接口，其字段与语义不变。

三个管理接口均要求：

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <registeredDeviceId>.<deviceSecret>
```

设备凭据必须属于当前 JWT 的账号与空间，登记类型为 `mobile`，登记状态有效。Cookie、deviceId、connectionToken 不能单独鉴权；请求不接收 userId/scopeKey 作为授权依据。管理操作不要求调用 App 已获得 WS 名额，无名额时仍能通过 HTTP 查看与断开其他连接。所有新接口均返回 `Cache-Control: no-store`。请勿把设备凭据、token 或完整接口响应写入客户端日志。

服务端先按可信设备角色分配HTTP预算；capabilities/register等仅JWT调用归App侧，不能宣称所有桌面发出的请求都享有桌面预留。未知设备凭据的数据库验证另受账号2/s、burst10保护；有界60秒角色提示缓存只帮助在查库前选择预算，每次仍验证原身份/设备权限。冷缓存时合法新设备也可能需要退避，不将429当作凭据失效或退出登录。

App申请票据成功时可见可选 `admissionHint={limitScope,limit,current,counts,managementAvailable}`；保留原 `wsUrl/expiresAt/protocolVersion`。hint读取失败可以缺省，它不表示已占名额或列表一定可读，真实握手与管理HTTP仍做实时校验。

## 2. 获取占位设备

```http
GET /api/remote/v1/mobile-connections?limit=20&cursor=<optionalOpaqueCursor>
```

`limit` 为 1–50，默认 20；`cursor` 由上页 `nextCursor` 提供，不能自行拼接。它绑定调用设备、账号、空间与列表修订；设备集合/连接代次变化后可能失效，此时清空游标并刷新第一页。

服务端其他设备按稳定 deviceId 排序，避免心跳变化导致分页抖动；UI不直接展示该标识。当前设备独立置顶，App若另做展示排序须以完整已加载集合为准，不能改变或自行重算服务器游标。

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "limitScope": "account_scope",
    "limit": 3,
    "used": 3,
    "counts": {"active": 2, "pending": 0, "recovering": 1, "closing": 0},
    "presenceAvailable": true,
    "managementAvailable": true,
    "serverTime": "2026-09-21T08:00:00Z",
    "revision": "opaqueRevision",
    "currentDevice": {
      "deviceId": "self",
      "displayName": "此设备",
      "platform": "ios",
      "shortLabel": "6B1C2D",
      "appVersion": "1.0.0",
      "state": "not_connected",
      "connectionToken": null,
      "connectedAt": null,
      "lastHeartbeatAt": null,
      "recoveryUntil": null,
      "occupiesSlot": false,
      "canDisconnect": false
    },
    "items": [
      {
        "deviceId": "mobile_a",
        "displayName": "刘刚的 iPhone",
        "platform": "ios",
        "shortLabel": "8D3F62",
        "appVersion": "1.0.0",
        "state": "active",
        "connectionToken": "mct_opaque",
        "connectedAt": "2026-09-21T07:40:00Z",
        "lastHeartbeatAt": "2026-09-21T07:59:50Z",
        "recoveryUntil": null,
        "occupiesSlot": true,
        "canDisconnect": true
      }
    ],
    "nextCursor": "mc_opaque"
  }
}
```

示例仅保留一条 `items`，分页后总额度仍是 `used=3`。`currentDevice` 永远单独返回，不重复出现在 `items`；其真实占位纳入 `used/counts`。状态含义：

| state | UI 建议 | 占用名额 |
| --- | --- | --- |
| active | 在线 | 是 |
| pending | 正在连接 | 是 |
| recovering | 暂时断线，等待恢复 | 是 |
| closing | 正在断开 | 是，直至确认释放 |
| not_connected | 尚未连接 | 否，仅当前 App |

`displayName` 已剔除控制字符/双向排版字符并限制 64 个 Unicode 字符；缺失时为“移动设备”。App 按普通文本展示，仍不得渲染 HTML/Markdown。`shortLabel` 为稳定散列短编号，仅帮助区分同名实例，不能用于鉴权；不直接展示原始 deviceId 或 connectionToken。未知平台为 `unknown`，使用通用移动设备图标。App 列表不混入桌面、其他空间或其他账号；服务端不返回 IP、原始主机名、设备密钥。

UTC ISO-8601 时间由 App 本地化；未知时间为 null。恢复倒计时基于 `recoveryUntil` 与 `serverTime` 校正，不只依赖手机时钟。倒计时归零表示可刷新确认，不等于服务端已经释放。列表/身份元数据不完整、Redis 不可读时返回 503/47003，含 `presenceAvailable=false, used=null, counts=null`；保留旧显示并标注暂不可用，不显示虚假的 0/3。

## 3. 断开指定 App 连接

先让用户确认目标设备。**仅支持断开同账号、同空间内的其他有效 mobile 实例**，不能自断、不能操作桌面、不能清理任务或退出目标账号。

```http
POST /api/remote/v1/mobile-connections/mobile_a/disconnect
Content-Type: application/json
```

```json
{
  "requestId": "69d2fbe1-76a5-4c9a-a4e9-f81d4e52ac7d",
  "expectedConnectionToken": "mct_opaque"
}
```

只允许以上两个字段，JSON 请求最大 4 KiB。requestId 为 UUID；expectedConnectionToken 必须原样来自目标列表行。它是本管理协议的代次标识，不是旧 WS 的 connectionGeneration、设备凭据或 connectionVersion。

用户确认后固定保存 requestId、目标 deviceId、expectedConnectionToken；网络超时重试必须复用原请求。相同 requestId 同内容重放回执，不刷新冷却；相同 requestId 内容不同返回 409/47122。若目标已换代返回 409/47120，刷新列表并由用户重新选择，不能自动改用新 token 再断一次。

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "requestId": "69d2fbe1-76a5-4c9a-a4e9-f81d4e52ac7d",
    "deviceId": "mobile_a",
    "status": "closing",
    "slotReleased": false,
    "pollAfterMs": 2000,
    "targetRetryNotBefore": "2026-09-21T08:00:30Z"
  }
}
```

HTTP 200 仅表示受理/回执重放。`closing` 是撤权关闭进行中；**仅 `status=released && slotReleased=true` 才表明本操作对应占位已确认释放**。回执状态由服务端确认，App 不根据 HTTP 成功或倒计时自行改为成功。

目标收到原 WS 关闭码 4409 且 reason=`mobile_connection_disconnected` 后应暂停自动重连，并显示“连接已在其他设备上断开”，等待用户主动恢复；其他4409保留通用安全暂停，不能全部归因为用户操作。服务端同时执行短暂冷却，默认 30 秒。冷却到期也不允许绕过仍在进行的关闭。断开只影响目标 App 实时通道，桌面任务继续执行。确认释放后申请方自动尝试一次建立连接，但不保证已为自己预留名额；若其他设备先连接，仍按真实超限处理。

## 4. 查询操作回执

```http
GET /api/remote/v1/mobile-connection-operations/69d2fbe1-76a5-4c9a-a4e9-f81d4e52ac7d
```

只允许原调用设备读取，返回与断开接口同形状的操作状态。列表已变化、返回途中网络丢失时优先查询同一回执，禁止盲目生成新的断开请求。确认释放的回执默认保存 24 小时，可由服务端配置覆盖；App 不应依赖永久回执或在过期后复用旧操作标识。尚未确认释放的回执不会靠 TTL 直接消失；服务端保留后台重试索引，节点退出后也继续核实释放，不依赖用户持续轮询。

轮询依次至少等待 2 秒、5 秒、10 秒，并遵守更长的 `pollAfterMs`；最多自动观察 30 秒后显示“仍在断开，可稍后刷新”。进入后台停止轮询，回到前台继续查询原 requestId。404/47124 表示回执不存在、过期或不属于调用设备；它不证明断开成功，先刷新连接列表。

## 5. 超限入口与错误处理

新版 App 在确认 `limitKind=mobile_connections` 后必须提供设备识别与管理入口：

> 当前空间的连接数已满（3/3）。选择一个设备断开连接后，可在此设备继续使用。

保留历史与输入草稿，显示当前 App“尚未连接，不占名额”，展示其他占位设备及状态。未超限时可将“App 连接管理”收在二级入口。不要把所有握手失败归类为满额；无法读取握手 body 时，可在能力支持前提下进行一次受限 HTTP 列表查询核验。

| HTTP / code / reason | 操作 |
| --- | --- |
| 429 / 47011 / RATE_LIMITED，limitKind=mobile_connections | 显示当前空间连接列表，不自动踢最旧设备；等待至少 30 秒及服务端更长 retryAfterMs |
| 429 / 47011，limitKind=device_reconnect_cooldown | 显示等待，过期后由用户显式恢复，不重放旧 ticket 绕过 |
| 429 / 47011，limitKind=device_connection_closing | 等待关闭完成，不能只看冷却计时 |
| 429 / 47011，limitKind=mobile_connection_management | 停止轮询至 retryAfterMs，保留原操作标识 |
| 400 / 47019 / INVALID_REMOTE_REQUEST | 参数/游标无效，清空游标刷新；不盲目重复无效请求 |
| 409 / 47120 / CONNECTION_VERSION_CONFLICT | 目标已重新连接，刷新并让用户重新选择 |
| 409 / 47122 / OPERATION_ID_CONFLICT | 操作标识与内容冲突，核对原回执 |
| 404 / 47124 / CONNECTION_OPERATION_NOT_FOUND | 刷新列表，不能据此推断操作完成 |
| 401 或 403 | 按已有登录/权限错误处理，不降级匿名；跨账号、跨空间、不存在目标均不泄露存在性 |
| 503 / 47003 / DEVICE_NOT_READY | 状态未知，遵守重试提示；不显示 0/3 或伪造释放成功 |

前台持续查看长任务不按在线时长强制断开。真正进入后台、退出登录或切空间时主动关闭；权限弹窗等短暂 inactive 不应导致频繁重连。已观察到的异常断线最多保留 30 秒，静默断线按最后有效心跳后 90 秒清理，不重复追加恢复时间。App 本地退避必须尊重服务端更长 retryAfterMs，不能沿用旧版最多裁剪至 30 秒的行为。前台多个任务共享当前账号/空间的同一条 WS。

## 6. 发布与验证

本次管理接口不新增 MySQL 表，使用既有设备登记与 Redis 临时额度/操作索引。新服务端接口为可选增量；App UI 需单独接入后才能展示设备管理。服务器默认开启功能配置不代表 Redis、集群协议/验收条件已满足，线上是否可用必须核查能力返回及真实握手。

优先按[上线与回滚步骤](../../../lobsterai-server/docs/operations/2026-09-21-app-ws-rollout.md)排空旧物理连接后统一切换。无证据文件时，发现旧 v1 有效占位会保护性拒绝，不能靠删除 Redis key 或关闭保护绕过。需要保留超额存量时，由运维冻结真实逻辑成员清单、确认旧物理连接排空，再配置 v2 证据；该过渡场景列表可能暂时超过 3 个，App 应显示真实 `used/limit`，不截断设备或宣称已收敛。证据非空但失效时不可继续按空配置正常放行；先处理实际部署问题。旧 v1 文件不能充当 v2 证据。

服务端为新接口记录固定分类吞吐/耗时：`remote.http.mobile_connection_list.*`、`remote.http.mobile_connection_disconnect.*`、`remote.http.mobile_connection_operation.*`；入口拒绝另外使用 `remote.http.ingress.<operation>.*`。指标不包含账号、设备、连接 token 或 requestId。

联调至少覆盖：无 WS 名额仍可读管理接口；3 个占位＋当前新 App；当前已在线计数不重复；跨空间/账号拒绝；同名设备可识别；目标在确认前重连；请求超时后原回执恢复；状态 closing 不提前减少用量；列表/Redis 不可用不显示 0；30 秒冷却与旧 4409 行为；后台不重连；不影响桌面本地任务与独立桌面额度。

完整策略见 [App WebSocket 连接限制 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-21-app-websocket-abuse-protection.md)。

## 7. 客户端具体行动项

### App（待接入；本次未修改iOS）

1. **能力和错误分类**：读取 `mobileConnectionPolicy` 和 `mobile_connection_management_v1`，策略数字来自服务端，不硬编码3。仅 `mobile_connections + account_scope` 显示当前空间满额；总账号预算、429频率、503/未知握手错误分别提示。ticket `admissionHint` 可缺省且不占名额。
2. **必备超限页面**：当前设备独立置顶，未连接明确不占名额；展示本空间其他App的 `displayName/platform/shortLabel/state`。按 `used/counts/limit` 展示真实用量，含pending、recovering、closing；列表不可用时保留旧内容并禁用操作，不显示0/3。设备ID/token仅用于协议，不显示给用户。
3. **明确断开**：显示目标名称/平台/短号确认，用户确认后固定保存 requestId、deviceId、expectedConnectionToken。超时重试/查询原操作，不改token自动重踢。released回执后只触发一次合并重连；不承诺抢到名额，不连锁踢其他设备。断开不取消桌面任务或退出账号。
4. **手动暂停**：识别4409 `mobile_connection_disconnected` 或冷却详情，设置本地手动暂停。普通前后台、网络变化、权限弹窗不清除此状态；用户明确点重新连接才恢复，仍遵守30秒冷却/closing。其他4409安全暂停且使用通用文案，忽略旧transport迟到回调，不能暂停替换成功的新连接。旧iOS现有行为不等价于该新要求。
5. **生命周期**：当前owner＋空间共享一个coordinator/WS，任务只订阅复用。真正后台/锁屏、退出或切空间时关闭；短暂inactive不立即反复断开，多个scene协调。前台等待长任务不按5/10分钟固定时长踢断。恢复后补快照/增量，不重执行任务。
6. **退避与回执**：保留完整server retryAfterMs，不再裁到30秒；空间容量失败至少等30秒加正向抖动，后台不自动重试。操作轮询2/5/10秒、最多自动30秒后人工刷新。仅确认released可解除这一次纯空间容量等待并尝试一次，其他ticket/握手/冷却限制保留。
7. **缓存与故障**：切账号/空间隔离草稿、列表、游标和回执，迟到响应必须匹配原身份/连接代次。未知命令结果先按原幂等ID核对；WS失败不清历史或另建任务。不要改用高频HTTP轮询规避WS限额。

### 桌面（接口兼容，无需同步升级才能继续使用）

- 桌面每账号＋空间5台产品额度及现有v2设备移除/恢复语义不变，不把App临时断开混入电脑列表。
- 保持同步/远控失败与本地执行隔离。账号32安全总量、迁移排空、Redis故障和节点fence仍可影响新桌面远控准入；429/503应退避并保留本地任务/待同步内容，不回滚消息、阻塞输入、重启任务或删除文件。
- 已认证桌面HTTP/WS有角色预留，但capabilities/register等仅JWT接口走App侧；不能声称所有桌面请求均不受共享预算影响。新未知凭据冷缓存可能受2/s、burst10验证门禁，应按返回退避，不能强制退出登录。
- 原有ticket/hello/心跳/订阅协议字段不变，新可选字段可忽略。桌面不调用App专用列表/断开端点，不因App管理能力暂不可用自动关闭用户远控偏好。

## 8. 关键默认值、发布顺序与验收边界

| 范围 | 默认值 |
| --- | --- |
| App产品 / 桌面产品 | 3 / 5，各按账号＋空间 |
| 跨类型账号安全总额 | 32逻辑实例＋2共享物理交接余量 |
| App每空间交接 | 额外1个，与账号2个共享；每设备最多2个物理连接，只有1个有效generation |
| 心跳 / 静默超时 / 明确异常恢复 | 30秒 / 90秒 / 最多30秒，恢复从首次观察关闭计时，不因异步关闭或Redis重试重置 |
| 手动断开冷却 | 30秒；closing未回收时冷却到期也不能抢回 |
| 账号HTTP / WS | 分别120/s、burst240，App最多90/180 |
| 账号ticket / handshake | 分别20/min、burst20，App最多15/15；实际握手另有device10/min、burst3 |
| 终态操作回执 | 24小时；128个回执上限、8个非终态上限 |

服务端默认开启资源保护；部署证据路径为空时正常按新Redis规则准入。显式配置文件必须为有效v2，不能提供旧v1文件或伪造排空布尔值。先排空旧物理WS、确认全部节点支持v2后恢复入口；需要同空间4–8个存量的逻辑宽限时，先冻结真实成员再按运维步骤提供v2清单，不保留未受新索引管理的旧transport。

registry节点Redis租约TTL为120秒，连续90秒不能续租会永久fence本进程UUID；Redis恢复后需要受控重启服务进程/Pod才能建立新节点代次。retryAfter=3秒不是一定自动恢复的承诺。本地任务继续运行；网络分区/长GC时逻辑计数回收不证明所有旧FD即时消失，Pod/入口物理上限继续必要。关闭回收采用Tomcat原生强制关闭、isClosed终态二次确认，不能将发送close成功等价于名额释放。

本次禁用WS扩展协商，原生Pong受限且不续JSON心跳。容器自动处理的原生Ping、分片慢流、TLS/未完整请求头和NAT/IP阈值仍需网关/容器层实测；不能仅凭应用代码宣称开源客户端的所有攻击入口已被覆盖。

新Metriclog包括管理HTTP、registry action/outcome、角色容量/worker/队列、入出站字节、预算拒绝；`remote.connection.registry.reserve.grandfathered`只是成功宽限准入次数，不是当前存量设备gauge。实际Grafana与告警尚未配置验收。联调必须验证第4App设备识别/主动断开、跨账号空间拒绝、CAS并发、回执丢失、关闭失败、节点重启、真实多节点计数、旧客户端兼容，以及App压力下桌面本地仍正常工作。

完整实现及未验收项目见[服务端Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-21-app-websocket-abuse-protection.md)，发布/回滚见[运维步骤](../../../lobsterai-server/docs/operations/2026-09-21-app-ws-rollout.md)。
