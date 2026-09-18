# 服务端接入：远控可靠性、资源保护与 claim 收敛

日期：2026-09-18。服务端代码及测试源码编译通过；**未运行服务端测试，未部署，测试库 V99 已执行并校验、生产未迁移，NOS/集群/Grafana 尚未完成真实环境验收**。本文说明已实现的接口与部署条件，不能据此判断当前线上能力已可用。桌面本地执行不依赖云端同步成功；同步失败不得回滚本地任务、锁住普通输入或要求重新执行任务。

服务端总方案：[远控可靠性补强](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-18-remote-reliability-hardening.md)。资源保护与实际实现范围：[S1–S5/O1 §12](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-18-remote-api-resource-protection.md#12-2026-09-18-实施记录与部署前提)。清理与收敛：[保留 Spec §18.9](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-17-remote-data-retention.md#189-本轮实施记录2026-09-18)。

## 1. 变更与兼容边界

- 既有 `/api/remote/v1/*`、设备管理 v2、WS 地址和 `protocolVersion=1` 保持。旧请求字段类型、认证、command/history DTO、错误码不改变；旧 App/桌面无需同步升级。
- 修复 `PUT /artifact-uploads/{id}/parts/{partNo}` 误入 JSON 过滤器；与原 input-assets 分片一样使用精确二进制路由，`partNo` 仍从1开始。既有类型/长度/hash/设备/任务/generation/策略版本检查保留。
- 增加跨 API 版本、跨账号空间的账号资源预算及 mobile 并发槽位；接口仍复用 `RATE_LIMITED` 信封，不把资源过载当成登录过期。
- 文件新写入安全证明与旧文件读取分开。证明未满足，相关新文件写入暂不可用；旧资产按原 provider/profile 和授权读取，上传状态及无新副作用的成功回执仍可核对。不会关闭 desktop WS 或文本同步。
- 新增可选 `claim_settlement_v1` 能力和历史 claim 补证接口。该接口只补充“确实未开始执行”的持久证据，**不产生执行许可**。清理仍须分别满足终态、引用、恢复窗口、归档和删除证明。
- Metriclog 增加完整入口 `remote.http.ingress.<operation>.<outcome>`；原 MVC 时延含义不变。客户端不需要发送指标字段。

## 2. 新增 claim 补证接口

调用前从 `GET /api/remote/v1/capabilities` 的 capability 数组确认 `claim_settlement_v1`。未公告时保持原 reconcile/查询行为，不能把404或能力缺失当作“已收敛”。

```http
POST /api/remote/v1/commands/{commandId}/claims/{claimId}/settlement
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
Content-Type: application/json
```

认证使用现有 access JWT 和设备凭据；Cookie 不足以调用。user/scope 来自服务端认证上下文，不接受 body 自报归属。只有原目标 desktop 可以补交，mobile 不可调用；不要求先建立 WS。离线或已从连接列表移除的桌面仍须具有有效登录/设备凭据并证明原 claim，不能借此重新接入或执行。

请求体最多4096字节，仅允许以下字段；版本使用十进制字符串，不用 JavaScript number。四项 `localEvidence` 必须来自完整持久记录，不能按超时、旧 claim 过期或“没有找到日志”推断为 true。

```json
{
  "claimToken": "<original-claim-token>",
  "expectedStatusVersion": "7",
  "outcome": "never_started",
  "localEvidence": {
    "databaseHealthy": true,
    "historyComplete": true,
    "inboxPersisted": true,
    "executionNeverStarted": true
  }
}
```

`commandId/claimId` 遵循现有非空ASCII ID校验，最长64；`claimToken` 沿用原 claim 凭据校验。首次提交要求旧 claim 已到期、无相冲突的报告或执行事实，并核对当前 `expectedStatusVersion`。已有 run 的历史 claim 不能仅凭后继 claimId 收敛；服务端还要求可信的其他 claim applied 事实。

成功响应示例（`command` 使用现有完整或压缩回执形状）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "claimId": "claim-example",
    "settlementVersion": "1",
    "settledAt": "2026-09-18T08:00:00.000Z",
    "command": {
      "commandId": "command-example",
      "type": "create_session",
      "deviceId": "desktop-example",
      "sessionId": null,
      "runId": null,
      "status": "expired",
      "statusVersion": "7",
      "acceptedAt": "2026-09-18T07:00:00.000Z",
      "expiresAt": "2026-09-18T07:01:00.000Z",
      "result": null,
      "error": null,
      "updatedAt": "2026-09-18T07:01:00.000Z"
    }
  }
}
```

响应不含新 claim、claimToken 或 executionPermit，不推进 command 的状态、版本、currentClaimId 或期限。`settlementVersion` 为正十进制字符串；`settledAt` 为UTC时间，重复不更新。

同证据重试必须原样保留首次 `expectedStatusVersion` 和 `localEvidence`：完成认证/归属/claimToken校验后，服务端先比较已保存证据摘要，命中直接返回持久回执和当前 command，不因 command 后续版本变化拒绝重试；改动证据则返回现有 HTTP409 / code47024 / `COMMAND_STATE_CONFLICT`。能力未就绪为现有47017 `CAPABILITY_UNSUPPORTED`。其他认证、权限、找不到、参数和限流错误沿原远控语义。

旧 reconcile 仍兼容。带原 claimToken 的可信 `not_started` 可记录证据；旧无 token 请求不自动成为新的 GC 安全证明。原 reconcile 命中已收敛证据时返回 `executionPermit:null`，不能因丢回包再申请执行。

## 3. 桌面配合项

1. 保持远控网络、文件同步、目录投影和失败重试在后台；429/503只暂停相应远控操作。本地消息、任务/审批、文件产物保存独立完成，UI不将“已本地保存”写成“手机已同步”。
2. 以 capability/file-policy 实际返回决定新附件及产物同步入口。新写证明失效时保留本地原件/受保护快照、asset/publication/operation ID及摘要；查询旧上传状态，避免重新创建同一任务或丢弃未传文件。
3. `writing/unknown` 表示实际存储结果未决。同part已有未决写入时服务端返回既有503/47060；只有可信核对或删除证明后才可进行新的非幂等写入。不要换新 asset/part 标识规避等待；超时并不证明对象未上传。
4. 根据 `retryable`、`retryAfterMs` 退避并加入抖动，合并重复请求。不要把47011或文件503当成401强制退出登录；真正401才走既有登录恢复。
5. 只在完整持久 inbox/运行记录/安全日志能够证明从未派发时提交 settlement；身份、scope、命令和原 claimToken 必须对应。同步镜像损坏或执行结果未知时保守保留，不自动填 true。原请求与最终回执持久保存用于幂等恢复。
6. App/桌面重连按 `hello` 的心跳间隔调度，多个会话继续复用单个WS。收到协议/资源关闭后退避重连，不开多条socket规避额度。

## 4. 默认预算与文件时限

| 维度 | 默认值 | 范围/客户端行为 |
| --- | --- | --- |
| 新设备登记 | 每账号30/滚动小时 | v1/v2、desktop/mobile、个人/企业空间合计；既有installation幂等复用 |
| mobile逻辑连接 | 每账号8 | scope+device标识逻辑槽位，同设备换票不重复占位；与desktop在线5个限制不同 |
| 远控HTTP | 120/s，突发240 | 同账号所有远控HTTP接口；既有设备预算继续生效 |
| WS入站 | 120帧/s，突发240/账号 | 连接本地30/s、突发60；畸形JSON也受限 |
| WS票据 | 20/分钟/账号 | 签发不占mobile在线名额，握手才原子准入 |
| 分片接收 | 总90秒、无进展15秒 | 异常只影响该传输；同标识核对状态后恢复 |
| 分片/complete端到端 | 240秒 / 300秒 | 请求取消不提前释放未知写入容量；执行槽位实际退出后释放 |

超预算复用 code47011、reason `RATE_LIMITED`、HTTP429；Redis/保护暂不可用沿503/47011。可选 `limitKind` 只作提示，不要求旧客户端识别。客户端不能依赖固定数字替代服务端实际拒绝及 `hello`/能力信息。

## 5. 配置默认值与两份事实证明

`REMOTE_RESOURCE_PROTECTION_ENABLED`、`REMOTE_FILE_TRANSFER_DEADLINE_ENABLED`、`REMOTE_FILE_STORAGE_PROOF_ENABLED` 默认 true；Java默认和properties回退一致。**开关开启不等于凭据、安全验收、集群同构或DDL已经满足。** 证明文件由受控运维配置挂载为只读文件，不通过客户端/API上传，不把真实凭据或源文件位置放进日志。

### 5.1 NOS新写证明

`REMOTE_FILE_STORAGE_PROOF_EVIDENCE_FILE` 对应 `remote-control.files.storage-proof.evidence-file`。默认空，相关share-gateway新写保持未就绪；历史读取继续。以下仅是字段模板，占位值必须由实际验收替换，不能直接保存为“已验收”：

```json
{
  "schemaVersion": 1,
  "storageIdentity": "[\"nos\",\"share-gateway\",\"https://luna-nos.youdao.com/backend/upload\",\"lobsterai\"]",
  "accessContract": "restricted-service-network",
  "contractVersion": "<reviewed-contract-version>",
  "reviewId": "<actual-review-id>",
  "policyDigest": "<actual-policy-digest>",
  "anonymousOriginDenied": true,
  "cdnBypassDenied": true,
  "durableRetentionVerified": true,
  "writeReconciliationReviewed": true,
  "deletionContractReviewed": true,
  "verifiedAt": "<UTC-ISO>",
  "expiresAt": "<UTC-ISO-within-seven-days>",
  "probeUrl": "https://<reviewed-host>.nosdn.127.net/<synthetic-object>"
}
```

文件最多16KiB，正式验收最多7天；身份、策略或访问合同变化需重新验收。当前网关适配器无服务认证代理协议，只接受真实核实的受限服务网络合同；如果实际源站仍可匿名读取，不能填写以上事实绕过。仍复用既有网关，不强制引入新bucket；若要改用服务认证代理，需先按其真实契约实现适配。

后台每1分钟读证据及检查合成对象的 `Range: bytes=0-0`，要求206和1字节响应；健康缓存5分钟，证据缓存超过2分钟未刷新则保守未就绪。热路径不读磁盘/跑探针；不会每分钟上传或删除对象。普通网络可达不产生或延长正式安全证明；源站/CDN旁路、持久保留及真实删除必须单独验收。

### 5.2 mobile全节点准入证明

`REMOTE_CONTROL_RESOURCE_DEPLOYMENT_EVIDENCE_FILE` 对应 `remote-control.resource-protection.deployment-evidence-file`。默认空：没有证明时拒绝**新逻辑mobile槽位**，已有Redis槽位的换票/续租继续；desktop WS、文本同步和本地任务不因该条件停止。

```json
{
  "schemaVersion": 1,
  "protocol": "account-budget-v1",
  "allServingNodesVerified": true,
  "clusterId": "<actual-cluster-id>",
  "reviewId": "<actual-rollout-review>",
  "nodes": ["<all-verified-serving-node-identities>"],
  "cutoverAt": "<immutable-UTC-ISO>",
  "verifiedAt": "<UTC-ISO>",
  "expiresAt": "<UTC-ISO-within-seven-days>",
  "legacyConnections": [
    {
      "userId": 123,
      "scopeKey": "personal",
      "deviceId": "<actual-device-id>",
      "generation": "<original-numeric-generation>",
      "lastSeenAt": "<UTC-ISO-within-90-seconds-before-cutover>"
    }
  ]
}
```

来自切换前受控在线路由盘点；不是用户自行申报的设备名单。文件≤1MiB、总记录≤10000、单账号≤64、nodes为1–256个实际节点名。无旧mobile的单节点开发机可用空 `legacyConnections`，仍须真实核实服务版本。四节点必须全部支持该协议才能签署，不能仅检查当前域名落到的一个节点。

切换后90秒内首次握手一次导入该账号全部已验证存量槽位；原始cutover不得通过续签重置。存量最多24小时过渡，断线恢复位90秒，未恢复的过期槽位不能从旧清单无限复活。24小时后换票时固定最近活跃的最多8个保留成员，超额其余设备收到原限流错误；不强制结束桌面任务。未完成同构验收不得宣称全局8连接上限已经成立。节点回滚、扩缩或服务版本变化后须及时撤销/更新事实记录。

## 6. 上线顺序与回滚约束

1. 核对目标库已有V98，再执行 [V99](../../../lobsterai-server/sql/V99__remote_retention_reliability.sql)，**必须先DDL再部署新读写代码**。仅增加claims证据、archive重试/对象租约列及索引，MySQL5.7、无外键；测试库已于2026-09-18 17:52执行并校验，见[执行记录](../../../lobsterai-server/docs/operations/2026-09-18-test-v99.md)，不要重复执行；生产未迁移。其他旧迁移是否完成按目标库实际检查，不能照抄测试库状态。
2. 混部期显式设置 `REMOTE_RETENTION_MODE=observe`、`REMOTE_RETENTION_CLUSTER_READY=false`，按已有保留方案暂停新协议/破坏性清理。默认仍为purge/true，临时覆盖用于真实滚动过程；新旧节点或旧清理worker并存时不能默认认为安全。
3. 所有共库API/后台节点升级后核验：V99列、旧HTTP/WS认证和DTO、产物二进制入口、claim同证据重试、Redis故障/代次交错、旧文件读取；再根据事实解除覆盖、公告能力。mobile准入和NOS新写证明分别配置，缺一只影响其自身能力。
4. 本地普通任务在断云、NOS失败、限流、证明缺失时仍应正常。完整SecurityFilterChain、Redis Lua并发、真实Tomcat慢流取消、四节点切换、NOS源站私有/删除/保留和Grafana指标出数需要授权环境验收；编译不能替代。
5. 回滚保留已生成的收敛证据、幂等回执、文件旧profile和读取兼容；不删除记录、不回退epoch/floor、不把unknown自动当成功。回滚到不理解V99安全证据的版本前停止相关清理。未验证的新写入或准入条件不能靠伪造证明解除。

桌面构建须运行 `npm run build`，只运行 `compile:electron` 不足以生成发布包所需的根目录 worker。Vite 已独立生成文件快照、投影、安全日志和历史导入四个 worker；开发启动等待这些产物，`electron-builder` 将其显式解包到 `app.asar.unpacked/dist-electron`，`beforePack` 在缺少任一产物时中止打包。原生 `better-sqlite3` 保持 external，worker 不加载主进程入口。本轮完整 build 和模拟解包目录的四种真实 worker smoke 已通过；未制作安装包或执行 Windows 真机验收。

本次服务端静态验证为 `./gradlew compileJava compileTestJava -x test --offline` 与 `git diff --check`。测试库V99已单独执行并校验；App真机、部署、生产数据库变更、NOS探针和Grafana操作尚未完成。
