# Standard `lmcode` REST Endpoints & Stateless CLI Interfaces

## Summary

`lmgit` is upgraded to `lmcode-go` `776494227256a7f83440690507f3cb6ffa50c608` (226 canonical `lmcode_std_v3` signatures) and `@lmctl-ai/lmctl@0.2.482`:
- Supports standard REST and stateless CLI interfaces (`RestGet`..`RestOptions`, `RestHandler`, `CliCommand`, `CliOption`, `rest_config`, `rest_route`, `rest_serve`, `rest_stop`, `rest_cli`).
- Verified by `./test.sh` (36 checks including `std-rest-cli` exercising `CliOption`, `CliCommand`, `RestGet`, and `rest_cli` against `git.open(".")`) and `python3 tests/protocol.py build/lmgit` (32 real-git protocol/effect checks).
