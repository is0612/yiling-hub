# Yiling Hub — 多角色 AI 养成中枢

一个用于管理多角色 AI、周期性记忆快照和长期记忆的项目。

> 当前状态：管理后台原型已建立。Phase 2 将角色档案与记忆周期设置接入 PostgreSQL；快照、时间线、真实任务 Worker、管理员登录和渠道适配器仍按后续阶段实施。

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

需要 Node.js 22、npm 和 Docker Desktop。

### 1. 配置本地环境

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少修改 `POSTGRES_PASSWORD`、`DATABASE_URL` 中对应的密码，以及 `DEV_OWNER_PASSWORD`（至少 12 位）。三处数据库用户名、密码、端口与数据库名必须匹配。请勿把 `.env` 提交到 Git。

### 2. 安装并启动数据库

```powershell
npm install
docker compose up -d db
docker compose ps
npm run db:format
npm run db:validate
```

### 3. 应用数据库迁移并生成 Client

```powershell
npm run db:migrate:deploy
npm run db:generate
npm run db:seed:dev
```

仓库已包含初始迁移 `prisma/migrations/20261023000000_init/migration.sql`，会创建项目定义的数据库表。该初始迁移面向全新、空的本地开发数据库。如果数据库中已有重要数据或手动创建的表，先停止并备份，不要直接运行迁移。`db:seed:dev` 只创建/更新 `.env` 指定的本地开发用户，不会植入演示角色。

### 4. 启动后台

```powershell
npm run dev
```

在浏览器打开 `http://localhost:3000`。角色列表、角色创建/编辑和记忆周期设置会通过本地开发 API 读写 PostgreSQL；重新加载页面后，这些数据应当仍然存在。记忆驾驶舱里的对话时间线、周期快照和任务监控依旧是演示数据，尚未接入真实存储或 Worker。

## 本地 API 安全说明

本阶段 API 只在 Nuxt 开发构建中可用，且必须显式设置 `YILING_LOCAL_API_ENABLED=true` 并通过 `localhost`/回环 Host 访问；Nuxt 开发服务器默认绑定 `127.0.0.1`。生产构建会拒绝这些请求。管理员登录、会话管理、正式权限校验必须在服务公开部署前完成；不要通过 `--host 0.0.0.0` 覆盖回环绑定，或把本地开发 API 暴露给局域网/公网。

数据备份和换电脑迁移流程见 [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)。
