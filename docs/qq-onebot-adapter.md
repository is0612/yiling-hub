# QQ 小号（OneBot v11）渠道接入设计

## 1. 背景与定位

yiling-hub 目前已有 **QQ 官方机器人** 渠道（`channel-adapter/qq.ts`，走 QQ 开放平台
WebSocket Gateway + OAuth2 app token）。但用户最终想养的是「QQ 小号挂 AI」——即用一个
**个人 QQ 号**（仿真群友 / 好友），而不是官方机器人号。

这种形态需要走 **OneBot v11 协议**：通过一个挂载在 QQ 客户端里的第三方网关（如
SnowLuma），把 QQ 消息转成 OneBot v11 事件推送给 yiling-hub，yiling-hub 再通过 OneBot
HTTP API 把回复发回 QQ。

本方案**新增并行渠道** `qq-onebot`，**保留**官方机器人 `qq`，两者互不影响、可同时接
不同的号。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|--------|------|
| 官方机器人如何处理 | **新增并行渠道**，不删除 `qq.ts` |
| 平台标识 | **`qq-onebot`**，与官方 `qq` 区分，记忆/身份严格隔离 |
| 协议 | OneBot v11，**正向 WebSocket**（yiling-hub 作为 WS 客户端连网关） |
| 网关 | SnowLuma（或任何兼容 OneBot v11 的实现），部署/登录由用户自理 |
| 大脑 | **yiling-hub 自己的模型 + 记忆**（不复用 qq-bridge 的 DSH） |

> 参考项目：`github.com/Derpyu520/qq-bridge`。它用 SnowLuma + OneBot v11 把 QQ 消息桥
> 接给 DSH。yiling-hub 借鉴其「SnowLuma 作 OneBot 网关」的思路，但大脑换成自己的
> `handleChannelMessage` 流水线（角色人格 + 分层记忆 + 跨平台身份绑定）。

## 3. 架构

```
个人 QQ 号（小号）
   │  消息收发（挂在 QQ 客户端进程里的原生 Hook）
   ▼
SnowLuma 网关（用户自行部署、扫码登录 QQ）
   │  OneBot v11 正向 WebSocket（ws://127.0.0.1:3001）
   │  OneBot v11 HTTP API     （http://127.0.0.1:3000）
   ▼
yiling-hub onebot 适配器（channel-adapter/onebot/）
   │  client.ts     —— WS 连接、心跳、事件解析、断线重连
   │  serve.ts      —— 事件 → 通用流水线 handleChannelMessage
   │  configure.ts  —— 从 DB 加载连接（解密 wsUrl / accessToken）
   ▼
通用渠道流水线 pipeline.ts
   ├─ 角色绑定 CharacterChannelBinding
   ├─ 外部身份 ExternalIdentity(platform="qq-onebot", uid=QQ号)  + 身份记忆范围
   ├─ 记忆检索（角色全局 + 本人身份私人记忆）
   └─ 模型回复 → 持久化 → 发回 QQ
```

## 4. 平台标识与记忆隔离

- `platform = "qq-onebot"`，与官方 `qq` 是两个独立平台。
- `ExternalIdentity.platformUid` 用 **QQ 号（user_id）**，而非官方 bot 的 openid。
- `MemoryScope.scopeKey = character:{cid}:external:qq-onebot:{qq号}`，与官方 `qq`、
  B站 `bili` 的记忆天然隔离，互不串味。
- 若同一 QQ 号同时是官方机器人绑定用户 + 小号，仍视为**两个外部身份**，除非管理员
  在「身份管理」里显式验证绑定到同一个 yiling-hub 用户。

## 5. OneBot v11 事件与字段映射

| OneBot v11 事件 | post_type | message_type | 会话 key | 平台 uid |
|-----------------|-----------|--------------|----------|----------|
| 私聊消息 | message | private | `c:<user_id>` | `user_id` |
| 群聊消息 | message | group | `g:<group_id>` | `user_id`（发消息的人） |
| 群临时会话 | message | group | `c:<user_id>` | `user_id` |

