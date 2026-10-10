# git2 `lm_*` ops — structured, byte-preserving reads

Ops beginning with `lm_` are a port of lmctl-ai/lmprobe's libgit2-based
`git_command.rs`, implemented over the `git` CLI instead of libgit2. They
exist for machine consumers that need structure our plain `status/diff/log`
ops don't expose, or byte-preserving guarantees.

## Surface

- `lm_status` — porcelain v1 with `-z`, rows with independent index_status /
  worktree_status / untracked / ignored / conflicted. `clean` is true only
  when no row has any change.
- `lm_diff` — unified diff parsed into rows, per-file status (added /
  modified / deleted / renamed / typechanged), hunks with `origin: +/- /\` /
  space lines, byte-preserving content.
- `lm_log` — commit graph rows with full author/committer signatures (name,
  email, time, offset_minutes), parents, tree, summary. Default max-count 20,
  `--max-count` overrides. Unborn-HEAD returns `rows: []`, not an error.
- `lm_show` — a commit's metadata, or a file blob from a revision
  (`--file`). Returns byte-preserving content.
- `lm_branch` — for-each-ref rows with optional upstream + ahead/behind
  computed via `rev-list --left-right --count`.
- `lm_remote` — remotes with credential-stripped URLs; `parseGitHubPrUrl` is
  the gh2 analogue for PR URLs.
- `lm_rev_parse` — resolve revision to `{oid, kind, commit?}`; commit
  peeling handles tags.
- `lm_ls_files` — index entries `--stage -z` with mode/oid/stage.
- `lm_blame` — per-line `--line-porcelain` blame with author metadata per
  hunk, boundary flags, path normalization.

## Byte-preserving contract

Any string that cannot be decoded as UTF-8 is represented as
`{bytes_hex: "..."}`. Do not lossy-decode; always emit the hex form so
consumers can reconstruct. This mirrors lmprobe's behavior on Unix file
names and is load-bearing for tests in `lm-git.test.ts`.

## Where NOT to add things

Do not add git submodule, worktree-move, or interactive-rebase handling to
these ops. They are deliberately read-only; mutations stay in the regular
ops (`add`, `commit`, `branch_create`, `merge`, ...) under policy.
