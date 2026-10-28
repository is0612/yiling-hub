# QQ 小号接入部署清单（NapCat + yiling-hub）

> 目标：用个人 QQ 小号，让 yiling-hub 里的大肥鱼在 QQ 上收发消息、带记忆。
> 前提：QQ 小号和 yiling-hub 先跑在同一台 Windows 电脑上（`127.0.0.1` 直连），跑通后再考虑上服务器/换设备。

## 0. 一句话原理

```
QQ 群/好友发消息
   → NapCat（挂在你登录的 QQNT 客户端里，把 QQ 操作翻译成 OneBot v11 协议）
   → OneBot 正向 WebSocket（ws://127.0.0.1:3001）推给 yiling-hub
   → yiling-hub 的 qq-onebot 适配器 → 角色 + 记忆 → 模型回复
   → OneBot HTTP API（http://127.0.0.1:3000）发回 QQ
```

NapCat 是"传话筒 + 翻译官"，yiling-hub 是"大脑"。

## 1. 装 NapCat

### 1.1 准备

- 一台 Windows 电脑，装好**新版 QQ（NTQQ，9.9.x）**，并用你的 QQ 小号**先登录一次**。
  - NapCat 是基于 NTQQ 的协议实现，需要一个已登录的 QQNT 客户端作载体。
- 强烈建议用**小号**（非主号）：非官方协议有风控/封号风险，小号损失可控。
- 小号先"养"几天（正常聊天、别一上来高频群发），降低风控概率。

### 1.2 下载安装

1. 打开 NapCat 官方 Release 页：`https://github.com/NapNeko/NapCatQQ/releases`
2. 下载 Windows 版本（推荐「一键安装器」`NapCat.Shell.Windows.OneKey.zip` 或 WebUI 版）。
3. 解压，运行 `NapCatInstaller.exe`，跟着向导走。
4. 安装完成后启动 NapCat。

### 1.3 扫码登录

- 启动后，按提示**用 QQ 小号扫码登录**（手机 QQ 扫码）。
- 首次扫码，之后同一设备可自动登录。
- 二维码 60 秒过期，过期就重启 NapCat 重新生成。

## 2. 开启 OneBot v11 正向 WebSocket + HTTP API

1. 浏览器打开 NapCat WebUI：`http://127.0.0.1:6099/webui/`（用终端里显示的 token 登录）。
2. 找到「网络配置」（Network / OneBot 11 设置）：
   - **开启「正向 WebSocket 服务端」**（forward WS server），端口保持 **3001**。
   - **开启「HTTP API」**，端口保持 **3000**。
   - Access Token 可以设一个（记下来，下面 yiling-hub 要填）；本机测试也可以先留空。
3. 保存并**重启 NapCat** 让配置生效。

### 2.1 验证端口已监听

PowerShell 执行：

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

有输出即说明 OneBot 的 WS 和 HTTP 都起来了。

## 3. 在 yiling-hub 里添加「QQ 小号」

1. 启动 yiling-hub（`yarn dev`）。
2. 打开「系统管理 → QQ 渠道」，点右上「添加 QQ 小号」。
3. 平台固定为 **`qq-onebot`**（这个页面只管 QQ 小号，B站 走「B站值班台」）。
4. 填表单：

| 字段 | 填什么 |
|------|--------|
| QQ 号（必填） | 你的 QQ 小号数字，例如 `123456789` |
| OneBot WebSocket 地址 | `ws://127.0.0.1:3001` |
| OneBot HTTP API 地址 | `http://127.0.0.1:3000` |
| WS Token | NapCat 里设的 Access Token（没设就留空） |
| HTTP Token | NapCat 里设的 Access Token（没设就留空） |
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

看到日志里出现 `onebot-connected` 即表示连上 NapCat 了。

> 注意：NapCat 那个窗口**不能关**（关了 QQ 就掉线）；`onebot:run` 这个进程也要保持运行。

## 5. 验证大肥鱼能收发

1. 用**另一个 QQ 号**（你的主号或朋友的号）给 QQ 小号**发私聊**「你好」。
2. 大肥鱼应该会回复（回复内容来自 yiling-hub 里你给角色配的模型 + 记忆）。
3. 如果开了「群聊仅 @ 回复」，去群里 **@ 一下小号**，它才会回。

## 6. 常见问题

| 现象 | 处理 |
|------|------|
| 收不到消息 | 确认 NapCat 已登录、正向 WS 已开、端口是 3001、`onebot:run` 在跑 |
| `onebot-connected` 后仍不回 | 检查角色是否已绑定到该渠道；检查角色模型/API Key 是否配好 |
| 登录提示风控/验证 | 换扫码/短信登录，小号养几天再上 |
| 发消息频繁被吞 | 降低回复频率（QQ 对高频有管控） |
| 改了 NapCat 端口后连不上 | 同步改 yiling-hub 渠道里的 WS/HTTP 地址 |

## 7. 将来换设备 / 上服务器

当前是「QQ 小号 + yiling-hub 同机 `127.0.0.1` 直连」，跑通后：

- **换设备挂小号**（公司 / 家里 / 笔记本轮换）：在每台电脑都装好 NapCat 并登录小号（同一时刻只能一处在线），`onebot:run` 和 yiling-hub 也随设备走。
- **yiling-hub 上服务器**：QQ 小号继续留在家里/公司电脑，用内网穿透（frp / cpolar / cloudflared）把 NapCat 的 `3000`/`3001` 端口暴露给服务器，然后在服务器 yiling-hub 的「QQ 小号」渠道里，把 WS/HTTP 地址改成穿透后的公网地址。

## 8. 安全提醒

- 用**小号**，非官方协议有封号风险，别用主号、别给 bot 号充值、别存重要数据。
- OneBot 端口**只走本机/局域网**，不要映射到公网（未加密 + 未鉴权，暴露等于交出 QQ 控制权）。
- 私聊场景风险低于群聊，群聊建议开启「仅 @ 回复」降低频率。
