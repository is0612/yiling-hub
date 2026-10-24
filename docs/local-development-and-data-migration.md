# 本地开发与数据迁移规范

本文说明如何在本地开发 Yiling Hub、备份 PostgreSQL 数据，并将项目迁移到新电脑。脚本面向 Windows PowerShell；其他系统可按同样原则实现对应脚本。

> 当前实现状态：Nuxt 管理后台已经接入 PostgreSQL，角色 CRUD、记忆设置、会话录入/对话、快照版本、AI 记忆提炼、长期记忆、持久化任务队列、Scheduler/Worker、原始消息保留清理与审计、管理员登录与服务端会话、多用户（管理员 + 邮箱注册用户）与账号管理、QQ 官方机器人渠道适配器、以及 Windows 备份/恢复的**真实数据演练**均已有实现和验收。生产部署安全（HTTPS、反向代理、监控告警）见 `docs/deployment.md`，仍需在真实服务器上演练。

## 1. 文件职责

- `docker-compose.yml`：本地 PostgreSQL 服务。
- `.env.example`：环境变量模板，不含真实密钥。
- 本地真实配置放在根目录 `.env`，禁止提交到 Git。
- `prisma/schema.prisma`：Phase 0 初始数据模型；`prisma/migrations/`：Phase 2 审查并生成的数据库迁移历史。
- `scripts/backup-db.ps1`：生成 PostgreSQL 自定义格式逻辑备份。
- `scripts/restore-db.ps1`：将指定备份恢复到配置的开发数据库。
- `backups/`：本地备份输出目录，已加入 Git 忽略规则。

## 2. 首次设置（Windows）

1. 安装 Git、Node.js LTS 和 Docker Desktop。
2. 克隆仓库并进入项目根目录。
3. 复制环境变量模板：

   ```powershell
   Copy-Item .env.example .env
   ```

4. 编辑 `.env`，至少修改 `POSTGRES_PASSWORD` 与 `DEV_OWNER_PASSWORD`（至少 12 位），并确保 `DATABASE_URL` 中的用户名、密码、主机、端口和数据库名与上方设置一致。保持 `YILING_LOCAL_API_ENABLED=true` 仅用于本机开发；这些示例值不能用于公开服务。
5. 使用仓库锁文件安装依赖（项目统一使用 Yarn Classic 1.22.22，不要额外生成 `package-lock.json`）：

   ```powershell
   yarn install --frozen-lockfile
   ```

6. 创建备份目录并启动数据库：

   ```powershell
   New-Item -ItemType Directory -Force backups
   docker compose up -d db
   docker compose ps
   ```

7. 仓库已经包含 Prisma Schema 与初始迁移。首次使用时先校验并应用迁移、生成 Prisma Client，再创建本地开发用户：

   ```powershell
   yarn db:validate
   yarn db:migrate:deploy
   yarn db:generate
   yarn db:seed:dev
   ```

   初始迁移面向全新、空的本地开发数据库。若数据库中已有重要数据或手动创建的表，先停止并备份；不要对已有数据数据库运行重置命令。

## 3. 本地数据存放位置

PostgreSQL 的运行数据存放在 Docker named volume `yiling_postgres_data`。不要将这个卷当作唯一备份。

数据库迁移优先使用 PostgreSQL 逻辑备份（`pg_dump` 的 custom 格式）和 `pg_restore` 恢复。该方式比直接拷贝 Docker 卷更适合不同电脑、不同 Docker 环境或迁移到 Linux 服务器。

如果上传图片或其他文件存放在本地目录，还必须单独备份这些文件。仅备份 PostgreSQL 不会自动包含文件系统中的图片或附件。

另外，网页中保存的角色 API Key 使用本机生成的加密密钥 `.data/credentials-encryption.key` 加密。备份/迁移包含 API Key 的数据库时，必须将该文件安全地一并备份并恢复到新电脑项目根目录的 `.data/` 下；如果丢失，原有 API Key 无法解密，需要在角色的“AI 对话 → 模型参数”中重新录入。该文件已被 Git 忽略，不能提交到仓库。

## 4. 备份数据库

从仓库根目录运行（或直接双击 `scripts\backup-db.bat`）：

```powershell
.\scripts\backup-db.ps1
```

脚本会启动数据库容器（如果尚未运行），并在 `backups/` 生成带时间戳的 `.dump` 文件。

