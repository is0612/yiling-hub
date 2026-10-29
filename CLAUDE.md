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
17. 字号最小 12px：任何页面、组件和全局样式的 `font-size` 不得小于 12px。辅助信息用颜色和字重区分层级，不要靠缩小字号。若某个容器因此放不下，改排版或精简文案，不要把字号压回去。
18. 改过 `.vue` 必须跑 `yarn check:sfc`（已进 `verify:local`）。它逐个编译 `app/**/*.vue` 的 script 与 template：像 `await` 写在非 async 函数里这类**语法错误**，`eslint` 不会报、`typecheck` 会被无关报错淹没，只有编译才发现，而线上表现就是整页白屏。

## 当前仓库状态

开发分支已包含 PostgreSQL 持久化的角色/记忆设置、对话录入、周期调度与独立 Worker。Worker 通过服务端 OpenAI-compatible Chat Completions API 对周期消息生成结构化总结，校验来源消息 ID，再以事务方式保存快照、长期记忆变更和审计日志。模型参数位于服务端 `.env`：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、可选的 `LLM_TIMEOUT_MS`。

Worker 当前消费 `GENERATE_SNAPSHOT` 与 `REGENERATE_SNAPSHOT`。AI 重新提炼会在同一逻辑快照下创建新版本并保留旧版本；为了避免重放历史周期意外改写当前长期记忆，重新提炼提出的记忆变化只作为审核建议，不自动应用。任务监控支持取消等待中的任务，以及对支持的快照任务手动重新入队，操作会写入审计日志。

AI 对话的检索范围按身份隔离：`resolveChatMemoryScopes()` 只放行角色全局范围与当前用户自己的私人范围，未验证外部身份、他人范围与未知类型一律拒绝；记忆写入接口支持 `scope: character | private`。来源带上 `character` / `private` 语义标签，提示词不包含范围 ID 或用户 ID。相关回归测试为 `yarn test:chat-private-memory`（纯逻辑与提示词）和 `yarn test:chat-private-memory-db`（数据库查询隔离）。

鉴权已实现服务端会话：`sessions` 表只存会话令牌的 SHA-256 哈希，Cookie 为 `yiling_session`（HttpOnly / SameSite=Strict / 生产 Secure），密码用 scrypt 校验，登录失败写 `login_attempts` 并按用户名与来源地址限流。所有 `/api` 请求经过同源/跨站校验；业务接口通过 `requireActorUserId()` 从会话取身份。本地开发保留一条受限回退（开发构建 + `YILING_LOCAL_API_ENABLED=true` + 未关闭 `YILING_ALLOW_DEV_OWNER_BYPASS` + 回环 Host），生产构建没有该通道；携带失效 Cookie 时必须重新登录，不能回退成开发身份。回归测试为 `yarn test:auth`、`yarn test:auth-db`，登录/登出/限流链路由冒烟脚本覆盖。

仍未完成的边界：密码重置（需 SMTP）、注册邮箱验证（需 SMTP）、渠道适配器的断线重连、渠道按外部用户隔离私人记忆、公网部署加固（HTTPS、反向代理信任、备份演练）；真实模型端到端调用也需要开发者在本机配置 API 后验证。当前 CI 用仅监听回环地址的模拟模型服务验证完整数据流。模型未配置时任务必须留在队列，不得用规则摘要冒充 AI 输出。来源证据必须通过当前周期原始消息 ID 白名单校验；不要把未验证的模型推断当作确定事实自动写入长期记忆。每次代码修改后运行适用的类型检查、测试、lint 与构建；没有实际执行的检查不能声称通过。

