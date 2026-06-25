#!/bin/bash
# Build browser extensions for Launchy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building Firefox extension..."
cd "$SCRIPT_DIR/extensions/firefox"
rm -f "$SCRIPT_DIR/public/launchy-extension.xpi"
zip -r "$SCRIPT_DIR/public/launchy-extension.xpi" manifest.json popup.html popup.css popup.js icons/
echo "  -> public/launchy-extension.xpi"

echo "Building Chromium extension..."
cd "$SCRIPT_DIR/extensions/chromium"
rm -f "$SCRIPT_DIR/public/launchy-extension-chromium.zip"
zip -r "$SCRIPT_DIR/public/launchy-extension-chromium.zip" manifest.json popup.html popup.css popup.js icons/
echo "  -> public/launchy-extension-chromium.zip"

echo "Done!"
