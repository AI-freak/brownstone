import { spawn } from 'node:child_process';
import type { AgentConfig, GitDiffResult, GitStatusSummary } from '@brownstone/contracts';
import { UpstreamError } from '@brownstone/errors';

/**
 * Git tooling — shells out to the local `git` binary. Why not a Node git
 * library? Because every Node git library either lies about edge cases or
 * is missing one (subrepos, sparse-checkout, signing). The user's git
 * binary is the source of truth.
 *
 * Safety:
 *   - Runs only inside config.workspaceRoot.
 *   - Never passes user input as a flag — all data goes as a positional arg
 *     after a `--` separator.
 *   - Output is parsed line-by-line, not eval'd or shell-piped.
 */

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export async function getGitStatus(config: AgentConfig): Promise<GitStatusSummary> {
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], config.workspaceRoot);
  if (branch.code !== 0) {
    throw new UpstreamError(`git rev-parse failed: ${branch.stderr.trim()}`);
  }
  const status = await runGit(['status', '--porcelain'], config.workspaceRoot);
  if (status.code !== 0) {
    throw new UpstreamError(`git status failed: ${status.stderr.trim()}`);
  }

  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const untracked: string[] = [];

  for (const line of status.stdout.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') untracked.push(file);
    else if (code.includes('A')) added.push(file);
    else if (code.includes('D')) deleted.push(file);
    else if (code.includes('M')) modified.push(file);
  }

  return {
    branch: branch.stdout.trim(),
    modified, added, deleted, untracked,
  };
}

export async function getGitDiff(config: AgentConfig, relativePath?: string): Promise<GitDiffResult> {
  const args = ['diff'];
  if (relativePath) {
    args.push('--', relativePath); // -- separator prevents flag injection
  }
  const result = await runGit(args, config.workspaceRoot);
  if (result.code !== 0) {
    throw new UpstreamError(`git diff failed: ${result.stderr.trim()}`);
  }
  return { relativePath, diff: result.stdout };
}
