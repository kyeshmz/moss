#!/bin/bash
set -euo pipefail

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
swift build --package-path "$package_dir" -c release
bin_dir="$(swift build --package-path "$package_dir" -c release --show-bin-path)"
app="$package_dir/dist/Moss.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/Moss" "$app/Contents/MacOS/Moss"
cp "$package_dir/Resources/Info.plist" "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - "$app"
codesign --verify --strict "$app"
printf 'Packaged %s\nLaunch only when ready for microphone permission: open "%s"\n' "$app" "$app"
