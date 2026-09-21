# 远控回复同步额度状态读取修复

日期：2026-09-21。涉及服务端与桌面，无 MySQL/SQLite 迁移，无 App 协议升级。

## 1. 变更概要

服务端修复 `remote_reply_quotas.ready/consistent` 的 JDBC Boolean 误读，以及 `SELECT *` 后同名数值别名无法覆盖原列的问题。已有账本不再被误判为未初始化；真实额度不足或账本不一致仍按原契约拒绝。容量限制、鉴权、owner/session 锁和事务均保留。

桌面精确识别 HTTP 410 + code 47010 + reason `SESSION_DELETED`，持久阻断该会话自动同步，停止每 30 秒重新开始无效导入。保留本地任务、消息、归属、outbox、import、原始 source/ACK，不自动复活远端、不伪造删除 ACK。其他会话不受影响；用户显式重试仍可发起一次核验。

## 2. 接口详情

接口无变更，继续使用：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| PUT | `/api/remote/v1/sessions/{sessionId}/contents/chunks/{sha256}` | 上传回复正文块 |
| PUT | `/api/remote/v1/sessions/{sessionId}/contents/{contentId}/versions/{version}` | 上传正文 manifest |
| POST | `/api/remote/v1/sync/imports` | 完整会话同步 |
| POST | `/api/remote/v1/sync/batches` | 增量会话同步 |

正文接口保持 JWT Bearer、现有设备凭据/空间头和 `X-Remote-Projection-Version: 4`（或已支持的更高版本），正文上传仅允许会话所属桌面。`deviceId`、`connectionGeneration`、`mode` 和正文格式不变，精确请求/响应以服务端 `docs/api/mobile-remote-reply-content-v4.md` 为准。

正文块请求示意（SHA 必须对应 text 的 UTF-8 字节）：

```json
{"deviceId":"desktop-device","connectionGeneration":"123","mode":"online","text":"hello"}
```

成功仍返回：

```json
{"code":0,"message":"success","data":{"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","sizeBytes":"5"}}
```

真实账本不一致仍返回 HTTP 503 / code 47012 / `data.reason=REPLY_CONTENT_QUOTA_INCONSISTENT`。同步接口的 HTTP 410 / code 47010 / `data.reason=SESSION_DELETED` 表示远端删除终态；没有提交序号，不能当作 ACK 或启动缓存回收。不得将所有 410 或全部 47010 都归为此终态。

## 3. 客户端事项与发布顺序

1. 先部署服务端类型读取修复，接口向后兼容。正常账本下旧桌面会自动重试积压正文，再发布待同步的任务终态；无需再次执行任务。
2. 更新桌面以停止删除终态的无效重试。错误保留可见，不能因停止重试就显示“已成功同步”。
3. 按会话观察 `sourceSeq`、`ackSourceSeq` 和服务端状态收敛。若 503 仍持续，核对实际 owner/session 账本，不能无条件修改 consistent 或清空本地队列。
4. 不要求 App 修改请求。本轮没有修改 iOS 代码。

## 4. 鉴权与现场边界

现有 JWT、设备凭据、账号/空间及会话所属桌面校验保持不变。没有新增开关，没有关闭权限、额度或存储就绪校验。

ticket 200 不代表 WS 握手成功。截图中的 iOS `-1011`、`fileUpload=false`、`online=false` 是独立排查项：需要实际握手 HTTP 回包、部署证明、存储证明/健康探针、目标桌面 Redis 路由。不能凭本次额度修复宣称这些问题已恢复；不伪造验收文件或绕过准入条件。

## 5. 验证

- 服务端 `compileJava compileTestJava -x test --offline` 通过；按仓库约定未运行服务端测试。
- 桌面 `remoteBridge.test.ts` 61 项通过，Electron TypeScript 与两文件 ESLint 通过。
- 测试库只读连接尝试超时，未核实或改写用户账本；未部署、未重启桌面、未做手机端到端验收。
- 详细日志证据和残留问题见服务端 `docs/operations/2026-09-21-remote-sync-blocked.md`。
