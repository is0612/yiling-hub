[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [switch]$ConfirmOverwrite,

    [string]$ContainerName = "yiling-hub-db",

    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmOverwrite) {
    throw "Restore overwrites the target database. Confirm the target and the backup, then re-run with -ConfirmOverwrite."
}

if ($RepoRoot) {
    $repoRoot = (Resolve-Path $RepoRoot).Path
} elseif ($PSScriptRoot) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
} else {
    $repoRoot = (Get-Location).Path
}
Set-Location $repoRoot

function Get-DockerExe {
    $cmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        "C:\Program Files (x86)\Docker\Docker\resources\bin\docker.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw "docker was not found. Install Docker Desktop or add docker to PATH."
}

$docker = Get-DockerExe

function Get-EnvValue([string]$Name, [string]$DefaultValue) {
    $envPath = Join-Path $repoRoot ".env"
    if (-not (Test-Path $envPath)) {
        throw "Missing .env. Copy .env.example to .env and configure the local database first."
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

# Restrict restores to files inside the repository backups directory.
$prefix = $backupDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $backupPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "For safety, backups may only be restored from the repository backups directory."
}
if (-not (Test-Path $backupPath -PathType Leaf)) {
    throw "Backup file not found: $backupPath"
}
if ((Get-Item $backupPath).Length -le 0) {
    throw "Backup file is empty: $backupPath"
}

$fileName = [System.IO.Path]::GetFileName($backupPath)
$containerPath = "/backups/$fileName"

Write-Warning "This will drop existing objects in database '$dbName' and restore '$fileName'. It cannot be easily undone."
$answer = Read-Host "Type RESTORE to continue"
if ($answer -cne "RESTORE") {
    Write-Host "Restore cancelled."
    exit 0
}

Write-Host "Ensuring database container '$ContainerName' is running..."
& $docker start $ContainerName 2>$null
if ($LASTEXITCODE -ne 0) {
    & $docker compose up -d db 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not start container '$ContainerName'."
    }
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    & $docker exec $ContainerName pg_isready --username $dbUser --dbname $dbName *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw "Database was not ready within 60 seconds. Check the container logs." }

& $docker exec $ContainerName pg_restore --username $dbUser --dbname $dbName --clean --if-exists --no-owner --no-privileges --exit-on-error $containerPath
if ($LASTEXITCODE -ne 0) {
    throw "pg_restore failed. The target database may be partially restored. Keep the original backup and consider restoring into a fresh empty database."
}

Write-Host "Restore finished. Start the app and verify characters, messages, memories, snapshots and tasks."
