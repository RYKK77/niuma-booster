$ErrorActionPreference = "Stop"

$winRoot = Split-Path -Parent $PSScriptRoot
$nativeDir = Join-Path $winRoot "native"
$libDir = Join-Path $nativeDir "lib"
$distDir = Join-Path $winRoot "dist"
$coreDir = Join-Path $winRoot "src\core"
$rendererDir = Join-Path $winRoot "src\renderer"
$assetsDir = Join-Path $winRoot "assets"

New-Item -ItemType Directory -Force -Path $libDir | Out-Null
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# 1. 确保 WebView2 互操作 DLL 已就位
if (-not (Test-Path (Join-Path $libDir "Microsoft.Web.WebView2.Core.dll"))) {
    Write-Host "Downloading Microsoft.Web.WebView2 NuGet package..."
    $nupkg = Join-Path $libDir "webview2.zip"
    Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2903.40" -OutFile $nupkg
    Expand-Archive -Path $nupkg -DestinationPath (Join-Path $libDir "extracted") -Force
    Copy-Item (Join-Path $libDir "extracted\lib\net462\Microsoft.Web.WebView2.Core.dll") $libDir -Force
    Copy-Item (Join-Path $libDir "extracted\lib\net462\Microsoft.Web.WebView2.WinForms.dll") $libDir -Force
    Copy-Item (Join-Path $libDir "extracted\runtimes\win-x64\native\WebView2Loader.dll") $libDir -Force
    Remove-Item -Recurse -Force (Join-Path $libDir "extracted"), $nupkg
}

# 2. 将 src/core/*.js 打包为纯浏览器可执行脚本 core-bundle.js
$bundleBuilder = New-Object System.Text.StringBuilder
[void]$bundleBuilder.AppendLine("(function() {")
[void]$bundleBuilder.AppendLine("  const modules = {};")
[void]$bundleBuilder.AppendLine("  const cache = {};")
[void]$bundleBuilder.AppendLine("  function requireMod(name) {")
[void]$bundleBuilder.AppendLine("    const key = name.replace(/^\.\//, '').replace(/\.js$/, '');")
[void]$bundleBuilder.AppendLine("    if (cache[key]) return cache[key].exports;")
[void]$bundleBuilder.AppendLine("    const m = { exports: {} };")
[void]$bundleBuilder.AppendLine("    cache[key] = m;")
[void]$bundleBuilder.AppendLine("    modules[key](m, m.exports, requireMod);")
[void]$bundleBuilder.AppendLine("    return m.exports;")
[void]$bundleBuilder.AppendLine("  }")

foreach ($modName in @("holidayData", "settings", "wageEngine", "display", "index")) {
    $srcPath = Join-Path $coreDir "$modName.js"
    $code = [System.IO.File]::ReadAllText($srcPath, [System.Text.Encoding]::UTF8)
    [void]$bundleBuilder.AppendLine("  modules['$modName'] = function(module, exports, require) {")
    [void]$bundleBuilder.AppendLine($code)
    [void]$bundleBuilder.AppendLine("  };")
}

[void]$bundleBuilder.AppendLine("  window.__NiumaCore = requireMod('index');")
[void]$bundleBuilder.AppendLine("})();")

$coreBundlePath = Join-Path $libDir "core-bundle.js"
[System.IO.File]::WriteAllText($coreBundlePath, $bundleBuilder.ToString(), (New-Object System.Text.UTF8Encoding($false)))

# 3. 使用系统内置 .NET Framework 4.8 csc.exe 编译单文件原生版
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    throw "未找到系统内置 C# 编译器: $csc"
}

$portableOut = Join-Path $distDir "NiumaBooster-Portable-1.0.0.exe"
$iconIco = Join-Path $assetsDir "icon.ico"

$csPath = Join-Path $nativeDir "NiumaHost.cs"
$csContent = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($csPath, $csContent, (New-Object System.Text.UTF8Encoding($true)))

