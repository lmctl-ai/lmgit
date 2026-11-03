# lmgit — git as an lmcode host

lmgit exposes Git through the reviewed Go lmcode SDK: typed repositories,
commits, branches, status entries and reports. Git is a separate argv-only
process, with prompts, color and pagers disabled. No Git code is linked.
See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [git.lock](git.lock).

## Run a program

Use a current compiler (the gates pin `@lmctl-ai/lmctl@0.2.456`, privately
installed). Git >=2.20 is required; `LMGIT_GIT` selects a specific executable.
The eight [examples](examples/README.md) execute through `run_lmcode`.

```lms
schema = load_schema(cli="lmgit" install="github:lmctl-ai/lmgit@v0.2.9");
program = _lmcode_ schema;
let repo = git.open(".");
$return.branch = repo.current_branch();
$return.clean = repo.is_clean();
end _lmcode_
result = run_lmcode(program);
require(result.ok, "git host failed");
print(json_stringify(result.result));
```

The host is discovered explicitly; a local binary on PATH wins over the tool
cache. For reproducible downstream use, replace `latest` with the exact CI
release tag. The release's SHA256SUMS pins each platform asset. No computed
bytecode-output path is part of the public example contract.

## Host protocol

- `--version`: exact build version.
- `--lmcode-schema [--json]`: exact hash-bound schema bytes.
- `--lmcode-signatures`: sorted SDK and domain signatures.
- `--lmcode FILE [--lmcode FILE ...]`: one invocation, single or builder.

Execution ends in exactly one `LMCODE_RETURN_BEGIN` / `LMCODE_RETURN_END`
frame. `run_lmcode` consumes the frame. Success contains the program's owned
result (null if unwritten); builders contain separate results in add order.
Failures contain phase/code/message and optional source/part association,
never partial result arrays. Exit codes are 0 success, 2 CLI/metadata,
3 load/run and 4 application failure. Unreadable input remains an application
failure. Program traces precede the terminal frame.

The private version-1 `LMCODE_INVOCATION_FILE` descriptor requires boolean
`dry`. Missing/nonboolean values are rejected before any input read or Git
dispatch. No default insertion or retry is performed. Metadata file strings
and CLI occurrences are correlated exactly, without path normalization.
Introspection does not read execution metadata or start Git.

## Dry policy

The immutable invocation dry flag is copied into the SDK context. Host callbacks
are skipped by default and return the SDK's typed dummies; `git.is_dry_run()` has
an explicit preview returning true. No Git process or report-file write occurs
in invocation dry mode. Pure standard previews and result writes retain their
SDK behavior; this is not a sandbox for arbitrary bytecode.

The existing `git.dry_run(bool)` operation remains a real-mode domain policy:
its write operations record intent instead of running Git. It cannot disable
an invocation's dry mode. All existing operations remain available.

## Operations

Global: version, open and clone. Repository reads: path, current_branch,
is_clean, status, branches, log(limit), tags, remote_names, remote_url, config,
diff(staged) and show. Writes: checkout, branch_create, commit, push and
tag_create. Lists expose len/at and typed properties. Report exposes add,
len, write_text, write_json and fail_if_any.

Log limits are caller-selected positive integers, with no arbitrary upper
ceiling. Git stdout/stderr and program results are not truncated. Platform
representability and available resources still apply; no host deadline or
implicit output/work budget is introduced.

## Develop and qualify

Go1.26 and Node24 are used by CI. Build with `go build -o build/lmgit .`, then
run `./test.sh` with LMSCRIPT_BIN pointing at a privately installed compiler.
That preserves all34 established fake-Git checks and eight example/report
oracles. `go test -race ./...` and `go vet ./...` check native code.
`python3 tests/protocol.py build/lmgit` exercises a real scratch repository,
strict metadata, builder order, dry effects, all exit classes and large output.
Its optional --before argument compares six operations on identical inputs
against the pre-adoption host; CI builds that immutable historical revision.

[sdk.lock](sdk.lock) records the full reviewed Go runtime SHA; go.mod/go.sum
pin its module bytes. Fixture generation uses the compiler library only in
maintainer tooling, never a public export operation. SDK defects must be
reported upstream rather than patched in this host.

## CI releases

After tests pass on main, CI selects version `0.2.RUN_NUMBER`, cross-builds six
assets, publishes the versioned release and SHA256SUMS, then downloads and
checks the actual binaries on Linux x64/arm64, macOS x64/arm64 and Windows x64.
Those five jobs run the real-Git protocol/effect suite, not just --version.
Windows arm64 has a cross-build and upload checksum check, without a native
execution claim. Operator-supplied version tags still use the same CI pipeline.
No manual tag or release command is required for adoption.
