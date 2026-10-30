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

账号模型为「1 个管理员 + 邮箱注册普通用户」：`User.role` 只有 ADMIN/USER；业务接口按会话 `userId` 过滤，天然隔离；管理员接口 `/api/admin/*` 走 `requireAdminActor()`。QQ 渠道只保留 OneBot 一条通道（`server/utils/channel-adapter/onebot/*`）：挂个人号，走 OneBot v11 网关的 WS 收消息 + HTTP API 发消息，WS/HTTP Token 加密入库，消息处理按角色绑定路由、幂等去重、回写平台；回归测试 `yarn test:onebot`。QQ 官方机器人渠道（AppID + AppSecret）已于 2026-10-27 下线，不要再恢复。绑定的 `routingKey` 存逗号分隔的多个群号（一个绑定挂多个群，前端用 InputTag 标签输入框填），路由时 `parseBindingRoutingKeys()` 拆数组做 `includes` 命中、留空或 `"*"` 是默认绑定（收所有群 + 私聊）；**不要再退回「每群绑一条、单值字符串精确匹配」** —— 后端接口 `normalizeRoutingKey()` 同时接受字符串与字符串数组并统一去重、限 255 字符，回归测试 `yarn test:onebot-multigroup`。**私聊必须保留「没有默认绑定但只有一条启用中绑定就用她」的兜底**：用户把群号填进 InputTag 之后，默认绑定就不存在了，早先只有 `defaults[0]` 的写法等于「私聊永久 no_binding」，而群里照常能回 —— 从群聊侧完全看不出问题（2026-10-30 实际踩到）。多条绑定又没有默认绑定时仍返回 null：猜错人比不回更糟。

QQ 私聊与「主人」：主人的 QQ 私聊（`speaker.isOwner`）挂在角色主人的 `USER_PRIVATE` 范围下（`ensureOwnerPrivateScope`），跟随全局周期一起排快照（`memory-scheduler.ts` 补排，幂等键含 scope id），只在主人自己的对话里可读；普通群友的私聊仍挂在该账号的 `EXTERNAL_IDENTITY` 范围、不排快照。群聊里主人发的消息落库带 `isOwner`、提炼时标「主人」，让角色在群里也认得出主人。**不要再退回「所有私聊一律挂全局 / 一律不排快照」的两种极端** —— 主人专属、其他人不自动记忆是产品决策。

模型调用统一记账：`model_usages` 表由 `server/utils/model-usage.ts` 写入（kind / model / prompt / completion / total / reasoning token），四个埋点是 `chat.post.ts`、`channel-adapter/pipeline.ts`、`memory-worker.ts`、`bili/duty-pipeline.ts`（粗筛与终判分开计）。每日额度取角色 `modelConfig.dailyTokenLimit`（0 = 不限，东八区日界），超额时对话返回 429、QQ 与值班静默跳过；记账失败只写日志，不许把已经成功的回复变成错误。

总览的「用量与花费」由 `readUsageReport()`（`server/utils/model-usage.ts`）按「角色 × 东八区自然日」聚合最近 7 天，金额来自 `server/utils/model-pricing.ts` 的内置参考价：**按每一行用自己的调用时间取价**（DeepSeek 分高峰/空闲，先求和再乘单价会算错）。输入必须分缓存命中/未命中两档：记账要存 `cacheHitTokens`（DeepSeek 的 `prompt_cache_hit_tokens`、OpenAI 兼容层的 `prompt_tokens_details.cached_tokens`），命中价按价目表的 `cacheHitInput` 算 —— 群聊反复发送同一段人设，命中率常在 80% 以上，只按未命中价算会把一天的花费高估三倍（2026-10-30 实测：页面 0.99 元 vs 供应商 0.34 元）。没有缓存明细的旧行只能按未命中价估，**在 `uncachedCalls` 里计数并在页面说明「金额偏高」，不许用平均命中率反推**。认不出的模型必须标成「未定价」并单独累计 `unpricedTokens`，不许当 0 元、也不许套别的模型的价格。厂商调价用 `.env` 的 `MODEL_PRICING` 覆盖（可写 `cacheHitInput`），美元模型用 `USD_CNY_RATE` 折算；回归测试 `yarn test:model-pricing`。

