# Current host protocol (2026-11-03)

This chapter supersedes historical v0 build/export/wire instructions in01–04.
The host is lmcode-only; the separate historical lmgitcli repo is not a dependency.

SDK: full reviewed Go SHA c075f8a87b63042b3f086c5e4f870c28edeff7e8, provenance
wp188's30-cell conformance qualification, recorded in sdk.lock/go.mod/go.sum.
The SDK is used as published; no local SDK patch. Compiler gates pin0.2.456.

main.go validates invocation metadata before creating the host or reading inputs,
selects a fresh owned sink per part, shares domain host state across parts, and
emits exactly one terminal envelope. Mandatory dry is never defaulted/retried.
SDK context dry skips domain callbacks; the explicit is_dry_run preview is true.
The old manual git.dry_run policy remains for real-mode writes. Missing input is
app/4; Report.fail_if_any is app/4; load/run failures3; CLI/metadata failures2.

Eight examples execute run_lmcode and have no bytecode-output argument. Host schema
bytes and operations remain unchanged. tests/expected removed only obsolete bare
success records and corrected APP_FAIL phase/framing. All34 old checks remain.
Real-Git tests add metadata/effects/builder/result and before/new parity assertions.
No arbitrary1000-log limit,three-line stderr truncation,output cap or host deadline.

CI privately installs the compiler, tests Linux, publishes CI-owned main versions,
then verifies downloaded release bytes and protocol/effects on the five already
covered native platforms. windows-arm64 is checksum/cross-build-only. Downstream
pins install="github:lmctl-ai/lmgit@vVERSION" with the exact CI release version.
