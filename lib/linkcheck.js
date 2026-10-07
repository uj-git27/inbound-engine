// Is a source link worth showing? "dead" only when we are sure (page gone, or the site does
// not exist). A site that blocks robots, is slow, or errors is "unknown": it may well work for a
// person, so it is kept.
export async function linkStatus(url, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; inbound-engine link check)', accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    res.body?.cancel?.().catch(() => {});
    if (res.status === 404 || res.status === 410) return 'dead';
    return res.status < 400 ? 'ok' : 'unknown';
  } catch (err) {
    return ['ENOTFOUND', 'EAI_AGAIN'].includes(err?.cause?.code) ? 'dead' : 'unknown';
  }
}

// Checks every link once, in parallel. Returns a lookup: url -> 'ok' | 'unknown' | 'dead'.
export async function checkLinks(urls, check = linkStatus) {
  const unique = [...new Set(urls.filter(Boolean))];
  const results = await Promise.all(unique.map((url) => check(url).catch(() => 'unknown')));
  return new Map(unique.map((url, i) => [url, results[i]]));
}

// For each sourced fact, keep the best of its cited pages: one that loads, else one we could not
// rule out. A fact whose pages are all dead keeps its value but loses its link.
export async function verifyWebLinks(web, check = linkStatus) {
  if (!web?.verified) return web;
  const items = [...Object.values(web.facts), web.parent, ...web.subsidiaries].filter(Boolean);
  const status = await checkLinks(items.flatMap((item) => item.urls ?? [item.url]), check);
  for (const item of items) {
    const urls = item.urls ?? [item.url];
    item.url = urls.find((u) => status.get(u) === 'ok') ?? urls.find((u) => status.get(u) === 'unknown') ?? null;
    delete item.urls;
  }
  return web;
}

// A news signal needs a working link as its evidence, so one with a dead link is dropped.
export async function verifySignalLinks(signals, check = linkStatus) {
  const status = await checkLinks(signals.map((s) => s.url), check);
  return signals.filter((s) => status.get(s.url) !== 'dead');
}
