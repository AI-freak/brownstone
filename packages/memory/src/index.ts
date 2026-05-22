import path from 'node:path';
import type { AgentConfig, MemoryNote, UserProfile } from '@brownstone/contracts';
import { generateId, readJsonFile, updateJsonFile } from '@brownstone/storage';

interface MemoryFile {
  version: 1;
  notes: MemoryNote[];
}

const EMPTY: MemoryFile = { version: 1, notes: [] };

function memoryPath(config: AgentConfig): string {
  return path.join(config.dataDir, 'memory', 'notes.json');
}

export async function listMemory(config: AgentConfig): Promise<MemoryNote[]> {
  const file = await readJsonFile<MemoryFile>(memoryPath(config), EMPTY);
  return file.notes;
}

export async function addMemory(
  config: AgentConfig,
  owner: UserProfile,
  input: { scope: 'user' | 'workspace' | 'project'; text: string; tags?: string[] },
): Promise<MemoryNote> {
  const note: MemoryNote = {
    id: generateId('mem'),
    ownerUserId: owner.id,
    createdAt: new Date().toISOString(),
    scope: input.scope,
    text: input.text,
    tags: input.tags ?? [],
  };
  await updateJsonFile<MemoryFile>(memoryPath(config), EMPTY, (current) => ({
    ...current,
    notes: [...current.notes, note],
  }));
  return note;
}
