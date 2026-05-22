import type {
  AgentConfig,
  ChatMessage,
  ModelProvider,
  ProviderEvent,
  SessionRecord,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  UserProfile,
} from '@brownstone/contracts';
import { ForbiddenError, ValidationError } from '@brownstone/errors';
import { appendTurn, loadSession, startSession } from '@brownstone/session-store';
import { writeEvent } from '@brownstone/telemetry';

/**
 * Runtime — the chat-turn orchestrator.
 *
 * Takes the user prompt, drives the provider (streaming), executes any tool
 * calls the model emits, feeds tool results back into a follow-up provider
 * call, and loops until the model emits a stop. Limits how many tool-call
 * rounds it'll do via `config.maxToolSteps`.
 *
 * The interface is event-based: callers get an async iterable of
 * `RuntimeEvent`s. The web app forwards these as Server-Sent Events to the
 * browser. The CLI just collects them and prints the final answer.
 *
 * This is where the "more user friendly" LLM interface comes from:
 *   - Token-level streaming is preserved end-to-end.
 *   - Tool calls and their results are visible as separate events.
 *   - Thinking-mode tokens get their own channel.
 *   - The final session turn record includes everything for replay.
 */

export type RuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; callId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_call_end'; callId: string; ok: boolean; output: string; durationMs: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; step: number }
  | { type: 'turn_complete'; sessionId: string; turnIndex: number }
  | { type: 'error'; message: string; recoverable: boolean };

export interface RuntimeRunArgs {
  config: AgentConfig;
  provider: ModelProvider;
  user: UserProfile;
  sessionId: string;
  prompt: string;
  /** Tools the model can call. Defaults to []. */
  tools?: Tool[];
}

export interface RuntimeStream {
  events: AsyncIterable<RuntimeEvent>;
  /** Resolves with the final consolidated turn once iteration is done. */
  final: Promise<{ assistant: string; thinkingText: string; toolCalls: Array<ToolCall & { result?: ToolResult }> }>;
  cancel(): void;
}

const SYSTEM_PROMPT = `You are Brownstone, a careful and concise assistant.
- Keep responses focused and well-structured.
- When you call a tool, explain why briefly.
- After tool calls, integrate the results into your answer.
- Format code blocks with language fences; use markdown for emphasis.`;

