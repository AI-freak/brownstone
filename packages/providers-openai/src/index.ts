import type {
  AgentConfig,
  CompletionRequest,
  ModelProvider,
  ProviderEvent,
  ProviderFinalResult,
  ProviderFinishReason,
  ProviderStream,
  ToolCall,
} from '@brownstone/contracts';

/**
 * OpenAI-compatible streaming provider.
 *
 * Works with:
 *   - OpenAI (api.openai.com/v1)
 *   - Anthropic via their OpenAI-compatibility layer
 *   - Local servers exposing the same shape (Ollama with the OpenAI plugin,
 *     llama.cpp server, vLLM, etc.) — point OPENAI_BASE_URL at them.
 *
 * Streams are parsed line-by-line as Server-Sent Events. Tool calls in the
 * OpenAI streaming protocol arrive as fragmented JSON in `tool_calls[i]`
 * with `arguments` accumulating one chunk at a time; we assemble them and
 * emit a single tool_call_start once each call's arguments parse as JSON.
 *
 * Implementation notes:
 *   - We don't depend on the `openai` SDK; this is ~200 lines of vanilla
 *     fetch + manual SSE parsing. That gives us tight control over events
 *     and avoids a heavy transitive dependency for a fairly thin surface.
 *   - On any non-2xx response, we read the body for diagnostics and throw
 *     UpstreamError. The caller (runtime) converts that to a tool error or
 *     surfaces it on the session, depending on context.
 */

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OpenAIDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: OpenAIDelta;
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAIProvider(config: AgentConfig): ModelProvider {
  if (!config.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required for the openai-compatible provider');
  }

  return {
    modelName: config.model,
    stream(request) {
      return runStream(config, request);
    },
    async complete(request) {
      const stream = runStream(config, request);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream.events) { /* drain */ }
      return stream.final;
    },
  };
}

function runStream(config: AgentConfig, request: CompletionRequest): ProviderStream {
  const controller = new AbortController();
  let resolveFinal!: (value: ProviderFinalResult) => void;
  const final = new Promise<ProviderFinalResult>((resolve) => { resolveFinal = resolve; });

  const events = (async function* (): AsyncIterable<ProviderEvent> {
    const url = `${config.openAiBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: config.model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxOutputTokens,
      tools: request.tools.length ? request.tools.map(toOpenAITool) : undefined,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openAiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = (error as Error).message;
      const event: ProviderEvent = { type: 'error', message, recoverable: false };
      resolveFinal({
        outputText: '', thinkingText: '', toolCalls: [],
        finishReason: 'error',
      });
      yield event;
      return;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      const message = `Provider responded ${response.status}: ${text.slice(0, 500)}`;
      resolveFinal({
        outputText: '', thinkingText: '', toolCalls: [],
        finishReason: 'error',
      });
      yield { type: 'error', message, recoverable: response.status >= 500 };
      return;
    }

    let outputText = '';
    const toolCallsByIndex = new Map<number, {
      id?: string;
      name?: string;
      arguments: string;
      emittedStart: boolean;
    }>();
    let finishReason: ProviderFinishReason = 'stop';
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    try {
      for await (const event of parseSse(response.body)) {
        if (event === '[DONE]') break;
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(event) as OpenAIChunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
            yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
          }
          continue;
        }
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          outputText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const entry = toolCallsByIndex.get(tc.index) ?? { arguments: '', emittedStart: false };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            toolCallsByIndex.set(tc.index, entry);

            // Try to emit start once we have a complete JSON arg string.
            if (!entry.emittedStart && entry.id && entry.name) {
              const parsed = tryParseJson(entry.arguments);
              if (parsed !== undefined) {
                entry.emittedStart = true;
                yield {
                  type: 'tool_call_start',
                  callId: entry.id,
                  toolName: entry.name,
                  input: parsed as Record<string, unknown>,
                };
              }
            }
          }
        }
        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      resolveFinal({ outputText, thinkingText: '', toolCalls: [], finishReason: 'error', usage });
      yield { type: 'error', message, recoverable: false };
      return;
    }

    // Any tool calls whose arguments never finished parsing as JSON during
    // the stream get a delayed start event here so the runtime can still
    // attempt them. Better to surface than silently drop.
    const toolCalls: ToolCall[] = [];
    for (const entry of toolCallsByIndex.values()) {
      if (!entry.id || !entry.name) continue;
      const parsedInput = tryParseJson(entry.arguments) ?? {};
      if (!entry.emittedStart) {
        yield {
          type: 'tool_call_start',
          callId: entry.id,
          toolName: entry.name,
          input: parsedInput as Record<string, unknown>,
        };
      }
      toolCalls.push({ id: entry.id, toolName: entry.name, input: parsedInput as Record<string, unknown> });
    }

    resolveFinal({
      outputText,
      thinkingText: '',
      toolCalls,
      finishReason,
      usage,
    });
    yield { type: 'done', finishReason };
  })();

  return {
    events,
    final,
    cancel() { controller.abort(); },
  };
}

function tryParseJson(text: string): unknown {
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { return undefined; }
}

function mapFinishReason(reason: string): ProviderFinishReason {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls': return 'tool_calls';
    case 'content_filter': return 'content_filter';
    default: return 'stop';
  }
}

function toOpenAIMessage(msg: import('@brownstone/contracts').ChatMessage): OpenAIChatMessage {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content,
      tool_call_id: msg.toolCallId,
    };
  }
  return {
    role: msg.role,
    content: msg.content,
    name: msg.name,
  };
}

function toOpenAITool(tool: import('@brownstone/contracts').ToolDefinition): OpenAIToolDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Parse a Server-Sent Events stream. Yields the `data:` payload of each
 * complete event (joined if the event spans multiple `data:` lines).
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      // SSE events are separated by a blank line (\n\n).
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
        const dataLines = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim());
        if (dataLines.length === 0) continue;
        yield dataLines.join('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// --- Public exports ---------------------------------------------------------

/**
 * Convenience factory used by the control plane's capabilities-default file.
 * Falls back to local-sim if no API key is set or provider is explicitly
 * configured as local-sim.
 */
export async function createModelProvider(config: AgentConfig): Promise<ModelProvider> {
  if (config.providerMode === 'local-sim' || !config.openAiApiKey) {
    const { createLocalSimProvider } = await import('@brownstone/providers-local-sim');
    return createLocalSimProvider(config.model);
  }
  return createOpenAIProvider(config);
}
