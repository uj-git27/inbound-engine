// Creates the 5 channels if they don't exist, sets each purpose to its owner, and posts a
// pinned welcome message. Safe to re-run: the welcome is only posted to a newly created
// channel, unless --welcome is passed.
import { loadEnv } from '../lib/env.js';
import { rules } from '../lib/rules.js';
import { createSlack } from '../lib/connectors/slack.js';

loadEnv();
const forceWelcome = process.argv.includes('--welcome');
const slack = createSlack();
let failed = false;

const who = await slack.authTest();
console.log(`Slack: signed in as ${who.user} in ${who.team}`);
const existing = await slack.listChannels();

for (const member of Object.values(rules.team)) {
  const name = member.channel;
  try {
    let channel = existing.find((c) => c.name === name);
    let created = false;
    if (channel?.is_archived) throw new Error('channel exists but is archived; unarchive it in Slack first');
    if (!channel) {
      channel = (await slack.call('conversations.create', { name })).channel;
      created = true;
    }
    await slack.call('conversations.join', { channel: channel.id });
    await slack.call('conversations.setPurpose', {
      channel: channel.id,
      purpose: `Owner: ${member.name} (${member.role}). Gets: ${member.gets}.`,
    });

    let welcome = 'welcome already posted';
    if (created || forceWelcome) {
      const posted = await slack.call('chat.postMessage', {
        channel: channel.id,
        text: `${rules.alert_prefix}${member.name}\nThis channel gets: ${member.gets}.\nEvery alert here starts with "${rules.alert_prefix}<name>" so it is clear who owns it.\n_${rules.disclaimer}_`,
      });
      await slack.call('pins.add', { channel: channel.id, timestamp: posted.ts });
      welcome = 'welcome posted and pinned';
    }
    console.log(`OK   #${name}: ${created ? 'created' : 'exists'}, purpose set, ${welcome}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL #${name}: ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
