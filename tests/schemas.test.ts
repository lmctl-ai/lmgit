import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALL_GIT2_SCHEMAS } from '../src/schemas.js';
import { runCli, useSandbox } from './helpers/sandbox.js';

const sandbox = useSandbox('schemas');

/** Spawn the CLI with cwd + HOME inside the sandbox (never the dev's cwd). */
function runGit2(args: string[]) {
  return runCli(sandbox(), sandbox().root, args);
}

describe('git2 authored schemas', () => {
  test('(a) every op in --list has an authored schema and --schema has 0 derived ops', () => {
    // 1. Check --schema output
    const schemaRes = runGit2(['--schema']);
    expect(schemaRes.status).toBe(0);
    const derivedMatches = schemaRes.stdout.match(/"derived"\s*:\s*true/g) ?? [];
    expect(derivedMatches.length).toBe(0);

    // 2. Check --list output
    const listRes = runGit2(['--list']);
    expect(listRes.status).toBe(0);
    const ops = JSON.parse(listRes.stdout) as Array<{ name: string; schema?: unknown }>;
    expect(ops.length).toBe(52);
    for (const op of ops) {
      expect(op.schema).toBeDefined();
    }
  });

  test('(b) every op has a non-empty description and every param has a description', () => {
    expect(ALL_GIT2_SCHEMAS.length).toBe(52);
    for (const schema of ALL_GIT2_SCHEMAS) {
      expect(schema.name).toBeTruthy();
      expect(typeof schema.description).toBe('string');
      expect(schema.description!.trim().length).toBeGreaterThan(0);
      for (const param of schema.params) {
        expect(param.name).toBeTruthy();
        expect(typeof param.description).toBe('string');
        expect(param.description!.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('(c) at least 5 ops pass validation with minimal valid input', () => {
    const opsToTest: Array<{ args: string[]; name: string }> = [
      { name: 'commit', args: ['commit', '--message', 'test commit', '--dryrun'] },
      { name: 'clean', args: ['clean', '--dryrun'] },
      { name: 'add', args: ['add', '--paths', '["file.txt"]', '--dryrun'] },
      { name: 'branch_create', args: ['branch_create', '--branch-name', 'feat', '--dryrun'] },
      { name: 'tag_create', args: ['tag_create', '--tag-name', 'v1.0', '--dryrun'] },
      { name: 'worktree_add', args: ['worktree_add', '--path', join(sandbox().root, 'wt'), '--dryrun'] },
    ];

    for (const { name, args } of opsToTest) {
      const res = runGit2(args);
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain('VALIDATION_ERROR');
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toBeDefined();
    }
  });
});
