# 2026-09-21 远控附件默认开启修复接入说明

## 1. 变更摘要

服务端修复 `test` profile 下未挂载可选存储验收文件、导致远控 `fileUpload=false` 的问题。默认 `share-gateway` 继续复用文件分享的 `NosUploadService`，无需新增 NOS bucket、AK/SK 或证明文件。

| 配置 | 默认值与行为 |
| --- | --- |
| `REMOTE_INPUT_ASSETS_ENABLED` | `true`，仍可显式关闭输入附件 |
| `REMOTE_FILES_INPUT_UPLOAD_ENABLED` | `true`，仍可显式关闭输入文件上传 |
| `REMOTE_FILE_STORAGE_PROOF_ENABLED` | `true`；显式 `false` 仍禁止分享网关新写入 |
| `REMOTE_FILE_STORAGE_PROOF_EVIDENCE_FILE` | 默认为空；空或空白按现有分享 NOS 准入，显式非空路径才要求文件验收及健康检查通过 |

默认准入不代表正式安全验收已完成。显式配置文件但缺失、无效、过期或健康检查失败时，仍禁止新写入。修改共同作用于输入附件、产物发布及迁移目标的新写入准入；各自功能开关、原有鉴权、隔离、类型/大小/配额校验和写入记录仍生效。原生 NOS profile 及手机 WS 部署证明逻辑不变。

## 2. 接口及协议示例

测试域名：`https://lobsterai-server-test.youdao.com`。以下路径以 `/api/remote/v1` 为前缀；本次不增加或修改 HTTP 路径、请求/响应字段类型、错误码或认证方式。示例响应为相关字段节选，完整协议以服务端 `docs/api/mobile-remote-files-api.md` 及 `docs/api/mobile-remote-input-v2.md` 为准。

```http
GET /api/remote/v1/capabilities HTTP/1.1
Host: lobsterai-server-test.youdao.com
Authorization: Bearer <accessToken>
```

服务端新写准入及所依赖功能均开启时，相关返回字段：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "capabilities": ["input_schema_v2", "model_selection_v1", "input_attachments_v1"],
    "features": {"fileUpload": true}
  }
}
```

数组仅展示本次相关项，真实响应还可能含其他能力。默认/v1 即可探测全局能力，不先强制发送旧服务器不支持的投影版本。

```http
GET /api/remote/v1/devices?kind=desktop HTTP/1.1
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <mobileDeviceId>.<deviceKey>
```

设备响应的目标电脑 `capabilities` 应包含 `input_attachments_v1`。随后按已协商投影查询目标输入能力：

```http
GET /api/remote/v1/devices/<desktopDeviceId>/input-capabilities HTTP/1.1
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <mobileDeviceId>.<deviceKey>
X-Remote-Projection-Version: 2
```

相关返回字段：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "deviceId": "<desktopDeviceId>",
    "capabilities": ["input_schema_v2", "model_selection_v1", "input_attachments_v1"],
    "features": {"fileUpload": true}
  }
}
```

附件申请继续使用原请求；`<64位摘要>` 应替换为原文件 SHA-256 小写十六进制值，非字面发送：

```http
POST /api/remote/v1/devices/<desktopDeviceId>/input-assets HTTP/1.1
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <mobileDeviceId>.<deviceKey>
X-Remote-Projection-Version: 2
Content-Type: application/json

{
  "uploadRequestId": "11111111-1111-4111-8111-111111111111",
  "source": "mobile_draft",
  "draftId": "draft_01",
  "fileName": "photo.png",
  "mimeType": "image/png",
  "sizeBytes": "814195",
  "sha256": "<64位摘要>"
}
```

成功 `data` 继续返回 `assetId`、内容 `version`、上传状态、分片信息等既有字段。随后使用原 `PUT /input-assets/{assetId}/parts/{partNo}` 二进制分片和 `POST /input-assets/{assetId}/complete` 完成流程；只有完整资产达到 `ready` 后才能准备及提交任务。文件策略、精确长度、摘要和恢复规则不变。

## 3. 客户端接入和刷新步骤

1. 先部署修复后的服务端；无需增加配置即可使用默认分享网关，但应核对部署是否遗留显式 `false` 或非空验收路径覆盖。
2. 重启一次目标桌面，让既有版本重新获取服务端能力并注册设备能力。已有版本仅收到附件能力变化时，不保证靠周期刷新就重新登记，不能仅等待固定秒数。
3. App 重新拉取服务端 `/capabilities`、目标设备列表和 `/devices/{id}/input-capabilities`，更新之前缓存的不可用值。现有 App/桌面已实现这些协议时，不需要为本次修复新增客户端代码。
4. 同时检查服务端和目标输入能力的 `features.fileUpload=true`，以及服务端、目标电脑和输入能力三处的 `input_attachments_v1`。不能硬编码为开启，也不能根据 WS 在线或仅服务端开启推断目标电脑支持上传。
5. 保留未提交的草稿与本地附件；有原上传 ID 时先核对原状态，避免因未知结果而重复申请。按既有 file-policy 和模型能力校验后，重试上传与发送。

产物发布同样按 `artifactPublish` 判断；历史产物下载按独立 `artifactDownload` 判断，不因新写入不可用隐藏已授权历史文件。默认网关准入并不保证网络上传永远成功，实际 NOS 错误仍执行原失败处理。

## 4. 鉴权要求

全局能力查询使用当前账号 JWT Bearer。设备、输入与文件接口继续携带当前客户端自己的 `X-Remote-Device-Credential`，目标电脑 ID 放在对应路径，不可拿目标电脑凭据冒充调用方。Cookie 不能替代 Bearer；账号和空间由服务端推导，不新增 `userId`、NOS URL、bucket 或凭据字段。

同账号/空间访问、控制授权、目标能力、有效连接和上传/下载上下文仍由现有接口逐项校验。历史文件读取继续走服务端鉴权接口，本次未改变其权限规则。

## 5. 发布及兼容性

本次无需新 SQL 迁移；既有文件功能所需的数据库版本应保持当前部署要求。不变更协议版本，不要求旧客户端同步升级，不需重配现有分享 NOS。尚未部署的服务仍可能返回旧能力；滚动期间应在服务节点全部升级后执行桌面重启及 App 能力刷新。

本说明仅描述本次修复，不代表测试环境已部署或真实附件上传已完成验证。服务端测试按项目约定不自动执行，具体编译结果见本次交付说明。
