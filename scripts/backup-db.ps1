[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

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
$backupDir = Join-Path $repoRoot "backups"
[System.IO.Directory]::CreateDirectory($backupDir) | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeDbName = $dbName -replace '[^a-zA-Z0-9_-]', '_'
$fileName = "yiling-hub-$safeDbName-$timestamp.dump"
$hostPath = Join-Path $backupDir $fileName
$containerPath = "/backups/$fileName"

Write-Host "启动本地 PostgreSQL..."
docker compose up -d db
if ($LASTEXITCODE -ne 0) { throw "docker compose 启动数据库失败。" }

Write-Host "等待数据库就绪..."
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

Write-Host "创建数据库备份：$hostPath"
docker compose exec -T db pg_dump --username $dbUser --dbname $dbName --format=custom --file=$containerPath
if ($LASTEXITCODE -ne 0) {
    if (Test-Path $hostPath) { Remove-Item $hostPath -Force }
    throw "pg_dump 失败；请检查数据库状态与权限。"
}
if (-not (Test-Path $hostPath) -or (Get-Item $hostPath).Length -le 0) {
    throw "备份文件未生成或为空：$hostPath"
}

Write-Host "备份完成。请将备份文件安全地保存到仓库之外的异地位置。"
Write-Host $hostPath
