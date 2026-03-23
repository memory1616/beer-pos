@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo  ========================================
echo     BeerPOS - Tat PM2
echo  ========================================
echo.
call pm2 stop all
call pm2 delete all
echo.
echo  Da tat va xoa tat ca PM2 processes.
echo.
