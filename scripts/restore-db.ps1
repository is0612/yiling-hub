[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [switch]$ConfirmOverwrite
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $ConfirmOverwrite) {
    throw "恢复操作可能覆盖目标数据库。确认目标数据库和备份无误后，重新运行并添加 -ConfirmOverwrite。"
}

function Get-EnvValue([string]$Name, [string]$DefaultValue) {
    $envPath = Join-Path $repoRoot ".env"
    if (-not (Test-Path $envPath)) {
        throw "找不到 .env。请先复制 .env.example 为 .env 并配置本地数据库。"
    }

    foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*?)\s*$") {
            $value = $Matches[1].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $DefaultValue
}

$dbName = Get-EnvValue "POSTGRES_DB" "yiling_hub"
$dbUser = Get-EnvValue "POSTGRES_USER" "yiling_hub"
$backupDir = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "backups"))
[System.IO.Directory]::CreateDirectory($backupDir) | Out-Null

if ([System.IO.Path]::IsPathRooted($BackupFile)) {
    $backupPath = [System.IO.Path]::GetFullPath($BackupFile)
} else {
    $backupPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $BackupFile))
}

# 限制恢复文件必须位于仓库的 backups 目录，防止意外读取任意路径。
$prefix = $backupDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $backupPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "出于安全考虑，只允许从仓库的 backups 目录恢复备份文件。"
}
if (-not (Test-Path $backupPath -PathType Leaf)) {
    throw "找不到备份文件：$backupPath"
}
if ((Get-Item $backupPath).Length -le 0) {
    throw "备份文件为空：$backupPath"
}

$fileName = [System.IO.Path]::GetFileName($backupPath)
$containerPath = "/backups/$fileName"

Write-Warning "即将清理数据库 '$dbName' 中的现有对象并恢复 '$fileName'。此操作不可轻易撤销。"
$answer = Read-Host "输入 RESTORE 继续"
if ($answer -cne "RESTORE") {
    Write-Host "已取消恢复。"
    exit 0
}

docker compose up -d db
if ($LASTEXITCODE -ne 0) { throw "docker compose 启动数据库失败。" }

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    docker compose exec -T db pg_isready --username $dbUser --dbname $dbName *> $null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw "数据库在 60 秒内未就绪，请检查 docker compose logs db。" }

docker compose exec -T db pg_restore --username $dbUser --dbname $dbName --clean --if-exists --no-owner --no-privileges --exit-on-error $containerPath
if ($LASTEXITCODE -ne 0) {
    throw "pg_restore 失败。目标数据库可能处于部分恢复状态。请检查错误；保留原备份，并考虑恢复到一个新建的空数据库。"
}

Write-Host "恢复命令已成功结束。请启动应用并检查角色、消息、长期记忆、快照版本和任务数据。"
