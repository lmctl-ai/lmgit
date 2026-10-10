# lmgit (`git2`) — durable memory

Portable knowledge for this repository. Read this first, then `./lm-git.md` for
the structured `lm_*` reads.

## What git2 is

A structured CLI over the `git` binary for LLMs and programs: JSON in, JSON out.
It is an lmapi server: `git2 --schema` prints its `cli.schema.v1` document, and
that document is the contract (see https://github.com/lmctl-ai/lmapi). Clients
validate against it before calling; git2 validates again and enforces policy.
Humans keep using `git`.

The runtime (argv/JSON/GraphQL input forms, validation, policy flags, error
envelope, `--schema`/`--list`/`--explain`/`--help`) is `@lmctl-ai/lmts/server`;
schema types and validation come from `@lmctl-ai/lmts`. This repository only
defines operations and their schemas.

## Layout

- `src/cli.ts` — op registry (`--list` shows them), access per op, `runCli`.
- `src/schemas.ts` — authored `OperationSchema` for every op (descriptions, types,
  cardinality `1 ? + *`).
- `src/index.ts` — the `Git2` facade. Every public method enforces policy before
  any command is built (read runs; write respects dry-run/read-only; dangerous
  writes need `--confirm`).
- `src/operations/**` — one function per op (add, commit, log, diff, branch,
  merge, rebase, cherry-pick, remote, fetch/push/pull, tag, stash, worktree,
  reset, blame, reflog). Each takes `(options, context, execGit)`.
- `src/utils/git-executor.ts` — `executeGitCommand` (argv only, timeout, locked
  down env); `execGitCommandSafe` for ops that expect a non-zero exit as data.
- `src/utils/command-builder.ts` — the `SAFE_GIT_OPTIONS` flag allow-list is the
  argument-injection defence (CVE-2017-1000117 class). Any flag a new op uses
  must be added here first.
- `src/utils/output-parser.ts` — porcelain v2 / ls-files / blame / reflog parsing.
  `--porcelain=v2 -z` is the canonical status shape.
- `src/lm-git.ts` — structured byte-preserving reads (see `./lm-git.md`).
- `src/types.ts` — option/result types for the operations.

`types.ts`, `index.ts`, `operations/**` and `utils/**` are derived from
cyanheads/git-mcp-server (Apache-2.0); keep the modification notice at the top of
those files and update `NOTICE` if the set of derived files changes.

## Invariants

- Every operation has an authored schema; `--schema` has no derived schemas.
- git2 never uses a shell; argv arrays only.
- Byte-preserving paths in `lm-git.ts`: non-UTF-8 strings become
  `{bytes_hex: ...}`.
- Remote URLs are redacted in `lm_remote`: userinfo and query/fragment removed,
  IPv6 hosts preserved, scp-style and local paths unchanged.
- `lm_rev_parse` runs plain `rev-parse <revision>` (peels to commit); only the HEAD
  lookup in the envelope uses `rev-parse --verify HEAD`.
- The published tool name stays `git2`; renaming an op breaks client scripts.

## Adding an op

1. Typed options in `types.ts`; the execute function in `operations/`.
2. Extend `SAFE_GIT_OPTIONS` for new flags.
3. Author the schema in `schemas.ts`.
4. Register it in `cli.ts` with the right access (`read` or `write`; a missing
   access counts as effectful).
5. Tests: dry-run shape, a real run in a temp repository, policy gates.

## Tests

`bun test --coverage` (thresholds in `bunfig.toml`). Tests use the real `git`
binary only inside temp directories with an isolated `HOME`/git config; they
never touch the network, the real `HOME` or the working directory.
