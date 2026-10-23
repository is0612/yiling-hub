# Yiling Hub — 多角色 AI 养成中枢

一个用于管理多角色 AI、周期性记忆快照和长期记忆的项目。

> 当前状态：项目规划与开发准备阶段。此仓库目前先建立产品和工程规范；不要把文档中的计划误认为功能已经实现。

## 从哪里开始

- [产品与技术开发方案 V1.2](docs/product-and-technical-plan.md)
- [本地开发与数据迁移规范](docs/local-development-and-data-migration.md)
- [记忆系统与周期快照规则](docs/memory-system.md)
- [数据模型设计](docs/data-model.md)
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

- 前端与 API：Next.js App Router + TypeScript
- UI：Tailwind CSS + shadcn/ui
- 数据库：PostgreSQL
- ORM：Prisma
- 本地容器：Docker Compose
- 后台任务：后续阶段增加独立 Node.js Worker

具体实施以 `docs/` 中的正式规范为准。