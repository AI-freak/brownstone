import type { AgentConfig } from './config.js';
import type { OwnedResource } from './auth.js';

/**
 * Streaming provider event.
 *
 * The redesigned provider produces an async iterable of events instead of a
 * single `{outputText, toolCalls}` return. That lets the UI surface tokens as
 * they're produced and show tool-call activity live.
 *
 * Event kinds:
 *   text_delta       Incremental output text.
 *   thinking_delta   Optional chain-of-thought tokens.
 *   tool_call_start  Model has decided to call a tool with given args.
 *   tool_call_end    Tool finished — the runtime emits this, not the model.
 *   usage            Token counts at end of response.
 *   done             End of response with finishReason.
 *   error            Terminal error.
 */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; callId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_call_end'; callId: string; ok: boolean; output: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: ProviderFinishReason }
  | { type: 'error'; message: string; recoverable: boolean };

export type ProviderFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  /** When role='tool', the id of the call this result responds to. */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  config: AgentConfig;
  sessionId: string;
  userId: string;
}

export interface Tool {
  definition: ToolDefinition;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** Streaming completion. */
export interface ProviderStream {
  events: AsyncIterable<ProviderEvent>;
  /** Resolves when the stream is fully consumed. */
  final: Promise<ProviderFinalResult>;
  /** Abort the in-flight request. */
  cancel(): void;
}

export interface ProviderFinalResult {
  outputText: string;
  thinkingText: string;
  toolCalls: ToolCall[];
  finishReason: ProviderFinishReason;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ModelProvider {
  modelName: string;
  stream(request: CompletionRequest): ProviderStream;
  /** Convenience wrapper: drain the stream and return the final result. */
  complete(request: CompletionRequest): Promise<ProviderFinalResult>;
}

// --- Session storage shapes ---------------------------------------------

export interface SessionTurn {
  timestamp: string;
  user: string;
  assistant: string;
  thinkingText?: string;
  toolCalls: Array<ToolCall & { result?: ToolResult }>;
}

export interface SessionRecord extends OwnedResource {
  id: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  turns: SessionTurn[];
}

export interface TelemetryEvent {
  timestamp: string;
  type: string;
  sessionId?: string;
  userId?: string;
  payload: Record<string, unknown>;
}

export interface MemoryNote extends OwnedResource {
  id: string;
  createdAt: string;
  scope: 'user' | 'workspace' | 'project';
  text: string;
  tags: string[];
}

// Legacy alias (still used by a few callers).
export interface ProviderResponse {
  outputText: string;
  toolCalls?: ToolCall[];
}
