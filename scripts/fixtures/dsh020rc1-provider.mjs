// Test-only provider backend. It replaces model generation through the public
// LlmAdapter seam; real DSH admission, Agent, tool execution and events remain.
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'vscode-runtime-contract-provider';
export const inject = ['llm'];
export async function apply(ctx, config) {
  const { LlmAdapter } = await import(config.llmModule);
  class ContractProvider extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Local contract probe' }; }
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'Deterministic local fixture', inputModalities: ['text'] }]; }
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 131072 } }; }
    async *stream(options) {
      const userIndex = options.messages.findLastIndex((message) => message.role === 'user' && message.content?.some((part) => part.type === 'text' && part.text.includes('probe-')));
      const prompt = (options.messages[userIndex]?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
      if (options.purpose !== 'session-title' && prompt.includes('probe-tool')) {
        const count = options.messages.slice(userIndex + 1).filter((message) => message.role === 'tool').length;
        const directCalls = [
          { name: 'read', args: { file_path: 'probe-tool.txt' } },
          { name: 'write', args: { file_path: 'probe-tool.txt', content: 'middle\n' } },
          { name: 'edit', args: { file_path: 'probe-tool.txt', old_string: 'middle', new_string: 'after' } },
        ];
        const calls = options.tools?.some((tool) => tool.name === 'run_code') && !options.tools.some((tool) => tool.name === 'read')
          ? [{ name: 'run_code', args: { description: 'Exercise synthetic workspace file tools',
            code: directCalls.map((call) => `await tools.${call.name}(${JSON.stringify(call.args)});`).join('\n') + '\nreturn "synthetic-tools-complete";' } }]
          : directCalls;
        if (count < calls.length) {
          const call = calls[count];
          if (!options.tools?.some((tool) => tool.name === call.name)) throw new Error(`Required fixture tool unavailable: ${call.name}`);
          const block = { type: 'tool-call', id: `probe-call-${count}`, name: call.name, arguments: JSON.stringify(call.args) };
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
          yield { type: 'block-end', index: 0, block };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'alpha ' };
      if (options.purpose !== 'session-title' && prompt.includes('probe-cancel')) {
        await delay(30000, undefined, { signal: options.signal });
      } else await delay(80, undefined, { signal: options.signal });
      yield { type: 'text-delta', index: 0, text: 'beta' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'alpha beta' } };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['vscode-contract-probe'], new ContractProvider()));
}
export default { name, inject, apply };
