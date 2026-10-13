/* ═══════════════════════════════════════════════════════════════════════
   report/report-shared.js — constants and pure helpers shared by the
   student page (userreport.js) and the admin console (adminreport.js).

   Loaded by BOTH pages, right after js/core/shared.js and before the
   page's own modules. Classic script, no modules. Nothing here touches
   the DOM, the network or storage.

   When linking in, DELETE the copies that still live in:
     js/core/shared.js
         REPORT_REASONS, REPORT_QUEUE_MAX, reportQueueAdd,
         reportQueueRemove, reportSection
     js/app/main/01-state-storage-helpers.js
         qReportHtml
     js/app/objective.js
         the report-button call sites (they keep working through the
         compat shims that userreport.js installs on QUIZ)
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── The six reasons a student can pick, and the words each one shows. ──
   REPORT_REASONS must stay identical to QREPORT_REASONS in gas/report.gs.
   The server rejects anything not in its own list with "Invalid report
   reason." tests/check.js compares the two lists, so a change here that
   is not matched there fails the build. */
const REPORT_REASONS = ['wrong_answer','unclear','typo','incomplete','image_problem','other'];
const REPORT_REASON_LABELS = {
  wrong_answer:  'The marked answer looks wrong',
  unclear:       'The question or options are unclear',
  typo:          'Typo or formatting issue',
  incomplete:    'The question is incomplete',
  image_problem: 'An image, table or diagram is missing or wrong',
  other:         'Something else'
};

/* ── Everywhere a question can be reported from. REPORT_SECTIONS must
   stay identical to QREPORT_SECTIONS in gas/report.gs; a new entry has
   to be added in both. tests/check.js compares the two lists. ── */
const REPORT_SECTIONS = [
  'practice','exam','daily-paper','weekly','hourly',
  'results','review-missed','review-saved','review-flagged','other'
];
const REPORT_SECTION_LABELS = {
  practice:          'Chapter practice',
  exam:              'Timed exam',
  'daily-paper':     'Daily 75-mark paper',
  weekly:            'Weekly test',
  hourly:            'Hourly 50',
  results:           'Results review',
  'review-missed':   'Missed list',
  'review-saved':    'Saved list',
  'review-flagged':  'Flagged list',
  other:             'Other'
};

/* Which section a report came from. `scope` is S.quiz.scope, `mode` is
   S.quiz.mode. `where` overrides both when the caller already knows (the
   review lists pass it directly). */
function reportSection(scope, mode, where) {
  if (where) return where;
  const sc = scope || {};
  if (sc.weeklyId) return 'weekly';
  if (sc.loksewaMock) return 'daily-paper';
  if (sc.hourlySprint) return 'hourly';
  return mode === 'exam' ? 'exam' : 'practice';
}

/* ── Offline report queue (localStorage). A report written with no signal
   is kept here and sent the next time the app opens online. Same question
   + same reason collapses to one entry; the queue is capped. ── */
const REPORT_QUEUE_KEY = 'abhyas_report_queue';
const REPORT_QUEUE_MAX = 20;

function reportQueueAdd(queue, report, now) {
  const q = Array.isArray(queue) ? queue.filter(x => x && x.uid) : [];
  if (!report || !report.uid || REPORT_REASONS.indexOf(report.reason) === -1) return q;
  const note = String(report.note || '').slice(0, 500);
  const dup = q.findIndex(x => x.uid === report.uid && x.reason === report.reason);
  const entry = Object.assign({}, report, { note, queuedAt: Number(now) || Date.now() });
  if (dup !== -1) q[dup] = entry; else q.push(entry);
  return q.slice(-REPORT_QUEUE_MAX);
}
function reportQueueRemove(queue, report) {
  return (Array.isArray(queue) ? queue : []).filter(x =>
    !(x && report && x.uid === report.uid && x.reason === report.reason));
}

/* ── The ⚠ button. Shown everywhere a question appears, except a question
   from the student's own local bank (nothing for the admin to correct
   there). Both arguments are escaped before they touch the HTML, so a
   caller that forgets gets safe output rather than an injection. ── */
