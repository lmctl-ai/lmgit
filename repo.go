package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/lmctl-ai/lmcode-go"
)

// Domain objects. Every pointer returned to the VM stays in the Host arena so
// a DSL handle stays valid for the process lifetime.

type Repo struct {
	git  *Host
	path string
}

type StatusEntry struct {
	path        string
	indexStatus string
	workStatus  string
}

type StatusList []*StatusEntry

type Branch struct {
	name    string
	current bool
}

type BranchList []*Branch

type Commit struct {
	hash, subject, author, date string
}

type CommitList []*Commit

// Strings is a read-only string collection; the std StrList has no exported
// constructor, so the host exposes its own len()/at() list type.
type Strings []string

func listAt(kind string, index, length int64) error {
	if index < 0 || index >= length {
		return lmcode.NewHostError(fmt.Sprintf("%s index %d out of range (length %d)", kind, index, length))
	}
	return nil
}

func splitLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// registerGit wires the Git context: global operations and the dry-run policy.
func (h *Host) registerGit() {
	method := func(name string, params []string, returns string, fn func(*Host, []lmcode.Value) (lmcode.Value, error)) {
		h.must(h.reg.Method("Git", name, params, returns, func(self any, args []lmcode.Value) (lmcode.Value, error) {
			return fn(self.(*Host), args)
		}))
	}

	method("dry_run", []string{"bool"}, "Git", func(h *Host, args []lmcode.Value) (lmcode.Value, error) {
		h.dryRun = vbool(args[0])
		return lmcode.Object("Git", h), nil
	})
	method("is_dry_run", nil, "bool", func(h *Host, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.Boolean(h.dryRun), nil
	})

	method("version", nil, "string", func(h *Host, _ []lmcode.Value) (lmcode.Value, error) {
		if err := h.ensureGit(); err != nil {
			return lmcode.None(), err
		}
		out, err := h.runGit("--version")
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(firstLine(out)), nil
	})

	method("open", []string{"string"}, "Repo", func(h *Host, args []lmcode.Value) (lmcode.Value, error) {
		path := vstr(args[0])
		if path == "" {
			return lmcode.None(), lmcode.NewHostError("open: path must not be empty")
		}
		return h.openRepo(path)
	})

	method("clone", []string{"string", "string"}, "Repo", func(h *Host, args []lmcode.Value) (lmcode.Value, error) {
		url, path := vstr(args[0]), vstr(args[1])
		if err := checkName("clone: url", url); err != nil {
			return lmcode.None(), err
		}
		if err := checkName("clone: path", path); err != nil {
			return lmcode.None(), err
		}
		if h.dryRun {
			h.report.add("dry-run", "clone", url+" -> "+path)
			return lmcode.Object("Repo", h.keepRepo(&Repo{git: h, path: path})), nil
		}
		if _, err := h.runGit("clone", url, path); err != nil {
			return lmcode.None(), err
		}
		return h.openRepo(path)
	})
}

// openRepo validates that path is inside a work tree and returns a Repo.
func (h *Host) openRepo(path string) (lmcode.Value, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return lmcode.None(), lmcode.NewHostError("open: cannot resolve " + path + ": " + err.Error())
	}
	out, err := h.runGitIn(abs, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		return lmcode.None(), err
	}
	if strings.TrimSpace(out) != "true" {
		return lmcode.None(), lmcode.NewHostError("open: " + path + " is not a git work tree")
	}
	return lmcode.Object("Repo", h.keepRepo(&Repo{git: h, path: abs})), nil
}

func (h *Host) keepRepo(r *Repo) *Repo {
	h.repos = append(h.repos, r)
	return r
}

