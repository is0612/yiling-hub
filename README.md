# Yiling Hub — 忆灵小窝（多角色 AI 养成）

一个用于管理多角色 AI、周期性记忆快照和长期记忆的项目。

> 当前状态：角色档案、记忆周期设置、对话录入、快照版本和周期任务已接入 PostgreSQL。周期 Worker 已接入 OpenAI-compatible 模型调用，可生成周期语义总结、识别有来源支持的事实/偏好变化，并维护长期记忆；AI 对话可按身份隔离读取角色全局记忆与当前用户私人记忆。管理员登录、服务端会话、CSRF 校验、登录限流、管理员改密与登录设备管理、多用户（管理员 + 邮箱注册用户）与账号管理已实现；QQ 小号（OneBot）与 B站 渠道适配器已接入，公网部署加固仍待后续阶段完成。

## 周期任务调度（开发阶段）

- 手动扫描一次已到期的周期：`yarn scheduler:run`
- 在独立终端每 60 秒扫描一次：`yarn scheduler:watch`
- 调整扫描间隔：在环境变量中设置 `YILING_MEMORY_SCHEDULER_INTERVAL_MS`（单位毫秒，最小 5000）。

调度器会把到期周期写入 PostgreSQL 的任务队列，并推进下一周期边界。独立 Worker 的命令：

- 单次执行一条任务：`yarn worker:run`
- 持续消费任务队列：`yarn worker:watch`
- 调整 Worker 轮询间隔：`YILING_MEMORY_WORKER_INTERVAL_MS`（毫秒，最小 1000）。

Worker 配置模型后会调用 LLM 对周期对话进行结构化总结，验证来源消息 ID，再将快照、长期记忆新增/更新/失效和审计记录放入同一数据库事务。模型未配置时会保留队列任务；失败时按退避策略重试。可运行 `yarn test:scheduler`、`yarn test:scheduler-db` 和 `yarn test:memory-ai` 检查周期边界、数据库调度幂等性与来源校验。

## 原始消息保留期限与自动清理

- 角色记忆设置支持永久保留、30 天、90 天或 180 天。新角色默认永久保留原始消息。有限保留天数与清理授权分开保存，只有用户明确确认授权后才会执行删除；旧角色的历史有限保留值不会自动启用清理；该配置独立于默认 8 天的快照生成周期。
- Scheduler 会把过期清理写入 PostgreSQL 任务队列；Worker 会先确认更早的快照任务没有待处理或失败项，之后才删除到期原文。
- 原始消息删除、任务成功状态与审计记录在同一数据库事务中提交。快照、长期记忆和来源追溯记录会保留，后台任务页展示审计中记录的实际删除数量与截止时间。
- 清理不能恢复原文。启用前请核对角色的保留期限，并做好数据库备份。若清理被失败的旧快照阻塞，应先处理对应快照任务。
- 验证相关逻辑可运行 `yarn test:scheduler-db`；CI 还会通过本地模拟模型执行 API 端到端验收，包括清理任务的取消和重新入队。

## AI 快照重新提炼与任务控制

- 自动 AI 快照支持重新提炼：系统将 `REGENERATE_SNAPSHOT` 写入任务队列，由 Worker 在原 `snapshotKey` 下创建新版本并保留旧版本。为避免历史周期重放意外改写当前长期记忆，重新提炼提出的记忆变化只显示审核，不会自动应用。审核清单与正常生成共用同一套置信度和来源消息校验（未通过的只计数并标出「另 N 条未通过来源校验」），`UPDATE`/`INVALIDATE` 类建议会带上被指向记忆的原文做对照；列表项的「待审核 N」提示能直接看出哪一份版本有待处理建议。
- 待审核建议可以逐条**采纳**或**忽略**：采纳调用与周期任务相同的落库逻辑（去重、来源消息、审计齐全），忽略只记录决定、不动记忆。处置结果写在独立表 `memory_reviews`，不回写快照正文；目标记忆若已被后续归档改动，采纳会返回 409 并提示只能忽略。
- 任务监控支持取消等待执行/等待重试任务，并将失败、待重试或已取消的周期快照、快照重新提炼和原始消息清理任务手动重新入队；两种操作都会留下审计记录，运行中任务不能被强制终止。

## AI 对话与相关记忆检索（本地开发）

