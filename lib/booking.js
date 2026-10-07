import { rules } from './rules.js';

const DAY = 86_400_000;

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

// Every bookable slot, in order. The preferred slot comes first if it is a weekday, in the future
// and at least 2 hours away; a weekend, past or too-soon choice rolls forward to the next slot.
// The search covers 10 business days.
export function candidateSlots(preferred, now = Date.now()) {
  const b = rules.booking;
  const earliest = now + b.min_lead_hours * 3_600_000;
  const today = zonedDate(now, b.slot_timezone);
  const wanted = preferred?.date && preferred?.slot ? zonedToUtc(preferred.date, preferred.slot, b.slot_timezone) : null;
  const from = Math.max(earliest, wanted ?? 0);
  let date = preferred?.date && preferred.date > today ? preferred.date : today;
  const slots = [];
  for (let days = 0; days < b.search_business_days; date = addDays(date, 1)) {
    if (!isWeekday(date)) continue;
    days += 1;
    for (const slot of b.slots) {
      const start = zonedToUtc(date, slot, b.slot_timezone);
      if (start >= from) slots.push({ date, slot, start, end: start + b.duration_minutes * 60_000 });
    }
  }
  return slots;
}

export function firstFree(slots, busy) {
  const blocks = busy.map((x) => [Date.parse(x.start), Date.parse(x.end)]);
  return slots.find((s) => !blocks.some(([start, end]) => s.start < end && s.end > start)) ?? null;
}

const localTime = (instant, timeZone) => new Intl.DateTimeFormat('en-US', {
  timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(instant));

export const slotText = (s) => `${s.date} ${s.slot} ${rules.booking.slot_label}`;

// Books the preferred slot if it's free, else the next free weekday slot.
// In DEMO_MODE the invite goes to DEMO_INBOX, never to the buyer.
export async function book({ lead, google, titleSuffix = '', env = process.env, now = Date.now() }) {
  const b = rules.booking;
  const slots = candidateSlots(lead.first_choice, now);
  if (!slots.length) return { booked: false, reason: 'no slot inside the booking window' };
  const busy = await google.freeBusy(new Date(slots[0].start).toISOString(), new Date(slots.at(-1).end).toISOString());
  const chosen = firstFree(slots, busy);
  if (!chosen) return { booked: false, reason: `no free slot in the next ${b.search_business_days} business days` };

  const asked = lead.first_choice?.date && lead.first_choice?.slot ? slotText(lead.first_choice) : null;
  const changed = asked !== slotText(chosen);
  const buyerZone = b.buyer_timezones[lead.timezone] ?? b.buyer_timezones.Other;
  const attendee = env.DEMO_MODE === 'true' ? (env.DEMO_INBOX || lead.email) : lead.email;
  const event = await google.createEvent({
    summary: `${b.title}${titleSuffix}`,
    description: [
      `Your local time: ${localTime(chosen.start, buyerZone)}.`,
      changed ? `The slot you asked for${asked ? ` (${asked})` : ''} was not available, so this is the next free one.` : null,
      // The invite goes to the buyer like an email, so it carries the email footer.
      rules.emails.footer,
    ].filter(Boolean).join('\n\n'),
    start: { dateTime: new Date(chosen.start).toISOString(), timeZone: b.slot_timezone },
    end: { dateTime: new Date(chosen.end).toISOString(), timeZone: b.slot_timezone },
    attendees: [{ email: attendee }],
  });
  return { booked: true, slot: slotText(chosen), start: new Date(chosen.start).toISOString(), changed, eventId: event.id, eventLink: event.htmlLink ?? '', buyerLocal: localTime(chosen.start, buyerZone) };
}