账号模型为「1 个管理员 + 邮箱注册普通用户」：`User.role` 只有 ADMIN/USER；业务接口按会话 `userId` 过滤，天然隔离；管理员接口 `/api/admin/*` 走 `requireAdminActor()`。QQ 渠道只保留 OneBot 一条通道（`server/utils/channel-adapter/onebot/*`）：挂个人号，走 OneBot v11 网关的 WS 收消息 + HTTP API 发消息，WS/HTTP Token 加密入库，消息处理按角色绑定路由、幂等去重、回写平台；回归测试 `yarn test:onebot`。QQ 官方机器人渠道（AppID + AppSecret）已于 2026-10-27 下线，不要再恢复。

模型调用统一记账：`model_usages` 表由 `server/utils/model-usage.ts` 写入（kind / model / prompt / completion / total / reasoning token），四个埋点是 `chat.post.ts`、`channel-adapter/pipeline.ts`、`memory-worker.ts`、`bili/duty-pipeline.ts`（粗筛与终判分开计）。每日额度取角色 `modelConfig.dailyTokenLimit`（0 = 不限，东八区日界），超额时对话返回 429、QQ 与值班静默跳过；记账失败只写日志，不许把已经成功的回复变成错误。

记忆注入按 token 预算装配（`rankMemoriesWithBudget` / `rankSnapshotsWithBudget`）：记忆默认 1200、快照默认 2000（各自独立）、条数上限 8，排序 = 相关度 × 重要度 × 半衰期衰减（30 天，参照 `lastRecalledAt`）× 召回加成；装不下时跳过整条但**第一条永远放行**。不要再改回 top-N 硬截断 —— 那样提示词会静默爆掉，且看不出谁被挤掉。预算与条数走 `modelConfig.memoryTokenBudget` / `snapshotTokenBudget` / `memoryItemLimit`。

前端渠道入口按平台拆成两个页面，**不要再合并回一个通用「渠道管理」页**（`app/pages/channels.vue` 已删除）：QQ 小号在「系统管理 → QQ 渠道」（`app/pages/qq.vue`，只列 `qq-onebot`，含四步接入引导），B站 在「系统管理 → B站 值班台」（`app/pages/bili/index.vue`，账号创建、绑定角色、值班设置都在里面）。两个页面共用 `/api/admin/channels` 系列接口；QQ 凭据不回显，保存时地址/Token 留空表示沿用旧值（`channels/index.post.ts` 里的合并逻辑，别改成直接覆盖）。

QQ 群里的「去刷一轮 B站」只认连接设置里的**主人 QQ**（`metadata.ownerQq`），并且要同时打开 `metadata.groupBiliRunEnabled`；主人称呼（`metadata.ownerName`）会作为 `speaker.ownerDisplayName` 写进对话提示词（只传称呼、不传账号 ID），让她认得出主人；群友发同一句话直接忽略，不能进入普通聊天。执行复用 `runDutyRound`（额度/模型/bili CLI/评论收藏动态与值班台一致），先回执再后台跑，同一角色不并发。没有 B站 绑定时只回复提示，不得假装跑过。

QQ 群发言限流按「绑定」配置（`CharacterChannelBinding.config.replyWindowMinutes` / `replyLimitPerWindow`，上限 0 = 不限；旧 `replyLimitPer10Min` 兼容）：滚动窗口只统计这条鱼在该群的 `ASSISTANT` 消息，达到上限后静默、不调模型；群公告流程不受限。它无法协调群里其他账号/系统的发言，别宣称能执行跨鱼群规。

QQ 渠道页顶部的「这条链路通到哪」（`app/components/QqChannelChain.vue`，小号 → 协议端网关 → 本机适配器 → 角色）回答的是「消息为什么不回」——这四种原因以前散在页面各处的小字里，只能靠人挨个核对。断点按**因果**挑，不按显示顺序挑（`app/utils/qq-channel.ts` 的 `resolveChainRoot`）：`platform_connections.status` 只有适配器会写，进程一停就停在最后那个值上，所以必须先看网关、再看适配器，最后才轮到小号；否则适配器没启动时会先报「小号未连接」，把人指去重新登录 QQ。同理，断点之后的段落一律置灰、全页只允许有一个红点，不许四段各标各的。改这段判断前先跑 `yarn test:qq-chain`。

