import { http } from '../http.js';
import { need } from '../env.js';

export function createClaude(env = process.env) {
  return {
    async message({ system, user, maxTokens = 1024 }) {
      const body = { model: need('CLAUDE_MODEL', env), max_tokens: maxTokens, messages: [{ role: 'user', content: user }] };
      if (system) body.system = system;
      const res = await http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': need('ANTHROPIC_API_KEY', env), 'anthropic-version': '2023-06-01' },
        body,
      });
      return res.json;
    },
  };
}
