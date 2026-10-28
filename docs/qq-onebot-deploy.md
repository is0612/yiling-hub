# QQ 小号接入部署清单（SnowLuma / NapCat + yiling-hub）

> 目标：用个人 QQ 小号，让 yiling-hub 里的角色在 QQ 上收发消息、带记忆。
> 前提：QQ 小号和 yiling-hub 先跑在同一台 Windows 电脑上（`127.0.0.1` 直连），跑通后再考虑上服务器/换设备。

## 0. 一句话原理

```
QQ 群/好友发消息
   → 协议端（SnowLuma 或 NapCat，挂在你登录的 QQNT 客户端里，把 QQ 操作翻译成 OneBot v11）
   → OneBot 正向 WebSocket（ws://127.0.0.1:3001）推给 yiling-hub
   → yiling-hub 的 qq-onebot 适配器 → 角色 + 记忆 → 模型回复
   → OneBot HTTP API（http://127.0.0.1:3002）发回 QQ
```

协议端是"传话筒 + 翻译官"，yiling-hub 是"大脑"。两者是各自独立的程序，靠 OneBot v11 通信，所以**换协议端不需要改任何 yiling-hub 代码**，只改渠道里填的地址和 Token。

## 1. 选一个协议端

两个都实现 OneBot v11，yiling-hub 这边填的东西几乎一样。选一个装就行，别同时装两个（会抢同一个 QQ 登录态）。

| | SnowLuma | NapCatQQ |
|---|---|---|
| 下载 | `https://github.com/SnowLuma/SnowLuma/releases`（选 `win-x64.zip`，自带 Node 运行时） | `https://github.com/NapNeko/NapCatQQ/releases`（一键安装器） |
| 管理面板 | 自带 WebUI `http://127.0.0.1:5099` | WebUI `http://127.0.0.1:6099/webui/` |
| Token | **WS / HTTP 两个不同的值** | 通常只有一个 Access Token |
| 特点 | NapCat 官方 README 推荐它做 GUI 替代；社区反馈较不容易掉线 | 社区最大、资料最多 |
| 许可 | 源码可见但**非商业**许可，核心注入组件闭源 | 同类非商业条款 |

> SnowLuma 没有独立窗口：双击 `start.bat` 会开一个命令行常驻（关掉即停），所有操作在浏览器面板里。
> 它靠注入已登录的 QQNT 客户端工作，**那个 QQ 窗口不能关**。

### 1.1 准备

- 装好**新版 QQ（NTQQ，9.9.x）**，并用 QQ 小号**先登录一次**。
- 强烈建议用**小号**：非官方协议有风控/封号风险，小号损失可控。
- 小号先"养"几天（正常聊天、别一上来高频群发），降低风控概率。

### 1.2 登录小号

- SnowLuma：面板里扫码登录 QQ → 左侧「进程注入」→「探测登录」→「加载」，等指示灯变绿。
- NapCat：启动后按提示用手机 QQ 扫码，二维码 60 秒过期就重启重新生成。

## 2. 开启 OneBot v11 正向 WebSocket + HTTP API

### 2.1 端口规划（先避开 3000）

yiling-hub 的 dev server 默认占 **3000**，而两个协议端的 HTTP API 默认也是 3000 —— 同机运行必然撞。

| 用途 | 端口 | 说明 |
|---|---|---|
| OneBot 正向 WebSocket | 3001 | 协议端 → yiling-hub 推消息，保持默认 |
| OneBot HTTP API | **3002** | 协议端 ← yiling-hub 发消息，从默认 3000 改到 3002 |

### 2.2 SnowLuma

1. 打开 `http://127.0.0.1:5099`，用启动日志里的初始账号登录，同意条款后**立刻改密码**（初始密码只打印一次）。
2. 开 **WebSocket 服务端**，端口 3001。
3. 开 **HTTP API**，端口改成 **3002**。
4. 分别记下 WS 的 token 和 HTTP 的 token —— **它们是两个不同的值**，最常见的报错就是拿 WS 的 token 去配 HTTP，握手直接 401。

### 2.3 NapCat

1. 打开 `http://127.0.0.1:6099/webui/`，用终端里显示的 token 登录。
2. 「网络配置」里开启**正向 WebSocket 服务端**（3001）与 **HTTP API**（改成 3002）。
3. 设一个 Access Token 并记下来（本机测试也可以先留空）；两个框填同一个值即可。