// dryRunWrite executes a write argv unless the policy is set, in which case
// it records the intent in the report and returns a dry-run marker string.
func (r *Repo) dryRunWrite(op string, argv []string) (string, error) {
	if r.git.dryRun {
		r.git.report.add("dry-run", op, strings.Join(argv, " "))
		return "dry-run: git " + strings.Join(argv, " "), nil
	}
	out, err := r.git.runGitIn(r.path, argv...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (h *Host) registerRepo() {
	method := func(name string, params []string, returns string, fn func(*Repo, []lmcode.Value) (lmcode.Value, error)) {
		h.must(h.reg.Method("Repo", name, params, returns, func(self any, args []lmcode.Value) (lmcode.Value, error) {
			return fn(self.(*Repo), args)
		}))
	}

	method("path", nil, "string", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.String(r.path), nil
	})
	method("current_branch", nil, "string", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		out, err := r.git.runGitIn(r.path, "rev-parse", "--abbrev-ref", "HEAD")
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(strings.TrimSpace(out)), nil
	})
	method("is_clean", nil, "bool", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		out, err := r.git.runGitIn(r.path, "status", "--porcelain")
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.Boolean(strings.TrimSpace(out) == ""), nil
	})
	method("status", nil, "StatusList", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		out, err := r.git.runGitIn(r.path, "status", "--porcelain")
		if err != nil {
			return lmcode.None(), err
		}
		list := StatusList{}
		for _, line := range splitLines(out) {
			if len(line) < 4 {
				continue
			}
			entry := &StatusEntry{indexStatus: line[0:1], workStatus: line[1:2]}
			p := line[3:]
			if i := strings.Index(p, " -> "); i >= 0 {
				p = p[i+4:]
			}
			entry.path = p
			list = append(list, entry)
		}
		h.statuses = append(h.statuses, &list)
		return lmcode.Object("StatusList", &list), nil
	})
	method("branches", nil, "BranchList", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		out, err := r.git.runGitIn(r.path, "branch", "--list")
		if err != nil {
			return lmcode.None(), err
		}
		list := BranchList{}
		for _, line := range splitLines(out) {
			current := strings.HasPrefix(line, "*")
			name := strings.TrimSpace(strings.TrimPrefix(line, "*"))
			if name != "" {
				list = append(list, &Branch{name: name, current: current})
			}
		}
		h.branches = append(h.branches, &list)
		return lmcode.Object("BranchList", &list), nil
	})
	method("log", []string{"int"}, "CommitList", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		limit := vint(args[0])
		if err := checkLimit(limit); err != nil {
			return lmcode.None(), err
		}
		format := "%H\x1f%an\x1f%aI\x1f%s"
		out, err := r.git.runGitIn(r.path, "log", "-n", fmt.Sprintf("%d", limit), "--pretty=format:"+format)
		if err != nil {
			return lmcode.None(), err
		}
		list := CommitList{}
		for _, line := range splitLines(out) {
			fields := strings.SplitN(line, "\x1f", 4)
			if len(fields) != 4 {
				continue
			}
			list = append(list, &Commit{hash: fields[0], author: fields[1], date: fields[2], subject: fields[3]})
		}
		h.commits = append(h.commits, &list)
		return lmcode.Object("CommitList", &list), nil
	})
	method("tags", nil, "Strings", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		out, err := r.git.runGitIn(r.path, "tag", "--list")
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.Object("Strings", h.keepStrings(splitLines(out))), nil
	})
	method("remote_names", nil, "Strings", func(r *Repo, _ []lmcode.Value) (lmcode.Value, error) {
		out, err := r.git.runGitIn(r.path, "remote")
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.Object("Strings", h.keepStrings(splitLines(out))), nil
	})
	method("remote_url", []string{"string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		name := vstr(args[0])
		if err := checkName("remote_url: name", name); err != nil {
			return lmcode.None(), err
		}
		out, err := r.git.runGitIn(r.path, "remote", "get-url", name)
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(strings.TrimSpace(out)), nil
	})
	method("config", []string{"string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		key := vstr(args[0])
		if err := checkName("config: key", key); err != nil {
			return lmcode.None(), err
		}
		out, err := r.git.runGitIn(r.path, "config", "--get", key)
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(strings.TrimSpace(out)), nil
	})
	method("diff", []string{"bool"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		argv := []string{"diff"}
		if vbool(args[0]) {
			argv = append(argv, "--staged")
		}
		out, err := r.git.runGitIn(r.path, argv...)
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(out), nil
	})
	method("show", []string{"string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		ref := vstr(args[0])
		if err := checkName("show: ref", ref); err != nil {
			return lmcode.None(), err
		}
		out, err := r.git.runGitIn(r.path, "show", "--stat", "--oneline", ref)
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(out), nil
	})

	// write operations, all dry-run aware
	method("checkout", []string{"string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		name := vstr(args[0])
		if err := checkName("checkout: name", name); err != nil {
			return lmcode.None(), err
		}
		out, err := r.dryRunWrite("checkout", []string{"checkout", name})
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(out), nil
	})
	method("branch_create", []string{"string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		name := vstr(args[0])
		if err := checkName("branch_create: name", name); err != nil {
			return lmcode.None(), err
		}
		out, err := r.dryRunWrite("branch_create", []string{"branch", name})
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(out), nil
	})
	method("commit", []string{"string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		message := vstr(args[0])
		if err := checkName("commit: message", message); err != nil {
			return lmcode.None(), err
		}
		if r.git.dryRun {
			out, err := r.dryRunWrite("commit", []string{"commit", "-m", message})
			if err != nil {
				return lmcode.None(), err
			}
			return lmcode.String(out), nil
		}
		if _, err := r.git.runGitIn(r.path, "commit", "-m", message); err != nil {
			return lmcode.None(), err
		}
		head, err := r.git.runGitIn(r.path, "rev-parse", "HEAD")
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(strings.TrimSpace(head)), nil
	})
	method("push", []string{"string", "string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		remote, branch := vstr(args[0]), vstr(args[1])
		if err := checkName("push: remote", remote); err != nil {
			return lmcode.None(), err
		}
		if err := checkName("push: branch", branch); err != nil {
			return lmcode.None(), err
		}
		out, err := r.dryRunWrite("push", []string{"push", remote, branch})
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(out), nil
	})
	method("tag_create", []string{"string", "string"}, "string", func(r *Repo, args []lmcode.Value) (lmcode.Value, error) {
		name, message := vstr(args[0]), vstr(args[1])
		if err := checkName("tag_create: name", name); err != nil {
			return lmcode.None(), err
		}
		out, err := r.dryRunWrite("tag_create", []string{"tag", "-a", name, "-m", message})
		if err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(out), nil
	})
}

