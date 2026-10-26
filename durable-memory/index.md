# lmgit — durable memory

Portable knowledge for this repository. Read this index first, then only the
chapters relevant to the task.

## What lmgit is

A Go [lmcode](../go.mod) host that turns git into a scriptable, schema-checked
API for LMScript: `.lms` source compiles against `schema/lmgit.dsl.json`
into DSL bytecode; the `lmgit` binary executes it by driving the `git`
binary over argv (prompts disabled) and returns typed domain objects. The
repository is the lmctl-ai fork of `git/git` — upstream is vendored in
`third_party/git` (reference only; no code is linked or copied, so the MIT
host keeps clear of git's GPL-2.0) and pinned by `git.lock`. The previous
Bun/TypeScript `git2` lmapi-server iteration of this project lives on as the
`lmctl-ai/lmgitcli` repository.

## 60-second takeover

```sh
scripts/sync-git.sh   # fetch the pinned git/git checkout
go build -o build/lmgit .
./test.sh             # 34 checks: build, parity, examples vs fake git, refusals
```

## Document map

| File | Contents |
|---|---|
| [01-purpose-and-place.md](01-purpose-and-place.md) | purpose, stack position, license boundary, scope |
| [02-schema-v0.md](02-schema-v0.md) | the v0 API catalog and design decisions |
| [03-build-run-test.md](03-build-run-test.md) | install story, CLI protocol, test flow |
| [04-open-items.md](04-open-items.md) | known gaps and candidate v1 work |
