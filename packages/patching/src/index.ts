import fs from 'node:fs/promises';
import type { AgentConfig, PatchOperation, PatchPlan } from '@brownstone/contracts';
import { ValidationError } from '@brownstone/errors';
import { safeResolve } from '@brownstone/security';

/**
 * Patch plans are JSON descriptions of file mutations. The agent emits them,
 * the user previews and explicitly approves before they touch disk.
 *
 * Operations:
 *   replace_file  - overwrite (or create) with `content`
 *   append_file   - append `content` to existing file (creates if missing)
 *   delete_file   - remove the file
 *
 * Every operation's path is checked with safeResolve against the workspace
 * root to prevent escape.
 */

const VALID_OPS = new Set(['replace_file', 'append_file', 'delete_file']);

export function parsePatchPlan(input: unknown): PatchPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Patch plan must be an object');
  }
  const obj = input as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const operations = obj.operations;
  if (!Array.isArray(operations)) {
    throw new ValidationError('Patch plan must include an operations array');
  }

  const parsed: PatchOperation[] = operations.map((op, index) => {
    if (!op || typeof op !== 'object') {
      throw new ValidationError(`operations[${index}] must be an object`);
    }
    const o = op as Record<string, unknown>;
    if (typeof o.type !== 'string' || !VALID_OPS.has(o.type)) {
      throw new ValidationError(`operations[${index}].type must be one of: ${[...VALID_OPS].join(', ')}`);
    }
    if (typeof o.relativePath !== 'string' || !o.relativePath) {
      throw new ValidationError(`operations[${index}].relativePath must be a non-empty string`);
    }
    if ((o.type === 'replace_file' || o.type === 'append_file') && typeof o.content !== 'string') {
      throw new ValidationError(`operations[${index}].content is required for ${o.type}`);
    }
    return {
      type: o.type as PatchOperation['type'],
      relativePath: o.relativePath,
      content: typeof o.content === 'string' ? o.content : undefined,
    };
  });

  return { summary, operations: parsed };
}

export async function previewPatchPlan(config: AgentConfig, plan: PatchPlan): Promise<string> {
  const lines: string[] = [];
  lines.push(`Plan: ${plan.summary || '(no summary)'}`);
  lines.push(`Operations: ${plan.operations.length}`);
  lines.push('');
  for (const op of plan.operations) {
    const target = safeResolve(config.workspaceRoot, op.relativePath, 'Patch target');
    let exists = false;
    let existingLength = 0;
    try {
      const stat = await fs.stat(target);
      exists = stat.isFile();
      existingLength = stat.size;
    } catch { /* fine */ }
    if (op.type === 'delete_file') {
      lines.push(`DELETE ${op.relativePath}${exists ? ` (${existingLength} bytes)` : ' (already absent)'}`);
    } else if (op.type === 'append_file') {
      lines.push(`APPEND ${op.relativePath} +${op.content?.length ?? 0} bytes${exists ? ` (currently ${existingLength})` : ' (new file)'}`);
    } else {
      lines.push(`REPLACE ${op.relativePath} → ${op.content?.length ?? 0} bytes${exists ? ` (was ${existingLength})` : ' (new file)'}`);
    }
  }
  return lines.join('\n');
}

export async function applyPatchPlan(
  config: AgentConfig,
  plan: PatchPlan,
): Promise<{ applied: number; files: string[] }> {
  const applied: string[] = [];
  for (const op of plan.operations) {
    const target = safeResolve(config.workspaceRoot, op.relativePath, 'Patch target');
    if (op.type === 'delete_file') {
      await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } else if (op.type === 'append_file') {
      await fs.appendFile(target, op.content ?? '', 'utf8');
    } else {
      await fs.mkdir(target.replace(/[^/\\]+$/, ''), { recursive: true });
      await fs.writeFile(target, op.content ?? '', 'utf8');
    }
    applied.push(op.relativePath);
  }
  return { applied: applied.length, files: applied };
}
