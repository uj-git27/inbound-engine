// Records posts instead of sending them. `posts` is exposed so tests can inspect it.
export function createMockSlack() {
  const posts = [];
  return {
    posts,
    async postMessage(channel, text, { thread, blocks } = {}) {
      const ts = String(posts.length + 1);
      posts.push({ channel, text, ts, ...(thread ? { thread_ts: thread.ts } : {}), ...(blocks ? { blocks } : {}) });
      return { ok: true, ts, channel };
    },
    async updateMessage(message, text, { blocks } = {}) {
      const post = posts.find((p) => p.ts === message.ts);
      if (!post) throw new Error(`mock Slack: no message ${message.ts}`);
      Object.assign(post, { text, edited: true, ...(blocks ? { blocks } : {}) });
      return { ok: true, ts: post.ts, channel: post.channel };
    },
  };
}
