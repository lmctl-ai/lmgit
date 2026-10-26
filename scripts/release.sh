#!/usr/bin/env bash
# Build release assets and create the GitHub release for a version.
# Asset names follow the lmscript install= convention: lmgit-OS-ARCH(.exe)
# with SHA256SUMS, for OS in linux/macos/windows and ARCH in x64/arm64.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <version>  (e.g. 0.1.1)" >&2
  exit 2
fi
case "$VERSION" in v*) echo "pass the version without the v prefix" >&2; exit 2;; esac

actual=$(./build/lmgit --version 2>/dev/null | awk '{print $2}')
if [ "$actual" != "$VERSION" ]; then
  echo "host reports version $actual; bump the version constant to $VERSION first" >&2
  exit 1
fi

OUT=build/release
rm -rf "$OUT"
mkdir -p "$OUT"

build() { # goos os arch suffix
  GOOS="$1" GOARCH="$3" CGO_ENABLED=0 go build -trimpath -ldflags='-buildid=' \
    -o "$OUT/lmgit-$2-$4$5" .
}

build linux linux amd64 x64 ""
build linux linux arm64 arm64 ""
build darwin macos amd64 x64 ""
build darwin macos arm64 arm64 ""
build windows windows amd64 x64 ".exe"
build windows windows arm64 arm64 ".exe"

(cd "$OUT" && sha256sum lmgit-* > SHA256SUMS)

gh release create "v$VERSION" "$OUT"/lmgit-* "$OUT/SHA256SUMS" \
  --repo lmctl-ai/lmgit --title "lmgit $VERSION" \
  --notes "lmgit $VERSION. Assets follow the lmscript install= convention (PROGRAM-OS-ARCH); checksums in SHA256SUMS."
echo "released v$VERSION"
