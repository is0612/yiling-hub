@echo off
rem 双击这个就能把 QQ 链路整个拉起来：SnowLuma → 等端口 → 适配器。
rem 想换协议端目录就设 SNOWLUMA_HOME，默认 D:\AI\snowluma\v2.2.1。
cd /d "%~dp0.."
npx tsx scripts/start-qq-stack.ts
echo.
echo 已退出。按任意键关闭窗口。
pause >nul
