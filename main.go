package main

import (
	_ "embed"
	"fmt"
	"os"
	"strings"

	"github.com/lmctl-ai/lmcode-go"
)

//go:embed schema/lmgit.dsl.json
var schemaBytes []byte

func usageError() int {
	msg := `{"ok": false, "phase": "cli", "code": "CLI_USAGE", "message": "usage: lmgit --version | --dsl-schema [--json] | --dsl-signatures | --dsl FILE"}`
	fmt.Println(msg)
	return 2
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		return usageError()
	}
	host := NewHost()
	switch args[0] {
	case "--version":
		fmt.Printf("lmgit %s\n", version)
		return 0
	case "--dsl-schema":
		if len(args) > 2 || (len(args) == 2 && args[1] != "--json") {
			return usageError()
		}
		os.Stdout.Write(schemaBytes)
		return 0
	case "--dsl-signatures":
		if len(args) != 1 {
			return usageError()
		}
		for _, sig := range host.reg.Signatures() {
			fmt.Println(sig)
		}
		return 0
	case "--dsl":
		if len(args) != 2 {
			return usageError()
		}
		return runDSL(host, args[1])
	default:
		return usageError()
	}
}

func runDSL(host *Host, file string) int {
	bytecode, err := os.ReadFile(file)
	if err != nil {
		return lmcode.ReportError("app", lmcode.NewError(lmcode.APP_FAIL, "cannot read "+file+": "+err.Error()))
	}
	program, err := lmcode.Load(bytecode, schemaBytes, host.reg)
	if err != nil {
		return lmcode.ReportError("load", normalizeLoadError(err))
	}
	ctx := lmcode.NewContext()
	ctx.Set("git", host)
	ctx.Set("report", host.report)
	if err := program.Run(ctx, host.reg); err != nil {
		return lmcode.ReportError("run", err)
	}
	return lmcode.ReportOK()
}

// normalizeLoadError maps SDK load failures onto the portable contract
// messages so loader output never leaks machine-specific paths.
func normalizeLoadError(err error) error {
	e, ok := err.(*lmcode.Error)
	if !ok {
		return err
	}
	switch e.Code {
	case lmcode.LOAD_BAD_BYTECODE:
		return lmcode.NewError(e.Code, "bad bytecode: not a DSLB v5 program")
	case lmcode.LOAD_SCHEMA_MISMATCH:
		return lmcode.NewError(e.Code, "bytecode was compiled against a different schema")
	case lmcode.LOAD_UNBOUND:
		msg := e.Message
		if i := strings.Index(msg, " (declared:"); i >= 0 {
			msg = msg[:i]
		}
		return lmcode.NewError(e.Code, "host does not declare: "+msg)
	default:
		return e
	}
}