QQ 群聊的「自然接话」走「攒批 → 零成本闸门 → 模型决定说不说」三段（`onebot/group-chat.ts`，文档 `7.1`）：绑定 `config.groupChatMode` 三档 `mention | ambient | all`，默认 ambient。攒批按 `bindingId + conversationKey`（最后一条之后 12 秒，被 @ 时 4 秒，第一条起最多 45 秒），闸门是纯函数（模式 → 安静时段 → 每日上限 → 最短间隔 → 被点名 → 3 分钟内她说过话 → 抽签），不过就整轮丢掉、不落库、不调模型。过闸门也只是「值得看一眼」：`generateConversationReply` 传 `transcript` + `allowSilent`，模型回 `silent` 就什么都不发（usage 照常记账）。**被 @ 的轮次必须 `allowSilent: false`** —— 点名了还说「不想说」比乱回更糟；`mention` 档则完全不攒批。群聊只读角色全局记忆，不拼任何人的 identity scope。不要再退回「群里每句都进模型再逐条回」——2026-10-29 那次 32 秒刷 6 条、把 10 分钟额度一次花完就是这么来的。

QQ 群公告走「草稿 → 管理员确认」两段（`onebot/announcement.ts`，表 `onebot_group_announcements`）：连接级开关 `metadata.groupAnnouncementEnabled` 默认关；只认群主/管理员（`sender.role`，缺失按 member），普通成员触发无效；管理员 @ 她说「写个群公告：主题」才拟稿，草稿 10 分钟有效，回复「确认发布」才调 SnowLuma `_send_group_notice`。草稿用 `PENDING → PUBLISHING` 原子认领，重复事件不得二次发布；成功/失败都写审计。前提是小号已是群管理员；踢人、禁言等破坏性动作不要顺手放开。

QQ 表情走「模型返回 faces 字段 → 渠道拼 face 段」：清单在 `onebot/faces.ts`（精选，非 QQ 完整 face 表），能力由 `ChannelMessageInput.faceCatalog` 声明而非平台名判断，角色开关 `modelConfig.emojiEnabled` 默认关，上一条刚发过表情则 10 分钟内不再发。**表情必须单独一条消息**，表情 id 只记在 `metadata.faceIds`、绝不进 `content`。别再退回「从 reply 文本里认 `[face]` 占位符」的做法 —— 正文一旦混进段标记就会被原样当文字发出去。发送侧要查 OneBot 返回的 `retcode`：出错时 HTTP 仍是 200。

QQ 群看图走「段里取直链 → 视觉模型 → 文字进提示词」的旁路（`server/utils/image-understanding.ts`，文档 `6.1`）：聊天模型（`deepseek-flash` 这类）不接受 `image_url`，所以图必须在进提示词之前变成文字，正文里的 `[图片]` 换成 `[图片：<描述>]`。默认关（不配 `VISION_MODEL` 就完全不动），只认 `data.url`（`data.file` 是文件名），收到就下载（rkey 有时效），地址过公网白名单（含 DNS 解析结果与重定向后的地址），一轮最多 3 张，失败静默降级。**先过群聊闸门再调视觉** —— 被丢掉的那一轮不该为看图花钱；记账 `model_usages.kind = "vision"`。不要再退回「把图塞进聊天请求」：那在纯文本接口上等于整轮 400。

B站 命令台以 `bili schema` 为准（`schema-catalog.ts`，5 分钟缓存，失败回退手写 `catalog.ts`），不要再扩手写清单；侧栏靠 `common` + 菜单隐藏清单，`MENU_VERSION` 变更时合并默认隐藏集。值班新增日报档位 `reportLevel`（full/brief/off）、今日额度重置 `quotaResetAt`、札记编辑（直接改角色全局 EVENT 记忆，软删除进回收站）；这些都不改变脚本化流水线，agent 工具循环仍未做。

