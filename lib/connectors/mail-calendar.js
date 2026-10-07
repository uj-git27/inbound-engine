import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { need } from '../env.js';
import { http } from '../http.js';
import { rules } from '../rules.js';
import { zonedToUtc } from '../booking.js';

// Calendar and email without Google Cloud: any mailbox's own mail server with an app password
// (Zoho, Gmail and others; SMTP_HOST picks the server).
// Invites are calendar invitations (.ics) sent by email; free/busy comes from the calendar's
// secret iCal address plus the slots this engine has already booked.

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
const header = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`);

export function buildMime({ from, to, subject, text, ics, method = 'REQUEST' }) {
  const head = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@inbound-engine>`,
    'MIME-Version: 1.0',
  ];
  if (!ics) {
    return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text)].join('\r\n');
  }
  const boundary = `b-${randomUUID()}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    `Content-Type: text/calendar; charset=UTF-8; method=${method}`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(ics),
    `--${boundary}--`,
  ].join('\r\n');
}

const icsTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export function buildIcs({ uid, sequence = 0, summary, description, start, end, organizer, attendees }) {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//inbound-engine//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    `ORGANIZER:mailto:${organizer}`,
    ...attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// Busy blocks from an iCal feed. Reads single events (UTC, zoned or all-day); a repeating
// event only counts on its first date.
export function parseIcsBusy(ics, fallbackZone = rules.booking.slot_timezone) {
  const unfolded = String(ics ?? '').replace(/\r?\n[ \t]/g, '');
  const busy = [];
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    if (/^STATUS:CANCELLED/m.test(body) || /^TRANSP:TRANSPARENT/m.test(body)) continue;
    const read = (name) => {
      const m = new RegExp(`^${name}((?:;[^:\\r\\n]*)?):([^\\r\\n]+)`, 'm').exec(body);
      if (!m) return null;
      const value = m[2].trim();
      const zone = /TZID=([^;:]+)/.exec(m[1])?.[1] ?? fallbackZone;
      const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
      if (!d) return null;
      const date = `${d[1]}-${d[2]}-${d[3]}`;
      if (!d[4]) return { ms: zonedToUtc(date, '00:00', fallbackZone), allDay: true };
      if (d[7]) return { ms: Date.UTC(d[1], d[2] - 1, d[3], d[4], d[5], d[6]) };
      try {
        return { ms: zonedToUtc(date, `${d[4]}:${d[5]}`, zone) };
      } catch {
        return { ms: zonedToUtc(date, `${d[4]}:${d[5]}`, fallbackZone) };
      }
    };
    const start = read('DTSTART');
    if (!start) continue;
    const end = read('DTEND') ?? { ms: start.ms + (start.allDay ? 86_400_000 : 3_600_000) };
    busy.push({ start: new Date(start.ms).toISOString(), end: new Date(end.ms).toISOString() });
  }
  return busy;
}

// One message over SMTP with implicit TLS (port 465).
function smtpSend({ host, user, pass, from, to, raw, timeoutMs = rules.limits.external_call_timeout_ms }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 465, servername: host });
    const steps = [
      [null, 220],
      ['EHLO inbound-engine', 250],
      [`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, 235],
      [`MAIL FROM:<${from}>`, 250],
      ...to.map((address) => [`RCPT TO:<${address}>`, 250]),
      ['DATA', 354],
      [`${raw.replace(/\r\n\./g, '\r\n..')}\r\n.`, 250],
      ['QUIT', 221],
    ];
    let step = 0;
    let buffer = '';
    const fail = (message) => { socket.destroy(); reject(new Error(`Mail server ${host}: ${message}`)); };
    socket.setTimeout(timeoutMs, () => fail('timed out'));
    socket.on('error', (err) => fail(err.message));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      const last = lines.at(-2);
      if (!buffer.endsWith('\r\n') || !last || !/^\d{3} /.test(last)) return; // reply not complete yet
      buffer = '';
      const code = Number(last.slice(0, 3));
      if (code !== steps[step][1]) {
        // Never echo the AUTH line; it holds the password.
        return fail(step === 2 ? `sign-in was rejected (${last.slice(0, 120)}). Check SMTP_HOST, SMTP_USER and SMTP_APP_PASSWORD.` : `unexpected reply ${last.slice(0, 200)}`);
      }
      step += 1;
      if (step >= steps.length) { socket.end(); return resolve(); }
      socket.write(`${steps[step][0]}\r\n`);
    });
  });
}

const packId = (event) => Buffer.from(JSON.stringify(event)).toString('base64url');
const unpackId = (id) => JSON.parse(Buffer.from(id, 'base64url').toString());

export function createMailCalendar(env = process.env, { airtable } = {}) {
  const user = () => need('SMTP_USER', env);
  const send = (message) => smtpSend({ host: need('SMTP_HOST', env), user: user(), pass: need('SMTP_APP_PASSWORD', env).replace(/\s/g, ''), from: user(), to: message.to, raw: buildMime({ from: user(), ...message }) });

  async function sendInvite(event) {
    const ics = buildIcs({ ...event, organizer: user() });
    const when = new Intl.DateTimeFormat('en-US', { timeZone: rules.booking.slot_timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(event.start));
    await send({
      to: [...new Set(event.attendees)],
      subject: `${event.sequence ? 'Updated invitation' : 'Invitation'}: ${event.summary}`,
      text: `${event.summary}\n${when} ${rules.booking.slot_label}\n\n${event.description}`,
      ics,
    });
  }

  return {
    // Busy = the calendar's secret iCal feed (if set) plus slots this engine already booked.
    async freeBusy() {
      const busy = [];
      if (env.CALENDAR_ICAL_URL) {
        const feed = await http(env.CALENDAR_ICAL_URL);
        busy.push(...parseIcsBusy(feed.text));
      }
      if (airtable) {
        const rows = await airtable.findRecords(rules.tables.leads, { formula: "{slot} != ''", maxRecords: 100 });
        for (const row of rows) {
          const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(row.fields.slot ?? '');
          if (!m) continue;
          const start = zonedToUtc(m[1], m[2], rules.booking.slot_timezone);
          busy.push({ start: new Date(start).toISOString(), end: new Date(start + rules.booking.duration_minutes * 60_000).toISOString() });
        }
      }
      return busy;
    },

    async createEvent(event) {
      const stored = {
        uid: `${randomUUID()}@inbound-engine`, sequence: 0, summary: event.summary, description: event.description,
        start: event.start.dateTime, end: event.end.dateTime, attendees: event.attendees.map((a) => a.email),
      };
      await sendInvite(stored);
      // Everything needed to update the invite later travels in the id.
      return { id: packId(stored), htmlLink: '' };
    },

    // Re-sends the invitation with the same UID and a higher sequence, so calendars update it.
    async patchEvent(eventId, changes) {
      const stored = { ...unpackId(eventId), ...changes };
      stored.sequence += 1;
      await sendInvite(stored);
      return { id: packId(stored), htmlLink: '' };
    },

    async sendEmail({ to, subject, text }) {
      await send({ to: [to], subject, text });
      return { id: 'sent' };
    },
  };
}
