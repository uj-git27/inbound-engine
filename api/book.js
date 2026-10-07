import { rules } from '../lib/rules.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// GET /book?sid=<Tally submission id>&e=<work email>: the slot page shown after the form.
// Plain HTML, CSS and JavaScript in one response: no framework and no external scripts.
const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pick a time for your demo</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #14171f; --muted: #5b6474; --line: #dfe3ea;
    --accent: #2f5bea; --accent-ink: #ffffff; --soft: #eef2fd; --ok: #1f7a4d;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1218; --card: #171b24; --ink: #eef1f6; --muted: #9aa4b5; --line: #2a3140; --accent: #7c9cff; --accent-ink: #0f1218; --soft: #1e2636; --ok: #5fd39a; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--ink);
    font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-text-size-adjust: 100%;
  }
  main { flex: 1; width: 100%; max-width: 720px; margin: 0 auto; padding: 20px 16px 8px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px 16px; }
  h1 { font-size: 1.35rem; line-height: 1.25; margin: 0 0 6px; text-wrap: balance; }
  p { margin: 0; }
  .sub { color: var(--muted); font-size: .95rem; }
  .who { color: var(--muted); font-size: .85rem; margin-top: 4px; overflow-wrap: anywhere; }
  .days { display: flex; gap: 8px; margin: 18px -16px 0; padding: 0 16px 6px; overflow-x: auto; scrollbar-width: none; }
  .days::-webkit-scrollbar { display: none; }
  .day {
    flex: 0 0 auto; min-width: 74px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 12px; background: transparent;
    color: var(--ink); font: inherit; text-align: center; cursor: pointer;
  }
  .day small { display: block; color: var(--muted); font-size: .75rem; }
  .day b { display: block; font-size: 1rem; font-variant-numeric: tabular-nums; }
  .day[aria-selected="true"] { background: var(--soft); border-color: var(--accent); }
  .day[aria-selected="true"] small { color: var(--ink); }
  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin-top: 14px; }
  .slot {
    padding: 11px 6px; border: 1px solid var(--line); border-radius: 10px; background: transparent; color: var(--ink);
    font: inherit; font-variant-numeric: tabular-nums; cursor: pointer;
  }
  .slot:hover, .day:hover { border-color: var(--accent); }
  .slot[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
  button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .zone { color: var(--muted); font-size: .85rem; margin-top: 14px; }
  .bar { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
  .picked { flex: 1; min-width: 0; font-size: .95rem; }
  .picked span { color: var(--muted); display: block; font-size: .8rem; }
  .confirm {
    flex: 0 0 auto; padding: 12px 20px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-ink);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  .confirm[disabled] { opacity: .45; cursor: not-allowed; }
  .state { text-align: center; padding: 28px 8px; }
  .state h1 { margin-bottom: 8px; }
  .tick { width: 44px; height: 44px; margin: 0 auto 14px; border-radius: 50%; background: var(--soft); color: var(--ok); display: grid; place-items: center; font-size: 1.4rem; }
  .error { color: #c0392b; font-size: .9rem; margin-top: 10px; }
  .empty { color: var(--muted); padding: 18px 0 4px; }
  footer { max-width: 720px; width: 100%; margin: 0 auto; padding: 14px 16px 22px; color: var(--muted); font-size: .78rem; text-align: center; }
  [hidden] { display: none !important; }
  @media (min-width: 640px) {
    main { padding-top: 48px; }
    .card { padding: 28px; }
    h1 { font-size: 1.6rem; }
    .days { margin: 22px 0 0; padding: 0 0 6px; }
    .day { flex: 1; }
    .slots { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
  }
</style>
</head>
<body>
<main>
  <div class="card">
    <section id="loading" class="state" aria-live="polite"><p class="sub">Loading available times…</p></section>

    <section id="picker" hidden>
      <h1>Pick a time for your demo</h1>
      <p class="sub">30 minutes, by video call.</p>
      <p class="who" id="who" hidden></p>
      <div class="days" id="days" role="tablist" aria-label="Day"></div>
      <div class="slots" id="slots" role="group" aria-label="Time"></div>
      <p class="empty" id="empty" hidden>No times left on this day. Try another day.</p>
      <p class="zone" id="zone"></p>
      <div class="bar">
        <p class="picked" id="picked"><span>Your pick</span>None yet</p>
        <button class="confirm" id="confirm" type="button" disabled>Confirm</button>
      </div>
      <p class="error" id="error" role="alert" hidden></p>
    </section>

    <section id="done" class="state" hidden aria-live="polite">
      <div class="tick" id="tick" aria-hidden="true">✓</div>
      <h1 id="doneTitle"></h1>
      <p class="sub" id="doneText"></p>
    </section>
  </div>
</main>
<footer>${esc(rules.disclaimer)}</footer>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var sid = params.get('sid') || '';
  var email = params.get('e') || '';
  var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var $ = function (id) { return document.getElementById(id); };
  var show = function (id) { ['loading', 'picker', 'done'].forEach(function (s) { $(s).hidden = s !== id; }); };
  var fmt = function (opts) { return new Intl.DateTimeFormat(undefined, opts); };
  var dayKey = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
  var weekday = fmt({ weekday: 'short' });
  var dayNum = fmt({ month: 'short', day: 'numeric' });
  var clock = fmt({ hour: 'numeric', minute: '2-digit' });
  var full = fmt({ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  var zoneName = (fmt({ timeZoneName: 'long' }).formatToParts(new Date()).find(function (p) { return p.type === 'timeZoneName'; }) || {}).value || zone;
  var days = [], chosenDay = 0, chosen = null;

  function finish(title, text, plain) {
    $('doneTitle').textContent = title;
    $('doneText').textContent = text;
    $('tick').hidden = Boolean(plain);
    show('done');
  }
  var NO_CALENDAR = ['Thanks, we\\u2019ll be in touch by email.', ''];

  function renderSlots() {
    var box = $('slots');
    box.textContent = '';
    var list = days[chosenDay] ? days[chosenDay].slots : [];
    $('empty').hidden = list.length > 0;
    list.forEach(function (iso) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.textContent = clock.format(new Date(iso));
      b.setAttribute('aria-pressed', String(iso === chosen));
      b.onclick = function () {
        chosen = iso;
        $('picked').innerHTML = '<span>Your pick</span>';
        $('picked').appendChild(document.createTextNode(full.format(new Date(iso))));
        $('confirm').disabled = false;
        $('error').hidden = true;
        renderSlots();
      };
      box.appendChild(b);
    });
  }

  function renderDays() {
    var box = $('days');
    box.textContent = '';
    days.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'day';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === chosenDay));
      var first = new Date(d.slots[0]);
      b.innerHTML = '<small></small><b></b>';
      b.firstChild.textContent = weekday.format(first);
      b.lastChild.textContent = dayNum.format(first);
      b.onclick = function () { chosenDay = i; renderDays(); renderSlots(); };
      box.appendChild(b);
    });
  }

  function showSlots(data) {
    var byDay = {};
    (data.slots || []).forEach(function (iso) {
      var key = dayKey.format(new Date(iso));
      (byDay[key] = byDay[key] || []).push(iso);
    });
    days = Object.keys(byDay).map(function (k) { return { slots: byDay[k].sort() }; }).sort(function (a, b) { return a.slots[0] < b.slots[0] ? -1 : 1; });
    if (!days.length) return finish('No times are open right now', 'We\\u2019ll email you to find a time that works.', true);
    if (email) { $('who').textContent = 'Booking for ' + email; $('who').hidden = false; }
    $('zone').textContent = 'Times are shown in your time zone: ' + zoneName + '.';
    renderDays();
    renderSlots();
    show('picker');
  }

  function handle(data) {
    if (data.status === 'rejected') return finish(NO_CALENDAR[0], NO_CALENDAR[1], true);
    if (data.status === 'booked') return finish('You\\u2019re booked', 'Booked for ' + full.format(new Date(data.slot)) + '. Invite on its way.');
    if (data.status === 'picked') return finish('We have your time', 'You picked ' + full.format(new Date(data.slot)) + '. We\\u2019ll confirm by email shortly.');
    if (data.status === 'ok') return showSlots(data);
    finish('Something went wrong', data.error || 'Please refresh the page to try again.', true);
  }

  // If the form has not reached us yet, try again every second for 5 seconds, then show times anyway.
  function load(attempt) {
    fetch('/api/slots?sid=' + encodeURIComponent(sid) + (attempt >= 5 ? '&force=1' : ''))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.status === 'unknown' && attempt < 5) return setTimeout(function () { load(attempt + 1); }, 1000);
        handle(data);
      })
      .catch(function () { finish('Something went wrong', 'Please refresh the page to try again.', true); });
  }

  $('confirm').onclick = function () {
    if (!chosen) return;
    var button = this;
    button.disabled = true;
    button.textContent = 'Confirming…';
    fetch('/api/slot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: sid, slot: chosen, tz: zone }) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var when = full.format(new Date(data.slot || chosen));
        if (data.status === 'booked') {
          return finish('You\\u2019re booked', (data.changed ? 'That time was just taken, so we booked the next free one. ' : '') + 'Booked for ' + when + '. Invite on its way.');
        }
        if (data.status === 'hold') return finish('Thanks, we have your time', 'You picked ' + when + '. Our team will confirm shortly.');
        if (data.status === 'received') return finish('Thanks, we have your time', 'You picked ' + full.format(new Date(data.requested || chosen)) + '. We\\u2019ll confirm by email shortly.');
        if (data.status === 'rejected') return finish(NO_CALENDAR[0], NO_CALENDAR[1], true);
        button.disabled = false;
        button.textContent = 'Confirm';
        $('error').textContent = data.error || 'Could not save your time. Please try again.';
        $('error').hidden = false;
      })
      .catch(function () {
        button.disabled = false;
        button.textContent = 'Confirm';
        $('error').textContent = 'Could not save your time. Please check your connection and try again.';
        $('error').hidden = false;
      });
  };

  if (!sid) return finish('This link is incomplete', 'Please go back to the form and submit it again.', true);
  load(0);
})();
</script>
</body>
</html>`;

export async function GET() {
  return new Response(page(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Nothing is loaded from anywhere else.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    },
  });
}