其他事件（notice / request / meta_event）默认忽略，仅处理 `post_type === "message"`
且 `message_type` 为 `private` / `group`。

- `externalMessageId` = `message_id`（幂等去重）。
- `externalConversationId` = 上述会话 key。
- `authorPlatformUid` = `user_id`（字符串化），用于 upsert ExternalIdentity。
- `authorDisplayName` = `sender.nickname` / `sender.card`（群名片优先）。

## 6. 消息解析

OneBot v11 的 `message` 字段是**分段数组**（CQ 码），例如：

```json
[
  { "type": "text", "data": { "text": "你好" } },
  { "type": "at",   "data": { "qq": "123456" } },
  { "type": "image", "data": { "url": "http://..." } }
]
```

适配器把文本段拼成 `content`；`at` 段转换为 `@qq号`；图片/表情/语音等非文本段用占位
符（`[图片]`/`[表情]`/`[语音]`）表示，不下载媒体（对齐 qq-bridge 的占位策略）。

## 7. 回复发送

- 私聊 → `send_private_msg`（`user_id`, `message`, 可选 `auto_escape`）。
- 群聊 → `send_group_msg`（`group_id`, `message`）。
- 群聊中被 @ 时才回复的开关（`replyOnlyWhenMentioned`）由连接配置控制；私聊总是回复。
- 回复按 OneBot HTTP API 发送（默认 `http://127.0.0.1:3000`），带 `Authorization:
  Bearer <token>` 头（SnowLuma 的 HTTP token 与 WS token 可能不同，分别配置）。

## 8. 配置字段（存储于 PlatformConnection）

平台标识：`qq-onebot`。`credentialsCiphertext` 内加密 JSON：

```json
{
  "wsUrl": "ws://127.0.0.1:3001",
  "httpUrl": "http://127.0.0.1:3000",
  "accessToken": "ws-token",
  "httpToken": "http-token",
  "replyOnlyWhenMentioned": true
}
```

- `accessToken`：WS 鉴权（OneBot v11 里通常作为 `Authorization` 头，或实现自定义）。
- `httpToken`：HTTP API 鉴权（SnowLuma 的 HTTP token 与 WS token 是**不同值**）。
- 环境变量兜底：`ONEBOT_WS_URL` / `ONEBOT_HTTP_URL` / `ONEBOT_TOKEN`。

## 9. 断线重连与状态

- 客户端维护 WS 心跳（OneBot v11 无标准心跳，SnowLuma 靠 WS 层 + 定时
  `get_status` 探活；适配器每 30s 探活一次，失败即重连）。
- 重连指数退避（1s/2s/4s…上限 30s）。
- 连接状态回写 `PlatformConnection.status`：`CONNECTED` / `ERROR` / `DISCONNECTED`。

## 10. 与 qq-bridge 的差异

| 维度 | qq-bridge | yiling-hub onebot |
|------|-----------|-------------------|
| 大脑 | DSH agent | yiling-hub 角色 + 分层记忆 |
| 会话模型 | 每个 QQ 会话一个 DSH 会话 | 每个 externalConversationId 一条 Conversation |
| 记忆 | DSH 自身 | MemoryItem / MemorySnapshot，按身份范围隔离 |
| 工具 | MCP（发消息/搜网） | 复用 yiling-hub 通用流水线（暂无 MCP 工具） |
| 身份 | QQ 号 | ExternalIdentity + 跨平台绑定（可汇聚到同一用户） |

## 11. 分阶段

- **M1（本次）**：OneBot v11 协议层 + 配置加载 + 消息处理 + runner + mock 测试。
- **M2（后续）**：主动回复 / 仿真群友状态机（借鉴 qq-bridge 的 reserved 模式）。
- **M3（后续）**：语音/图片媒体下载与识别（接入多模态）。
