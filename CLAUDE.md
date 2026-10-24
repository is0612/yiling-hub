# Yiling Hub：AI 开发约束

在修改代码前，先阅读：
- `README.md`
- `docs/product-and-technical-plan.md`
- 与当前任务相关的 `docs/` 文档
- `docs/openapi.yaml`（涉及 API 时）
- `docs/local-development-and-data-migration.md`（涉及本地环境、数据库或部署时）

## 项目约束

1. 这是通用的多角色 AI 养成平台。角色名称、设定、模型配置和渠道必须由数据驱动，不能硬编码某个特定角色。
2. 必须区分原始消息/事件、周期快照和长期记忆。默认 8 天是快照生成间隔，不是原始消息的保留期限。
3. 快照重新生成必须创建新版本，不能无痕覆盖历史版本；重要的人工修改需要审计记录。
4. 记忆必须有明确范围：角色全局记忆与用户私人记忆不可混用。跨平台身份只有在经过验证的绑定流程后才能合并。
5. API 行为以 `docs/openapi.yaml` 为契约。修改接口时同步更新契约与相关 Mock/测试。
6. 数据库结构变更必须通过 Prisma schema 和 migration 管理，禁止只改数据库而不提交迁移文件。
7. 任何公开部署的写接口都必须有服务端鉴权和授权校验。不能把密钥、数据库凭据或管理员 Token 暴露给浏览器、提交到 Git 或写入普通日志。
8. 周期任务必须持久化，具备幂等性、失败重试、可观测状态和错过周期后的补处理能力。正式任务不能依赖 Web 进程内的 `setInterval` 保证执行。
9. AI 输出的总结应尽可能保留来源；不确定的推断不能写成确定事实。
10. 本地 Mock 只用于开发验证，必须明确标注，不能伪装成真实数据库或真实任务状态。
11. 换电脑和灾难恢复需要遵循本地开发与数据迁移文档。备份文件和真实环境变量不可提交到 Git。
12. 一次只实现用户当前要求的范围。开始前检查仓库现状，不要覆盖已有实现或擅自扩大需求。
13. 前端统一使用 Vue 3 + Nuxt 4 + TypeScript + Element Plus；Nuxt 默认使用 Vite，不要再引入 React/Next.js 或单独重复搭建 Vite 应用，除非用户明确要求重新评估技术栈。
14. 优先使用 Element Plus 的按钮、输入框、表单、选择器、弹窗、表格、标签、通知等组件，保持现有工作台的浅色视觉风格；自定义 CSS 主要用于布局与品牌样式。
15. 完成修改后，运行适用的类型检查、测试和构建；如当前项目尚未具备运行环境，必须说明未执行的检查，不得声称通过。
16. 交付时简要列出修改文件、关键实现、运行/测试结果、已知限制与下一步建议。

## 当前仓库状态

开发分支已包含 PostgreSQL 持久化的角色/记忆设置、对话录入、周期调度与独立 Worker。Worker 通过服务端 OpenAI-compatible Chat Completions API 对周期消息生成结构化总结，校验来源消息 ID，再以事务方式保存快照、长期记忆变更和审计日志。模型参数位于服务端 `.env`：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、可选的 `LLM_TIMEOUT_MS`。

Worker 当前消费 `GENERATE_SNAPSHOT` 与 `REGENERATE_SNAPSHOT`。AI 重新提炼会在同一逻辑快照下创建新版本并保留旧版本；为了避免重放历史周期意外改写当前长期记忆，重新提炼提出的记忆变化只作为审核建议，不自动应用。任务监控支持取消等待中的任务，以及对支持的快照任务手动重新入队，操作会写入审计日志。

AI 对话的检索范围按身份隔离：`resolveChatMemoryScopes()` 只放行角色全局范围与当前用户自己的私人范围，未验证外部身份、他人范围与未知类型一律拒绝；记忆写入接口支持 `scope: character | private`。来源带上 `character` / `private` 语义标签，提示词不包含范围 ID 或用户 ID。相关回归测试为 `yarn test:chat-private-memory`（纯逻辑与提示词）和 `yarn test:chat-private-memory-db`（数据库查询隔离）。

鉴权已实现服务端会话：`sessions` 表只存会话令牌的 SHA-256 哈希，Cookie 为 `yiling_session`（HttpOnly / SameSite=Strict / 生产 Secure），密码用 scrypt 校验，登录失败写 `login_attempts` 并按用户名与来源地址限流。所有 `/api` 请求经过同源/跨站校验；业务接口通过 `requireActorUserId()` 从会话取身份。本地开发保留一条受限回退（开发构建 + `YILING_LOCAL_API_ENABLED=true` + 未关闭 `YILING_ALLOW_DEV_OWNER_BYPASS` + 回环 Host），生产构建没有该通道；携带失效 Cookie 时必须重新登录，不能回退成开发身份。回归测试为 `yarn test:auth`、`yarn test:auth-db`，登录/登出/限流链路由冒烟脚本覆盖。

仍未完成的边界：真实聊天渠道 Adapter、多用户权限模型（当前仍是单管理员）、密码重置与会话管理界面、公网部署加固（HTTPS、反向代理信任、备份演练）；真实模型端到端调用也需要开发者在本机配置 API 后验证。当前 CI 用仅监听回环地址的模拟模型服务验证完整数据流。模型未配置时任务必须留在队列，不得用规则摘要冒充 AI 输出。来源证据必须通过当前周期原始消息 ID 白名单校验；不要把未验证的模型推断当作确定事实自动写入长期记忆。每次代码修改后运行适用的类型检查、测试、lint 与构建；没有实际执行的检查不能声称通过。