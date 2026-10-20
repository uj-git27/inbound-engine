import { rules } from './rules.js';

const DAY = 86_400_000;

// The AE's time zone: AE_TZ from the environment, else the default in rules.json.
export const aeZone = (env = process.env) => env.AE_TZ || rules.booking.slot_timezone;

// Wall-clock time in a zone -> UTC milliseconds. Handles daylight saving without a library.
export function zonedToUtc(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(instant)).map((p) => [p.type, Number(p.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

export const zonedDate = (instant, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isWeekday = (date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Every slot on offer: the next weekdays (today included when it is one), 30-minute slots across
// the whole day in the AE's time zone, at least 2 hours from now. The calendar decides what is free.
// Times are UTC milliseconds.
export function slotGrid(now = Date.now(), env = process.env) {
  const b = rules.booking;
  const zone = aeZone(env);
  const earliest = now + b.min_lead_hours * 3_600_000;
  const step = b.duration_minutes;
  const slots = [];
  let date = zonedDate(now, zone);
  for (let days = 0; days < b.weekdays_ahead; date = addDays(date, 1)) {
    if (!isWeekday(date)) continue;
    days += 1;
    for (let t = minutes(b.day_start); t + step <= minutes(b.day_end); t += step) {
      const start = zonedToUtc(date, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, zone);
      if (start >= earliest) slots.push({ start, end: start + step * 60_000 });
    }
  }
  return slots;
}

export const isFree = (slot, busy) => !busy.some((x) => slot.start < Date.parse(x.end) && slot.end > Date.parse(x.start));

// The slots that are on the grid and not busy on the AE's calendar.
export async function openSlots({ google, now = Date.now(), env = process.env }) {
  const grid = slotGrid(now, env);
  if (!grid.length) return [];
  const busy = await google.freeBusy(new Date(grid[0].start).toISOString(), new Date(grid.at(-1).end).toISOString());
  return grid.filter((slot) => isFree(slot, busy));
}

// "Tue, Oct 20, 10:30 AM EDT" in any zone.
export const localTime = (instant, timeZone) => new Intl.DateTimeFormat('en-US', {
  timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(instant));

// The invite's guest. In DEMO_MODE it is a plus-address of DEMO_INBOX named after the lead's company
// (me+temporal.io@...), so the invite shows the prospect by name and still reaches nobody else.
const guest = (lead, env) => {
  if (env.DEMO_MODE !== 'true') return { email: lead.email };
  const inbox = env.DEMO_INBOX || lead.email;
  const [user, host] = String(inbox).split('@');
  const tag = String(lead.domain ?? '').toLowerCase();
  return { email: tag && host ? `${user}+${tag}@${host}` : inbox, displayName: lead.name };
};

// Books the requested slot if it is still free, else the next free one after it (or the first
// free slot when nothing was requested). Free/busy is checked again here, at booking time.
// In DEMO_MODE the invite goes to DEMO_INBOX, never to the buyer.
export async function book({ lead, google, requested = null, buyerZone = null, titleSuffix = '', env = process.env, now = Date.now() }) {
  const b = rules.booking;
  const zone = aeZone(env);
  const open = await openSlots({ google, now, env });
  if (!open.length) return { booked: false, reason: `no free slot in the next ${b.weekdays_ahead} weekdays` };

  const wanted = requested ? Date.parse(requested) : null;
  const chosen = (wanted ? open.find((s) => s.start === wanted) ?? open.find((s) => s.start > wanted) : null) ?? open[0];
  const changed = wanted !== null && chosen.start !== wanted;
  const shownZone = buyerZone || zone;
  const buyerLocal = localTime(chosen.start, shownZone);
  const changeNote = changed ? b.slot_taken_note.replace('{new_time}', buyerLocal) : null;
  const event = await google.createEvent({
    summary: `${b.title}${titleSuffix}`,
    description: [
      `Your local time: ${buyerLocal}.`,
      changeNote,
      // The invite goes to the buyer like an email, so it carries the email footer.
      rules.emails.footer,
    ].filter(Boolean).join('\n\n'),
    start: { dateTime: new Date(chosen.start).toISOString(), timeZone: zone },
    end: { dateTime: new Date(chosen.end).toISOString(), timeZone: zone },
    attendees: [guest(lead, env)],
  });
  return {
    booked: true, start: new Date(chosen.start).toISOString(), slot: localTime(chosen.start, zone), buyerLocal,
    requested: requested ?? null, changed, changeNote, eventId: event.id, eventLink: event.htmlLink ?? '',
  };
}
