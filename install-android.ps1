param(
    [string]$Apk
)

# USB接続されたスマホへ APK を上書きインストールする
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Apk) {
    $candidates = @(
        (Join-Path $root "apk\app-debug.apk"),
        (Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk")
    )
    $Apk = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Apk -or -not (Test-Path $Apk)) {
    Write-Host "APK が見つかりません。先に build-android.bat を実行してください。" -ForegroundColor Red
    exit 1
}

# adb: ADB_PATH > PATH > 標準のSDK場所
$adb = $env:ADB_PATH
if (-not $adb) {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { $adb = $cmd.Source }
}
if (-not $adb) {
    $sdkCandidates = @(
        "$env:ANDROID_HOME\platform-tools\adb.exe",
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe"
    )
    $adb = $sdkCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $adb) {
    Write-Host "adb が見つかりません。platform-tools をPATHに追加するか、ADB_PATH を設定してください。" -ForegroundColor Red
    exit 1
}

Write-Host "adb: $adb"
Write-Host "APK: $Apk"

$devices = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim() -ne "" })
$ready = @($devices | Where-Object { $_ -match "\sdevice$" })
if ($devices | Where-Object { $_ -match "unauthorized" }) {
    Write-Host "端末が未承認です。スマホに表示されるUSBデバッグの許可ダイアログで「許可」を押してください。" -ForegroundColor Red
    exit 1
}
if ($ready.Count -eq 0) {
    Write-Host "端末が見つかりません。USB接続とUSBデバッグの有効化を確認してください。" -ForegroundColor Red
    exit 1
}
if ($ready.Count -gt 1) {
    Write-Host "複数の端末が接続されています。1台だけにしてください。" -ForegroundColor Red
    exit 1
}

Write-Host "インストール中..."
& $adb install -r $Apk
if ($LASTEXITCODE -ne 0) {
    Write-Host "インストールに失敗しました。" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "インストールが完了しました。スマホで「Smart Capture」を開いてください。" -ForegroundColor Green