### 2.4 验证端口已监听

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen
Get-NetTCPConnection -LocalPort 3002 -State Listen
```

两条都有输出，说明 WS 和 HTTP 都起来了。

## 3. 在 yiling-hub 里添加「QQ 小号」

1. 启动 yiling-hub（`yarn dev`）。
2. 打开「系统管理 → QQ 渠道」，点右上「添加 QQ 小号」。
3. 平台固定为 **`qq-onebot`**（这个页面只管 QQ 小号，B站 走「B站值班台」）。
4. 填表单：

| 字段 | 填什么 |
|------|--------|
| QQ 号（必填） | 你的 QQ 小号数字，例如 `123456789` |
| OneBot WebSocket 地址 | `ws://127.0.0.1:3001` |
| OneBot HTTP API 地址 | `http://127.0.0.1:3002` |
| WS Token | 协议端的 WS token（SnowLuma）／Access Token（NapCat）；没设就留空 |
| HTTP Token | 协议端的 HTTP token（SnowLuma 与 WS 不同）／Access Token（NapCat 相同） |
| 群聊中仅在被 @ 时才回复 | 建议勾选（群聊只在被 @ 时说话，更像真人、更安全） |
| 显示名 | 例如「我的 QQ 小号」 |

5. 保存。
6. 在这张连接卡片上点「绑定角色」，选一个角色。**不绑角色，消息进来不会有人回。**
   路由键留空 = 私聊 + 所有群都响应；填群号 = 只响应那个群（多个群就绑多条）。

> 凭据（WS/HTTP 地址 + Token）会 AES-256-GCM 加密后存进数据库，不会明文落盘，接口也不回显。
> 所以重新保存时**这些字段留空 = 沿用已保存的值**，不会把 Token 清掉。同一个 QQ 号再保存一次是更新，不会重复创建。

## 4. 启动 QQ 小号适配器

新开一个终端，在项目根目录执行：

```bash
yarn onebot:run
```

看到日志里出现 `onebot-connected` 即表示连上协议端了。

> 协议端那个窗口**不能关**（关了 QQ 就掉线）；`onebot:run` 这个进程也要保持运行。

## 5. 验证能收发

1. 用**另一个 QQ 号**（你的主号或朋友的号）给 QQ 小号**发私聊**「你好」。
2. 角色应该会回复（内容来自 yiling-hub 里配的模型 + 记忆）。
3. 如果开了「群聊仅 @ 回复」，去群里 **@ 一下小号**，它才会回。

## 6. 常见问题

| 现象 | 处理 |
|------|------|
| 收不到消息 | 确认协议端已登录、正向 WS 是 3001、`onebot:run` 在跑 |
| HTTP 一直失败 | 协议端 HTTP 端口若是默认 3000，会和 yiling-hub dev server 抢；改成 3002 并在渠道里同步 |
| 401 / 握手失败 | SnowLuma 的 WS token 与 HTTP token 填反了；两个框的值不一样 |
| `onebot-connected` 后仍不回 | 检查角色是否已绑定该渠道；检查角色模型/API Key 是否配好 |
| SnowLuma 首次连接报 1006 | 已知行为，会自动重连；只要最后出现 `onebot-connected` 就没问题 |
| SnowLuma 启动报 `Client private-message reporting is unavailable` | 只是拿不到自己发出去私聊的送达回执，不影响收消息，可忽略 |
| SnowLuma 进程活着但收不到 | 「Hook 退化」已知问题：重启协议端，仍不行就查它自己的 logs |
| 登录提示风控/验证 | 换扫码/短信登录，小号养几天再上 |
| 发消息频繁被吞 | 降低回复频率（QQ 对高频有管控） |
| 改了协议端端口后连不上 | 同步改 yiling-hub 渠道里的 WS/HTTP 地址 |

## 7. 将来换设备 / 上服务器

当前是「QQ 小号 + yiling-hub 同机 `127.0.0.1` 直连」，跑通后：

- **换设备挂小号**（公司 / 家里 / 笔记本轮换）：在每台电脑都装好协议端并登录小号（同一时刻只能一处在线），`onebot:run` 和 yiling-hub 也随设备走。
- **yiling-hub 上服务器**：QQ 小号继续留在家里/公司电脑，用内网穿透（frp / cpolar / cloudflared）把 `3001`/`3002` 暴露给服务器，然后在服务器 yiling-hub 的渠道里把地址改成穿透后的公网地址。

## 8. 安全提醒

- 用**小号**，非官方协议有封号风险，别用主号、别给 bot 号充值、别存重要数据。
- OneBot 端口**只走本机/局域网**，不要映射到公网（未加密 + 未鉴权，暴露等于交出 QQ 控制权）。
- 私聊场景风险低于群聊，群聊建议开启「仅 @ 回复」降低频率。
