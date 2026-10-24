# 跨平台身份绑定方案

> 目标：让"同一个角色在 B站/微信/QQ 上的账号"共享人格记忆（角色全局），同时按平台隔离
> 每个外部用户的私人记忆；并提供管理员验证、绑定、解绑外部身份的能力。
>
> 这是"三平台记忆汇聚到一个角色"的关键一环 —— 隔离逻辑已就位（`resolveChatMemoryScopes`），
> 本方案补齐的是「身份写入 + 绑定管理 + UI」。

## 1. 背景：已经有什么，缺什么

**已经有的（隔离规则已实现且正确）：**

- `ExternalIdentity` 表：`platform` + `platformUid` 唯一，`status`（UNVERIFIED/VERIFIED/REVOKED），
  `linkedUserId`，`connectionId`，`metadata`。
- `MemoryScope` 支持 `EXTERNAL_IDENTITY` 类型，`externalIdentityId` 外键。
- `resolveChatMemoryScopes()` 只放行 `VERIFIED` 且 `linkedUserId === actingUserId` 的外部身份记忆；
  `CHARACTER_GLOBAL` 始终可读。未验证身份、他人身份、未知类型一律拒绝。

**缺的（本方案补齐）：**

1. **身份写入**：渠道消息进来时，没有地方创建/更新 `ExternalIdentity`（目前表是空的）。
2. **绑定管理 API**：没有"查看身份列表 / 验证绑定 / 解绑 / 撤销"的接口。
3. **前端 UI**：没有身份管理页面。
4. **渠道流水线**：`handleChannelMessage` 目前只读角色全局记忆，没有为外部身份建立/检索私人记忆。

## 2. 核心设计决策

### 2.1 身份的三态与合并规则

| 状态 | 含义 | 记忆可读 |
| --- | --- | --- |
| `UNVERIFIED` | 默认，只在某个平台出现过，未确认是谁 | 其私人记忆仅该平台该 uid 内部可读，不跨平台 |
| `VERIFIED` | 管理员确认该外部身份 = 某个 yiling-hub 用户 | 该身份的私人记忆可被 `linkedUserId` 在对话中读取 |
| `REVOKED` | 已解绑/撤销 | 记忆保留但不再参与该用户的检索 |

**关键规则（对齐 CLAUDE.md 第 4 条）：**
- 默认隔离：不同平台的同名/同昵称身份**绝不自动合并**。
- 只有管理员显式执行「验证绑定」后，`status=VERIFIED` + `linkedUserId` 才成立，私人记忆才跨平台打通。
- 绑定是**单向、显式、可撤销**的，且留审计记录。

### 2.2 记忆归属：三层清晰分工

| 层 | scopeType | 存什么 | 谁读 |
| --- | --- | --- | --- |
| 人格层 | `CHARACTER_GLOBAL` | "大肥鱼是谁"（性格/长期偏好/三观） | 所有绑定该角色的平台 |
| 平台身份层 | `EXTERNAL_IDENTITY` | "B站 uid=123 跟大肥鱼聊过啥" | 仅该外部身份（未验证）或绑定用户（已验证） |
| 站内用户层 | `USER_PRIVATE` | "yiling-hub 注册用户跟大肥鱼聊过啥" | 仅该用户 |

**结论**：三平台"汇聚"的是**人格层**（自动，天然共享）；平台互动记忆**默认隔离**，只有管理员显式绑定后才跨平台打通。这既满足"汇聚"，又满足"不乱合并"。

## 3. 实现内容

### 3.1 身份写入（渠道流水线改造）

在 `handleChannelMessage`（`channel-adapter/pipeline.ts`）里，收到消息时：

1. 用 `platform + authorOpenId`（或 `authorUid`）upsert 一条 `ExternalIdentity`（初始 `UNVERIFIED`），
   关联到当前 `connectionId`，`metadata` 存昵称/头像等。
2. 为该外部身份建立/查找 `EXTERNAL_IDENTITY` 类型的 `MemoryScope`
   （`scopeKey = character:{characterId}:external:{platform}:{platformUid}`）。
3. 会话落在该外部身份的 scope 下；检索时，`resolveChatMemoryScopes` 会自动处理：
   - 未验证身份 → 只有该身份自己的记忆 + 角色全局参与；
   - 已验证且绑定当前用户 → 额外带上该用户的私人记忆。

> 注意：B站渠道的 `authorOpenId` 目前是 `authorUid`（B站 uid）。QQ 渠道是 `user_openid`。
> 统一用 `platform + platformUid` 作为外部身份键。

### 3.2 绑定管理 API（`server/api/admin/identities/`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/admin/identities` | 列出外部身份（按平台/状态筛选，含是否已绑定、关联用户） |
| POST | `/api/admin/identities/[id]/verify` | 验证并绑定到指定 `userId`（`status=VERIFIED`, `linkedUserId`） |
| POST | `/api/admin/identities/[id]/unlink` | 解绑（`status=UNVERIFIED`，清空 `linkedUserId`） |
| POST | `/api/admin/identities/[id]/revoke` | 撤销（`status=REVOKED`） |

所有操作走 `requireAdminActor`，写审计日志（`identity.verified` / `identity.unlinked` / `identity.revoked`）。

### 3.3 前端页面（`app/pages/identities.vue`）

管理员身份管理页：
- 列出所有外部身份（平台、uid、昵称、状态、是否绑定用户、关联的角色）。
- 支持"绑定到用户"（选择 yiling-hub 用户）、"解绑"、"撤销"。
- 仅管理员可见，普通用户访问返回 403。

## 4. 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| I1 | 渠道流水线写入 `ExternalIdentity` + `EXTERNAL_IDENTITY` scope | `test:identity-ingest` 通过（B站/QQ 事件 → 身份+scope 建立，幂等） |
| I2 | 绑定管理 API（列表/验证/解绑/撤销）+ 审计 | `test:identity-admin` 通过 |
| I3 | 前端身份管理页 | 管理员可查看/绑定/解绑 |
| I4 | 检索打通：已验证身份绑定用户后，跨平台私人记忆进入检索 | `test:identity-retrieval` 通过 |

## 5. 边界与约束

- 绑定是**显式人工动作**，不做自动猜测合并（哪怕昵称相同）。
- 绑定后不影响历史：已写入的私人记忆 scope 不变，只是从"该身份可读"变为"绑定用户也可读"。
- 撤销绑定后，该身份的私人记忆不再参与绑定用户的检索，但数据保留（可追溯）。
- 所有绑定/解绑/撤销写审计日志，管理员身份管理页不展示对话/记忆正文。