B站 值班的终判除了「值得/跳过」还要给 0-20 分，分数进 `bili_seen_videos.score` 并驱动两个对外动作：收藏（`duty.favMinScore`，默认 0 = 关）和发动态（`duty.autoDynamic`，默认关）。两条动作都记账在 `bili_actions`（按 `bindingId + day + kind`），因为「每天几次 / 隔多久」这类判定不能存在内存里 —— 进程一重启就归零，而账号那边的痕迹删不掉。**分数缺失必须是 `null` 不是 `0`**：0 分会被当成当天最低分压掉别的东西。发动态前必须过 `sanitizePublicText()`，那是唯一面向陌生人的写操作。B站 侧栏命令目录用 `catalog.ts` 的 `common` 标记决定默认可见性，存「隐藏清单 + 版本号」，别改回「全部铺开」。

主动找话走「想 → 判 → 说」三段（`server/utils/proactive*.ts`，文档 `docs/proactive-messaging.md`）：先攒目的池（`proactive_intents`，按 `characterId + dedupeKey` 去重），再由 `evaluateProactiveGate` 零成本判定，放行后才调模型写一句话并发 QQ 私信。**默认关**（`PROACTIVE_DEFAULTS.enabled = false`），闸门必须先判配置性问题（开关/收件人/额度）再判时间性问题（安静时段/间隔/主人在聊），**先判闸门再调模型**，发出后必须落成一条 `ASSISTANT` 消息（否则她读不到自己说过什么）。页面「立即试一次」的 `force` 只跳过时间类闸门，不跳过开关、收件人和额度。收件人取最近一次 `c:` 前缀的 QQ 私聊，不要求用户手填主人 QQ。常驻进程 `yarn proactive:run`，不要塞进 Web 进程的 `setInterval`。

## 外部 Vue Skill 的 Nuxt 覆盖说明

项目引入了 `vue-best-practices` skill（`.workbuddy/skills/vue-best-practices/`，来源 `github.com/vuejs-ai/skills` v19）。它面向 Vue 核心库，**不含 Nuxt 知识**，以下条目覆盖其冲突规则，优先级高于该 skill：

1. **状态共享禁止引入 Pinia，也禁止模块级 `reactive`/`ref` 单例。** 该 skill 的 `references/state-management.md` 建议「SSR/Nuxt 应用默认使用 Pinia」，本项目不采用。跨页面共享状态一律用 Nuxt `useState`，范本为 `app/composables/useActiveCharacter.ts` 与 `useAuthSession.ts`。模块级单例在 SSR 下会跨请求串号，属于必须避免的实现。
2. **路由规则不适用。** 走 Nuxt 文件路由与 `app/middleware/*.ts`，动态参数用 `route.params.id`；不要按 `vue-router-best-practices` 的思路新增路由配置文件或额外引入 `vue-router`。
3. **数据获取用 Nuxt 内建能力。** 页面级数据用 `useAsyncData` / `useFetch`；SSR 阶段需要转发登录态时用 `useRequestFetch()`（见 `useActiveCharacter.ts` 的 `loadCharacters`）。不要改成客户端 `onMounted` + `$fetch`。
4. **Element Plus 优先级高于 skill 的通用 UI 建议。** 先查 `el-*` 组件；skill 提到的手写控件、自定义过渡/弹层方案，只有在 Element Plus 确实没有对应能力时才考虑。
5. **拆分与重构的判定标准**按该 skill `SKILL.md` 1.2 的责任边界（行为是否一起变化、是否共担同一不变量），文件行数只作为复查信号，不作为拆分阈值。第 12 条「不擅自扩大需求」指不越出用户要求的功能范围，不包含为完成该功能所必需的结构调整；但跨文件的大范围重构仍需先给出方案再动代码。
6. **冲突兜底：** 该 skill 属社区早期实验，规则可能不完整。任何与本文档 1–17 条或上述条目冲突之处，以本文档为准；不得为迁就 skill 而引入新依赖或重搭技术栈。