# Yiling Hub — 多角色 AI 养成中枢

一个用于管理多角色 AI、周期性记忆快照和长期记忆的项目。

> 当前状态：角色档案、记忆周期设置、对话录入、快照版本和周期任务已接入 PostgreSQL。周期 Worker 已接入 OpenAI-compatible 模型调用，可生成周期语义总结、识别有来源支持的事实/偏好变化，并维护长期记忆；真实渠道适配器、正式管理员登录和公网部署安全仍待后续阶段完成。

## 周期任务调度（开发阶段）

- 手动扫描一次已到期的周期：`yarn scheduler:run`
- 在独立终端每 60 秒扫描一次：`yarn scheduler:watch`
- 调整扫描间隔：在环境变量中设置 `YILING_MEMORY_SCHEDULER_INTERVAL_MS`（单位毫秒，最小 5000）。

调度器会把到期周期写入 PostgreSQL 的任务队列，并推进下一周期边界。独立 Worker 的命令：

- 单次执行一条任务：`yarn worker:run`
- 持续消费任务队列：`yarn worker:watch`
- 调整 Worker 轮询间隔：`YILING_MEMORY_WORKER_INTERVAL_MS`（毫秒，最小 1000）。

Worker 配置模型后会调用 LLM 对周期对话进行结构化总结，验证来源消息 ID，再将快照、长期记忆新增/更新/失效和审计记录放入同一数据库事务。模型未配置时会保留队列任务；失败时按退避策略重试。可运行 `yarn test:scheduler` 和 `yarn test:memory-ai` 执行周期边界与来源校验测试。

## AI 对话与相关记忆检索（本地开发）

- 在角色档案的侧边栏打开“AI 对话”，可以创建新会话、继续历史会话并保存消息到 PostgreSQL。
- 每次回复只携带最近 20 条会话消息、按当前话题匹配的最多 8 条活动长期记忆和最多 4 份当前快照；不会把整个记忆库塞入模型上下文。
- 模型引用的长期记忆/快照 ID 会按本次实际提供的来源白名单过滤；聊天页面会展示通过验证的来源。当前版本只使用角色全局记忆，不把不同用户的私人记忆混入上下文。
- 历史会话支持按标题/消息内容搜索、归档与恢复；归档不会删除消息或来源记录，归档会话只读。可以将完整会话分批读取并导出为 Markdown，内容包含消息时间和已验证的记忆来源。
- 需要服务端配置 `LLM_API_KEY`、`LLM_MODEL`，必要时设置 `LLM_BASE_URL`。开发接口仍仅限本机访问；真实渠道 Adapter 与正式管理员登录尚未完成。
- 检索逻辑可运行 `yarn test:memory-retrieval` 测试。

## 从哪里开始

- [产品与技术开发方案 V1.2](docs/product-and-technical-plan.md)
- [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)
- [记忆系统与周期快照规则](docs/memory-system.md)
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
- 后台任务：后续阶段增加独立 Node.js Worker

## 本地运行

需要 Node.js 22、Yarn Classic 1.22.22 和 Docker Desktop。

### 1. 配置本地环境

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少修改 `POSTGRES_PASSWORD`、`DATABASE_URL` 中对应的密码，以及 `DEV_OWNER_PASSWORD`（至少 12 位）。三处数据库用户名、密码、端口与数据库名必须匹配。配置真实模型调用时还需填写 `LLM_API_KEY` 和 `LLM_MODEL`；兼容 OpenAI Chat Completions 的服务可通过 `LLM_BASE_URL` 指定地址。密钥必须只保存在服务端 `.env` 中。请勿把 `.env` 提交到 Git。

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

在浏览器打开 `http://localhost:3000`。角色列表、角色创建/编辑、记忆周期设置、手动新增长期记忆、消息录入、时间线和快照版本会读写 PostgreSQL。周期任务通过 `yarn scheduler:run` 入队，由 `yarn worker:run` 处理；调试时可分别运行 watch 模式。周期总结和长期记忆提炼需要先配置服务端模型参数。自动记忆仅采纳带有本周期原始消息证据、且通过来源 ID 校验的模型结果。真实聊天渠道适配、正式管理员登录和公网部署安全仍待完成。

## 本地 API 安全说明

本阶段 API 只在 Nuxt 开发构建中可用，且必须显式设置 `YILING_LOCAL_API_ENABLED=true` 并通过 `localhost`/回环 Host 访问；Nuxt 开发服务器默认绑定 `127.0.0.1`。生产构建会拒绝这些请求。管理员登录、会话管理、正式权限校验必须在服务公开部署前完成；不要通过 `--host 0.0.0.0` 覆盖回环绑定，或把本地开发 API 暴露给局域网/公网。

数据备份和换电脑迁移流程见 [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)。
