import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentConfig,
  ApprovalRecord,
  ArtifactExportRecord,
  CollaborationComment,
  ScheduledTask,
  SessionRecord,
  TaskRecord,
  ThinkingMode,
  UserProfile,
} from '@brownstone/contracts';
import { generateId, readJsonFile, updateJsonFile } from '@brownstone/storage';

// --- Files & paths ----------------------------------------------------------

interface SchedulesFile { version: 1; schedules: ScheduledTask[]; }
interface CommentsFile { version: 1; comments: CollaborationComment[]; }
interface ApprovalsFile { version: 1; approvals: ApprovalRecord[]; }
interface ExportsFile { version: 1; records: ArtifactExportRecord[]; }

const EMPTY_SCHEDULES: SchedulesFile = { version: 1, schedules: [] };
const EMPTY_COMMENTS: CommentsFile = { version: 1, comments: [] };
const EMPTY_APPROVALS: ApprovalsFile = { version: 1, approvals: [] };
const EMPTY_EXPORTS: ExportsFile = { version: 1, records: [] };

const filePath = {
  schedules: (c: AgentConfig) => path.join(c.dataDir, 'operations', 'schedules.json'),
  comments: (c: AgentConfig) => path.join(c.dataDir, 'operations', 'comments.json'),
  approvals: (c: AgentConfig) => path.join(c.dataDir, 'operations', 'approvals.json'),
  exports: (c: AgentConfig) => path.join(c.dataDir, 'operations', 'exports.json'),
};

// --- Schedules --------------------------------------------------------------

export async function listSchedules(config: AgentConfig): Promise<ScheduledTask[]> {
  const file = await readJsonFile<SchedulesFile>(filePath.schedules(config), EMPTY_SCHEDULES);
  return file.schedules;
}

export async function createSchedule(
  config: AgentConfig,
  owner: UserProfile,
  input: { title: string; prompt: string; everyMs: number; thinkingMode: ThinkingMode },
): Promise<ScheduledTask> {
  const now = new Date().toISOString();
  const schedule: ScheduledTask = {
    id: generateId('sched'),
    ownerUserId: owner.id,
    title: input.title,
    prompt: input.prompt,
    createdAt: now,
    updatedAt: now,
    everyMs: input.everyMs,
    nextRunAt: new Date(Date.now() + input.everyMs).toISOString(),
    thinkingMode: input.thinkingMode,
    enabled: true,
  };
  await updateJsonFile<SchedulesFile>(filePath.schedules(config), EMPTY_SCHEDULES, (file) => ({
    ...file,
    schedules: [...file.schedules, schedule],
  }));
  return schedule;
}

/**
 * Fire any schedules whose nextRunAt is in the past. The scheduler-worker
 * calls this on every tick. The runner callback gets one schedule at a time
 * and returns a summary that we record.
 */
export async function runDueSchedules(
  config: AgentConfig,
  run: (schedule: ScheduledTask) => Promise<{ summary: string }>,
): Promise<ScheduledTask[]> {
  const fired: ScheduledTask[] = [];
  await updateJsonFile<SchedulesFile>(filePath.schedules(config), EMPTY_SCHEDULES, async (file) => {
    const now = Date.now();
    for (const schedule of file.schedules) {
      if (!schedule.enabled) continue;
      if (new Date(schedule.nextRunAt).getTime() > now) continue;
      try {
        const result = await run(schedule);
        schedule.lastResultSummary = result.summary;
        schedule.lastRunAt = new Date().toISOString();
      } catch (error) {
        schedule.lastResultSummary = `Error: ${(error as Error).message}`;
        schedule.lastRunAt = new Date().toISOString();
      }
      schedule.nextRunAt = new Date(Date.now() + schedule.everyMs).toISOString();
      schedule.updatedAt = schedule.lastRunAt!;
      fired.push(schedule);
    }
    return file;
  });
  return fired;
}

// --- Comments ---------------------------------------------------------------

export async function listComments(config: AgentConfig, targetId?: string): Promise<CollaborationComment[]> {
  const file = await readJsonFile<CommentsFile>(filePath.comments(config), EMPTY_COMMENTS);
  return targetId ? file.comments.filter((c) => c.targetId === targetId) : file.comments;
}

