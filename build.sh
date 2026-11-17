#!/bin/zsh
# 打包「牛马加油器.app」
#   ./build.sh           编译到 build/牛马加油器.app
#   ./build.sh install   另外复制到 ~/Applications（开机自启需要装在这里）
#   ./build.sh dmg       另外打成 build/NiumaBooster-<版本>.dmg 安装包（发 Release 用）
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="牛马加油器"
EXE="NiumaBooster"
BUNDLE_ID="local.niuma.booster"
VERSION="1.0.0"
MIN_MACOS="13.0"
APP="build/${APP_NAME}.app"

echo "▸ 编译 (release, arm64 + x86_64)"
# Package.swift 里 platforms 是 .macOS(.v13)，二进制的 minos 会是 13.0（下面会检查）
swift build -c release --arch arm64 --arch x86_64 >/dev/null 2>&1 \
  || swift build -c release
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path 2>/dev/null || swift build -c release --show-bin-path)/${EXE}"
[[ -f "$BIN" ]] || BIN="$(swift build -c release --show-bin-path)/${EXE}"

echo "▸ 组装 ${APP}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/${EXE}"

echo "▸ 生成图标 (Assets/AppIcon.svg → AppIcon.icns)"
swift Scripts/make-icon.swift Assets/AppIcon.svg build/AppIcon.iconset >/dev/null
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${EXE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>自用，不联网</string>
</dict>
</plist>
PLIST

echo "▸ 本地签名 (ad-hoc)"
codesign --force --sign - --timestamp=none "$APP" >/dev/null

echo "▸ 检查"
lipo -archs "$APP/Contents/MacOS/${EXE}"
vtool -show-build "$APP/Contents/MacOS/${EXE}" 2>/dev/null | awk '/minos/ {print "  minos " $2}' | sort -u
codesign --verify --strict "$APP" && echo "  签名有效"

if [[ "${1:-}" == "dmg" ]]; then
  DMG="build/NiumaBooster-${VERSION}.dmg"
  STAGE="build/dmg"
  rm -rf "$STAGE" "$DMG"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "${APP_NAME}" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  rm -rf "$STAGE"
  echo "▸ 安装包：$DMG"
elif [[ "${1:-}" == "install" ]]; then
  mkdir -p "$HOME/Applications"
  DEST="$HOME/Applications/${APP_NAME}.app"
  pkill -x "$EXE" 2>/dev/null || true
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  touch "$DEST"   # 让 Finder 刷新图标缓存
  echo "▸ 已安装到 $DEST"
  open "$DEST"
else
  echo "完成：$APP （运行：open \"$APP\"）"
fi