func (h *Host) registerStatusList() {
	h.must(h.reg.Method("StatusList", "len", nil, "int", func(self any, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.Integer(int64(len(*self.(*StatusList)))), nil
	}))
	h.must(h.reg.Method("StatusList", "at", []string{"int"}, "StatusEntry", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		l := *self.(*StatusList)
		i := vint(args[0])
		if err := listAt("StatusList", i, int64(len(l))); err != nil {
			return lmcode.None(), err
		}
		return lmcode.Object("StatusEntry", l[i]), nil
	}))
}

func (h *Host) registerStatusEntry() {
	reg := func(name string, returns string, fn func(*StatusEntry) (lmcode.Value, error)) {
		h.must(h.reg.Method("StatusEntry", name, nil, returns, func(self any, _ []lmcode.Value) (lmcode.Value, error) {
			return fn(self.(*StatusEntry))
		}))
	}
	reg("path", "string", func(v *StatusEntry) (lmcode.Value, error) { return lmcode.String(v.path), nil })
	reg("index_status", "string", func(v *StatusEntry) (lmcode.Value, error) { return lmcode.String(v.indexStatus), nil })
	reg("work_status", "string", func(v *StatusEntry) (lmcode.Value, error) { return lmcode.String(v.workStatus), nil })
}

func (h *Host) registerBranch() {
	reg := func(name string, returns string, fn func(*Branch) (lmcode.Value, error)) {
		h.must(h.reg.Method("Branch", name, nil, returns, func(self any, _ []lmcode.Value) (lmcode.Value, error) {
			return fn(self.(*Branch))
		}))
	}
	reg("name", "string", func(v *Branch) (lmcode.Value, error) { return lmcode.String(v.name), nil })
	reg("is_current", "bool", func(v *Branch) (lmcode.Value, error) { return lmcode.Boolean(v.current), nil })
}

