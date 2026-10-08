import { rules } from '../lib/rules.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formId = (env) => /tally\.so\/(?:r|embed)\/([A-Za-z0-9]+)/.exec(env.TALLY_FORM_EMBED ?? env.TALLY_FORM_URL ?? '')?.[1] ?? rules.form.tally_form_id;

// GET /demo: the one page a visitor sees. The Tally form and the time picker (/book) sit side by
// side from the start. The visitor picks a time and submits the form; the page then tells the
// picker which submission the time belongs to, and the picker books it.
const page = (id) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(rules.form.title)}</title>
<style>
  html, body { margin: 0; background: #fff; }
  main { max-width: 1240px; margin: 0 auto; padding: 0 8px; display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 8px; align-items: start; }
  iframe { display: block; width: 100%; border: 0; height: ${Number(rules.form.embed_height)}px; }
  #times { margin-top: 84px; height: ${Number(rules.form.embed_height) - 84}px; }
  /* On a narrow screen everything stacks: the times first, then the form with its Submit button. */
  @media (max-width: 900px) {
    main { grid-template-columns: minmax(0, 1fr); }
    #times { order: -1; margin-top: 8px; height: 560px; }
  }
  @media (max-width: 640px) { #step { height: ${Number(rules.form.embed_height_narrow)}px; } }
</style>
</head>
<body>
<main>
  <iframe id="step" title="${esc(rules.form.title)}" src="https://tally.so/embed/${esc(id)}?transparentBackground=1"></iframe>
  <iframe id="times" title="Pick a time for your demo" src="/book?pre=1"></iframe>
</main>
<script>
(function () {
  var times = document.getElementById('times');
  var done = false;
  window.addEventListener('message', function (event) {
    if (done || event.origin !== 'https://tally.so') return;
    var data = event.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
    if (!data || data.event !== 'Tally.FormSubmitted' || !data.payload) return;
    var p = data.payload;
    var sid = p.id || p.submissionId || p.responseId;
    if (!sid) return;
    var email = '';
    (p.fields || []).forEach(function (f) {
      var value = f && f.answer ? f.answer.value : null;
      if (!email && f && f.type === 'INPUT_EMAIL' && typeof value === 'string') email = value;
    });
    done = true;
    // The picker books the time already chosen, or asks for one now.
    times.contentWindow.postMessage({ type: 'form-submitted', sid: sid, email: email }, location.origin);
    times.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
})();
</script>
</body>
</html>`;

export async function GET() {
  return new Response(page(formId(process.env)), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Only the Tally form and our own time picker may be shown in the frames.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src https://tally.so 'self'; base-uri 'none'; form-action 'none'",
    },
  });
}
