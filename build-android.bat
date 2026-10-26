@echo off
rem Android APK をビルドする (ダブルクリック可)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-android.ps1" %*
set RESULT=%ERRORLEVEL%
pause
exit /b %RESULT%
