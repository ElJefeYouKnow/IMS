# Simple Postgres backup script.
# Usage: powershell -File backup-db.ps1
# Requires env var DATABASE_URL or specify manually.
$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dbUrl = $env:DATABASE_URL
if (-not $dbUrl) {
  Write-Error "Set DATABASE_URL before running."
}
$outFile = "backup-$timestamp.sql"
Write-Host "Backing up database to $outFile..."
pg_dump $dbUrl > $outFile
Write-Host "Backup complete: $outFile"
