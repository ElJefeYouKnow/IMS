#!/usr/bin/env powershell
# IMS Setup Script - Install dependencies and start server

Write-Host "=== Inventory Management System Setup ===" -ForegroundColor Green

# Check if Node.js is installed
$nodeCheck = node --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Node.js is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

Write-Host "Node.js version: $nodeCheck" -ForegroundColor Green

# Install npm dependencies
Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
npm install

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to install dependencies" -ForegroundColor Red
    exit 1
}

Write-Host "`nDependencies installed successfully!" -ForegroundColor Green
Write-Host "`nStarting server..." -ForegroundColor Cyan

# Start the server
node server.js
