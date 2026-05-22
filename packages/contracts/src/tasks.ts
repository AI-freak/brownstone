import type { ThinkingMode } from './config.js';
import type { OwnedResource } from './auth.js';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskKind = 'chat_turn' | 'browser_capture' | 'workspace_index' | 'orchestration_plan' | 'web_search';
export type AgentRole = 'coordinator' | 'planner' | 'executor' | 'verifier';

export interface TaskRecord extends OwnedResource {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export interface AgentWorkItem {
  id: string;
  role: AgentRole;
  goal: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  dependsOn: string[];
  output?: string;
}

export interface OrchestrationPlan {
  id: string;
  objective: string;
  createdAt: string;
  items: AgentWorkItem[];
  finalSummary?: string;
}

export interface ScheduledTask extends OwnedResource {
  id: string;
  title: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  everyMs: number;
  nextRunAt: string;
  lastRunAt?: string;
  lastResultSummary?: string;
  thinkingMode: ThinkingMode;
  enabled: boolean;
}
