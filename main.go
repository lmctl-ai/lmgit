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
	return lmcode.FailureFrame(os.Stdout, "cli", lmcode.NewError(lmcode.CLI_USAGE, "usage: lmgit --version | --lmcode-schema [--json] | --lmcode-signatures | --lmcode FILE [--lmcode FILE ...]"))
}

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		return usageError()
	}
	switch args[0] {
	case "--version":
		if len(args) != 1 {
			return usageError()
		}
		fmt.Printf("lmgit %s\n", version)
		return 0
	case "--lmcode-schema":
		if len(args) > 2 || len(args) == 2 && args[1] != "--json" {
			return usageError()
		}
		_, err := os.Stdout.Write(schemaBytes)
		if err != nil {
			return 4
		}
		return 0
	case "--lmcode-signatures":
		if len(args) != 1 {
			return usageError()
		}
		for _, sig := range NewHost().reg.Signatures() {
			fmt.Println(sig)
		}
		return 0
	}
	files := []string{}
	for i := 0; i < len(args); i += 2 {
		if args[i] != "--lmcode" || i+1 >= len(args) {
			return usageError()
		}
		files = append(files, args[i+1])
	}
	// Strict SDK validation precedes host construction, file reads and all dispatch.
	// Do not add defaults or retry malformed metadata, particularly missing dry.
	results, err := lmcode.InvocationResultsFromCommand(files)
	if err != nil {
		return lmcode.FailureFrame(os.Stdout, "cli", err)
	}
	contract, err := lmcode.ResultContractFromSchema(schemaBytes)
	if err != nil {
		return lmcode.FailureFrame(os.Stdout, "load", err)
	}
	host := NewHost()
	host.invocationDry = results.Dry()
	ctx := lmcode.NewContext()
	ctx.SetDry(results.Dry())
	ctx.Set("git", host)
	ctx.Set("report", host.report)
	for _, part := range results.Registrations() {
		phase := "load"
		err = func() error {
			bytecode, e := os.ReadFile(part.File)
			if e != nil {
				phase = "app"
				return lmcode.NewError(lmcode.APP_FAIL, "cannot read "+part.File+": "+e.Error())
			}
			program, e := lmcode.Load(bytecode, schemaBytes, host.reg)
			if e != nil {
				return normalizeLoadError(e)
			}
			if _, e = results.Select(part.Index, host.reg, contract); e != nil {
				return e
			}
			phase = "run"
			if e = program.Run(ctx, host.reg); e != nil {
				return e
			}
			return results.Complete(part.Index)
		}()
		if err != nil {
			if e, ok := err.(*lmcode.Error); ok && e.Code == lmcode.APP_FAIL {
				phase = "app"
			}
			_ = results.Fail(&part.Index, phase, err)
			break
		}
	}
	return results.WriteFrame(os.Stdout)
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
		return lmcode.NewError(e.Code, "invalid lmcode bytecode")
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
