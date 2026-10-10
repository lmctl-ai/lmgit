# LMScript Recipes for lmgit (`git2`)

Practical automation recipes in [LMScript](https://github.com/lmctl-ai/lmctl) using the `@lmctl-ai/lmgit` schema module import (defaulting to the `latest` channel defined by `cli.schema.latest.json`).

## Recipe Index

| File | What it does | Access | Arguments |
|---|---|---|---|
| `status-summary.lms` | Summarizes working tree status (branch, clean/dirty, staged/unstaged counts) | Read-only | `[path]` |
| `recent-commits.lms` | Displays recent commits with short hash, author, and commit summary | Read-only | `[limit] [path]` |
| `changed-files.lms` | Lists files changed and diff statistics against a target revision | Read-only | `[ref] [path]` |
| `branch-report.lms` | Reports all branches, current branch, upstream tracking, and ahead/behind counts | Read-only | `[path]` |
| `who-touched.lms` | Shows line-by-line blame attribution (author, commit, content) for a file | Read-only | `<file> [path]` |
| `commit-all.lms` | Stages all working tree changes and records a new commit with the given message | Changes state | `<message> [path]` |
| `remote-inventory.lms` | Lists configured git remotes and their fetch and push URLs | Read-only | `[path]` |

## Running Recipes

Run any recipe with `lmscript`:

```bash
lmscript examples/status-summary.lms
```

To preview without side effects or spawning tool processes:

```bash
lmscript --dry-run examples/commit-all.lms "my commit message"
```
