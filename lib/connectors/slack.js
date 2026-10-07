import { http } from '../http.js';
import { need } from '../env.js';

export function createSlack(env = process.env) {
  // Form-encoded works for every Web API method, read or write.
  async function call(method, params = {}) {
    const res = await http(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${need('SLACK_BOT_TOKEN', env)}` },
      form: params,
    });
    if (!res.json?.ok) {
      const needed = res.json?.needed ? ` (needs scope: ${res.json.needed})` : '';
      const err = new Error(`Slack ${method}: ${res.json?.error ?? res.text.slice(0, 200)}${needed}`);
      err.slackError = res.json?.error;
      throw err;
    }
    return res.json;
  }

  return {
    call,

    authTest: () => call('auth.test'),

    // Channel by name; chat:write.public lets the bot post without joining.
    postMessage: (channel, text, extra = {}) =>
      call('chat.postMessage', { channel: `#${channel.replace(/^#/, '')}`, text, unfurl_links: 'false', ...extra }),

    async listChannels() {
      const channels = [];
      let cursor = '';
      do {
        const page = await call('conversations.list', { types: 'public_channel', limit: '200', cursor });
        channels.push(...page.channels);
        cursor = page.response_metadata?.next_cursor ?? '';
      } while (cursor);
      return channels;
    },
  };
}
