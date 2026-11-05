@echo off
chcp 65001 >nul
title 课业看板本地代理
cd /d "%~dp0"

set LOG=%~dp0launch.log
set PORT=7788
if not "%~1"=="" set PORT=%~1

echo ==== %date% %time% 启动 ==== > "%LOG%"
echo 目录: %CD% >> "%LOG%"
where node >> "%LOG%" 2>&1

where node >nul 2>nul
if errorlevel 1 (
  echo [结果] 没找到 node >> "%LOG%"
  goto NONODE
)

rem ---------- 已经有一个代理在跑？ ----------
curl -s -m 2 "http://127.0.0.1:%PORT%/ping" >nul 2>nul
if not errorlevel 1 (
  echo [结果] 代理已在运行 >> "%LOG%"
  goto ALREADY
)

rem 端口被别的程序占着（不是我们的代理）
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if not errorlevel 1 (
  echo [结果] 端口 %PORT% 被占用 >> "%LOG%"
  goto PORTOCCUPIED
)

rem ---------- 首次运行装依赖 ----------
if not exist "node_modules\" (
  echo [步骤] 安装依赖 >> "%LOG%"
  echo.
  echo   第一次运行，正在安装依赖（只需一次，要联网）...
  echo.
  call npm install --no-audit --no-fund >> "%LOG%" 2>&1
)

echo.
echo   ============================================================
echo     课业看板 · 学习通本地代理
echo     窗口开着代理就在跑，关掉窗口就是停止。
echo   ============================================================
echo.
echo [步骤] node server.js %PORT% >> "%LOG%"
node "server.js" %PORT%

echo [结果] node 退出，退出码 %errorlevel% >> "%LOG%"
echo.
echo   代理已停止。若窗口里没有别的内容，说明 node 启动即退出，
echo   把 localserver\launch.log 发我即可定位。
echo.
pause
exit /b 0

:ALREADY
echo.
echo   ============================================================
echo     代理已经在运行了（端口 %PORT% 有服务在应答）
echo   ============================================================
echo.
echo   这不是出错，说明代理是好的。已经帮你打开控制台网页。
echo   如果网页能打开、能扫码，就说明一切正常，直接用小程序测。
echo.
echo   想自己开窗口看日志？先关掉后台的 node（任务管理器里结束
echo   所有 node.exe），再双击本文件。
echo.
start "" "http://127.0.0.1:%PORT%/"
pause
exit /b 0

:PORTOCCUPIED
echo.
echo   端口 %PORT% 被别的程序占用了，代理起不来。
echo.
echo   两个办法：
echo     1) 先关掉占用该端口的程序，再双击本文件；
echo     2) 换一个端口启动：start-proxy.cmd 7799
echo.
pause
exit /b 1

:NONODE
echo.
echo   [!] 没找到 node，代理起不来。
echo       请先安装 Node.js（https://nodejs.org ，选 LTS 版）。
echo       装完要关掉所有命令行窗口再重试（PATH 才会生效）。
echo.
pause
exit /b 1