$cscArgs = @(
    "/nologo",
    "/utf8output",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    "/out:$portableOut",
    "/win32icon:$iconIco",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:$(Join-Path $libDir 'Microsoft.Web.WebView2.Core.dll')",
    "/reference:$(Join-Path $libDir 'Microsoft.Web.WebView2.WinForms.dll')",
    "/resource:$(Join-Path $libDir 'Microsoft.Web.WebView2.Core.dll'),Microsoft.Web.WebView2.Core.dll",
    "/resource:$(Join-Path $libDir 'Microsoft.Web.WebView2.WinForms.dll'),Microsoft.Web.WebView2.WinForms.dll",
    "/resource:$(Join-Path $libDir 'WebView2Loader.dll'),WebView2Loader.dll",
    "/resource:$coreBundlePath,core-bundle.js",
    "/resource:$(Join-Path $nativeDir 'bridge.js'),bridge.js",
    "/resource:$(Join-Path $nativeDir 'controller.js'),controller.js",
    "/resource:$(Join-Path $rendererDir 'panel.html'),panel.html",
    "/resource:$(Join-Path $rendererDir 'panel.css'),panel.css",
    "/resource:$(Join-Path $rendererDir 'panel.js'),panel.js",
    "/resource:$(Join-Path $rendererDir 'settings.html'),settings.html",
    "/resource:$(Join-Path $rendererDir 'settings.css'),settings.css",
    "/resource:$(Join-Path $rendererDir 'settings.js'),settings.js",
    "/resource:$(Join-Path $rendererDir 'minibar.html'),minibar.html",
    "/resource:$(Join-Path $rendererDir 'minibar.css'),minibar.css",
    "/resource:$(Join-Path $rendererDir 'minibar.js'),minibar.js",
    "/resource:$(Join-Path $assetsDir 'icon.ico'),icon.ico",
    "/resource:$(Join-Path $assetsDir 'icon.png'),icon.png",
    "/resource:$(Join-Path $assetsDir 'tray.png'),tray.png",
    "/resource:$(Join-Path $assetsDir 'tray@2x.png'),tray@2x.png",
    (Join-Path $nativeDir "NiumaHost.cs")
)

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) {
    throw "csc.exe 编译失败，退出码: $LASTEXITCODE"
}

Copy-Item $portableOut (Join-Path $distDir "牛马加油器 1.0.0.exe") -Force

# 4. 如果本机存在 NSIS (makensis.exe)，同时生成轻量 Setup 安装包
$makensis = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\nsis*\*\makensis.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($makensis) {
    $setupOut = Join-Path $distDir "NiumaBooster-Setup-1.0.0.exe"
    $nsiPath = Join-Path $libDir "installer.nsi"
    $nsiContent = @"
Unicode true
!include "MUI2.nsh"
Name "牛马加油器"
OutFile "$setupOut"
InstallDir "`$LOCALAPPDATA\Programs\NiumaBooster"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "$iconIco"
!define MUI_UNICON "$iconIco"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "`$INSTDIR"
  File "/oname=牛马加油器.exe" "$portableOut"
  File "$iconIco"
  WriteUninstaller "`$INSTDIR\Uninstall.exe"
  CreateShortCut "`$DESKTOP\牛马加油器.lnk" "`$INSTDIR\牛马加油器.exe" "" "`$INSTDIR\icon.ico"
  CreateDirectory "`$SMPROGRAMS\牛马加油器"
  CreateShortCut "`$SMPROGRAMS\牛马加油器\牛马加油器.lnk" "`$INSTDIR\牛马加油器.exe" "" "`$INSTDIR\icon.ico"
SectionEnd

Section "Uninstall"
  Delete "`$DESKTOP\牛马加油器.lnk"
  Delete "`$SMPROGRAMS\牛马加油器\牛马加油器.lnk"
  RMDir "`$SMPROGRAMS\牛马加油器"
  Delete "`$INSTDIR\牛马加油器.exe"
  Delete "`$INSTDIR\icon.ico"
  Delete "`$INSTDIR\Uninstall.exe"
  RMDir "`$INSTDIR"
SectionEnd
"@
    [System.IO.File]::WriteAllText($nsiPath, $nsiContent, (New-Object System.Text.UTF8Encoding($true)))
    & $makensis.FullName /V2 $nsiPath
    if ($LASTEXITCODE -eq 0) {
        Copy-Item $setupOut (Join-Path $distDir "牛马加油器 Setup 1.0.0.exe") -Force
    }
}

Get-ChildItem (Join-Path $distDir "*.exe") | Select-Object Name, Length, @{N='SizeKB';E={[math]::Round($_.Length / 1KB, 1)}}
