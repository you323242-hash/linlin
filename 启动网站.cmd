@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" scripts\dev.mjs start
  ) else (
    echo 未找到 Node.js。请使用已安装的 Node 24 LTS 后再启动。
  )
) else (
  node scripts\dev.mjs start
)
echo.
echo 网站地址：http://127.0.0.1:4174
echo 运行中按 Ctrl+C 可停止。用户数据保留在 .local 文件夹。
pause
