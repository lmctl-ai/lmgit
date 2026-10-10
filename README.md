# lmgit — `git2`, a structured git CLI

`git2` runs `git` (argv only, never a shell) and returns JSON: status, diff, log, blame, branches, remotes, tags, stashes, worktrees and the write operations around them. Byte-preserving `lm_*` reads keep non-UTF-8 paths as `{bytes_hex}` and strip credentials from remote URLs.

`git2` is an [lmapi](https://github.com/lmctl-ai/lmapi) server: `git2 --schema` prints its
`cli.schema.v1` document, which is the contract. A client (an LLM tool, a script,
an SDK) validates against it before calling, and `git2` validates again and
enforces its policy. Built on [@lmctl-ai/lmts](https://github.com/lmctl-ai/lmts).

## Install

`git2` runs on [Bun](https://bun.sh) and needs the `git` binary on `PATH`.

```sh
git clone https://github.com/lmctl-ai/lmgit.git
cd lmgit
bun install
bun link            # puts `git2` on PATH
```

## Usage

```sh
git2 --list                 # operations with access (read/write) and descriptions
git2 --schema               # the cli.schema.v1 document
git2 --explain <op>         # one operation's schema (--format text for help text)
git2 <op> [--param value ...] [--dryrun] [--readonly] [--confirm]
```

```sh
git2 lm_status --path .
git2 log --path . --max-count 5
git2 commit --path . --message "fix: typo" --dryrun
git2 lm_log --input-json '{"op":"lm_log","params":{"path":".","maxCount":3}}'
```

Input can be flags, a JSON document (`--input-json '{"op":...,"params":{...}}'`
or `--input-file`) or a GraphQL document (`--input-graphql`). Output is JSON on
stdout; errors are `{"success":false,"error":{"code","message","data"}}` with a
non-zero exit code.

## Use from lmscript

> [!NOTE]
> Available in lmscript >= the release that includes schema module import.

lmscript can import this tool's schema directly:

```ts
import "@lmctl-ai/lmgit";

const status = await git2.lm_status({ path: "." });
```

Or with an alias:

```ts
import "@lmctl-ai/lmgit" as mygit;

const diff = await mygit.lm_diff({ path: ".", staged: true });
```

Or targeting the development channel:

```ts
import "@lmctl-ai/lmgit#dev";
```

### Channel files and release workflow

The repository publishes two schema contracts at the root of its default branch:
- `cli.schema.latest.json` — the contract of the latest stable release (default for `import "@lmctl-ai/lmgit"`).
- `cli.schema.dev.json` — the active development contract (used by `import "@lmctl-ai/lmgit#dev"`).

When releasing a new tool version, copy `cli.schema.dev.json` to `cli.schema.latest.json` in the release commit. Automated tests verify that `cli.schema.dev.json` is byte-for-byte identical to `bun src/cli.ts --schema`, and that all differences between `latest` and `dev` are strictly additive.

### Product compatibility

`git2` declares and enforces product version requirements for the underlying `git` binary:
- Product name: `git`
- Supported versions: `>=2.43.0 <3.0.0`
- Detection: `git --version` (pattern `git version (\d+\.\d+\.\d+)`)

If the installed `git` binary is missing or outside this range, operations are refused with error code `UNSUPPORTED_PRODUCT_VERSION` (exit code 10). Introspection flags (`--schema`, `--list`, `--help`) succeed regardless of the product check. The `git2` binary must be installed and available on `PATH` at runtime; installing the CLI tool is separate.

## Safety flags

Every write goes through the same policy before any command is built:

- `--dryrun` — report what would run, change nothing (reads still execute).
- `--readonly` — refuse every write operation.
- `--confirm` — required for operations marked dangerous.
- Environment floors `GIT2_READONLY=1` / `GIT2_DRYRUN=1` turn the same modes on for every call;
  flags cannot loosen them.

Operations whose schema does not declare `access: "read"` are treated as effectful.

## Development

Requires [Bun](https://bun.sh) (version in `.bun-version`).

```sh
bun install --frozen-lockfile
bunx tsc --noEmit
bun test --coverage   # fails below the thresholds in bunfig.toml
```

The tests are hermetic: no network, no credentials, and they never touch your
`HOME` or working directory; `git` tests run against throwaway repositories in a temp directory.

## Provenance

- The git operations, their option/result types and the output parsers
  (`src/types.ts`, `src/index.ts`, `src/operations/**`, `src/utils/**`) are derived
  from [cyanheads/git-mcp-server](https://github.com/cyanheads/git-mcp-server)
  (Apache-2.0), ported from the MCP server to a standalone CLI with the
  MCP/DI/OpenTelemetry wrapper removed. Details in [NOTICE](NOTICE).
- The structured `lm_*` reads originated in
  [lmctl-ai/lmprobe](https://github.com/lmctl-ai/lmprobe) (MIT, Lattice Systems LLC).
- The CLI runtime is [@lmctl-ai/lmts](https://github.com/lmctl-ai/lmts).

## License

MIT for original code; Apache-2.0 for derived portions, see [NOTICE](NOTICE).
The MIT license is in [LICENSE](LICENSE), the Apache License 2.0 in
[LICENSE-APACHE](LICENSE-APACHE).
