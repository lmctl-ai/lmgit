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

Each recipe calls explicit load_schema followed by run_lmcode. Run, for example,
`lmscript examples/repo-status.lms /path/to/repo`. A binary on PATH is used;
otherwise explicit real discovery may download the pinned lmgit v0.2.9 release.
Check mode needs the schema already cached by real discovery. The examples create
their report directory; there is no public compiled-file output argument.

The existing stdout/report oracles are exercised by ./test.sh. Terminal frames
are consumed by run_lmcode; application failures still exit4. The status example
also returns branch/clean as owned program result fields. Git >=2.20 is needed.
