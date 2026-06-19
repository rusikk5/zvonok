@echo off
chcp 65001 >nul
echo.
echo  ╔══════════════════════════════════════╗
echo  ║      Звонок — Запуск сервера         ║
echo  ╚══════════════════════════════════════╝
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ОШИБКА: Node.js не установлен!
    echo  Скачай на https://nodejs.org ^(LTS версия^)
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo  Первый запуск — устанавливаю зависимости...
    echo  ^(это займёт ~30 секунд^)
    echo.
    npm install
    if %errorlevel% neq 0 (
        echo.
        echo  ОШИБКА при установке. Попробуй запустить от имени администратора.
        pause
        exit /b 1
    )
    echo.
)

echo  Запускаю Звонок...
echo.
node server.js
pause
