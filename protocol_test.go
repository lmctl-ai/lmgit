package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func captured(t *testing.T, args ...string) (int, string) {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = f
	defer func() { os.Stdout = old; f.Close() }()
	code := run(args)
	if _, err = f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return code, string(b)
}
func TestUsageHasOneTerminalFailure(t *testing.T) {
	code, out := captured(t, "--unknown")
	if code != 2 || !strings.HasPrefix(out, "LMCODE_RETURN_BEGIN\n") || !strings.HasSuffix(out, "\nLMCODE_RETURN_END\n") || strings.Count(out, "LMCODE_RETURN_BEGIN") != 1 {
		t.Fatalf("usage must be framed: code=%d stdout=%q", code, out)
	}
}
func TestMalformedDryRefusedBeforeInput(t *testing.T) {
	for _, field := range []string{"", `,"dry":"false"`, `,"dry":null`} {
		t.Run(field, func(t *testing.T) {
			d := t.TempDir()
			file := filepath.Join(d, "missing.dslb")
			manifest := filepath.Join(d, "invocation.json")
			raw := `{"version":1,"mode":"single"` + field + `,"parts":[{"index":0,"file":` + strconv.Quote(file) + `}]}`
			if err := os.WriteFile(manifest, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("LMCODE_INVOCATION_FILE", manifest)
			code, out := captured(t, "--lmcode", file)
			if code != 2 || !strings.Contains(out, "dry must be boolean") || strings.Contains(out, "cannot read") {
				t.Fatalf("malformed metadata dispatched: code=%d stdout=%q", code, out)
			}
		})
	}
}
func TestLogLimitHasNoArbitraryUpperCeiling(t *testing.T) {
	if err := checkLimit(1001); err != nil {
		t.Fatal(err)
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("LMGIT_TEST_ERROR_HELPER") == "1" {
		fmt.Fprint(os.Stderr, "first\nsecond\nthird\nfourth\nfifth\n")
		os.Exit(1)
	}
	os.Exit(m.Run())
}
func TestGitErrorPreservesEveryLine(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LMGIT_TEST_ERROR_HELPER", "1")
	h := NewHost()
	h.gitSeen = true
	h.gitPath = exe
	_, err = h.runGit("probe")
	if err == nil || !strings.Contains(err.Error(), "fifth") {
		t.Fatalf("git stderr truncated: %v", err)
	}
}
