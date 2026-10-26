# Purpose and place

lmgit exists so agent-written LMScript can operate local git repositories
through a compiled schema contract instead of ad-hoc argv strings.

## Place in the stack

- LMScript source → `lmscript` (≥ 0.2.420) compiles against
  `schema/lmgit.dsl.json` → DSL bytecode v5 (`.dslb`).
- `lmgit` host (Go, `github.com/lmctl-ai/lmcode-go` SDK, CGO disabled)
  embeds the exact schema bytes, loads the bytecode, and runs it.
- Every operation shells out to `git` with `-c color.ui=false -C <repo>`
  (repo-scoped) and `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`,
  `GIT_OPTIONAL_LOCKS=0`.
- Upstream `git/git` v2.56.0 (`a0189536`) is vendored in `third_party/git`
  (git-ignored) as a read-only reference; `git.lock` pins it and
  `scripts/sync-git.sh --verify` guards drift.

## License boundary (important)

git is GPL-2.0; lmgit is MIT. That is safe only because lmgit never links,
embeds, or copies git code: it runs the `git` binary as a separate process
(argv/stdin/stdout), which the GPL treats as independent work. Keep it that
way — no cgo, no vendored-code compilation, no copy-paste from
`third_party/git`. The notices say this explicitly.

## Scope boundaries

- v0 covers reads (status, log, branches, tags, remotes, config, diff,
  show) and five dry-run-aware writes (checkout, branch_create, commit,
  push, tag_create). No rebases, merges, stash, submodule, or worktree ops.
- The host never prompts; `GIT_TERMINAL_PROMPT=0` plus refusal to run
  interactive commands.
- `git` version must parse as >= 2.20 or every op refuses.

## History

2026-10-10: `lmctl-ai/lmgit` created as `git2`, a Bun/TypeScript lmapi
server. 2026-10-26: renamed that repository to `lmctl-ai/lmgitcli` and
created a fresh `lmctl-ai/lmgit` as the Go lmcode host (same pivot pattern
as lmgh, except the old iteration keeps its own repo rather than history).