export function runChatTurn(args: RuntimeRunArgs): RuntimeStream {
  const { config, provider, user, sessionId, prompt, tools = [] } = args;
  if (!prompt.trim()) throw new ValidationError('Prompt must be non-empty');

  let resolveFinal!: (value: { assistant: string; thinkingText: string; toolCalls: Array<ToolCall & { result?: ToolResult }> }) => void;
  const final = new Promise<{ assistant: string; thinkingText: string; toolCalls: Array<ToolCall & { result?: ToolResult }> }>((resolve) => { resolveFinal = resolve; });

  let cancelled = false;
  let activeProviderStream: ReturnType<ModelProvider['stream']> | undefined;

  const events = (async function* (): AsyncIterable<RuntimeEvent> {
    const session = await loadSession(config, sessionId);
    if (!session) {
      yield { type: 'error', message: `Session ${sessionId} not found`, recoverable: false };
      resolveFinal({ assistant: '', thinkingText: '', toolCalls: [] });
      return;
    }

    const messages: ChatMessage[] = buildMessageHistory(session);
    messages.push({ role: 'user', content: prompt });

    let assistantText = '';
    let thinkingText = '';
    const completedToolCalls: Array<ToolCall & { result?: ToolResult }> = [];
    const toolMap = new Map(tools.map((tool) => [tool.definition.name, tool]));

    for (let step = 0; step < Math.max(1, config.maxToolSteps); step += 1) {
      if (cancelled) break;

      const stream = provider.stream({
        messages,
        tools: tools.map((t) => t.definition),
      });
      activeProviderStream = stream;

      const stepToolCalls: ToolCall[] = [];
      let stepAssistant = '';
      let stepThinking = '';
      let finishReason: string = 'stop';

      try {
        for await (const event of stream.events) {
          if (cancelled) {
            stream.cancel();
            break;
          }
          yield* forwardProviderEvent(event, step);
          if (event.type === 'text_delta') stepAssistant += event.text;
          else if (event.type === 'thinking_delta') stepThinking += event.text;
          else if (event.type === 'tool_call_start') {
            stepToolCalls.push({ id: event.callId, toolName: event.toolName, input: event.input });
          }
          else if (event.type === 'done') finishReason = event.finishReason;
          else if (event.type === 'error') {
            // Provider already yielded the error event to the consumer.
            // Stop processing this turn.
            finishReason = 'error';
            break;
          }
        }
      } catch (error) {
        yield { type: 'error', message: (error as Error).message, recoverable: false };
        finishReason = 'error';
      }

      activeProviderStream = undefined;
      assistantText += stepAssistant;
      thinkingText += stepThinking;

      if (finishReason === 'error') break;
      if (stepToolCalls.length === 0) break;

      // Add assistant's tool-call message and tool results to the history.
      messages.push({
        role: 'assistant',
        content: stepAssistant,
      });

      for (const call of stepToolCalls) {
        const tool = toolMap.get(call.toolName);
        const startedAt = Date.now();
        let result: ToolResult;
        if (!tool) {
          result = { ok: false, content: `No tool named "${call.toolName}" is registered` };
        } else {
          try {
            const ctx: ToolContext = { config, sessionId, userId: user.id };
            result = await tool.run(call.input, ctx);
          } catch (error) {
            result = { ok: false, content: (error as Error).message };
          }
        }
        const durationMs = Date.now() - startedAt;
        completedToolCalls.push({ ...call, result });
        yield {
          type: 'tool_call_end',
          callId: call.id,
          ok: result.ok,
          output: result.content,
          durationMs,
        };
        messages.push({
          role: 'tool',
          content: result.content,
          name: call.toolName,
          toolCallId: call.id,
        });

        await writeEvent(config, {
          timestamp: new Date().toISOString(),
          type: 'tool_call',
          sessionId,
          userId: user.id,
          payload: { toolName: call.toolName, ok: result.ok, durationMs },
        });
      }
    }

    // Persist the turn.
    const updated = await appendTurn(config, sessionId, {
      user: prompt,
      assistant: assistantText,
      thinkingText: thinkingText || undefined,
      toolCalls: completedToolCalls,
    });

    yield {
      type: 'turn_complete',
      sessionId: updated.id,
      turnIndex: updated.turns.length - 1,
    };

    resolveFinal({ assistant: assistantText, thinkingText, toolCalls: completedToolCalls });
  })();

  return {
    events,
    final,
    cancel() {
      cancelled = true;
      activeProviderStream?.cancel();
    },
  };
}

function* forwardProviderEvent(event: ProviderEvent, step: number): Generator<RuntimeEvent> {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'tool_call_start':
      yield event;
      return;
    case 'usage':
      yield { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens, step };
      return;
    case 'error':
      yield event;
      return;
    case 'done':
    case 'tool_call_end':
      // 'done' is internal-only here; tool_call_end is emitted by runtime, not provider
      return;
  }
}

function buildMessageHistory(session: SessionRecord): ChatMessage[] {
  const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const turn of session.turns) {
    history.push({ role: 'user', content: turn.user });
    history.push({ role: 'assistant', content: turn.assistant });
    // We don't replay tool messages because the provider sees the cooked
    // result text in the assistant message above. Replaying would balloon
    // history with intermediate states.
  }
  return history;
}

// --- Convenience non-streaming entrypoint (used by tests and older code) ---

export async function runTurn(
  config: AgentConfig,
  provider: ModelProvider,
  sessionId: string,
  prompt: string,
): Promise<string> {
  // Legacy path with no user (admin assumed). For real multi-user flows,
  // call runChatTurn directly with the user profile.
  const session = await loadSession(config, sessionId);
  if (!session) throw new ForbiddenError('Session not found');
  const placeholderUser: UserProfile = {
    id: session.ownerUserId,
    email: '',
    displayName: '',
    role: 'member',
    createdAt: session.createdAt,
  };
  const stream = runChatTurn({
    config, provider, user: placeholderUser, sessionId, prompt,
  });
  // Drain
  for await (const _event of stream.events) { /* ignored */ }
  const result = await stream.final;
  return result.assistant;
}

// Re-export the start helper for the capabilities default.
export { startSession };
export { builtinTools } from './builtin-tools.js';
