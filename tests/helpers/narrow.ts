/**
 * @fileoverview Small type helpers for asserting on Git2 results.
 */

import { isDryRunResult, type DryRunResult } from '@lmctl-ai/lmts/server';

/** Assert a facade result is a real (non dry-run) result and narrow it. */
export function real<T>(r: T | DryRunResult): T {
  if (isDryRunResult(r)) throw new Error('unexpected dry-run result');
  return r as T;
}

type ByMode<T, M> = [Extract<T, { mode: M }>] extends [never] ? T : Extract<T, { mode: M }>;

/** Narrow a (possibly discriminated) result by its `mode` field. */
export function mode<T extends { mode: string }, M extends T['mode']>(
  r: T | DryRunResult,
  m: M,
): ByMode<T, M> {
  const v = real(r);
  if (v.mode !== m) throw new Error(`expected mode ${m}, got ${v.mode}`);
  return v as ByMode<T, M>;
}

/** Recording ExecGitFn stub: captures argv and replays canned responses. */
export interface StubCall {
  args: string[];
  cwd: string;
  allowNonZeroExit: boolean;
}

export type StubReply =
  | { stdout?: string; stderr?: string; exitCode?: number }
  | Error;

export function stubExec(replies: StubReply[] | ((args: string[]) => StubReply)) {
  const calls: StubCall[] = [];
  let i = 0;
  const fn = async (
    args: string[],
    cwd: string,
    options?: { allowNonZeroExit?: boolean },
  ): Promise<{ stdout: string; stderr: string; exitCode?: number }> => {
    calls.push({ args, cwd, allowNonZeroExit: options?.allowNonZeroExit === true });
    const reply = typeof replies === 'function' ? replies(args) : (replies[i++] ?? {});
    if (reply instanceof Error) throw reply;
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
  };
  return { fn, calls };
}
