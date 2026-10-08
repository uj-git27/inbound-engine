import { rules } from './rules.js';
import { responseText } from './connectors/gemini.js';

const label = (type) => type.replace(/_/g, ' ');
const numbersIn = (text) => (String(text).match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ''));

// The summary with no model: counts the signals and names each kind with its month.
export function templateSummary(signals, company) {
  const kinds = signals.map((s) => `${label(s.type)} (${s.date.slice(0, 7)})`).join(', ');
  return `${company} shows ${signals.length} dated business signal${signals.length === 1 ? '' : 's'} in the last ${rules.signals.window_months} months: ${kinds}.`;
}

// Two or three lines that sum up the dated signals. The signals were already filtered to the
// window and link-checked; the model only rewords them. Its text is dropped for the template when
// it is empty, or when it contains a number that is not in the signals (a sign of an added fact).
// Returns { text, by } or null when there are no signals.
export async function growthSummary({ signals, company, gemini, notes = [] }) {
  if (!signals?.length) return null;
  const fallback = { text: templateSummary(signals, company), by: 'template' };
  if (!gemini) return fallback;
  const cfg = rules.signals.summary;
  const items = signals.map((s) => `- ${s.date} | ${label(s.type)} | ${s.title}${s.snippet ? ` | ${s.snippet}` : ''}`).join('\n');
  const prompt = `${cfg.prompt.join('\n').replace('{company}', company).replace('{months}', rules.signals.window_months)}\n\nItems:\n${items}`;
  try {
    const reply = await gemini.generate(prompt, { jsonMode: false, search: false, timeoutMs: cfg.timeout_ms });
    const text = responseText(reply).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('empty reply');
    const known = new Set([...numbersIn(items), String(rules.signals.window_months)]);
    const added = numbersIn(text).find((n) => !known.has(n));
    if (added) throw new Error(`it used a number that is not in the signals (${added})`);
    const short = text.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
    return { text: short.length > cfg.max_chars ? `${short.slice(0, cfg.max_chars - 1).trimEnd()}…` : short, by: 'Gemini' };
  } catch (err) {
    notes.push(`Growth summary by Gemini not used: ${err.message}`);
    return fallback;
  }
}
