# 桌面提问同步与双端回答接入

日期：2026-09-18。桌面端与服务端代码已配套修改，测试库 V100 已迁移，待部署及 App 接入验收；生产未迁移。iOS 按用户要求仅只读参考，未修改 App 项目。

## 变更摘要

此前原生 `ask_user` 仅把任务置为 `waiting_local`，MCP `AskUserQuestion` 仅发桌面窗口 IPC；成功的任务同步没有携带问题表单。本次将两条已验证的桌面任务提问路径接入独立 Question 协议，允许手机或电脑提交结构化答案，保留本地最终裁决。

- `question_response_v1` 能力、外层投影 v5，原消息正文仍使用 v4，WS protocolVersion 仍为 1。
- 新增 `question.updated`、快照 pendingQuestions、问题分页，以及 question_response 命令；不更改允许/拒绝审批语义。
- 桌面本地回答不等待云端；投影故障可从持久问题事实重建，远端结果未知不重放。
- 旧服务端不接收未知 question 事件；旧 App 通过原 session.reset 补齐水位，继续在电脑处理问题。

完整协议位于相邻服务端仓库：`lobsterai-server/docs/api/mobile-remote-questions-v1.md`；详细方案：`lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-18-remote-user-questions.md`。

## 接口与认证

所有路径以前缀 `/api/remote/v1` 开始。沿用 JWT Bearer + `X-Remote-Device-Credential: <deviceId>.<deviceKey>`，服务端从认证上下文解析账号/空间，不接收请求自报用户身份。v5 HTTP 带 `X-Remote-Projection-Version: 5`，WS 通过 `/connection-tickets` 协商 `{protocolVersion:1,projectionVersion:5}` 后使用短期 URL。

| 接口 | 变化 |
| --- | --- |
| GET /capabilities | 新 capability；实际 projectionVersions 随已启用能力返回 |
| 桌面 /devices/register 及 /devices/{id}/settings | 发布桌面支持的 question_response_v1；新问题同步必须与服务端能力匹配 |
| POST /sync/batches、全量导入 | 新增 question.updated，payload={question,controlVersion}；旧 seq/sourceSeq/epoch/manifest 完整性语义不变 |
| GET /sessions/{id}/snapshot | v5 新增 pendingQuestions、questionsNextCursor；问题首批上限10 |
| GET /sessions/{id}/questions | status可省略或pending，cursor，limit默认10/max20，返回items/nextCursor/readSeq |
| POST /commands | type=question_response，payload见下例；最长30秒且不晚于问题截止时间 |
| GET /commands/{id} | 查询原提交；成功result.outcome=question_applied，accepted不是引擎确认 |

回答 payload 示例：

```json
{
  "runId":"run_01",
  "questionId":"question_01",
  "questionVersion":"1",
  "operationDigest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "action":"answer",
  "answers":{"q0":["Describe / analyze it"]}
}
```

提交完整命令仍须固定 commandId、deviceId、sessionId、expiresAt；重试不改这些字段，不自动生成新ID。取消为action=cancel、answers={}，需allowCancel。新问题接口及命令只给投影v5，旧头请求返回47009/426。问题版本、状态、摘要或run冲突为47024/409（reasonDetail=QUESTION_CHANGED），能力不可用47017；非法答案47019（INVALID_REMOTE_REQUEST），超限47012。

## 桌面实现和维护约束

1. `shared/remote/questions.ts` 定义固定题目ID、单选/多选/自填、UTF-8限额和字符串数组答案。native和plugin使用原始选项标签。插件题目文本键与`|||`只在legacy resolver边界转换，不出现在手机协议中。
2. `remoteQuestionService.ts` 固定问题与session/run/owner/Agent/cwd绑定；先持久裁决再派发，同一问题仅一次实际调用。桌面和mobile进入统一入口，未知结果不fallback到旧resolver。
3. 原生Controller必须核验resolve响应或完整终态。`QUESTION_NOT_FOUND`可能是15秒终态回执已过期，不表示从未执行；`ALREADY_TERMINAL`也不表示当前提交成功。首次确认的终态答案/时间不能被后续回执改写。
4. MCP只有显式解析到桌面任务的问题可远端回答；全局/无法映射/秘密存储问题仍本地。桥接层使用真实创建时间、截止时间、单次resolve与取消通知。
5. `RemoteStore`持久Question事实，投影worker生成question.updated；能力切换要求快照重建，不能改写已分配sourceSeq载荷。未知/未决问答阻止相关缓存清理。
6. `SessionCommandService`复核绑定、归属与执行许可；`RemoteBridge`复用command claim/receipt/settlement。重启、丢ACK、暂停后的核对只读取原submission，不重发回答。

## App 后续工作

不在本轮改动范围内。App需完整接入v5协商、Question DTO/分页/事件缓存、答案草稿、单选/多选/其他回答及命令待确认状态。只读参考：`/Users/admin/Documents/lobsterai/lobsterai-ios/LobsterAI/Remote/`。详细文件落点见服务端问答API文档。

保持旧版兼容，未升级App不会自动显示问卷。不能用普通send_message代替结构化回答，也不能在云端未确认或另一端已处理时显示“本次提交成功”。

## 迁移、发布和验证边界

- 服务端新增V100（remote_questions、remote_question_snapshots）已于 2026-09-18 18:33:57–18:34:00 在测试库执行并校验：20 字段、2 主键、3 普通索引，现有 V99 结构保持一致。生产未执行。执行记录位于相邻服务端仓库 `docs/operations/2026-09-18-test-v100.md`；V99 未重跑。
- `remote-control.question-response-enabled=${REMOTE_QUESTION_RESPONSE_ENABLED:true}`，Java默认true；默认开启不能代替数据库/客户端就绪。
- 发布顺序：V100 → 所有服务节点兼容升级 → 桌面更新 → App适配v5后开放。服务新旧节点混部需显式暂关新能力，结束后解除覆盖。
- 本次不部署、不重启正在运行的用户任务。桌面定向回归及TS编译、服务端仅编译源码/测试源码，最终执行记录以Spec为准；真实App联调尚未完成。
