#!/usr/bin/env powershell
param(
    [ValidateSet('dev', 'start')]
    [string]$Mode = 'dev',
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "=== IMS Local Dev Startup ===" -ForegroundColor Green

function Test-CommandExists {
    param([string]$CommandName)
    try {
        Get-Command $CommandName -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Initialize-EnvFile {
    param(
        [string]$EnvPath,
        [string]$TemplatePath
    )

    if (Test-Path $EnvPath) {
        Write-Host "Using existing .env.local" -ForegroundColor Green
        return
    }

    if (Test-Path $TemplatePath) {
        Copy-Item $TemplatePath $EnvPath
    } else {
        New-Item -ItemType File -Path $EnvPath -Force | Out-Null
        Add-Content -Path $EnvPath -Value @(
            'DATABASE_URL=postgres://postgres:postgres@localhost:5432/ims'
            'DATABASE_SSL=false'
            'NODE_ENV=development'
            'SESSION_STORE=memory'
            'COOKIE_SECURE=false'
        )
    }

    Write-Host "Created .env.local with local development defaults." -ForegroundColor Yellow
    Write-Host "Edit .env.local if your PostgreSQL credentials differ from postgres/postgres." -ForegroundColor Yellow
}

function Install-Dependencies {
    param([switch]$ForceInstall)

    $needsInstall = $ForceInstall -or -not (Test-Path (Join-Path $scriptDir 'node_modules'))
    if (-not $needsInstall) {
        Write-Host "Dependencies already installed. Skipping npm install." -ForegroundColor Green
        return
    }

    Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install dependencies."
    }
}

if (-not (Test-CommandExists 'node')) {
    Write-Host "Node.js is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Install Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$nodeVersion = node --version
Write-Host "Node.js version: $nodeVersion" -ForegroundColor Green

if (-not (Test-CommandExists 'npm')) {
    Write-Host "npm is not available in PATH" -ForegroundColor Red
    exit 1
}

$envPath = Join-Path $scriptDir '.env.local'
$templatePath = Join-Path $scriptDir '.env.local.example'
Initialize-EnvFile -EnvPath $envPath -TemplatePath $templatePath
Install-Dependencies -ForceInstall:$Install

Write-Host "`nLocal app URLs:" -ForegroundColor Cyan
Write-Host "  Login:      http://localhost:8000/login.html"
Write-Host "  Dashboard:  http://localhost:8000/dashboard.html"
Write-Host "  Procurement:http://localhost:8000/order-register.html"
Write-Host "  Operations: http://localhost:8000/inventory-operations.html"
Write-Host "  Projects:   http://localhost:8000/job-creator.html"

if ($Mode -eq 'dev') {
    Write-Host "`nStarting in watch mode (nodemon)..." -ForegroundColor Cyan
    npm run dev
} else {
    Write-Host "`nStarting in normal mode..." -ForegroundColor Cyan
    npm start
}
