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
  };
}