function qReportHtml(q, call, label) {
  if (!q || !q.uid) return '';
  if (q.fileId === 'local' || String(q.uid).indexOf('local_') === 0) return '';
  const rawCall  = String(call == null ? '' : call);
  const rawLabel = String(label || 'Report an issue with this question');
  const safeCall = (typeof window.escAttrJs === 'function')
    ? window.escAttrJs(rawCall)
    : rawCall.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const safeLabel = (typeof window.esc === 'function')
    ? window.esc(rawLabel)
    : rawLabel.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  return '<button type="button" class="ib" data-on-click="' + safeCall + '" ' +
    'title="Report an issue with this question" ' +
    'aria-label="' + safeLabel + '">' +
    '<i class="ph ph-warning-circle"></i></button>';
}

/* ── Export format for the corrections JSON. This is the DEFAULT a reader
   uses when the file it opens has no version field; the exporter in
   gas/report.gs writes its own value into every file it produces, and
   that value is the authoritative one. Bump the default only when the
   shape of a correction entry changes in a way a reader has to branch
   on. ── */
const CORRECTIONS_EXPORT_DEFAULT_VERSION = 1;

/* An entry's questionIndex may legitimately be null — an old correction
   made before the question was assigned a stable position in its file.
   Such an entry is valid input and is simply not indexed by file+index
   (see indexCorrections). An entry's uid is required, because the
   server-side exporter always writes one and any consumer that wants to
   cross-reference a correction against the wrong bank will key on it. */
function validateCorrectionEntry(c) {
  if (!c || typeof c !== 'object') return 'Entry is not an object.';
  if (!c.fileId || typeof c.fileId !== 'string') return 'Missing fileId.';
  if (!c.uid || typeof c.uid !== 'string') return 'Missing uid.';
  if (c.questionIndex !== null && c.questionIndex !== undefined &&
      (!isFinite(Number(c.questionIndex)) || Number(c.questionIndex) < 0)) {
    return 'questionIndex must be null or a non-negative number.';
  }
  if (!c.after || typeof c.after !== 'object') return 'Missing corrected (after) snapshot.';
  if (!String(c.after.question || '').trim()) return 'Corrected snapshot has no question text.';
  if (!Array.isArray(c.after.options)) return 'Corrected snapshot has no options array.';
  return '';
}

/* Parse + validate an exported corrections file. Returns
   { ok, entries, version } or { ok:false, entries: [], error }. */
function parseCorrectionsExport(raw) {
  let doc;
  try { doc = (typeof raw === 'string') ? JSON.parse(raw) : raw; }
  catch (e) { return { ok: false, entries: [], error: 'Not valid JSON.' }; }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.corrections)) {
    return { ok: false, entries: [], error: 'Missing corrections array.' };
  }
  const entries = [];
  for (let i = 0; i < doc.corrections.length; i++) {
    const bad = validateCorrectionEntry(doc.corrections[i]);
    if (bad) return { ok: false, entries: [], error: 'Entry ' + (i + 1) + ': ' + bad };
    entries.push(doc.corrections[i]);
  }
  return {
    ok: true, entries,
    version: Number(doc.version) || CORRECTIONS_EXPORT_DEFAULT_VERSION
  };
}

/* Index entries by fileId -> { index -> entry }. Used by any screen that
   needs to look up "was this question corrected?" in O(1). Entries with
   a null questionIndex are skipped, as documented on
   validateCorrectionEntry. */
function indexCorrections(entries) {
  const out = {};
  (Array.isArray(entries) ? entries : []).forEach(c => {
    const idx = (c.questionIndex !== null && c.questionIndex !== undefined)
      ? Number(c.questionIndex) : null;
    if (idx === null || !isFinite(idx)) return;
    out[c.fileId] = out[c.fileId] || {};
    out[c.fileId][idx] = c;
  });
  return out;
}

/* Classic-script const/let are NOT attached to window; expose the ones
   that handler text (data-on-click) may need. The function declarations
   above are already globals in a classic script, so they are not listed
   here. */
window.REPORT_REASONS = REPORT_REASONS;
window.REPORT_REASON_LABELS = REPORT_REASON_LABELS;
window.REPORT_SECTIONS = REPORT_SECTIONS;
window.REPORT_SECTION_LABELS = REPORT_SECTION_LABELS;
window.REPORT_QUEUE_KEY = REPORT_QUEUE_KEY;
window.REPORT_QUEUE_MAX = REPORT_QUEUE_MAX;
window.CORRECTIONS_EXPORT_DEFAULT_VERSION = CORRECTIONS_EXPORT_DEFAULT_VERSION;