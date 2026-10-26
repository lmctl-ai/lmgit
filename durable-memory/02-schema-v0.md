# Schema v0

`schema/lmgit.host.json` (copied byte-identical to `schema/lmgit.dsl.json`)
is the authored contract: `dsl.schema: 2`, name `lmgit`. With lmscript ≥
0.2.420 the compiler supplies the std catalog implicitly, so the embedded
schema is host-only; `print` and `assert_close` are host-provided via
`lmcode.RegisterTesting` (the lmhtml pattern).

## Contexts and types

- Contexts: `git: Git` (global ops + dry-run policy), `report: Report`
  (findings log: `add`, `len`, `write_text`, `write_json`, `fail_if_any`;
  `fail_if_any` raises `APP_FAIL` → exit 4).
- `Git.open(path) -> Repo` validates with
  `git -C path rev-parse --is-inside-work-tree`; `Git.clone(url, path)` is a
  dry-run-aware write.
- `Repo` holds the policy link and the absolute path; all repo ops are
  `git -C <path>` argv calls.
- Lists follow the `len()`/`at(int)` protocol: `StatusList`, `BranchList`,
  `CommitList`, and `Strings` (tags/remote names).

## Parsing decisions

- `status()` parses `--porcelain` (v1) lines: XY codes at columns 0-1,
  path from column 3, ` -> ` renames keep the destination.
- `log(limit)` uses `--pretty=format:%H%x1f%an%x1f%aI%x1f%s` (unit-separator
  fields, ISO dates) — stable against subjects containing spaces or pipes.
- `commit(message)` returns the new HEAD sha (`rev-parse HEAD` after the
  commit), so scripts can print or report what was created.
- Write ops under `dry_run(true)` add a `dry-run` report entry and return a
  `dry-run: git ...` marker string instead of executing.

## Reused toolchain constraints (same as lmgh)

- Host `Strings` type because std `StrList` has no exported constructor.
- No std `Json` as a host-declared return type (compiler rejects it).
