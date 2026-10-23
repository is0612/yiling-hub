# Yiling Hub — 多角色 AI 养成中枢

一个用于管理多角色 AI、周期性记忆快照和长期记忆的项目。

> 当前状态：项目基础规范、数据库模型和管理后台 Mock 原型已建立。页面交互仍为演示状态，不代表真实 API、数据库持久化、认证或后台任务已经实现。

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

## 当前约定

- 前端与服务端入口：Vue 3 + Nuxt 4 + TypeScript
- UI：Element Plus（通过官方 Nuxt 模块集成）
- 开发服务器与生产构建：Vite（Nuxt 默认使用，无需另建独立 Vite 应用）
- 数据库：PostgreSQL
- ORM：Prisma
- 本地容器：Docker Compose
- 后台任务：后续阶段增加独立 Node.js Worker

具体实施以 `docs/` 中的正式规范为准。

## 本地运行（前端演示阶段）

需要安装 Node.js 22、npm 和 Docker Desktop（数据库现在不是启动前端预览的必要条件）。

```powershell
Copy-Item .env.example .env
# 编辑 .env，将 POSTGRES_PASSWORD 改成自己的本地开发密码
npm install
npm run dev
```

在浏览器打开 `http://localhost:3000`。当前页面使用 Mock 演示数据，新增/编辑、重试和归档按钮只会更改当前页面状态，不会写入数据库。

如需启动本地 PostgreSQL：

```powershell
docker compose up -d db
npm run db:format
npm run db:validate
```

当前提供了 Prisma Schema，但正式迁移文件和真实 API 尚未完成；不要误以为只启动数据库就已接入持久化。换电脑和备份流程见 [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)。