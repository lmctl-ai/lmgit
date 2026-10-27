# Build, run, test

## Install story (users)

Users never install lmgit and never need Go. The `_lmcode_` block names the
host (`cli="lmgit" install="github:lmctl-ai/lmgit@latest"`), so `lmscript`
downloads the release asset `lmgit-OS-ARCH` (OS: linux/macos/windows; arch:
x64/arm64; `.exe` on windows) into its tool cache
(`LMSCRIPT_TOOL_CACHE` or `~/.cache/lmscript/tools`), verifies sha256 against
`SHA256SUMS`, and compiles against the binary's embedded schema. A `lmgit`
found on PATH skips the download. (Verified for lmgh 2026-10-26; same
convention, verify here after the first release.) The only user prerequisite
is `git` >= 2.20; `LMGIT_GIT` overrides the git path.

Releases: pushing a `v*` tag publishes automatically — CI runs `./test.sh`
and, once tests pass, the release job cross-builds the six assets +
SHA256SUMS, verifies the tag matches `lmgit --version`, and creates the GitHub
release. `scripts/release.sh <version>` (no `v` prefix) remains as the local
fallback; the `version` constant in host.go must match.

## CLI protocol

- `lmgit --version` → `lmgit 0.1.1`
- `lmgit --dsl-schema [--json]` → embedded schema bytes (byte-equal to
  `schema/lmgit.dsl.json`; every `.dslb` header hash is sha256 of these
  bytes)
- `lmgit --dsl-signatures` → registry signatures (full SDK std + host; a
  superset of the compiler's catalog)
- `lmgit --dsl FILE` → load + run; success prints one
  `{"ok": true, "result": null}` line
- anything else → one-line `CLI_USAGE` JSON, exit 2

Exit codes: 0 ok · 2 usage · 3 load/VM/host errors · 4 `APP_FAIL`.

## Test flow (`./test.sh`, 34 checks)

Same structure as lmgh: compiler gate, `sync-git.sh --verify`, `go build`,
fake `git` on PATH ([tests/fake-git.py](../tests/fake-git.py) — canned
output, fails for unknown refs/remotes/repos, never touches a real repo),
examples byte-diffed against `tests/expected/`, refusal chunks (bad limit,
list bounds, not-a-repo, bad ref/remote, branch conflict, checkout missing,
empty commit message, missing git binary, live/dry writes, `APP_FAIL`, junk
bytecode, missing file).
