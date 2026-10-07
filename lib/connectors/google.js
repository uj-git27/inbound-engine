import { http } from '../http.js';
import { need } from '../env.js';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1';

// RFC 2822 message, base64url encoded, as Gmail's send endpoint expects.
const encoded = (text) => `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;

// `fromName` sets the display name (Gmail keeps the signed-in address), `replyTo` and `bcc` are optional.
export function buildRawEmail({ to, subject, text, fromName, fromAddress, replyTo, bcc }) {
  const message = [
    ...(fromName && fromAddress ? [`From: ${encoded(fromName)} <${fromAddress}>`] : []),
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encoded(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}

export function createGoogle(env = process.env) {
  let cached = null;

  // The refresh token expires after 7 days while the OAuth app is in Testing mode.
  async function accessToken() {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const res = await http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        client_id: need('GOOGLE_CLIENT_ID', env),
        client_secret: need('GOOGLE_CLIENT_SECRET', env),
        refresh_token: need('GOOGLE_REFRESH_TOKEN', env),
        grant_type: 'refresh_token',
      },
    });
    cached = { token: res.json.access_token, expires: Date.now() + res.json.expires_in * 1000 };
    return cached.token;
  }

  const authed = async (url, options = {}) =>
    http(url, { ...options, headers: { authorization: `Bearer ${await accessToken()}` } });

  return {
    async freeBusy(timeMin, timeMax) {
      const res = await authed(`${CALENDAR}/freeBusy`, {
        method: 'POST',
        body: { timeMin, timeMax, items: [{ id: 'primary' }] },
      });
      return res.json.calendars.primary.busy;
    },

    async createEvent(event) {
      const res = await authed(`${CALENDAR}/calendars/primary/events?sendUpdates=all`, { method: 'POST', body: event });
      return res.json;
    },

    async patchEvent(eventId, changes) {
      const res = await authed(`${CALENDAR}/calendars/primary/events/${eventId}?sendUpdates=all`, { method: 'PATCH', body: changes });
      return res.json;
    },

    // Cancels the meeting and tells the attendees.
    async deleteEvent(eventId) {
      await authed(`${CALENDAR}/calendars/primary/events/${eventId}?sendUpdates=all`, { method: 'DELETE' });
    },

    async sendEmail(email) {
      // The sending address is the signed-in Gmail account.
      const fromAddress = env.GMAIL_SENDER || env.DEMO_INBOX;
      const res = await authed(`${GMAIL}/users/me/messages/send`, {
        method: 'POST',
        body: { raw: buildRawEmail({ ...email, fromAddress }) },
      });
      return res.json;
    },
  };
}