func (h *Host) registerBranchList() {
	h.must(h.reg.Method("BranchList", "len", nil, "int", func(self any, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.Integer(int64(len(*self.(*BranchList)))), nil
	}))
	h.must(h.reg.Method("BranchList", "at", []string{"int"}, "Branch", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		l := *self.(*BranchList)
		i := vint(args[0])
		if err := listAt("BranchList", i, int64(len(l))); err != nil {
			return lmcode.None(), err
		}
		return lmcode.Object("Branch", l[i]), nil
	}))
}

func (h *Host) registerCommit() {
	reg := func(name string, returns string, fn func(*Commit) (lmcode.Value, error)) {
		h.must(h.reg.Method("Commit", name, nil, returns, func(self any, _ []lmcode.Value) (lmcode.Value, error) {
			return fn(self.(*Commit))
		}))
	}
	reg("hash", "string", func(v *Commit) (lmcode.Value, error) { return lmcode.String(v.hash), nil })
	reg("subject", "string", func(v *Commit) (lmcode.Value, error) { return lmcode.String(v.subject), nil })
	reg("author", "string", func(v *Commit) (lmcode.Value, error) { return lmcode.String(v.author), nil })
	reg("date", "string", func(v *Commit) (lmcode.Value, error) { return lmcode.String(v.date), nil })
}

func (h *Host) registerCommitList() {
	h.must(h.reg.Method("CommitList", "len", nil, "int", func(self any, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.Integer(int64(len(*self.(*CommitList)))), nil
	}))
	h.must(h.reg.Method("CommitList", "at", []string{"int"}, "Commit", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		l := *self.(*CommitList)
		i := vint(args[0])
		if err := listAt("CommitList", i, int64(len(l))); err != nil {
			return lmcode.None(), err
		}
		return lmcode.Object("Commit", l[i]), nil
	}))
}

func (h *Host) registerStrings() {
	h.must(h.reg.Method("Strings", "len", nil, "int", func(self any, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.Integer(int64(len(*self.(*Strings)))), nil
	}))
	h.must(h.reg.Method("Strings", "at", []string{"int"}, "string", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		s := *self.(*Strings)
		i := vint(args[0])
		if err := listAt("Strings", i, int64(len(s))); err != nil {
			return lmcode.None(), err
		}
		return lmcode.String(s[i]), nil
	}))
}

func (h *Host) registerReport() {
	h.must(h.reg.Method("Report", "add", []string{"string", "string", "string"}, "void", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		self.(*Report).add(vstr(args[0]), vstr(args[1]), vstr(args[2]))
		return lmcode.None(), nil
	}))
	h.must(h.reg.Method("Report", "len", nil, "int", func(self any, _ []lmcode.Value) (lmcode.Value, error) {
		return lmcode.Integer(int64(len(self.(*Report).entries))), nil
	}))
	h.must(h.reg.Method("Report", "write_text", []string{"string"}, "void", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		r := self.(*Report)
		var b strings.Builder
		for _, e := range r.entries {
			b.WriteString(e.Kind + ": " + e.Subject + ": " + strings.ReplaceAll(e.Message, "\n", " ") + "\n")
		}
		if err := os.WriteFile(vstr(args[0]), []byte(b.String()), 0o644); err != nil {
			return lmcode.None(), lmcode.NewHostError("write_text failed: " + err.Error())
		}
		return lmcode.None(), nil
	}))
	h.must(h.reg.Method("Report", "write_json", []string{"string"}, "void", func(self any, args []lmcode.Value) (lmcode.Value, error) {
		r := self.(*Report)
		data, err := json.Marshal(r.entries)
		if err != nil {
			return lmcode.None(), lmcode.NewHostError("write_json failed: " + err.Error())
		}
		if err := os.WriteFile(vstr(args[0]), append(data, '\n'), 0o644); err != nil {
			return lmcode.None(), lmcode.NewHostError("write_json failed: " + err.Error())
		}
		return lmcode.None(), nil
	}))
	h.must(h.reg.Method("Report", "fail_if_any", nil, "void", func(self any, _ []lmcode.Value) (lmcode.Value, error) {
		r := self.(*Report)
		if len(r.entries) > 0 {
			return lmcode.None(), lmcode.NewError(lmcode.APP_FAIL, fmt.Sprintf("report has %d finding(s), expected none", len(r.entries)))
		}
		return lmcode.None(), nil
	}))
}