- 在角色档案的侧边栏打开“AI 对话”，可以创建新会话、继续历史会话并保存消息到 PostgreSQL。
- 每次回复只携带最近 20 条会话消息、按当前话题匹配的最多 8 条活动长期记忆和最多 4 份当前快照；不会把整个记忆库塞入模型上下文。
- 模型引用的长期记忆/快照 ID 会按本次实际提供的来源白名单过滤；聊天页面会展示通过验证的来源，并用「私人」标签区分当前用户自己的私人记忆。
- 检索范围按身份隔离：总是包含角色全局记忆，另外只包含当前用户自己的私人记忆范围（`USER_PRIVATE`）。其他人的私人记忆、未验证外部身份绑定的范围、其他类型的范围一律不参与检索；提示词里只标注 `character` / `private` 语义，不发送范围 ID 或用户 ID。会话本身仍保存在角色全局范围下，历史消息结构不变。
- 在角色页「新增长期记忆」里可以选择「角色全局」或「我的私人」，私人记忆只在你与该角色对话时参与检索，并在时间线中标注为「私人记忆」。
- 历史会话支持按标题/消息内容搜索、重命名、归档与恢复；归档不会删除消息或来源记录，归档会话只读。完整对话可以导出为 Markdown，AI 回复可一键复制。
- 每个角色的“AI 对话 → 模型参数”可填写 API Base URL、API Key、模型名称、温度和最大输出 Token，并可直接测试 API 连通性；聊天和周期记忆 Worker 都会使用该角色的配置。
- API Key 使用 AES-256-GCM 加密后保存，网页不会读取或回显密钥原文。加密密钥会自动生成在本机 `.data/credentials-encryption.key`，该文件已被 Git 忽略；备份/迁移数据库时必须一并保管，丢失后需要重新填写 API Key。
- `LLM_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL` 现在是可选的服务端默认/兼容配置；没有填写角色 API 时才会按规则回退。业务接口需要登录会话，本地开发保留受限回退；QQ 小号（OneBot）与 B站 Channel Adapter 已接入。
- 检索逻辑可运行 `yarn test:memory-retrieval` 测试；角色模型参数和全局 Key 的供应商隔离可运行 `yarn test:chat-model-config` 测试；提示词凭据隔离、来源 ID 校验和异常模型响应可运行 `yarn test:chat-reply` 测试；私人记忆范围隔离（纯逻辑 + 数据库查询）可运行 `yarn test:chat-private-memory` 和 `yarn test:chat-private-memory-db` 测试。

## 管理员登录、注册与账号管理

- 登录页在 `/login`，使用 `DEV_OWNER_USERNAME` / `DEV_OWNER_PASSWORD` 创建的账号登录（由 `yarn db:seed:dev` 写入）。密码用 scrypt 存储与校验。
- 会话保存在 PostgreSQL `sessions` 表，浏览器只持有 HttpOnly、SameSite=Strict 的 `yiling_session` Cookie；数据库只存该令牌的 SHA-256 哈希。有效期由 `AUTH_SESSION_TTL_HOURS` 控制（1–720，默认 12）。生产环境（或 `YILING_COOKIE_SECURE=true`）自动加 `Secure`。
- 所有 `/api` 业务接口都在服务端从会话取身份；未登录返回 401。所有 `/api` 请求都会校验 `Origin` / `Sec-Fetch-Site` 与当前 Host 一致，跨源/跨站请求返回 403。
- 登录失败按用户名（15 分钟 5 次）与来源地址（15 分钟 20 次）限流，超过返回 429；成功登录会清除该账号的失败记录。失败记录保存在 `login_attempts` 表，来源地址只存哈希。
- 本地开发默认仍允许免登录回退：`yarn dev` + `YILING_LOCAL_API_ENABLED=true` + 通过 localhost 访问 + 未关闭 `YILING_ALLOW_DEV_OWNER_BYPASS` 时，以 `DEV_OWNER_ID` 身份运行，侧边栏会标注「本地开发身份」。把 `YILING_ALLOW_DEV_OWNER_BYPASS=false` 写进 `.env` 即可强制本地也走真实登录；生产构建没有这个回退。
- 携带失效或已撤销的 Cookie 时不会回退成开发身份，而是要求重新登录，避免「看起来已登录、实际是以开发用户操作」的错觉。
- 系统设置页的「账户与安全」可以修改自己的密码，并列出当前有效登录设备（设备名由 User-Agent 派生）、撤销单个会话或退出其他所有设备。改密成功后其他会话立即失效，当前会话保留；新密码要求 10–128 个字符且同时包含字母与数字。
- 相关操作写入 `audit_logs`：`auth.password_changed`、`auth.session_revoked`、`auth.sessions_revoked`、`admin.user_updated`。
- 验证命令：`yarn test:auth`（哈希、Cookie 属性、同源矩阵、身份回退决策、限流阈值、密码策略、设备名派生、管理员判定）与 `yarn test:auth-db`（会话签发/过期/撤销、停用账号拒绝、哈希存储、限流计数、设备列表、越权撤销拒绝、退出其他设备、改密与旧密码失效、角色读写）。完整登录/登出/限流/改密/会话撤销流程在冒烟脚本中覆盖。

