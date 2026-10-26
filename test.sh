#!/usr/bin/env bash
# lmgit end-to-end checks: build, schema parity, examples against a fake git,
# and refusal tests. Mirrors lmgh's test.sh structure.
set -u
cd "$(dirname "$0")"
mkdir -p build

PASS=0
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# --- compiler ----------------------------------------------------------
LMSCRIPT="${LMSCRIPT_BIN:-$(command -v lmscript || true)}"
[ -n "$LMSCRIPT" ] || fail "lmscript not found; npm install -g @lmctl-ai/lmctl"
ver=$("$LMSCRIPT" --version 2>/dev/null | awk '{print $2}')
[ -n "$ver" ] || fail "cannot read lmscript version"
python3 - "$ver" <<'PY' || fail "lmscript $ver < 0.2.420"
import sys
sys.exit(0 if tuple(int(p) for p in sys.argv[1].split(".")) >= (0, 2, 420) else 1)
PY
ok "compiler $LMSCRIPT ($ver)"

# --- upstream git pin ---------------------------------------------------
scripts/sync-git.sh --verify 2>/dev/null || scripts/sync-git.sh || fail "cannot sync third_party/git"
ok "third_party/git pinned by git.lock"

# --- build --------------------------------------------------------------
CGO_ENABLED=0 go build -trimpath -ldflags='-buildid=' -o build/lmgit . || fail "go build"
HOST=build/lmgit
ok "go build (CGO disabled)"

# fake git on PATH for every run below
mkdir -p build/fake-bin
cat > build/fake-bin/git <<EOF
#!/bin/bash
exec python3 "$PWD/tests/fake-git.py" "\$@"
EOF
chmod +x build/fake-bin/git
export PATH="$PWD/build/fake-bin:$PWD/build:$PATH"

# --- CLI protocol -------------------------------------------------------
[ "$("$HOST" --version)" = "lmgit 0.1.0" ] || fail "--version"
ok "--version"
cmp -s <("$HOST" --dsl-schema) schema/lmgit.dsl.json || fail "--dsl-schema bytes differ from schema/lmgit.dsl.json"
ok "--dsl-schema equals schema/lmgit.dsl.json"
set +e; out=$("$HOST" 2>&1); code=$?; set -e
[ "$code" = 2 ] && [[ "$out" == *'CLI_USAGE'* ]] || fail "bad args refusal (exit $code)"
set +e
out=$("$HOST" --schema 2>&1); code=$?
set -e
[ "$code" = 2 ] || fail "former --schema flag accepted"
ok "usage errors exit 2 with CLI_USAGE JSON"

# --- schema parity ------------------------------------------------------
"$HOST" --dsl-signatures > build/host-signatures.txt
"$LMSCRIPT" --dsl-signatures schema/lmgit.dsl.json > build/compiler-signatures.txt
missing=$(python3 - <<'PY'
host = set(open("build/host-signatures.txt").read().splitlines())
print("\n".join(s for s in open("build/compiler-signatures.txt").read().splitlines() if s not in host))
PY
)
[ -z "$missing" ] || fail "compiler signatures missing from host registry: $missing"
ok "every compiler-visible signature binds in the host registry"
python3 - <<'PY' || fail "host schema drifts from the registry"
import json, subprocess
schema = json.load(open("schema/lmgit.host.json"))
sigs = set(subprocess.run(["build/lmgit", "--dsl-signatures"], capture_output=True, text=True).stdout.splitlines())
want = [f"context {n}: {t}" for n, t in schema["context"].items()]
for fn, overloads in schema.get("functions", {}).items():
    for o in overloads:
        want.append(f"fn {fn}({', '.join(o['params'])}) -> {o['returns']}")
for t, decl in schema["types"].items():
    for m, overloads in decl.get("methods", {}).items():
        for o in overloads:
            ret = t if o["returns"] == "self" else o["returns"]
            want.append(f"method {t}.{m}({', '.join(o['params'])}) -> {ret}")
missing = [s for s in want if s not in sigs]
if missing:
    print("\n".join(missing)); raise SystemExit(1)
PY
ok "every host schema signature is registered"

# --- examples -----------------------------------------------------------
run_example() { # name [expected-exit]
  local name="$1" want="${2:-0}"
  "$LMSCRIPT" "examples/$name.lms" "build/$name.dslb" >/dev/null || fail "$name compile"
  od -An -t u1 -j 5 -N 1 "build/$name.dslb" | grep -q 5 || fail "$name is not bytecode v5"
  set +e
  "$HOST" --dsl "build/$name.dslb" > "build/$name.out" 2>&1
  local code=$?
  set -e
  [ "$code" = "$want" ] || fail "$name exit $code (want $want): $(cat build/$name.out)"
  cmp -s "build/$name.out" "tests/expected/$name.out" || fail "$name stdout drift: $(diff tests/expected/$name.out build/$name.out | head -5)"
  ok "$name (exit $want)"
}

