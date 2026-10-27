# Open items

Candidate work after v0, in no fixed order.

## API surface

- `merge`, `rebase`, `stash_push`/`stash_list`, `cherry_pick` — the
  lmgitcli (`git2`) repo's catalog is the reference for which commands
  matter.
- `ahead_behind(branch)` via `git rev-list --count` when an upstream is
  configured.
- `file_text(path)` scoped to the repo root (scripts currently use std
  `file_read` with the path from `Repo.path()`).
- `api` escape hatch for arbitrary read-only git argv (blocked on the same
  compiler `Json` limitation as lmgh).

## Platform

- Release v0.1.1 on publishes from CI: pushing a `v*` tag runs `./test.sh`
  and the release job cross-builds the six `lmgit-OS-ARCH` assets +
  SHA256SUMS, verifies the tag matches `lmgit --version`, and creates the
  GitHub release (v0.1.0 was cut locally with `scripts/release.sh`).
- Commit signing/hooks: the host runs `git commit` with the repo's own
  configuration (hooks run); document or add `--no-verify` policy if agent
  use cases need it.

## Upstream

- `git.lock` pins v2.56.0. git's CLI text output (branch listing, status
  porcelain v1) is stable but the pin is the reference for any parsing
  changes.
