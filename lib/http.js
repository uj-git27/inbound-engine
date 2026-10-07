import { rules } from './rules.js';

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', timeout = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.timeout = timeout;
  }
}

// One external call with a time limit. Returns { status, json, text }; throws HttpError on
// a network error, a timeout or a non-2xx reply. Never puts headers (keys) in the message.
export async function http(url, options = {}) {
  // A "slow down" reply (429) is retried a few times, honouring Retry-After.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once(url, options);
    } catch (err) {
      if (err.status !== 429 || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(err.retryAfter ?? 1 + attempt, 10) * 1000));
    }
  }
}

async function once(url, { method = 'GET', headers = {}, body, form, timeoutMs } = {}) {
  const init = {
    method,
    headers: { ...headers },
    signal: AbortSignal.timeout(timeoutMs ?? rules.limits.external_call_timeout_ms),
  };
  if (form) {
    init.body = new URLSearchParams(form);
  } else if (body !== undefined) {
    init.headers['content-type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const where = `${method} ${new URL(url).host}${new URL(url).pathname}`;
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new HttpError(`${where}: ${timeout ? 'timed out' : err.message}`, { timeout });
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON; callers use .text
  }
  if (!res.ok) {
    const error = new HttpError(`${where}: HTTP ${res.status} ${text.slice(0, 500)}`, { status: res.status, body: text });
    error.retryAfter = Number(res.headers.get('retry-after')) || undefined;
    throw error;
  }
  return { status: res.status, json, text };
}
