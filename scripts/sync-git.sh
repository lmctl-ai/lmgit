#!/usr/bin/env bash
# Fetch or verify the vendored git/git checkout used as the upstream
# reference for the lmgit fork (lmhtml sync-lexbor idiom). The vendored
# source is a reference only: lmgit never links or copies git code.
set -euo pipefail
cd "$(dirname "$0")/.."

LOCK=git.lock
DIR=third_party/git

repo=$(sed -n 's/^repo=//p' "$LOCK")
commit=$(sed -n 's/^commit=//p' "$LOCK")

if [ "${1:-}" = "--verify" ]; then
  if [ ! -d "$DIR/.git" ]; then
    echo "third_party/git is not checked out; run scripts/sync-git.sh" >&2
    exit 1
  fi
  actual=$(git -C "$DIR" rev-parse HEAD)
  if [ "$actual" != "$commit" ]; then
    echo "third_party/git is at $actual, lock pins $commit; run scripts/sync-git.sh" >&2
    exit 1
  fi
  echo "third_party/git matches $commit"
  exit 0
fi

mkdir -p third_party
if [ ! -d "$DIR/.git" ]; then
  rm -rf "$DIR"
  git init -q "$DIR"
  git -C "$DIR" remote add origin "$repo"
fi
git -C "$DIR" fetch -q --depth 1 origin "$commit"
git -C "$DIR" checkout -q FETCH_HEAD
echo "third_party/git now at $commit ($repo)"