记忆注入按 token 预算装配（`rankMemoriesWithBudget` / `rankSnapshotsWithBudget`）：记忆默认 1200、快照默认 2000（各自独立）、条数上限 8，排序 = 相关度 × 重要度 × 半衰期衰减（30 天，参照 `lastRecalledAt`）× 召回加成；装不下时跳过整条但**第一条永远放行**。不要再改回 top-N 硬截断 —— 那样提示词会静默爆掉，且看不出谁被挤掉。预算与条数走 `modelConfig.memoryTokenBudget` / `snapshotTokenBudget` / `memoryItemLimit`。

群聊记录也算她的记忆：群会话挂在角色全局范围下，标题写 `QQ群 <群号>`、`metadata` 带 `kind`/`groupId`；记忆页时间线只取 `memory,snapshot`，所以群聊原文走独立接口 `GET /characters/{id}/group-chats`（群列表 + 选中群消息，按群号区分）。周期快照的来源消息必须**按会话配额**取（`memory-source-selection.ts`：每会话先保最新一条，250 条总预算内按时间填，单会话上限 80），**不要再改回「整个范围按时间取最早 125 + 最晚 125」** —— 一天几十条的群会把私聊整段挤出窗口，总结只剩群里与她无关的闲话。来源带 `origin`（`QQ群 <群号>` / `私聊` / `本地对话`）进提示词，群聊只提炼与她相关的内容，群友隐私不写长期记忆。回归测试 `yarn test:memory-source-selection`。

前端渠道入口按平台拆成两个页面，**不要再合并回一个通用「渠道管理」页**（`app/pages/channels.vue` 已删除）：QQ 小号在「系统管理 → QQ 渠道」（`app/pages/qq.vue`，只列 `qq-onebot`，含四步接入引导），B站 在「系统管理 → B站 值班台」（`app/pages/bili/index.vue`，账号创建、绑定角色、值班设置都在里面）。两个页面共用 `/api/admin/channels` 系列接口；QQ 凭据不回显，保存时地址/Token 留空表示沿用旧值（`channels/index.post.ts` 里的合并逻辑，别改成直接覆盖）。

QQ 群里的「去刷一轮 B站」只认连接设置里的**主人 QQ**（`metadata.ownerQq`），并且要同时打开 `metadata.groupBiliRunEnabled`；主人称呼（`metadata.ownerName`）会作为 `speaker.ownerDisplayName` 写进对话提示词（只传称呼、不传账号 ID），让她认得出主人；群友发同一句话直接忽略，不能进入普通聊天。执行复用 `runDutyRound`（额度/模型/bili CLI/评论收藏动态与值班台一致），先回执再后台跑，同一角色不并发。没有 B站 绑定时只回复提示，不得假装跑过。

QQ 群发言限流按「绑定」配置（`CharacterChannelBinding.config.replyWindowMinutes` / `replyLimitPerWindow`，上限 0 = 不限；旧 `replyLimitPer10Min` 兼容）：滚动窗口只统计这条鱼在该群的 `ASSISTANT` 消息，达到上限后静默、不调模型；群公告流程不受限。它无法协调群里其他账号/系统的发言，别宣称能执行跨鱼群规。

QQ 渠道页顶部的「这条链路通到哪」（`app/components/QqChannelChain.vue`，小号 → 协议端网关 → 本机适配器 → 角色）回答的是「消息为什么不回」——这四种原因以前散在页面各处的小字里，只能靠人挨个核对。断点按**因果**挑，不按显示顺序挑（`app/utils/qq-channel.ts` 的 `resolveChainRoot`）：`platform_connections.status` 只有适配器会写，进程一停就停在最后那个值上，所以必须先看网关、再看适配器，最后才轮到小号；否则适配器没启动时会先报「小号未连接」，把人指去重新登录 QQ。同理，断点之后的段落一律置灰、全页只允许有一个红点，不许四段各标各的。改这段判断前先跑 `yarn test:qq-chain`。

