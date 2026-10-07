import { rules } from '../lib/rules.js';
import { verifyAction, ACTIONS } from '../lib/links.js';
import { runAction } from '../lib/actions.js';
import { loadLead } from '../lib/state.js';
import { getConnectors } from '../lib/connectors/index.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;line-height:1.5;color:#111;background:#fafafa}
h1{font-size:1.3rem}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#111;color:#fff;cursor:pointer}
p.small{color:#666;font-size:.85rem}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}p.small{color:#999}}</style>
</head><body>${body}<p class="small">${esc(rules.disclaimer)}</p></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const params = (request) => Object.fromEntries(new URL(request.url).searchParams);

// GET shows a confirm page. Only the POST from the button runs the action, so link previews
// and scanners can never trigger one.
export async function GET(request) {
  const check = verifyAction(params(request));
  if (!check.ok) return page('Link problem', `<h1>${esc(check.error)}</h1>`, 400);
  const loaded = await loadLead(getConnectors().airtable, check.leadId);
  const lead = loaded?.state?.lead;
  if (!lead) return page('Not found', '<h1>This lead could not be found.</h1>', 404);
  return page(ACTIONS[check.action], `<h1>${esc(ACTIONS[check.action])}?</h1>
<p>${esc(lead.name)}, ${esc(lead.title)} at ${esc(lead.company || lead.domain)}</p>
<form method="post"><button type="submit">${esc(ACTIONS[check.action])}</button></form>`);
}

export async function POST(request) {
  const check = verifyAction(params(request));
  if (!check.ok) return page('Link problem', `<h1>${esc(check.error)}</h1>`, 400);
  const result = await runAction({ leadId: check.leadId, action: check.action, connectors: getConnectors() });
  return page(result.ok ? 'Done' : 'Not done', `<h1>${result.ok ? 'Done' : 'Not done'}</h1><p>${esc(result.message)}</p>`, result.ok ? 200 : 500);
}
