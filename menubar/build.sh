#!/bin/bash
set -e

# Build the AI Ops app headlessly with swiftc and assemble the .app bundle.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR"
APP_DIR="$SCRIPT_DIR/../AI Ops.app"
BIN_NAME="AI Ops"
LOGO_SRC="$SCRIPT_DIR/assets/aimakers-diamond.png"

echo "==> Compiling…"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

echo "==> Copying AI Makers diamond icon…"
if [ -f "$LOGO_SRC" ]; then
  cp "$LOGO_SRC" "$APP_DIR/Contents/Resources/aimakers-diamond.png"
else
  echo "WARNING: logo source not found at $LOGO_SRC — menubar icon will fall back to SF symbol."
fi

swiftc \
  -O \
  -target "$(uname -m)-apple-macos13.0" \
  -framework SwiftUI \
  -framework AppKit \
  -framework ServiceManagement \
  -parse-as-library \
  -o "$APP_DIR/Contents/MacOS/$BIN_NAME" \
  "$SRC_DIR/main.swift"

echo "==> Writing Info.plist…"
cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>AI Ops</string>
    <key>CFBundleDisplayName</key>
    <string>AI Ops</string>
    <key>CFBundleIdentifier</key>
    <string>co.aimakers.claudesessions</string>
    <key>CFBundleExecutable</key>
    <string>AI Ops</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Ad-hoc sign so SMAppService / launch is stable on Apple Silicon.
codesign --force --deep -s - "$APP_DIR" >/dev/null 2>&1 || true

echo "==> Built: $APP_DIR"
