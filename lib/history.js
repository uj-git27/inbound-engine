import { rules } from './rules.js';

// CRM history has this shape for every provider:
// { touches: [{ type: 'email'|'call'|'meeting', date, owner, status, incoming }],
//   notes:   [{ date, author, body }],
//   deals:   [{ name, stage, won, lost, reason, closed_at, entered_stage_at }] }
// or { unavailable: true } when it could not be read.

const day = (value) => String(value ?? '').slice(0, 10);
const byDate = (a, b) => String(a.date).localeCompare(String(b.date));

// What came of a touch, in the reader's words.
function outcomeOf(touch, touches) {
  const status = String(touch.status ?? '').toUpperCase();
  if (touch.type === 'meeting') return status === 'COMPLETED' ? 'held' : status === 'NO_SHOW' ? 'no-show' : status ? status.toLowerCase().replace(/_/g, ' ') : 'outcome not recorded';
  if (touch.type === 'call') return ['COMPLETED', 'CONNECTED'].includes(status) ? 'held' : status ? 'no reply' : 'outcome not recorded';
  // An email counts as answered when the other side wrote back afterwards.
  if (touch.incoming) return 'replied';
  return touches.some((t) => t.type === 'email' && t.incoming && String(t.date) > String(touch.date)) ? 'replied' : 'no reply';
}

// At most 3 lines, filled only from what the CRM holds. No model is involved.
export function summarizeHistory(history, now = Date.now()) {
  if (!history || history.unavailable) return ['CRM history unavailable'];
  const touches = [...(history.touches ?? [])].sort(byDate);
  const notes = [...(history.notes ?? [])].sort(byDate);
  const deals = history.deals ?? [];
  if (!touches.length && !notes.length && !deals.length) return ['No prior activity. Net new account.'];

  const lines = [];
  if (touches.length) {
    const last = touches.at(-1);
    lines.push(`${touches.length} touch${touches.length === 1 ? '' : 'es'} since ${day(touches[0].date)}. Last: ${last.type} by ${last.owner || 'unknown'}, ${day(last.date)} (${outcomeOf(last, touches)}).`);
  }
  // The open deal if there is one, otherwise the one closed most recently.
  const deal = deals.find((d) => !d.won && !d.lost) ?? [...deals].sort((a, b) => String(b.closed_at ?? '').localeCompare(String(a.closed_at ?? '')))[0];
  if (deal) {
    let detail;
    if (deal.lost) detail = `${deal.reason || 'no reason recorded'}, ${day(deal.closed_at) || 'close date unknown'}`;
    else if (deal.won) detail = day(deal.closed_at) || 'close date unknown';
    else {
      const days = deal.entered_stage_at ? Math.max(0, Math.floor((now - Date.parse(deal.entered_stage_at)) / 86_400_000)) : null;
      detail = days === null ? 'days in stage unknown' : `${days} day${days === 1 ? '' : 's'} in stage`;
    }
    lines.push(`"${deal.name || 'Unnamed deal'}" ${deal.stage || 'stage unknown'}, ${detail}.`);
  }
  if (notes.length) {
    const note = notes.at(-1);
    const max = rules.history.note_chars;
    const body = String(note.body ?? '').replace(/\s+/g, ' ').trim();
    lines.push(`"${body.length > max ? `${body.slice(0, max)}…` : body}" (note, ${day(note.date)}, ${note.author || 'author unknown'})`);
  }
  return lines.slice(0, 3);
}

// Reads the history of a company the CRM knows, keeping a copy next to the other saved company
// data. Fails open: on an error the last saved copy is used, and with none the card says
// "CRM history unavailable".
export async function getHistory({ crm, cache, domain, notes = [] }) {
  if (!crm.history) return { unavailable: true };
  const saved = await cache.get('crm_history', domain, rules.history.cache_minutes * 60_000).catch(() => null);
  if (saved) return saved;
  try {
    const history = (await crm.history(domain)) ?? { touches: [], notes: [], deals: [] };
    await cache.set('crm_history', domain, history, 'CRM').catch(() => {});
    return history;
  } catch (err) {
    notes.push(`CRM history failed: ${err.message}`);
    return (await cache.getStale('crm_history', domain).catch(() => null)) ?? { unavailable: true };
  }
}