run_example repo-status
run_example recent-commits
run_example branch-list
run_example tags-remotes
run_example uncommitted-changes 4
run_example repo-health 4
run_example new-branch
run_example make-commit
cmp -s build/repo-status.json tests/expected/repo-status.json || fail "repo-status.json drift"
cmp -s build/recent-commits.txt tests/expected/recent-commits.txt || fail "recent-commits.txt drift"
cmp -s build/branch-list.json tests/expected/branch-list.json || fail "branch-list.json drift"
cmp -s build/tags-remotes.txt tests/expected/tags-remotes.txt || fail "tags-remotes.txt drift"
cmp -s build/new-branch.txt tests/expected/new-branch.txt || fail "new-branch.txt drift"
cmp -s build/make-commit.txt tests/expected/make-commit.txt || fail "make-commit.txt drift"
ok "example report files match"

# --- behavioral chunks ---------------------------------------------------
WORK=build/test-chunks
rm -rf "$WORK"; mkdir -p "$WORK"
compile_chunk() { # name body
  cat > "$WORK/$1.lms" <<EOF2
p = _lmcode_ cli="lmgit" install="github:lmctl-ai/lmgit@latest";
$2
end _lmcode_
savedsl(p, "$WORK/$1.dslb");
EOF2
  "$LMSCRIPT" "$WORK/$1.lms" >/dev/null || fail "$1 compile"
}

expect_run() { # name want-exit needle
  set +e
  out=$("$HOST" --dsl "$WORK/$1.dslb" 2>&1); code=$?
  set -e
  [ "$code" = "$2" ] || fail "$1 exit $code (want $2): $out"
  [[ "$out" == *"$3"* ]] || fail "$1 output lacks '$3': $out"
  ok "$1"
}

expect_refusal() { # name body needle
  compile_chunk "$1" "$2"
  expect_run "$1" 3 "$3"
}

expect_refusal bad-limit 'let r = git.open("."); r.log(0);' 'invalid limit'
expect_refusal list-oob 'let r = git.open("."); r.status().at(99);' 'out of range'
expect_refusal not-a-repo 'git.open("not-a-repo");' 'not a git repository'
expect_refusal bad-ref 'let r = git.open("."); r.show("missing-ref");' 'failed'
expect_refusal bad-remote 'let r = git.open("."); r.remote_url("missing");' "No such remote"
expect_refusal branch-exists 'let r = git.open("."); r.branch_create("conflict-branch");' 'already exists'
expect_refusal checkout-missing 'let r = git.open("."); r.checkout("missing-branch");' 'did not match'
expect_refusal empty-commit-msg 'let r = git.open("."); r.commit("");' 'must not be empty'

# git binary missing: LMGIT_GIT points nowhere
compile_chunk needs-git 'git.open(".");'
set +e
out=$(LMGIT_GIT="$WORK/no-such-git" "$HOST" --dsl "$WORK/needs-git.dslb" 2>&1); code=$?
set -e
[ "$code" = 3 ] && [[ "$out" == *'missing git executable'* ]] || fail "missing git refusal (exit $code): $out"
ok "missing git binary refused"

# write ops
compile_chunk commit-live 'git.dry_run(false); let r = git.open("."); print(r.commit("real message"));'
expect_run commit-live 0 'e3b0c442'

compile_chunk commit-nothing 'git.dry_run(false); let r = git.open("clean-repo"); r.commit("nothing");'
expect_run commit-nothing 3 'nothing to commit'

compile_chunk push-dry 'git.dry_run(true); let r = git.open("."); print(r.push("origin", "main"));'
expect_run push-dry 0 'dry-run: git push origin main'

compile_chunk tag-dry 'git.dry_run(true); let r = git.open("."); print(r.tag_create("v9.9.9", "release")); report.write_text("build/test-chunks/tag-report.txt");'
expect_run tag-dry 0 'dry-run: git tag -a v9.9.9'
grep -q 'dry-run: tag_create: tag -a v9.9.9 -m release' "$WORK/tag-report.txt" || fail "dry-run report entry"
ok "dry-run write recorded in report"

compile_chunk app-fail 'report.add("test", "subject", "intentional"); report.fail_if_any();'
expect_run app-fail 4 'APP_FAIL'

# load failures
printf 'not bytecode' > "$WORK/junk.dslb"
set +e
out=$("$HOST" --dsl "$WORK/junk.dslb" 2>&1); code=$?
set -e
[ "$code" = 3 ] && [[ "$out" == *'LOAD_BAD_BYTECODE'* ]] || fail "junk bytecode (exit $code): $out"
ok "bad bytecode refused at load"

set +e
out=$("$HOST" --dsl "$WORK/absent.dslb" 2>&1); code=$?
set -e
[ "$code" = 4 ] && [[ "$out" == *'APP_FAIL'* ]] || fail "missing bytecode file (exit $code): $out"
ok "missing bytecode file exits 4"

echo "PASS: $PASS checks"
