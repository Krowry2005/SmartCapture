param(
    [string]$JavaHome,
    [string]$AndroidHome,
    [string]$GradleCmd
)

# android/ をASCIIのみのパスへコピーしてビルドし、apk\app-debug.apk に出力する
# (プロジェクトパスに日本語が含まれると Gradle が失敗するため)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($JavaHome) { $env:JAVA_HOME = $JavaHome }
if ($AndroidHome) { $env:ANDROID_HOME = $AndroidHome }
if (-not $env:ANDROID_HOME) {
    foreach ($p in @("$env:LOCALAPPDATA\Android\Sdk", "C:\Program Files (x86)\Android\android-sdk")) {
        if (Test-Path $p) { $env:ANDROID_HOME = $p; break }
    }
}
if (-not $env:JAVA_HOME) {
    $jdk = Get-ChildItem "C:\Program Files\Microsoft", "C:\Program Files\Eclipse Adoptium", "C:\Program Files\Java" -Directory -Filter "jdk-17*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
}
if (-not $GradleCmd) {
    $local = Get-ChildItem "$env:USERPROFILE\gradle-tools" -Directory -Filter "gradle-*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($local) { $GradleCmd = Join-Path $local.FullName "bin\gradle.bat" }
    elseif (Get-Command gradle -ErrorAction SilentlyContinue) { $GradleCmd = "gradle" }
}
if (-not $GradleCmd -or -not $env:JAVA_HOME -or -not $env:ANDROID_HOME) {
    Write-Host "JDK 17 / Android SDK / Gradle が見つかりません。-JavaHome -AndroidHome -GradleCmd で指定してください。" -ForegroundColor Red
    exit 1
}

$work = Join-Path $env:TEMP "mirror-build"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
Copy-Item (Join-Path $root "android") $work -Recurse
Remove-Item (Join-Path $work "app\build") -Recurse -Force -ErrorAction SilentlyContinue

# インストール済みの build-tools に合わせる (ライセンス未同意のバージョンを避ける)
$tools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($tools) {
    $gradleFile = Join-Path $work "app\build.gradle.kts"
    $text = Get-Content $gradleFile -Raw
    if ($text -notmatch "buildToolsVersion") {
        $text = $text -replace "(compileSdk\s*=\s*\d+)", "`$1`r`n    buildToolsVersion = `"$($tools.Name)`""
        [IO.File]::WriteAllText($gradleFile, $text, (New-Object Text.UTF8Encoding $false))
    }
}

Push-Location $work
try {
    & $GradleCmd ":app:assembleDebug" --no-daemon -q
    if ($LASTEXITCODE -ne 0) { throw "Gradle のビルドに失敗しました。" }
} finally {
    Pop-Location
}

$out = Join-Path $root "apk"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $work "app\build\outputs\apk\debug\app-debug.apk") (Join-Path $out "app-debug.apk") -Force
Remove-Item $work -Recurse -Force
Write-Host "APK を作成しました: $out\app-debug.apk" -ForegroundColor Green
