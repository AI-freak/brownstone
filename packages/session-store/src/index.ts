import path from 'node:path';
import type {
  AgentConfig,
  SessionRecord,
  SessionTurn,
  ToolCall,
  ToolResult,
  UserProfile,
} from '@brownstone/contracts';
import { generateId, readJsonFile, updateJsonFile } from '@brownstone/storage';

/**
 * Sessions are stored one JSON file per session at:
 *   {dataDir}/sessions/{sessionId}.json
 *
 * The directory is also indexed by a flat list file at
 *   {dataDir}/sessions/index.json
 * which holds session metadata (id, createdAt, updatedAt, ownerUserId, title)
 * for cheap list operations without reading every file. The full session
 * body (turns array) lives only in the per-session file.
 *
 * Concurrent access: the index is updated under the storage mutex; per-
 * session files are also protected. Cross-file consistency: if a crash
 * happens between writing the body and updating the index, the next
 * loadSession will still find the file but listSessions will miss it.
 * That's acceptable — index can be rebuilt by scanning the directory.
 */

interface SessionIndexEntry {
  id: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
}

interface SessionIndexFile {
  version: 1;
  sessions: SessionIndexEntry[];
}

function sessionsDir(config: AgentConfig): string { return path.join(config.dataDir, 'sessions'); }
function indexPath(config: AgentConfig): string { return path.join(sessionsDir(config), 'index.json'); }
function sessionPath(config: AgentConfig, id: string): string { return path.join(sessionsDir(config), `${id}.json`); }

const EMPTY_INDEX: SessionIndexFile = { version: 1, sessions: [] };

export async function startSession(config: AgentConfig, owner: UserProfile): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: generateId('session'),
    ownerUserId: owner.id,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
  await writeSession(config, session);
  await updateJsonFile<SessionIndexFile>(indexPath(config), EMPTY_INDEX, (current) => ({
    ...current,
    sessions: [
      ...current.sessions,
      { id: session.id, ownerUserId: owner.id, createdAt: now, updatedAt: now },
    ],
  }));
  return session;
}

export async function listSessions(config: AgentConfig, _owner: UserProfile): Promise<SessionRecord[]> {
  // Returns lightweight records (no turns). The service-layer caller uses
  // filterOwned to scope to the user; admins see everything.
  const index = await readJsonFile<SessionIndexFile>(indexPath(config), EMPTY_INDEX);
  return index.sessions
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((entry) => ({
      id: entry.id,
      ownerUserId: entry.ownerUserId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      title: entry.title,
      turns: [],
    }));
}

export async function loadSession(config: AgentConfig, sessionId: string): Promise<SessionRecord | undefined> {
  return readJsonFile<SessionRecord | undefined>(sessionPath(config, sessionId), undefined);
}

async function writeSession(config: AgentConfig, session: SessionRecord): Promise<void> {
  await updateJsonFile<SessionRecord>(
    sessionPath(config, session.id),
    session,
    () => session,
  );
}

/**
 * Append a turn to a session. The runtime calls this once per user prompt
 * after the assistant has fully responded (including any tool calls).
 */
export async function appendTurn(
  config: AgentConfig,
  sessionId: string,
  turn: {
    user: string;
    assistant: string;
    thinkingText?: string;
    toolCalls: Array<ToolCall & { result?: ToolResult }>;
  },
): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const sessionTurn: SessionTurn = {
    timestamp: now,
    user: turn.user,
    assistant: turn.assistant,
    thinkingText: turn.thinkingText,
    toolCalls: turn.toolCalls,
  };

  const updated = await updateJsonFile<SessionRecord | undefined>(
    sessionPath(config, sessionId),
    undefined,
    (current) => {
      if (!current) {
        throw new Error(`Session ${sessionId} no longer exists`);
      }
      return { ...current, updatedAt: now, turns: [...current.turns, sessionTurn] };
    },
  );

  // Bump the index entry's updatedAt; if the entry is missing (stale index),
  // re-add it.
  await updateJsonFile<SessionIndexFile>(indexPath(config), EMPTY_INDEX, (idx) => {
    const existing = idx.sessions.find((s) => s.id === sessionId);
    if (existing) {
      existing.updatedAt = now;
      if (!existing.title && turn.user) {
        existing.title = turn.user.slice(0, 60);
      }
      return idx;
    }
    return {
      ...idx,
      sessions: [
        ...idx.sessions,
        {
          id: sessionId,
          ownerUserId: updated?.ownerUserId ?? 'unknown',
          createdAt: updated?.createdAt ?? now,
          updatedAt: now,
          title: turn.user.slice(0, 60),
        },
      ],
    };
  });

  if (!updated) throw new Error(`Session ${sessionId} no longer exists`);
  return updated;
}
