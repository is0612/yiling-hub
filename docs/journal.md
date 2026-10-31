# 日记与手账

同一天有两份**独立文本**，共用当天的聊天、忆泡和人设作为素材，但写作方式和内容组织不同：

| 文本 | 回答什么问题 | 写法 |
| --- | --- | --- |
| 日记（DIARY） | 「今天发生的事让我有什么感受？」 | 第一人称叙事，150–400 字，选一到两件展开 |
| 手账（HANDBOOK） | 「今天有什么值得留下来？」 | 结构化记录：短句、列表、可选栏目 |

不能拿日记截断当手账，也不能把手账列表扩写成日记。两份可以有相同的事实，但不重复同一段表达。

## 手账的栏目

- **今日片段**：2–4 条短句，值得收藏的瞬间；不重新罗列当天所有事件。
- **今日想法**：1–2 句，必须有当天经历支撑，不写通用格言。
- **今日一句**：从日记正文里**原样摘取的连续原文**（不改写、不拼接、不加引号），服务端校验。
- **灵感与发现**：当天产生的小发现、想法或灵感，可空。
- **待续事项**：还没结束、想继续关注的事，可空。
- **标签**：1–5 个主题词。

以上都可空；没有值得记录的内容时允许整份 SKIP，不为了填满栏目硬写。手账不是每日总结，也不是第二份忆泡。

## 数据

- `character_journals`：一天一个日期主体（`@@unique([memoryScopeId, dayKey])`），状态只有 `ACTIVE` / `SKIPPED` + `skipReason`。
- `journal_revisions`：完整的版本，`kind` 区分 `DIARY` / `HANDBOOK`，版本号按 `(journalId, kind)` 各自递增（`@@unique([journalId, kind, version])`）。
  - 日记：`title` + `content`。
  - 手账：`content`（片段 / 灵感 / 待续，带 `##` 小标题）+ `thought` + `quote` + `tags`。
  - 手账的 `sourceDiaryRevisionId` 指向「这一句摘自哪一版日记」；日记重写后仍指向当时那一版，可追溯。
- 两份文本的 `sourceMessageIds` / `sourceEventIds` 各自保存；消息被清理后指针保留。

## 生成

- 任务类型 `GENERATE_JOURNAL`，每天为「昨天」（角色时区）排一次，幂等键 `journal:{globalScopeId}:{YYYY-MM-DD}`；走现有 Worker，不另起调度器。
- 取材：角色全局范围 + 角色主人的私人范围（主人 QQ 私聊）；其他用户的私人范围**不读**。按会话配额取，避免一个热闹的群把私聊挤出去。
- 生成顺序：先生成日记，再把这一版日记正文交给手账生成；手账的「一句」只能从这里摘。两份各自一次模型调用，各自可以 SKIP。
- 没有对话、或两份都判断没内容 → 日期主体落 `SKIPPED` + 原因，不写空文本。
- 模型没配或额度用完 → 任务留在队列退避重试（`maxAttempts=24`）。
- 用量记 `model_usages.kind = "journal"`，`metadata.text` 区分 diary / handbook。

## 版本与人工操作

- 编辑：`PATCH /api/characters/{id}/journals/{dayKey}` 带 `kind`，只改那一份，新建 `USER_EDITED` 版本；另一份和旧版本都不动。
- 重写：`POST .../regenerate` 带 `target`（`DIARY` / `HANDBOOK` / `BOTH`），每份各自追加 `AI_REWRITE` 版本。
- 恢复：`POST .../restore` 带 `kind` + `version`，复制成新的 `RESTORED` 版本。
- 历史：`GET .../revisions?kind=DIARY|HANDBOOK`。
- 自动任务永远不会覆盖已有文本；人工操作写审计：`journal.generated` / `journal.edited` / `journal.regenerated` / `journal.restored`。

## 次日注入

网页对话与主人私聊会把**前一天手账里的「一句」**带进提示词（字段 `journal`）；群聊与普通人的私聊不注入，整份日记/手账也不进提示词。提示词（v20）明确写：那句是她自己写的，不是对方说的，也不是关于对方的事实。拆分前的旧数据如果 quote 记在日记版本上，读取时会兜底。

## 页面

侧栏「工作空间 → 日记手账」（`/journal`）：

- 左边按天列表（日记首句、手账那句、两份各自的版本标记），右边两个 tab：日记 / 手账。
- 每份文本独立「编辑 / 重写 / 历史版本」，另一份不受影响。
- 手账按 `##` 小标题渲染成栏目；想法、一句（含「摘自第 N 版日记」）、标签单独展示。
- 「补写某一天」默认两份都补；哪份缺就补哪份。
- 和「忆泡日历」互相跳转。

## V1 不做

- 私人日记/手账（按每个用户各一份）——目前只有角色全局一本。
- 角色卡导出 / 导入不带日记与手账：跟着整个数据库走，换机器请用整库迁移。
- 看门狗暂不检查「日记/手账停了」；生成情况看任务监控里的 `GENERATE_JOURNAL`。
- 手账图片/贴纸、分享、公开、统计。

## 测试

- `yarn test:journal`：日记校验、手账栏目渲染、一句必须来自给定日记、来源白名单、SKIP。
- `yarn test:journal-db`：两份独立版本、改一份不动另一份、一句追溯、恢复、次日读取、唯一约束、级联删除、调度器。
- `yarn test:chat-reply` / `test:chat-speaker-context` / `test:chat-private-memory`：提示词版本与注入边界。