QQ 群聊的「自然接话」走**一条管道**：「短期上下文 → 攒批 → 零成本闸门 → 一次模型判断并生成回复」（`onebot/group-chat.ts` + `onebot/group-context.ts`，文档 `7.1`）。绑定 `config.groupChatMode` 三档 `mention | ambient | all` 只是放行策略，默认 ambient；一条绑定可以挂多个群，而「大群只看被 @、小群随便聊」很常见，所以还有 `config.groupChatModes = { "<群号>": 档位 }` **按群覆盖档位**（只覆盖 mode，节奏/安静时段/概率仍跟绑定走；没列的群沿默认档）。`groupChatForGroup()` 是唯一取值入口，`flushGroupRound` 与 `handleRoutedEvent` 都必须走它、不许再直读 `binding.groupChat`，否则某个群的档位会被别的群顶掉。写入侧严格校验（坏群号/坏档位报错，最多 50 个群，空表从 config 删掉）；前端只提交当前群号列表里的覆盖项（`QqCharacterBehavior` 的「按群分别设」）。**不要再退回「@ 走单条、水群走攒批」两套入口**。上下文按「绑定 + 群」缓存最近 5 分钟、最多 40 条（闸门丢掉的消息也在里面，供下一轮理解），QQ 号入模前换成 `member_n`、@ 她写 `@self`。攒批按 `bindingId + conversationKey`（被 @ 或叫到名字 4 秒、`all` 最多 3 秒、其余 12 秒、第一条起最多 45 秒）。闸门是纯函数（all → mention 档只放 direct/named/topic → 安静时段 → 日上限 → 最短间隔 → direct → named → 话题候选 → 抽签），不过就整轮丢掉、不落库、不调模型。**只有真实 @（at 段 QQ 是她）与 `all` 档 `mustReply = true`**；名字/别名只是弱线索，不能强制回复、不能绕过安静时段。过闸门也只是「值得看一眼」：`transcript` + `groupBackground` + `groupAnchors` + `policy.direct`，模型回 `silent` 就什么都不发，可选的 `groupDecision` 只做白名单校验。回复**发送成功**后才登记话题参与；3 分钟无相关互动过期、最长 15 分钟、最多 3 个并行话题。群聊只读角色全局记忆，不拼任何人的 identity scope。不要再退回「群里每句都进模型再逐条回」——2026-10-29 那次 32 秒刷 6 条、把 10 分钟额度一次花完就是这么来的。

QQ 群公告走「草稿 → 管理员确认」两段（`onebot/announcement.ts`，表 `onebot_group_announcements`）：连接级开关 `metadata.groupAnnouncementEnabled` 默认关；只认群主/管理员（`sender.role`，缺失按 member），普通成员触发无效；管理员 @ 她说「写个群公告：主题」才拟稿，草稿 10 分钟有效，回复「确认发布」才调 SnowLuma `_send_group_notice`。草稿用 `PENDING → PUBLISHING` 原子认领，重复事件不得二次发布；成功/失败都写审计。前提是小号已是群管理员；踢人、禁言等破坏性动作不要顺手放开。

QQ 表情走「模型返回 faces 字段 → 渠道拼 face 段」：清单在 `onebot/faces.ts`（精选，非 QQ 完整 face 表），能力由 `ChannelMessageInput.faceCatalog` 声明而非平台名判断，角色开关 `modelConfig.emojiEnabled` 默认关，上一条刚发过表情则 10 分钟内不再发。**表情必须单独一条消息**，表情 id 只记在 `metadata.faceIds`、绝不进 `content`。别再退回「从 reply 文本里认 `[face]` 占位符」的做法 —— 正文一旦混进段标记就会被原样当文字发出去。发送侧要查 OneBot 返回的 `retcode`：出错时 HTTP 仍是 200。

