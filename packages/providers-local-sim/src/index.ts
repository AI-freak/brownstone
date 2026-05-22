import type {
  CompletionRequest,
  ModelProvider,
  ProviderEvent,
  ProviderFinalResult,
  ProviderStream,
  ToolCall,
} from '@brownstone/contracts';

/**
 * Local simulation provider.
 *
 * Produces deterministic-ish responses without any network calls. Useful for:
 *   - Demos without API keys
 *   - Integration tests
 *   - Offline development
 *
 * Emits text in small chunks to exercise the streaming path properly so the
 * UI's incremental rendering can be validated in dev.
 */
export function createLocalSimProvider(modelName = 'local-sim'): ModelProvider {
  return {
    modelName,
    stream(request: CompletionRequest): ProviderStream {
      return buildSimStream(request, modelName);
    },
    async complete(request: CompletionRequest): Promise<ProviderFinalResult> {
      const stream = buildSimStream(request, modelName);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of stream.events) { /* drain */ }
      return stream.final;
    },
  };
}

function buildSimStream(request: CompletionRequest, _modelName: string): ProviderStream {
  let cancelled = false;
  let resolveFinal!: (value: ProviderFinalResult) => void;
  const final = new Promise<ProviderFinalResult>((resolve) => { resolveFinal = resolve; });

  const events = (async function* (): AsyncIterable<ProviderEvent> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';
    const promptLower = prompt.toLowerCase();

    // Tool-call branch: only fires if the prompt explicitly asks to use a
    // registered tool. Deterministic so tests are reproducible; explicit so
    // a user can demonstrate the tool-call UI by typing "use workspace_read
    // to look at package.json".
    const triggeredTool = request.tools.find((tool) => {
      const name = tool.name.toLowerCase();
      return promptLower.includes(`use ${name}`)
        || promptLower.includes(`call ${name}`)
        || promptLower.includes(`run ${name}`);
    });

    const toolCalls: ToolCall[] = [];
    if (triggeredTool) {
      const call: ToolCall = {
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        toolName: triggeredTool.name,
        input: deriveInputFromPrompt(triggeredTool.name, prompt),
      };
      toolCalls.push(call);
      yield { type: 'tool_call_start', callId: call.id, toolName: call.toolName, input: call.input };
      if (cancelled) {
        resolveFinal({ outputText: '', thinkingText: '', toolCalls, finishReason: 'error' });
        return;
      }
      resolveFinal({
        outputText: '',
        thinkingText: '',
        toolCalls,
        finishReason: 'tool_calls',
        usage: { inputTokens: prompt.length, outputTokens: 0 },
      });
      yield { type: 'done', finishReason: 'tool_calls' };
      return;
    }

    // Generate a deterministic-ish reply.
    const reply = synthesizeReply(prompt);
    const tokens = reply.split(/(\s+)/); // include whitespace as tokens
    let buffer = '';
    for (const token of tokens) {
      if (cancelled) {
        resolveFinal({
          outputText: buffer, thinkingText: '', toolCalls: [],
          finishReason: 'error', usage: { inputTokens: prompt.length, outputTokens: buffer.length },
        });
        yield { type: 'error', message: 'Cancelled', recoverable: false };
        return;
      }
      buffer += token;
      yield { type: 'text_delta', text: token };
      // Small delay so the UI can actually animate streaming in dev.
      await new Promise((r) => setTimeout(r, 12));
    }

    const usage = { inputTokens: prompt.length, outputTokens: buffer.length };
    yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    resolveFinal({
      outputText: buffer, thinkingText: '', toolCalls,
      finishReason: 'stop', usage,
    });
    yield { type: 'done', finishReason: 'stop' };
  })();

  return {
    events,
    final,
    cancel() { cancelled = true; },
  };
}

/**
 * Pull a plausible argument out of the prompt for the named tool. Just
 * enough to make local-sim's tool calls look real in the UI.
 */
function deriveInputFromPrompt(toolName: string, prompt: string): Record<string, unknown> {
  if (toolName === 'workspace_read') {
    // Look for a quoted path or a token that looks like a file path.
    const quoted = prompt.match(/"([^"]+)"|'([^']+)'/);
    const pathLike = prompt.match(/\b([\w./-]+\.[a-zA-Z0-9]+)\b/);
    return { relativePath: quoted?.[1] ?? quoted?.[2] ?? pathLike?.[1] ?? 'README.md' };
  }
  if (toolName === 'web_search') {
    // Use the prompt itself, stripped of the trigger phrase.
    const query = prompt.replace(/use|run|call|web_search/gi, '').trim();
    return { query: query || prompt };
  }
  if (toolName === 'git_status') return {};
  return { prompt: prompt.slice(0, 200) };
}

function synthesizeReply(prompt: string): string {
  if (!prompt.trim()) return 'I need a question to answer.';
  const trimmed = prompt.trim();
  // Echo-style helpful response for transparency about what the sim does.
  return [
    `(local-sim) You asked: "${trimmed.slice(0, 120)}${trimmed.length > 120 ? '…' : ''}"`,
    '',
    'In a real deployment with an API key configured, this would be answered by your chosen model.',
    'For now I can confirm the streaming pipeline, tool plumbing, and session storage are all wired up.',
  ].join('\n');
}
