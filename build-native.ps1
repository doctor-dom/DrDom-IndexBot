# Full native build for a Supernote plugin (.snplg with native modules such as react-native-fs)
# Usage (PowerShell, from this plugin directory):
#   npm install
#   powershell -ExecutionPolicy Bypass -File .\build-native.ps1
#
# Optional: copy local-build.ps1.example to local-build.ps1 and set JAVA_HOME / ANDROID_HOME.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-JavaHome {
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        return $env:JAVA_HOME
    }
    $javaCmd = Get-Command java -ErrorAction SilentlyContinue
    if ($javaCmd -and $javaCmd.Source) {
        $binDir = Split-Path $javaCmd.Source -Parent
        return (Split-Path $binDir -Parent)
    }
    $microsoftJdks = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'jdk*' } |
        Sort-Object Name -Descending
    foreach ($jdk in $microsoftJdks) {
        if (Test-Path (Join-Path $jdk.FullName 'bin\java.exe')) {
            return $jdk.FullName
        }
    }
    return $null
}

function Resolve-AndroidHome {
    if ($env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) {
        return $env:ANDROID_HOME
    }
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path $defaultSdk) {
        return $defaultSdk
    }
    return $null
}

if (Test-Path (Join-Path $root 'local-build.ps1')) {
    . (Join-Path $root 'local-build.ps1')
}

$resolvedJava = Resolve-JavaHome
$resolvedAndroid = Resolve-AndroidHome

if (-not $resolvedJava) {
    Write-Error "JAVA_HOME must point to a JDK install (bin\java.exe not found). Current: '$($env:JAVA_HOME)'. Run: where java"
}
if (-not $resolvedAndroid) {
    Write-Error "ANDROID_HOME must point to the Android SDK root. Current: '$($env:ANDROID_HOME)'. Install Android Studio SDK or set ANDROID_HOME."
}

$env:JAVA_HOME = $resolvedJava
$env:ANDROID_HOME = $resolvedAndroid

Write-Host "JAVA_HOME=$($env:JAVA_HOME)" -ForegroundColor Green
Write-Host "ANDROID_HOME=$($env:ANDROID_HOME)" -ForegroundColor Green

$sdkDir = $env:ANDROID_HOME -replace '\\', '/'
$localProps = Join-Path $root 'android\local.properties'
"sdk.dir=$sdkDir" | Set-Content -Path $localProps -Encoding ASCII
Write-Host "Wrote $localProps" -ForegroundColor Green

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$projectName = $pkg.name
if ([string]::IsNullOrWhiteSpace($projectName)) {
    Write-Error 'package.json name is required (used for .snplg filename)'
}

Push-Location $root
try {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error "npm install failed (exit $LASTEXITCODE). Fix dependency errors above before building."
    }

    Remove-Item -Recurse -Force (Join-Path $root 'build') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $root 'android\app\build') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $root 'android\.gradle') -ErrorAction SilentlyContinue

    & (Join-Path $root 'buildPlugin.ps1')
} finally {
    Pop-Location
}

$out = Join-Path $root "build\outputs\$projectName.snplg"
$outExists = Test-Path $out

if (-not $outExists) {
    Write-Error "Build failed: $out not found. On Windows use build-native.ps1, not bash buildPlugin.sh."
}

$sizeMb = [math]::Round((Get-Item $out).Length / 1MB, 2)
$genCfg = Join-Path $root 'build\generated\PluginConfig.json'
$hasNative = $false
if (Test-Path $genCfg) {
    $cfg = Get-Content $genCfg -Raw | ConvertFrom-Json
    $hasNative = [bool]$cfg.nativeCodePackage
}

Write-Host ""
Write-Host "Output: $out ($sizeMb MB)" -ForegroundColor Cyan
Write-Host "nativeCodePackage: $hasNative" -ForegroundColor $(if ($hasNative) { 'Green' } else { 'Red' })

if ($sizeMb -lt 1 -or -not $hasNative) {
    Write-Error "This looks like a JS-only build. Gradle/native module did not bundle. Check JAVA_HOME, ANDROID_HOME, and Gradle output above."
}

Write-Host "Native build OK." -ForegroundColor Green
