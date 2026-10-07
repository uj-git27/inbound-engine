// Records posts instead of sending them. `posts` is exposed so tests can inspect it.
export function createMockSlack() {
  const posts = [];
  return {
    posts,
    async postMessage(channel, text) {
      posts.push({ channel, text });
      return { ok: true, ts: String(posts.length) };
    },
  };
}
