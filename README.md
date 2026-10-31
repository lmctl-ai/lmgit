# lmgit — git as an lmcode tool

lmgit is a native host for [lmcode](https://github.com/lmctl-ai/lmcode-go)
bytecode that turns git into a scriptable, type-checked API: LMScript source
is compiled against the lmgit schema into DSL bytecode, and the `lmgit`
host executes it through the `git` binary (argv only, prompts disabled),
producing typed `Repo`, `Commit`, `Branch` and status objects plus a
`Report` for findings.

This repository is the lmctl-ai fork of [`git/git`](https://github.com/git/git):
upstream is vendored under `third_party/git` and pinned by
[`git.lock`](git.lock). The lmgit-authored host, schema and examples are MIT
licensed (see [LICENSE](LICENSE)); git itself is GPL-2.0 and is **not**
linked or copied — lmgit drives the `git` binary as a separate process, the
same way lmgh drives `gh` (see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

## Use it — no installation

Users do **not** install lmgit and do **not** need Go. A `_lmcode_` block
that names lmgit makes `lmscript` download the released host binary for your
platform (SHA-256 verified, cached), compile against its embedded schema,
and run it:

```lms
out = ARGV.len() > 0 ? ARGV[0] : "build/repo-status.dslb";
path = ARGV.len() > 1 ? ARGV[1] : ".";
p = _lmcode_ cli="lmgit" install="github:lmctl-ai/lmgit@latest";
let repo = git.open(${path});
print("branch: " + repo.current_branch());
let commits = repo.log(5);
for (i in range(0, commits.len())) {
  print(commits.at(i).hash() + " " + commits.at(i).subject());
}
end _lmcode_
savedsl(p, out);
```

```sh
lmscript repo-status.lms /path/to/repo   # compiles AND fetches the lmgit host on first use
lmgit --lmcode build/repo-status.dslb       # or run it straight from the lmscript tool cache
```

The only runtime requirement is `git` itself (version >= 2.20). Set
`LMGIT_GIT` to point at a `git` that is not on `PATH`.

The schema ([`schema/lmgit.dsl.json`](schema/lmgit.dsl.json)) is the
contract: `lmgit --lmcode-schema` prints the exact embedded bytes and
`lmgit --lmcode-signatures` the host registry. Contexts: `git: Git` (global
operations and the dry-run policy) and `report: Report` (findings log with
`write_text`, `write_json` and `fail_if_any`, which fails with exit 4 /
`APP_FAIL` when non-empty).

## Operation catalog (v0)

Global: `version`, `open(path) -> Repo`, `clone(url, path) -> Repo`.
Repo reads: `path`, `current_branch`, `is_clean`, `status`, `branches`,
`log(limit)`, `tags`, `remote_names`, `remote_url`, `config`, `diff(staged)`,
`show(ref)`.
Writes: `checkout`, `branch_create`, `commit` (returns the new HEAD sha),
`push`, `tag_create` — all honor `git.dry_run(bool)`, which records intent
in the report instead of running git.

## Develop

```sh
go build -o build/lmgit .   # from a source checkout; needs Go 1.26
scripts/sync-git.sh         # fetch the pinned git/git checkout (third_party/)
./test.sh                   # 34 checks: build, parity, examples vs a fake git, refusals
```

Releases: pushing a `v*` tag publishes automatically — CI runs `./test.sh`
and, once tests pass, cross-builds the six `lmgit-{linux,macos,windows}-{x64,arm64}`
assets plus `SHA256SUMS` and creates the GitHub release (the asset names are
the lmscript `install=` convention). `scripts/release.sh <version>` remains as
the local fallback. [durable-memory/](durable-memory/) records the design and
decisions.