表情包（贴图）走「用户传图 → 模型返回 sticker → 渠道拼 image 段」，是**与 QQ 内置表情（face 段）并列的两条路**：内置表情是 QQ 客户端自带的那几十张脸，谁发都一样；表情包是她自己的图（`character_stickers` 表 + `.data/stickers/<角色>/`，接口 `/api/characters/{id}/stickers`，管理页 `/characters/{id}/settings/stickers`）。清单非空时**优先用表情包、内置表情不再进提示词**（两套清单同时给，模型会在两者之间犹豫）；两者共用 `modelConfig.emojiEnabled` 开关、同一份额度与「单独一条消息」。清单进提示词前先做减法（剔除上一张、封顶 12、**没用过的先上且其余打乱**，`pickStickerCatalog`）—— 按插入顺序切前 12 张的老做法会让第 13 张以后永远发不出来，实测 25 张库里只有固定 12 张进过提示词、400 条助手消息只带出 2 次表情包。**频率靠额度兜，不靠提示词打压**：额度是「每 N 分钟最多 N 张」（`modelConfig.emojiWindowMinutes` / `emojiPerWindow`，默认 10 分钟 3 张，判定在 `server/utils/emoji-frequency.ts`），**按会话分别算**（A 群贴满不该让 B 群闭嘴），内置表情与贴图共用一份额度。原来那条「距上一条带表情的回复满 4 分钟」的单条间隔冷却（`FACE_COOLDOWN_MS`）已经删掉 —— 它只挡得住「连着两条」，热聊时一分钟三条照样过得去，且 4 分钟窗口把整体频率压到几乎为 0；窗口内条数统计不能复用 `recentStoredMessages`（只有 20 条，热聊时覆盖不到十分钟），要按 `occurredAt` 回表数。提示词里不许再写「大多数回复别发表情」——那句话会被模型当默认答案，写多少张图都发不出来；`scripts/probe-sticker-pick.ts` 用生产同一条提示词跑五句台词，判「该挑的挑了、不该挑的没挑」。管理页 `stickers.vue` 支持排序（最近添加 / 最早添加 / 用过最多 / 最近用过 / 一直没用过的在前）与分页（12/24/48）—— 几十张以后才找得到「白占名额」的那几张。**用户知道自己这张图是什么、却写不出「什么时候用」**是编辑这张表时最常见的卡壳（而挑图模型真正比对的就是这一句，空着等于这张图永远轮不上），所以编辑弹窗那一栏挂了「AI 生成」（`server/utils/sticker-usage.ts`，`POST /api/characters/{id}/stickers/{stickerId}/usage-suggestion`）：只回建议、**不写库**（用户在弹窗里可能还要改，落库仍走 PATCH），传的是输入框里**当前**的名字而不是库里那个（人往往先改名再想起点按钮）；有图且开了看图就走视觉（名字 + 画面），没开则退化只看名字 —— 后者必须能单独走通，不然「根据名字生成」这个需求等于没做。只看名字那条**不要自己拼请求**：`deepseek-flash` 是思考型模型，给 120 tokens 会思考吃满、http 200 但正文为空，得走 `callRawModel`（预算 1200 + 截断翻倍重试）。发送用 `base64://`（网关可能与适配器不同机，本地路径跨机就是一张发不出去的图；若某网关不认 base64，改 `loadStickerSegments` 一处即可）。文件名一律服务端生成、只认 `uuid.ext`（`safeFileName`），客户端传来的名字只用于取扩展名。**发出去的最大宽度 200**（`server/utils/sticker-image.ts`，sharp 实现）：QQ 按图片**原始像素**显示，群里偷来的图动辄 1000~1500px，在聊天窗里就是一张占满屏的巨图，完全不像表情。规则是「只缩不放 + 只定宽高度等比」—— 本来就不比 200 宽的图**原样返回、不重编码**（重编码只掉画质）；gif/webp 必须 `animated: true` 按帧缩，不加这一项动图会变成只有第一帧的静图；解不开的图返回 null、调用方存原件，不让「图坏了」把上传或收图整条打断。入口两处：上传（`stickers/index.post.ts`）与自动收图（`sticker-collect.ts`，顺带用缩好的那张去打标，base64 小一大截）。历史数据一次性补：`yarn stickers:normalize`（先 `--dry` 看清单；原件备份在 `.data/sticker-originals/`，覆盖后同步 `sizeBytes`；重复跑会**从原件重缩**，不会拿上一轮压过的图再压一次）。注意 sharp 对动图返回的 `height` 是**所有帧叠起来的总高**，看日志时别把它读成「长截图」。回归测试 `yarn test:sticker-image` 与 `yarn test:stickers`。**不要再退回「只能发 QQ 默认表情」** —— 那是用户明确要换掉的东西。

「偷表情包」走「群里的图 → `sticker-collect.ts` 下载 → 视觉模型起名 → 存进表情库」：开关 `modelConfig.stickerAutoCollect` 默认关（QQ 行为面板的「偷表情包」开关），只收**群聊**里的图、不收她自己（ASSISTANT）发的，一轮最多收 1 张；下载复用 `image-understanding.ts` 的 `downloadImage`（rkey 时效 + 公网白名单 + 4MB 上限），打标复用视觉模型配置但用独立提示词输出 `{name, usage}` JSON，记账 `kind = "sticker-label"`。**按图片内容 SHA-256（`contentHash`）去重**：群里一张图转来转去只收第一次；打标失败、或名字落在泛称黑名单里（「表情」「表情包」「收藏的表情」这类，`GENERIC_NAMES`）就**不收** —— 这种图模型在十几张里挑不出来，收进库只是占位；以前拿「收藏的表情」兜底入库是错的，`isUsableStickerName` 把关。**模型自己判定「这不是表情包」也不收**（`{"skip":true}`）：群里转的图有相当一部分是别人的聊天截图、长截图、随手拍的照片，进了库只是噪声。提示词里写的是「只有明显不能当表情用时才 skip，拿不准一律正常起名」—— 误杀一张好图比多收一张差图更难受；实测一张假聊天截图（760×900、九行对话）能被判成 `skip`。解析逻辑抽成纯函数 `readStickerLabel`，单测覆盖 skip / 泛称名 / 非 JSON / 空白裁剪四种返回。管理页每张图有「重新识别」（`POST /api/characters/{id}/stickers/{stickerId}/relabel`）：第一次打标常不准（动图只看到一帧、抽象梗图、带字的图），让模型再看一次、直接写库并回新 DTO；模型说是截图时**不改数据**、只回一句人话让用户自己决定删不删。整条链路失败都静默、不影响这轮回复。来源存 `source`（`manual`/`collected`），页面标「从群里收的」。回归测试 `yarn test:sticker-collect`。**不要再退回「只能手动传表情包」** —— 自动收图就是用户要的「偷表情包」。

