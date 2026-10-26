# lmgit examples

LMScript recipes compiled against the lmgit schema and run by the `lmgit`
host. Each example takes a repository path (default `.`) and operates on the
ambient git repository.

| File | What it does | git access | Arguments |
|---|---|---|---|
| [repo-status.lms](repo-status.lms) | Branch, cleanliness, porcelain status entries as JSON | read | `[repo-path]` |
| [recent-commits.lms](recent-commits.lms) | Recent commits with hash, author and date | read | `[repo-path] [limit]` |
| [branch-list.lms](branch-list.lms) | Local branches with the current one marked | read | `[repo-path]` |
| [tags-remotes.lms](tags-remotes.lms) | Tags, remote names and their URLs | read | `[repo-path]` |
| [uncommitted-changes.lms](uncommitted-changes.lms) | CI gate: exits 4 (`APP_FAIL`) when the tree is dirty | read | `[repo-path]` |
| [repo-health.lms](repo-health.lms) | CI gate: branch, cleanliness, origin remote; exits 4 on findings | read | `[repo-path]` |
| [new-branch.lms](new-branch.lms) | Creates and checks out a branch; dry-run unless `--live` | write | `[repo-path] <name> [--live]` |
| [make-commit.lms](make-commit.lms) | Commits staged changes, prints the new HEAD sha; dry-run unless `--live` | write | `[repo-path] <message> [--live]` |

## Running

Nothing to install: on first compile, `lmscript` downloads the released
lmgit host for your platform (SHA-256 verified, cached under the lmscript
tool cache) because each recipe names it on the `_lmcode_` line:

```sh
lmscript examples/repo-status.lms /path/to/repo   # compile to build/repo-status.dslb
lmgit --dsl build/repo-status.dslb                # run
```

If `lmgit` is already on `PATH`, the download is skipped and that binary is
used. Runtime requirement: `git` >= 2.20.

`./test.sh` compiles every example, runs it against the canned `git` double
in [tests/fake-git.py](../tests/fake-git.py), and diffs stdout and report
files against [tests/expected/](../tests/expected/).