export async function addComment(
  config: AgentConfig,
  input: { targetId: string; authorUserId: string; authorDisplayName: string; text: string },
): Promise<CollaborationComment> {
  const comment: CollaborationComment = {
    id: generateId('cmt'),
    createdAt: new Date().toISOString(),
    targetId: input.targetId,
    authorUserId: input.authorUserId,
    authorDisplayName: input.authorDisplayName,
    text: input.text,
  };
  await updateJsonFile<CommentsFile>(filePath.comments(config), EMPTY_COMMENTS, (file) => ({
    ...file,
    comments: [...file.comments, comment],
  }));
  return comment;
}

// --- Approvals --------------------------------------------------------------

export async function listApprovals(config: AgentConfig, targetId?: string): Promise<ApprovalRecord[]> {
  const file = await readJsonFile<ApprovalsFile>(filePath.approvals(config), EMPTY_APPROVALS);
  return targetId ? file.approvals.filter((a) => a.targetId === targetId) : file.approvals;
}

export async function recordApproval(
  config: AgentConfig,
  input: { targetId: string; actorUserId: string; actorDisplayName: string; action: 'approved' | 'rejected'; note?: string },
): Promise<ApprovalRecord> {
  const approval: ApprovalRecord = {
    id: generateId('apr'),
    createdAt: new Date().toISOString(),
    targetId: input.targetId,
    action: input.action,
    actorUserId: input.actorUserId,
    actorDisplayName: input.actorDisplayName,
    note: input.note,
  };
  await updateJsonFile<ApprovalsFile>(filePath.approvals(config), EMPTY_APPROVALS, (file) => ({
    ...file,
    approvals: [...file.approvals, approval],
  }));
  return approval;
}

// --- Exports ----------------------------------------------------------------

export async function listExports(config: AgentConfig): Promise<ArtifactExportRecord[]> {
  const file = await readJsonFile<ExportsFile>(filePath.exports(config), EMPTY_EXPORTS);
  return file.records;
}

export async function createExportBundle(
  config: AgentConfig,
  owner: UserProfile,
  input: { title: string; session?: SessionRecord; tasks: TaskRecord[]; summary: string },
): Promise<ArtifactExportRecord> {
  const id = generateId('exp');
  const exportDir = path.join(config.dataDir, 'exports', id);
  await fs.mkdir(exportDir, { recursive: true });

  const jsonContent = JSON.stringify({
    title: input.title,
    summary: input.summary,
    session: input.session,
    tasks: input.tasks,
    exportedAt: new Date().toISOString(),
  }, null, 2);
  const markdownContent = renderMarkdown(input);
  const htmlContent = renderHtml(input, markdownContent);

  const jsonPath = path.join('exports', id, 'export.json');
  const markdownPath = path.join('exports', id, 'export.md');
  const htmlPath = path.join('exports', id, 'export.html');

  await fs.writeFile(path.join(config.dataDir, jsonPath), jsonContent, 'utf8');
  await fs.writeFile(path.join(config.dataDir, markdownPath), markdownContent, 'utf8');
  await fs.writeFile(path.join(config.dataDir, htmlPath), htmlContent, 'utf8');

  const record: ArtifactExportRecord = {
    id,
    ownerUserId: owner.id,
    createdAt: new Date().toISOString(),
    title: input.title,
    htmlPath,
    markdownPath,
    jsonPath,
  };

  await updateJsonFile<ExportsFile>(filePath.exports(config), EMPTY_EXPORTS, (file) => ({
    ...file,
    records: [...file.records, record],
  }));

  return record;
}

function renderMarkdown(input: { title: string; session?: SessionRecord; tasks: TaskRecord[]; summary: string }): string {
  const lines: string[] = [];
  lines.push(`# ${input.title}`, '', input.summary, '');
  if (input.session) {
    lines.push('## Session', `**ID:** ${input.session.id}`, '');
    for (const turn of input.session.turns) {
      lines.push(`### ${turn.timestamp}`, '', `**User:** ${turn.user}`, '', `**Agent:** ${turn.assistant}`, '');
      for (const call of turn.toolCalls) {
        lines.push(`- Tool: \`${call.toolName}\` ${call.result?.ok ? '✓' : '✗'}`);
      }
      lines.push('');
    }
  }
  if (input.tasks.length) {
    lines.push('## Tasks', '');
    for (const task of input.tasks) {
      lines.push(`- ${task.kind} · ${task.status} · ${task.id}`);
    }
  }
  return lines.join('\n');
}

function renderHtml(input: { title: string }, markdown: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title>
<style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.5}</style>
</head><body><pre style="white-space:pre-wrap">${escaped}</pre></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>
  )[ch] ?? ch);
}