### 多用户：管理员 + 邮箱注册用户

- 账号分两档：`User.role` 为 `ADMIN`（唯一管理员）或 `USER`。管理员只能有一个来源——`db:seed:dev` 种下的账号（迁移会把迁移前已有的账号统一提升为 ADMIN）。
- 普通用户用邮箱自助注册：登录页「用邮箱注册」进入 `/register`，邮箱即登录标识（存入 `email` 唯一列和 `username`），注册后自动登录。**注册默认关闭**，部署到服务器后再把 `YILING_ALLOW_REGISTRATION=true` 写进环境变量开放；不发送验证邮件（本部署无 SMTP），注册 IP 只存哈希。
- 每个用户拥有独立的数据空间：所有角色/记忆/会话都按会话里的 `userId` 过滤，用户之间天然互不可见。
- 管理员在「用户管理」页（`/users`）查看账号列表与统计（角色数、注册时间、最后活跃）、停用/启用账号、重置密码。该页**不展示**任何人的对话或记忆内容；停用账号会立即让对方的会话失效。
- 普通用户看不到「QQ 渠道 / B站值班台 / 任务监控 / 用户管理 / 系统设置」这些系统管理入口，访问对应接口返回 403。

### QQ 小号渠道（OneBot v11）

- 通过 OneBot v11 网关（NapCat / SnowLuma 等）挂**个人 QQ 号**，支持群聊与私聊消息；`qq-onebot` 是当前唯一的 QQ 通道。
- 流程：管理员在「系统管理 → QQ 渠道」（`/qq`）添加 QQ 小号连接（WS/HTTP 地址与 Token 加密入库）并绑定角色 → 跑适配器 → 收到消息后按绑定路由到角色，检索该角色全局记忆生成回复，持久化对话并回发平台；同一消息重复投递会被幂等去重。
- 启动：`yarn onebot:stack`（或双击 `scripts/start-qq.bat`）会**先把协议端拉起来、等 3001/3002 通了再挂适配器**，一个窗口管到底；协议端已经自己跑着就用 `yarn onebot:run`。协议端不在默认目录时设 `SNOWLUMA_HOME`。
- 页面顶部有四步接入引导（装 SnowLuma 或 NapCat、开 3001/3002、填连接并绑角色、跑适配器），完整部署清单见 `docs/qq-onebot-deploy.md`。
- 端点与 Token 加密入库，管理员在「连接设置」里能回显明文核对；同一个 QQ 号再保存是更新同一条连接。
- 端点可用 `ONEBOT_WS_URL` / `ONEBOT_HTTP_URL` 覆盖，本地联调用 `scripts/mock-onebot-gateway.mjs` 模拟网关。
- 验证命令：`yarn test:onebot`（端到端：事件接入、凭据解密、绑定路由、记忆检索、模型回复、持久化、回发与幂等去重）。
- 主动私聊已实现：角色可在「运行中」且你跟她 QQ 私聊过之后，自己想开口时先发一条消息（默认关闭，设置与闸门见 `docs/proactive-messaging.md`，进程为 `yarn proactive:run`）；群聊里的主动参与还没有。
- 群聊刷 B站：连接设置里填「主人 QQ 号」并勾选开关后，只有该 QQ 在群里 @ 她说「去刷一轮 B站」才会触发；执行与值班台「跑一轮」相同的 `runDutyRound`，额度/评论/收藏/动态照常生效。其他群友说同一句话会被忽略。验证命令：`yarn test:onebot-bili-run` 与 `yarn test:onebot`。

## B站 值班台

