#!/bin/sh
# Builds ClaudeIsland.app from ClaudeIsland.swift for this Mac (Apple silicon
# or Intel, macOS 14 or later). Needs Xcode or its command line tools.
# Usage: build.sh [path/to/ClaudeIsland.app]   (default ~/Applications/ClaudeIsland.app)
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
app="${1:-$HOME/Applications/ClaudeIsland.app}"
arch="$(uname -m)"

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -swift-version 5 -parse-as-library \
  -target "$arch-apple-macos14.0" \
  -o "$app/Contents/MacOS/ClaudeIsland" \
  "$here/ClaudeIsland.swift"
cp "$here/Info.plist" "$app/Contents/Info.plist"
codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "$app"
