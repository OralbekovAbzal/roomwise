@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Сборка TuranResort Admin - установщик
echo ============================================
echo.

echo [1/2] Сборка exe через PyInstaller...
pyinstaller --noconfirm TuranResortAdmin.spec
if errorlevel 1 (
    echo Ошибка PyInstaller. Проверьте: pip install -r requirements.txt
    exit /b 1
)
echo.

echo [2/2] Сборка установщика Inno Setup...
where iscc >nul 2>nul
if errorlevel 1 (
    echo Inno Setup не найден в PATH.
    echo Установите Inno Setup 6 и добавьте папку установки в PATH, например:
    echo   "C:\Program Files (x86)\Inno Setup 6"
    echo Либо откройте TuranResortAdmin.iss в Inno Setup и нажмите Build.
    exit /b 1
)
iscc TuranResortAdmin.iss
if errorlevel 1 (
    echo Ошибка компиляции Inno Setup.
    exit /b 1
)

echo.
echo Готово. Установщик: Output\TuranResortAdmin_Setup_1.0.0.exe
pause
