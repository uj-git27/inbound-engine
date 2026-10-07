// One-time: gets a Google refresh token with a Desktop OAuth client.
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. Prints GOOGLE_REFRESH_TOKEN to paste
// into .env. In Testing mode the token expires after 7 days; re-run this script then.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadEnv, need } from '../lib/env.js';
import { http } from '../lib/http.js';

loadEnv();
const PORT = 53682;
const redirectUri = `http://127.0.0.1:${PORT}`;
const state = randomBytes(16).toString('hex');
const scopes = ['calendar.events', 'calendar.freebusy', 'gmail.send'].map((s) => `https://www.googleapis.com/auth/${s}`);

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: need('GOOGLE_CLIENT_ID'),
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: scopes.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  state,
})}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('State mismatch. Run the script again.');
    return;
  }
  try {
    const token = await http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        code,
        client_id: need('GOOGLE_CLIENT_ID'),
        client_secret: need('GOOGLE_CLIENT_SECRET'),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
    });
    res.end('Done. You can close this tab and go back to the terminal.');
    if (!token.json.refresh_token) {
      console.log('FAIL: Google returned no refresh token. Remove the app at myaccount.google.com/permissions and run again.');
      process.exitCode = 1;
    } else {
      console.log(`\nScopes granted: ${token.json.scope}`);
      console.log(`\nPaste this line into .env:\n\nGOOGLE_REFRESH_TOKEN=${token.json.refresh_token}\n`);
    }
  } catch (err) {
    res.end('Token exchange failed. See the terminal.');
    console.log(`FAIL: ${err.message}`);
    process.exitCode = 1;
  }
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Open this URL in your browser and sign in with the Gmail account that owns the calendar:\n\n${authUrl}\n`);
  console.log(`Waiting for Google to redirect to ${redirectUri} ...`);
});
