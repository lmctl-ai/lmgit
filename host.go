package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/lmctl-ai/lmcode-go"
)

const version = "0.1.2"

// gitVersionRe parses the first line of `git --version`.
var gitVersionRe = regexp.MustCompile(`git version (\d+)\.(\d+)\.(\d+)`)

// Host owns the lmcode registry, the arena of domain handles returned to
// scripts, and the execution policy for the git subprocess.
type Host struct {
	reg *lmcode.Registry

	gitPath string
	gitSeen bool
	dryRun  bool

	repos    []*Repo
	statuses []*StatusList
	branches []*BranchList
	commits  []*CommitList
	strings  []*Strings
	report   *Report
}

// Report is the script-visible findings log (context "report").
type Report struct {
	entries []ReportEntry
}

// ReportEntry is one report line.
type ReportEntry struct {
	Kind    string `json:"kind"`
	Subject string `json:"subject"`
	Message string `json:"message"`
}

func (r *Report) add(kind, subject, message string) {
	r.entries = append(r.entries, ReportEntry{Kind: kind, Subject: subject, Message: message})
}

// NewHost builds the registry and registers every host callback.
func NewHost() *Host {
	h := &Host{report: &Report{}}
	h.reg = lmcode.NewRegistry()
	h.must(h.reg.Context("git", "Git"))
	h.must(h.reg.Context("report", "Report"))
	h.registerGit()
	h.registerRepo()
	h.registerStatusList()
	h.registerStatusEntry()
	h.registerBranch()
	h.registerBranchList()
	h.registerCommit()
	h.registerCommitList()
	h.registerStrings()
	h.registerReport()
	h.must(lmcode.RegisterTesting(h.reg, os.Stdout))
	return h
}

func (h *Host) must(err error) {
	if err != nil {
		panic(err)
	}
}

// ensureGit locates the git binary once and checks its version. LMGIT_GIT
// overrides PATH lookup (testing and non-PATH installs).
func (h *Host) ensureGit() error {
	if h.gitSeen {
		return nil
	}
	path := os.Getenv("LMGIT_GIT")
	if path == "" {
		var err error
		path, err = exec.LookPath("git")
		if err != nil {
			return lmcode.NewHostError("git executable not found on PATH; install git (>= 2.20) or set LMGIT_GIT")
		}
	} else if _, err := os.Stat(path); err != nil {
		return lmcode.NewHostError("LMGIT_GIT points to a missing git executable: " + path)
	}
	out, err := exec.Command(path, "--version").Output()
	if err != nil {
		return lmcode.NewHostError("git --version failed: " + err.Error())
	}
	m := gitVersionRe.FindStringSubmatch(string(out))
	if m == nil {
		return lmcode.NewHostError("git --version output is not parseable: " + firstLine(string(out)))
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	if major < 2 || (major == 2 && minor < 20) {
		return lmcode.NewHostError(fmt.Sprintf("unsupported git version %s.%s.%s: lmgit supports git >= 2.20", m[1], m[2], m[3]))
	}
	h.gitPath = path
	h.gitSeen = true
	return nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// runGit runs one git argv (no working directory). Repo-scoped calls use
// runGitIn. Prompts, color and pagers are disabled.
func (h *Host) runGit(args ...string) (string, error) {
	return h.run([]string{"-c", "color.ui=false"}, args)
}

// runGitIn runs git inside a repository directory.
func (h *Host) runGitIn(dir string, args ...string) (string, error) {
	return h.run([]string{"-c", "color.ui=false", "-C", dir}, args)
}

func (h *Host) run(prefix []string, args []string) (string, error) {
	if err := h.ensureGit(); err != nil {
		return "", err
	}
	argv := append(append([]string{}, prefix...), args...)
	cmd := exec.Command(h.gitPath, argv...)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_PAGER=cat",
		"PAGER=cat",
		"GIT_OPTIONAL_LOCKS=0",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		lines := strings.Split(detail, "\n")
		if len(lines) > 3 {
			lines = lines[:3]
		}
		return "", lmcode.NewHostError("git " + strings.Join(args, " ") + " failed: " + strings.Join(lines, " | "))
	}
	return stdout.String(), nil
}

func checkLimit(limit int64) error {
	if limit < 1 || limit > 1000 {
		return lmcode.NewHostError(fmt.Sprintf("invalid limit %d: expected 1..1000", limit))
	}
	return nil
}

func checkName(what, name string) error {
	if name == "" {
		return lmcode.NewHostError(what + " must not be empty")
	}
	return nil
}

func (h *Host) keepStrings(values []string) *Strings {
	s := Strings(values)
	h.strings = append(h.strings, &s)
	return &s
}

// vstr/vint/vbool unwrap VM arguments; the VM guarantees declared schema types.
func vstr(v lmcode.Value) string { s, _ := v.AsStr(); return s }
func vint(v lmcode.Value) int64  { n, _ := v.AsInt(); return n }
func vbool(v lmcode.Value) bool  { b, _ := v.AsBool(); return b }