- 命令台不再手写固定清单：每次读 `bili schema`（5 分钟缓存）自动同步 CLI 的全部命令（本机 102 条 + 面板入口共 107 条），CLI 不可用时回退手写目录。侧栏仍只默认展开常用命令，其余在「菜单管理」里打开；验证命令 `yarn test:bili-schema`。
- 值班设置新增「日报写多细」：`full` 写挑中 + 跳过 + 过程，`brief` 只写挑中，`off` 只记额度和判重。
- 「重置今日额度」只把当天已挑条数清零（`duty.quotaResetAt`），报告和判重记录不删；适配器每轮会重新读配置。
- 「她的札记」直接编辑角色全局长期记忆里的 EVENT 条目：列表、补写、编辑、软删除（进记忆回收站），改动写审计。接口为 `/api/admin/bili/journal` 与 `/api/admin/bili/duty/reset`。
- 群发言限流：绑定角色时可设「本群每 10 分钟最多回复几条」，0 = 不限；填 4 表示第 5 条起静默。只统计这条鱼在该群的回复，不改模型和记忆；配置在绑定 `config.replyWindowMinutes` / `replyLimitPerWindow`（旧 `replyLimitPer10Min` 兼容）。
- 群公告（可选，默认关闭）：群主/管理员 @ 小号说「写个群公告：主题」，角色先拟草稿；管理员回复「确认发布」后才调用 SnowLuma 的 `_send_group_notice`。普通成员触发无效，草稿 10 分钟过期，发布成功/失败都写审计。前提是小号已是群管理员；踢人、禁言等动作不在本期范围。验证命令：`yarn test:onebot-announcement` 与 `yarn test:onebot`。
- 已知限制：v1 只检索角色全局记忆，尚未按外部用户隔离私人记忆；断线重连仍需后续完善。
- QQ 官方机器人渠道（AppID + AppSecret 走开放平台网关）已于 2026-10-27 下线，只保留 OneBot。库里若残留 `platform = "qq"` 的连接，适配器不加载、也不会显示在 QQ 渠道页（该页只列 `qq-onebot`），可以直接忽略；要清掉需操作数据库。

### 部署、备份与健康检查（Phase 6）

- 备份：双击 `scripts/backup-db.bat`（或 `.\scripts\backup-db.ps1`），在 `backups/` 生成带时间戳的 `.dump`；脚本会自动定位 `docker.exe`，不依赖 PATH。
- 恢复：把 `.dump` 拖到 `scripts/restore-db.bat` 上（或 `.\scripts\restore-db.ps1 -BackupFile ... -ConfirmOverwrite`）。备份/恢复已做过真实数据演练（恢复到临时库并逐表核对一致）。
- 健康检查：`GET /api/health`（存活，无需登录）、`GET /api/admin/health`（仅管理员：数据库连通性 + 任务队列计数）。
- HTTPS、反向代理、监控告警、日志轮转、数据删除策略与扩展说明见 `docs/deployment.md`。

## 从哪里开始

- [产品与技术开发方案 V1.2](docs/product-and-technical-plan.md)
- [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)
- [记忆系统与周期快照规则](docs/memory-system.md)
- [忆泡设计构想（未实现）](docs/忆泡设计构想.md)
- [数据模型设计](docs/data-model.md)
- [Prisma Schema](prisma/schema.prisma)
- [Phase 0 审查清单](docs/phase-0-review-checklist.md)
- [OpenAPI 契约](docs/openapi.yaml)
- [安全规范](docs/security.md)
- [开发阶段与验收标准](docs/development-phases.md)
- [项目 AI 协作约束](CLAUDE.md)
- 长期记忆生命周期：编辑、归档、标记失效、移入回收站、按原状态恢复，以及仅对回收站条目开放的永久删除。
- 历史保护：永久删除当前记忆条目时，不改写已有快照；已保存的快照副本和来源记录继续保留。

## 核心原则

1. 区分原始消息、周期性快照与长期记忆。
2. 记忆快照默认每 8 天生成一次；该周期可按角色调整，**不是原始消息的保留期限**。
3. 快照重新生成采用版本化，不无痕覆盖旧版本。
4. 前端 Mock、API 与后端遵守同一份数据契约。
5. 本地使用 PostgreSQL + Docker 开发；数据通过逻辑备份迁移，不依赖复制 Docker 数据卷。
6. 核心后台任务应由可恢复的 Worker 执行，不依赖 Web 进程内的定时器保证可靠性。
7. 当前本地 API 是开发过渡层；管理员认证上线前，生产环境会拒绝这些 API。

## 当前技术栈

- 前端与服务端入口：Vue 3 + Nuxt 4 + TypeScript
- UI：Element Plus（通过官方 Nuxt 模块集成）
- 开发服务器与生产构建：Vite（Nuxt 默认使用，无需另建独立 Vite 应用）
- 数据库：PostgreSQL
- ORM：Prisma 7（通过 PostgreSQL driver adapter）
- 本地容器：Docker Compose
- 后台任务：独立 Node.js Worker + PostgreSQL 持久化任务队列