QQ 群聊「引用回复」走「模型返回 `groupDecision.replyToMessageId` → 渠道拼 reply 段」：群聊里多条鱼并存时，引用让「接的是哪一句」不再靠猜。`replyToMessageId` 只能来自本轮 transcript 的 id（`chat-reply.ts` 的 `readGroupDecision` 白名单），渠道侧 `buildOnebotReplyMessage`（`onebot/serve.ts`）把它转成 `{type:"reply",data:{id}}` 拼在正文前，id 必须纯数字否则退回纯文本。回归测试 `yarn test:onebot-reply`。

QQ 群看图走「段里取直链 → 视觉模型 → 文字进提示词」的旁路（`server/utils/image-understanding.ts`，文档 `6.1`）：聊天模型（`deepseek-flash` 这类）不接受 `image_url`，所以图必须在进提示词之前变成文字，正文里的 `[图片]` 换成 `[图片：<描述>]`。默认关（不配 `VISION_MODEL` 就完全不动），只认 `data.url`（`data.file` 是文件名），收到就下载（rkey 有时效），地址过公网白名单（含 DNS 解析结果与重定向后的地址），一轮最多 3 张，失败静默降级。**先过群聊闸门再调视觉** —— 被丢掉的那一轮不该为看图花钱；记账 `model_usages.kind = "vision"`。不要再退回「把图塞进聊天请求」：那在纯文本接口上等于整轮 400。

QQ 语音走「文字 ↔ silk」两个边界（`server/utils/voice.ts`，文档 `docs/voice.md`）：她发语音 = 回复文字 → TTS(`/audio/speech`，**必须要 wav**) → `silk-wasm` → `record` 段；她听懂语音 = `record` 直链 → 下载 → silk 解码 → 补 wav 头 → ASR(`/audio/transcriptions`) → 正文 `[语音]` 换成 `[语音：<转写>]`。**QQ 只认 silk，喂 mp3/wav 是一条打不开的语音**，转码必须自己做（网关不保证同机、也不保证装 ffmpeg）。两个开关独立且默认关：`modelConfig.voiceEnabled` / `voiceTranscribe`；**触发主入口是「有人明确要她发语音」**（`isVoiceRequested`：发个语音/来一段语音/语音条呢/说句话，否定句不算），随机触发 `voiceChance` **默认 0** —— 硅基流动 CosyVoice2 合成实测 16-21 秒，随机发等于随机让一条回复静默迟到，别把默认值调回去。另外**服务商返回的 wav 头长度字段是坏的**（实测 `0xFFFFFFA6`），必须走 `repairWavSizes()` 重算，否则「合成成功但一条也发不出去」，日志还只会说「不是 wav」。语音**替代**正文，合成失败退回发文字，不能让这一轮沉默。语音按字符/秒计费，**不写 `model_usages`**（token 表 + 金额报表会被污染），只有 `[voice]` 日志。语音配置**优先在页面填**（`modelConfig.voiceApiKeyEncrypted` / `voiceApiBaseUrl` / `ttsModel` / `ttsVoice` / `asrModel`，Key 用 `encryptApiKey` 加密、只回显布尔），`.env` 的 `VOICE_*` 只是服务级默认值 —— 优先级「页面 > 环境变量 > 角色聊天配置」，因为语音几乎总是**另一家**服务商（DeepSeek 的 `/audio/speech` 实测 404）。显式配了 `VOICE_*_BASE_URL` 却写错时不许回落 —— 那会让人以为在用独立服务。已知边界：群里语音里的名字闸门看不见（先过闸门再花钱的取舍），@ 仍然有效。回归测试 `yarn test:voice`。

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