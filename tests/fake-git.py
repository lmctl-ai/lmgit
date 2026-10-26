#!/usr/bin/env python3
"""Fake `git` for lmgit tests.

Prints canned output for the lmgit operation catalog. Every response is
deterministic so example outputs can be diffed byte-for-byte. Never touches
a real repository.
"""
import re
import sys

HEAD = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
PATCH = """diff --git a/src/app.go b/src/app.go
index 3b18e51..c7b27a4 100644
--- a/src/app.go
+++ b/src/app.go
@@ -10,3 +10,4 @@ func main() {
 \tfmt.Println("demo")
+\tfmt.Println("more")
 }
"""
STAGED_PATCH = """diff --git a/staged.txt b/staged.txt
new file mode 100644
index 0000000..d95f3ad
--- /dev/null
+++ b/staged.txt
@@ -0,0 +1 @@
+content
"""
SHOW_STAT = """abc1234 Add login flow

 src/app.go | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
"""
COMMITS = (
    "f47ac10b58cc4372a5670e02b2c3d47981234567\x1fAlice Dev\x1f2026-10-20T09:00:00+02:00\x1fAdd login flow\n"
    "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\x1fBob Hacker\x1f2026-10-19T18:30:00+02:00\x1fFix flaky test\n"
)


def out(text):
    sys.stdout.write(text)


def fail(message):
    sys.stderr.write(message + "\n")
    sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args:
        fail("usage: git <command>")

    # strip the host's global config prefix and find the work directory
    if args[0:2] == ["-c", "color.ui=false"]:
        args = args[2:]
    cwd = None
    if args[0:1] == ["-C"]:
        cwd = args[1]
        args = args[2:]
        if "not-a-repo" in cwd:
            fail("fatal: not a git repository: '%s'" % cwd)

    if not args:
        fail("fake git: missing command")
    cmd = args[0]

    if cmd == "--version":
        out("git version 2.56.0\n")
        return

    if cmd == "clone":
        out("Cloning into '%s'...\ndone.\n" % args[2])
        return

    if cmd == "rev-parse":
        if args[1:] == ["--is-inside-work-tree"]:
            out("true\n")
        elif args[1:] == ["--abbrev-ref", "HEAD"]:
            out("main\n")
        elif args[1:] == ["HEAD"]:
            out(HEAD + "\n")
        else:
            fail("fake git: unsupported rev-parse " + " ".join(args[1:]))
        return

    if cmd == "status":
        if "--porcelain" in args:
            out(" M src/app.go\n?? notes.txt\nA  docs/new.md\nM  staged.txt\n")
        else:
            fail("fake git: unsupported status argv")
        return

    if cmd == "branch":
        if args[1:] == ["--list"]:
            out("* main\n  dev\n  feature/x\n")
        elif len(args) == 2:
            if args[1] == "conflict-branch":
                fail("fatal: a branch named 'conflict-branch' already exists")
            out("")
        else:
            fail("fake git: unsupported branch argv")
        return

    if cmd == "log":
        m = re.search(r"-n (\d+)", " ".join(args))
        limit = int(m.group(1)) if m else 10
        lines = COMMITS.splitlines(keepends=True)[:limit]
        out("".join(lines) + ("\n" if lines else ""))
        return

    if cmd == "tag":
        if args[1:] == ["--list"]:
            out("v1.2.0\nv1.1.0\n")
        elif len(args) == 5 and args[1] == "-a":
            out("")
        else:
            fail("fake git: unsupported tag argv " + " ".join(args))
        return

    if cmd == "remote":
        if len(args) == 1:
            out("origin\nupstream\n")
        elif args[1:3] == ["get-url", "origin"]:
            out("https://github.com/octo/demo.git\n")
        elif args[1:3] == ["get-url", "upstream"]:
            out("https://github.com/octo/upstream.git\n")
        elif args[1:3] == ["get-url", "missing"]:
            fail("error: No such remote 'missing'")
        else:
            fail("fake git: unsupported remote argv " + " ".join(args))
        return

    if cmd == "config":
        if args[1:2] == ["--get"]:
            if args[2] == "user.name":
                out("Octo Coder\n")
            else:
                fail("error: key does not contain a section: " + args[2])
        else:
            fail("fake git: unsupported config argv")
        return

    if cmd == "diff":
        if "--staged" in args:
            out(STAGED_PATCH)
        else:
            out(PATCH)
        return

    if cmd == "show":
        if "missing-ref" in args:
            fail("fatal: ambiguous argument 'missing-ref': unknown revision or path not in the working tree.")
        out(SHOW_STAT)
        return

    if cmd == "checkout":
        name = args[1]
        if name == "missing-branch":
            fail("error: pathspec 'missing-branch' did not match any file(s) known to git")
        out("Switched to branch '%s'\n" % name)
        return

    if cmd == "commit":
        if cwd and "clean-repo" in cwd:
            fail("nothing to commit, working tree clean")
        out("[main %s] %s\n 1 file changed, 1 insertion(+)\n" % (HEAD[:7], args[args.index("-m") + 1]))
        return

    if cmd == "push":
        out("To https://github.com/octo/demo.git\n * [new branch] %s -> %s\n" % (args[2], args[2]))
        return

    fail("fake git: unsupported argv " + " ".join([cmd] + args[1:]))


if __name__ == "__main__":
    main()