## 本地运行

需要 Node.js 22、Yarn Classic 1.22.22 和 Docker Desktop。

### 1. 配置本地环境

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少修改 `POSTGRES_PASSWORD`、`DATABASE_URL` 中对应的密码，以及 `DEV_OWNER_PASSWORD`（至少 12 位）。三处数据库用户名、密码、端口与数据库名必须匹配。模型 API 推荐在角色的“AI 对话 → 模型参数”中填写；若你仍配置 `LLM_API_KEY`、`LLM_MODEL`、`LLM_BASE_URL`，它们只作为默认回退配置。请勿把真实密钥提交到 Git。

### 2. 安装并启动数据库

```powershell
yarn install
docker compose up -d db
docker compose ps
yarn run db:format
yarn run db:validate
```

### 3. 应用数据库迁移并生成 Client

```powershell
yarn run db:migrate:deploy
yarn run db:generate
yarn run db:seed:dev
```

仓库已包含初始迁移 `prisma/migrations/20261023000000_init/migration.sql`，会创建项目定义的数据库表。该初始迁移面向全新、空的本地开发数据库。如果数据库中已有重要数据或手动创建的表，先停止并备份，不要直接运行迁移。`db:seed:dev` 只创建/更新 `.env` 指定的本地开发用户，不会植入演示角色。

### 4. 启动后台

```powershell
yarn run dev
```

在浏览器打开 `http://localhost:3000`。角色列表、角色创建/编辑、记忆周期设置、手动新增长期记忆、消息录入、时间线和快照版本会读写 PostgreSQL。周期任务通过 `yarn scheduler:run` 入队，由 `yarn worker:run` 处理；调试时可分别运行 watch 模式。周期总结和长期记忆提炼需要先配置服务端模型参数。自动记忆仅采纳带有本周期原始消息证据、且通过来源 ID 校验的模型结果。公网部署加固仍待完成。

## 本地全量校验

日常开发完成后，可以在项目根目录运行一条命令执行主要静态检查、自动化测试和生产构建：

```powershell
yarn verify:local
```

该命令会校验 Prisma Schema、重新生成 Prisma Client、准备 Nuxt 类型信息，并依次运行 TypeScript 检查、周期调度单元测试、PostgreSQL 调度与清理集成测试、AI 来源校验与请求凭据隔离、记忆检索测试、角色模型参数测试、聊天提示词凭据隔离测试、私人记忆范围隔离测试（含数据库集成）、聊天请求幂等数据库测试、登录会话与 CSRF 单元测试、会话与登录限流数据库测试、跨平台身份隔离测试、QQ 小号（OneBot）端到端测试（自带模拟网关与模拟模型）、B站 命令目录/值班判定/解析层单元测试与 B站 数据库集成测试，最后是 ESLint 和生产构建。

运行前请先启动 PostgreSQL，并确认 `.env` 中的 `DATABASE_URL` 指向本机开发/测试数据库，且已应用仓库迁移。数据库集成测试会创建并清理临时数据；不要将该命令指向包含重要数据的数据库。该命令不会自动重置数据库，也不会启动 Nuxt 服务；QQ 小号测试会自行拉起模拟网关与模拟模型服务。B站 相关测试不需要本机安装 bili CLI。

GitHub Actions 还会额外启动本地模拟模型与 Nuxt，执行完整 API 冒烟测试，并检查数据库迁移与 OpenAPI 契约。真实供应商模型验证、Windows 实际备份/恢复演练和公开部署安全审查仍需单独完成。

## 本地 API 安全说明

业务接口现在要求登录会话；本地开发为了方便调试，额外提供一条受限回退：只有 `YILING_LOCAL_API_ENABLED=true`、`YILING_ALLOW_DEV_OWNER_BYPASS` 未关闭、通过 `localhost`/回环 Host 访问、且运行在开发构建中时，才会以 `DEV_OWNER_ID` 身份放行。Nuxt 开发服务器默认绑定 `127.0.0.1`。生产构建不接受这条回退，必须登录。

回退只是本地便利，不代表可以把这个开发服务暴露出去：不要通过 `--host 0.0.0.0` 覆盖回环绑定，也不要把开发数据库或开发服务接入局域网/公网。公开部署前还需要 HTTPS、反向代理信任配置、数据库不对外暴露、备份恢复演练等部署侧工作，见 [安全规范](docs/security.md)。

数据备份和换电脑迁移流程见 [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)。