> 注意：脚本会自动定位 `docker.exe`（先查 PATH，再回退到 Docker Desktop 的默认安装路径），因此即使 `docker` 不在 PATH 中也能运行。2026-10-25 已在本机完成一次真实演练：备份生成、恢复到临时库、并逐表核对 18 张表的行数与源库完全一致后清理。

备份文件可能包含私人聊天与角色记忆，必须视为敏感数据：
- 不要提交到 Git。
- 不要放入公开共享目录。
- 需要异地保存时，使用有访问控制的存储，必要时先加密。
- 保留多个可恢复版本，定期清理过期的本地备份。
- 定期进行恢复测试，确认文件不仅“存在”而且“可用”。

## 5. 恢复数据库

> 警告：恢复脚本会清理目标数据库中的既有对象并恢复备份内容。先确认目标数据库正确，并确保已备份目标数据库中需要保留的数据。

运行（或把 `.dump` 文件拖到 `scripts\restore-db.bat` 上）：

```powershell
.\scripts\restore-db.ps1 -BackupFile ".\backups\yiling-hub-YYYYMMDD-HHMMSS.dump" -ConfirmOverwrite
```

将示例文件名替换为实际备份文件名。必须显式传入 `-ConfirmOverwrite`，脚本才会继续执行。

首次恢复到新电脑时，优先恢复到一个空的本地开发数据库。恢复完成后，检查角色数量、消息、长期记忆、快照版本、任务记录和迁移历史，再启动应用。不要在未经检查的情况下把开发数据库备份恢复到含有真实用户数据的生产数据库。

## 6. 更换电脑的完整流程

### 旧电脑

1. 停止正在执行写入的开发任务。
2. 执行备份脚本并确认备份文件生成。
3. 将备份文件安全地复制到加密移动硬盘或受访问控制的云盘。
4. 确认代码已提交并推送到 Git；真实 `.env` 不要提交。
5. 单独备份不在 Git 中的用户上传文件（如果有）。

### 新电脑

1. 安装 Git、Node.js LTS、Docker Desktop。
2. 克隆仓库。
3. 复制 `.env.example` 为 `.env`，设置本机开发密码和数据库连接串。
4. 创建 `backups/`，将备份文件复制到该目录。
5. 运行 `docker compose up -d db`。
6. 使用恢复脚本恢复数据库。
7. 安装项目依赖（`yarn install --frozen-lockfile`），确认 `.data/credentials-encryption.key` 已安全恢复，然后执行 `yarn db:generate` 并按当前 README 检查迁移状态。
8. 在本地启动应用，检查角色、消息、快照、版本和周期设置。
9. 测试无误后，再继续开发。

## 7. 迁移到云服务器

1. 在云环境准备独立数据库或受保护的 PostgreSQL 服务。
2. 先备份本地数据库并保留原副本。
3. 在目标环境建立与项目版本兼容的数据库。
4. 在目标环境执行已提交的迁移文件，或按经验证的恢复流程导入数据；两种方式不可不加判断地混用。
5. 通过独立且受保护的环境变量配置连接串和模型密钥。
6. 验证数据库、权限、周期设置、Worker 和备份流程。
7. 确认目标服务可用后再切换流量。
8. 生产备份必须存放在服务器之外，并定期测试恢复。

不要将本地 `.env` 原样复制到公开服务器；要为目标环境单独配置凭据。

## 8. 故障处理

- **数据库未启动：** 检查 `docker compose ps` 与容器日志。
- **端口冲突：** 修改 `.env` 中的 `POSTGRES_PORT`，同时同步更新 `DATABASE_URL`。
- **恢复失败：** 保留原备份文件，查看完整错误信息；不要反复对含重要数据的目标数据库尝试破坏性恢复。
- **版本不兼容：** 先确认 PostgreSQL 版本与扩展需求，测试迁移后再操作真实数据。
- **项目能运行但数据缺失：** 确认连接的是预期的数据库，不要误把空库当成恢复成功。

## 9. 保持文档同步

凡是更改 Docker 服务、数据库版本、环境变量、Prisma 命令或备份/恢复行为，都必须同步修改本文、`.env.example` 和相关脚本。脚本变更需要在本地测试；文档不能声称未经验证的命令已成功执行。