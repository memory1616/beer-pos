@echo off
chcp 65001 >nul
title BeerPOS Cloud Server
cd /d "%~dp0"
echo ========================================
echo   BeerPOS - Cloud Server Mode
echo ========================================
echo.
echo Server se chay tai: http://localhost:3001
echo.
echo De truy cap tu may khac trong mang LAN:
echo   http://[IP-may-cua-ban]:3001
echo.
echo De xem IP may, chay: ipconfig
echo.
echo De dung: Ctrl+C
echo.
set PORT=3001
set HOST=0.0.0.0
node server.js
