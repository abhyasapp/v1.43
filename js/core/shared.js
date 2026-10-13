/* ═══════════════════════════════════════════════════════════════════════
   SHARED.JS — small utilities used by index.html, user.html (via
   app.js/objective.js/subjective.js), and admin.html.

   Loaded via <script src="shared.js"> on every page, BEFORE the page's
   own logic. Classic script, no modules — the project intentionally has
   no build step.

   Exposes on window (implicitly, since everything is top-level):
     esc()                — HTML-escape
     escAttrJs()          — dual-layer escape for data-on-click="...('${x}')"
     pluralize()          — "1 file" vs "5 files"
     computeAccessLevel() — canonical trial/permanent/expired/pending
     getStoredTheme()     — 'dark' | 'light'
     applyTheme()
     toggleTheme()
     togglePwVisibility() — the eye icon in every password field
     pingBackend()        — one-shot reachability check against GAS
     THEME_KEY            — 'abhyas_theme', shared storage key

   ── v1.43: the reporting system moved to its own folder ─────────────
   The following names USED to live in this file. They now belong to
   report/report-shared.js and report/report-matching.js, which load
   right after this file on every page:

     report/report-shared.js
         REPORT_REASONS, REPORT_REASON_LABELS, REPORT_SECTIONS,
         REPORT_SECTION_LABELS, REPORT_QUEUE_KEY, REPORT_QUEUE_MAX,
         reportQueueAdd, reportQueueRemove, reportSection, qReportHtml

     report/report-matching.js
         qTokens, qSimilarity, qUidParts, qOptionsSimilarity,
         sameQuestionAfterCorrection, matchCorrectedQuestion,
         questionContentChanged, applyQuestionCorrection,
         applyCorrectionsToList

   Do not re-add any of them here — tests/check.js has a guard (group
   'No duplicated report helpers') that fails the build if a name
   appears in more than one file.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Escape a value for safe interpolation into data-on-click="...('${value}')"
 * style attributes — i.e. inside an HTML double-quoted attribute that
 * itself contains a JS single-quoted string literal.
 *
 * esc() alone isn't enough here: the browser HTML-decodes the attribute
 * value BEFORE handing it to the JS parser, so a plain HTML-escaped `"`
 * would still close the JS string wrapper (after decoding) even though
 * it looks "escaped". This handles both layers in the right order.
 *
 * Note: this does NOT escape newlines. Every value ever passed here
 * (usernames, ids, chapter names) is either validated upstream against
 * a scheme with no newline character, or comes from a JSON question file
 * that never emits literal newlines inside string fields. If a call
 * site ever passes unvalidated free text, this MUST be extended —
 * a literal newline inside a JS single-quoted string literal is a
 * syntax error, not an injection vector, but it breaks the page.
 */
function escAttrJs(s) {
  /* 1) escape for a single-quoted JS string, 2) HTML-escape everything, because the browser decodes the attribute
     BEFORE running the handler (so an unescaped &#39; would turn back into a quote and end the string). */
  const js = String(s == null ? '' : s).replace(/[\\'"]/g, c => '\\' + c);
  return js.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * HTML-escape a value for safe interpolation into innerHTML.
 *
 * Note the explicit null check — the naive `s || ''` coerces 0 and
 * false to '' which would silently drop legitimate zero values
 * (e.g. a counter that reads 0).
 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

/**
 * "1 question" vs "5 questions". Several chapters/subtopics genuinely
 * have exactly 1 question, so the singular case isn't theoretical.
 * Pass an explicit pluralWord for irregular nouns.
 */
function pluralize(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`;
}

/**
 * Computes a user's access level from a checkSession / login / signup
 * API response. This is now the ONLY place this logic lives — it was
 * previously duplicated character-for-character in index.html's
 * handleUserAuth() and app.js's AUTH._buildSession(), a real risk
 * since the two copies had no mechanism forcing them to stay identical.
 *
 * @param {object} res    The API response (checkSession / login / signup).
 * @param {object} [user] Optional — pass res.user explicitly if the
 *                        caller has already destructured it; otherwise
 *                        this reads res.user itself.
 */
function computeAccessLevel(res, user) {
  user = user || res.user || {};
  return {
    level: res.permanentAccess || user.status === 'active' ? 'permanent'
           : res.isTrial ? 'trial'
           : res.needsPayment && user.status === 'payment_pending' ? 'pending_review'
           : res.needsPayment ? 'expired'
           : 'unknown',
    trialExpiresAt: res.trialExpiresAt || user.trialExpiresAt,
    permanent: !!(res.permanentAccess || user.status === 'active'),
    accessType: res.accessType || user.accessType || 'permanent',
    accessExpiresAt: res.accessExpiresAt || user.accessExpiresAt || ''
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   DARK MODE — shared across index.html and admin.html.

   user.html/app.js ships its OWN complete dark mode (the .dark class
   on <body>, UI.theme(), and a real toggle button in the top bar) —
   this does NOT touch or duplicate that. It exists only so index.html
   and admin.html, which don't load app.js, can offer the same toggle
   and land on the SAME preference.

   To stay compatible with the existing implementation this deliberately
   mirrors app.js's _save()/_load(): the same localStorage key, the same
   JSON.stringify/parse encoding, and the same mechanism — toggling a
   .dark class rather than a data-* attribute, so design-system.css's
   shared dark rules and user.html's own .dark{} block can both key off
   plain ".dark".

   index.html and admin.html apply the class to <html> (via an inline
   pre-paint script in <head>, and via applyTheme() below); user.html
   applies it to <body> via app.js's UI.theme() and the inline boot
   code. Both work with design-system.css's shared .dark rules.
   ═══════════════════════════════════════════════════════════════════════ */
const THEME_KEY = 'abhyas_theme';

function getStoredTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v === 'dark' || v === 'light') return v;
    }
  } catch (e) { /* unavailable or malformed — fall through */ }
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

function toggleTheme() {
  const next = getStoredTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch (e) { /* non-fatal */ }
  applyTheme(next);
  return next;
}

/* ═══════════════════════════════════════════════════════════════════════
   PASSWORD-VISIBILITY TOGGLE
   Expects the button to be the input's previous sibling inside a
   .pw-field wrapper, containing a single <i class="ph ph-eye|ph-eye-slash">
   icon. See design-system.css's .pw-field / .pw-toggle rules.
   ═══════════════════════════════════════════════════════════════════════ */
function togglePwVisibility(btn) {
  const input = btn.previousElementSibling;
  if (!input || input.tagName !== 'INPUT') return;
  const icon = btn.querySelector('i');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  if (icon) icon.className = showing ? 'ph ph-eye' : 'ph ph-eye-slash';
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  btn.setAttribute('aria-pressed', String(!showing));
}

/* ═══════════════════════════════════════════════════════════════════════
   CRASH REPORTS (v1.15)
   Sends a SHORT technical note (page, error message, script name, app version,
   browser) to the Activity log so you find out about bugs from real phones.
   At most 5 per page load, never any answers or personal details.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  let sent = 0;
  const seen = {};
  function report(msg, src, line) {
    try {
      if (sent >= 5) return;
      msg = String(msg || '').slice(0, 200);
      if (!msg || msg === 'Script error.' || seen[msg]) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const url = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || '';
      if (!url) return;
      seen[msg] = 1; sent++;
      fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, keepalive: true,
        body: JSON.stringify({
          action: 'logClientError', msg: msg,
          src: String(src || '').split('/').pop().slice(0, 80), line: line || 0,
          page: (location.pathname || '').split('/').pop() || 'index',
          v: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''),
          ua: (navigator.userAgent || '').slice(0, 80)
        })
      }).catch(function () {});
    } catch (e) { /* never let the reporter itself throw */ }
  }
  window.addEventListener('error', function (e) { report(e.message, e.filename, e.lineno); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report(r && r.message ? r.message : String(r), 'promise', 0);
  });
})();

/* ═══════════════════════════════════════════════════════════════════════
   BACKEND REACHABILITY
   One-shot ping used by index.html's checkNet and app.js's NETCHECK.
   Each page owns its own online-state variable and UI updates — this
   just answers "can we reach the backend right now, yes or no".
   ═══════════════════════════════════════════════════════════════════════ */
async function pingBackend(gasUrl, timeoutMs = 12000) {
  if (!gasUrl) return false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${gasUrl}?action=ping&_=${Date.now()}`, {
      signal: ctrl.signal,
      cache: 'no-store'
    });
    clearTimeout(to);
    if (!r.ok) return false;
    const data = await r.json();
    return !!(data.pong || data.success);
  } catch (e) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   60-DAY SPRINT PLANNER (pure function, unit-tested in tests/check.js)

   Three phases over 60 days:
     Days  1-35  LEARN  cover every topic once, 40 questions a day
     Days 36-52  DRILL  attack weak chapters, 80 questions a day
     Days 53-60  MOCK   one full paper a day plus review, 100 questions

   opts: { startISO:'YYYY-MM-DD', now:Date, totalTopics, coveredTopics,
           dueReview, questionsToday }
   Day numbers use calendar days (not 24 h blocks), so they stay correct
   across clock changes and late-night study.
   ═══════════════════════════════════════════════════════════════════════ */
const SPRINT_DAYS = 60, SPRINT_LEARN_END = 35, SPRINT_DRILL_END = 52;

function sprintDayNumber(startISO, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startISO || ''));
  if (!m) return 0;
  const a = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000) + 1;
}

function sprintPlan(o) {
  if ((o.totalQ | 0) > 0) return sprintPlanQ(o);
  const day = sprintDayNumber(o.startISO, o.now || new Date());
  if (!day || day < 1) return { state: 'notstarted' };
  if (day > SPRINT_DAYS) return { state: 'finished', day };

  const total = Math.max(1, o.totalTopics | 0);
  const covered = Math.min(total, Math.max(0, o.coveredTopics | 0));
  const due = Math.max(0, o.dueReview | 0);
  const doneQ = Math.max(0, o.questionsToday | 0);
  const left = total - covered;

  let phase, label, qTarget, mins, newTopics = 0, mock = false, expectedPct;
  if (day <= SPRINT_LEARN_END) {
    phase = 'learn'; label = 'Learn'; qTarget = 40; mins = 90;
    newTopics = Math.min(left, Math.max(1, Math.ceil(left / (SPRINT_LEARN_END - day + 1))));
    expectedPct = day / SPRINT_LEARN_END;
  } else if (day <= SPRINT_DRILL_END) {
    phase = 'drill'; label = 'Drill'; qTarget = 80; mins = 120;
    newTopics = Math.min(left, Math.ceil(left / (SPRINT_DRILL_END - day + 1)));
    expectedPct = 1;
  } else {
    phase = 'mock'; label = 'Mock'; qTarget = 100; mins = 150; mock = true;
    expectedPct = 1;
  }

  const actualPct = covered / total;
  const gap = actualPct - expectedPct;
  const pace = gap >= 0.05 ? 'ahead' : gap <= -0.1 ? 'behind' : 'on-track';

  return {
    state: 'active', day, daysLeft: SPRINT_DAYS - day, phase, label,
    qTarget, mins, newTopics, mock, due, doneQ,
    qRemaining: Math.max(0, qTarget - doneQ),
    covered, total, pace,
    coveragePct: Math.round(actualPct * 100),
    goalMet: doneQ >= qTarget && due === 0
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   SIZE-BASED SPRINT PLAN (v1.33, pure, unit-tested)

   The fixed 40 / 80 / 100 targets ignored how much content there is. This plan is built from the real numbers:

     totalQ      questions in Level 7 + GK            attemptedQ  questions answered at least once
     wrongQ      attempted, latest answer wrong       dueReview   wrong-bank reviews due today
     offDays     dates the student took off           examISO     exam date (shortens the plan, never lengthens it)
     secPerQ     average seconds per question         paperSize   questions in one mock paper

   Learn  : remaining new questions / remaining working days, plus reviews.
   Catch-up: every 7th learn day has no new quota. It pays back any backlog, or is a light review and weak-spot day.
   Drill  : (remaining new + wrong) / days left, between 40 and 150, plus reviews.
   Mock   : one full paper a day.
   Pace is judged in QUESTIONS attempted, not chapters touched.
   Reviews are capped (30, or 15 when behind) so they cannot crowd out new work.
   ═══════════════════════════════════════════════════════════════════════ */
const SPRINT_CATCHUP_EVERY = 7, SPRINT_REVIEW_CAP = 30, SPRINT_REVIEW_CAP_BEHIND = 15;
const SPRINT_FEAS_OK = 120, SPRINT_FEAS_TIGHT = 200, SPRINT_MIN_DAYS = 14;

function sprintIsoAdd(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

/* 60 days, or fewer when the exam is sooner. Day 1 is the start date; the last plan day is the day before the exam. */
function sprintTotalDays(startISO, examISO) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startISO || ''));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(examISO || ''));
  if (!a || !b) return SPRINT_DAYS;
  const gap = Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
  return Math.max(SPRINT_MIN_DAYS, Math.min(SPRINT_DAYS, gap));
}

function sprintPlanQ(o) {
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  const D = sprintTotalDays(o.startISO, o.examISO);
  const day = sprintDayNumber(o.startISO, o.now || new Date());
  if (!day || day < 1) return { state: 'notstarted' };
  if (day > D) return { state: 'finished', day, totalDays: D };

  const learnEnd = Math.round(D * 35 / 60), drillEnd = Math.round(D * 52 / 60);
  const off = new Set(Array.isArray(o.offDays) ? o.offDays : []);
  const isOff = d => off.has(sprintIsoAdd(o.startISO, d - 1));
  const isCatch = d => d <= learnEnd && d % SPRINT_CATCHUP_EVERY === 0;
  const working = (a, b, skipCatch) => { let n = 0; for (let d = a; d <= b; d++) if (!isOff(d) && !(skipCatch && isCatch(d))) n++; return n; };

  const totalQ = Math.max(1, o.totalQ | 0);
  const attempted = clamp(0, totalQ, o.attemptedQ | 0);
  const wrongQ = clamp(0, attempted, o.wrongQ | 0);
  const due = Math.max(0, o.dueReview | 0), doneQ = Math.max(0, o.questionsToday | 0);
  const remainingNew = totalQ - attempted;
  const secPerQ = clamp(20, 180, Number(o.secPerQ) || 60);
  const paper = (o.paperSize | 0) > 0 ? (o.paperSize | 0) : 100;

  const learnWork = Math.max(1, working(1, learnEnd, true));
  const expectedPct = day <= learnEnd ? Math.min(1, working(1, Math.min(day, learnEnd), true) / learnWork) : 1;
  const actualPct = attempted / totalQ, gap = actualPct - expectedPct;
  const pace = gap >= 0.05 ? 'ahead' : gap <= -0.1 ? 'behind' : 'on-track';
  const reviewQ = Math.min(due, pace === 'behind' ? SPRINT_REVIEW_CAP_BEHIND : SPRINT_REVIEW_CAP);

  const learnDaysLeft = day <= learnEnd ? working(day, learnEnd, true) : 0;
  const drillDaysLeft = day <= drillEnd ? Math.max(1, working(Math.max(day, learnEnd + 1), drillEnd, false)) : 0;
  let phase = day <= learnEnd ? 'learn' : day <= drillEnd ? 'drill' : 'mock';
  let label = phase === 'learn' ? 'Learn' : phase === 'drill' ? 'Drill' : 'Mock';
  let newQ = 0, qTarget = 0, mock = false, catchup = false, rest = false, backlogQ = 0;

  if (isOff(day)) {
    rest = true; label = 'Rest day';
  } else if (phase === 'learn') {
    if (isCatch(day)) {
      catchup = true; label = 'Catch-up';
      backlogQ = Math.max(0, Math.round(totalQ * expectedPct) - attempted);
      newQ = Math.min(backlogQ, remainingNew, 150);
      qTarget = newQ > 0 ? newQ + reviewQ : reviewQ + 20;
    } else {
      newQ = (learnDaysLeft > 0 && remainingNew > 0) ? Math.ceil(remainingNew / learnDaysLeft) : 0;
      qTarget = newQ + reviewQ;
      if (!qTarget) qTarget = 20;
    }
  } else if (phase === 'drill') {
    const need = remainingNew + wrongQ;
    newQ = Math.min(remainingNew, Math.ceil(remainingNew / drillDaysLeft));
    qTarget = clamp(40, 150, Math.ceil(need / drillDaysLeft) + reviewQ);
  } else {
    mock = true; qTarget = paper;
  }

  const raw = rest ? 0 : mock ? qTarget * secPerQ / 60 + 30 : Math.max(15, qTarget * secPerQ / 60);
  const mins = rest ? 0 : Math.ceil(raw / 5) * 5;

  const needDays = phase === 'learn' ? learnDaysLeft : drillDaysLeft;
  const neededPerDay = remainingNew > 0 && needDays > 0 ? Math.ceil(remainingNew / needDays) : (remainingNew > 0 ? remainingNew : 0);
  const feasibility = remainingNew === 0 ? 'done' : neededPerDay <= SPRINT_FEAS_OK ? 'ok' : neededPerDay <= SPRINT_FEAS_TIGHT ? 'tight' : 'unrealistic';

  return {
    state: 'active', sized: true, day, totalDays: D, daysLeft: D - day, learnEnd, drillEnd,
    phase, label, qTarget, mins, newQ, reviewQ, backlogQ, catchup, rest, mock, due, doneQ,
    qRemaining: Math.max(0, qTarget - doneQ), newTopics: 0,
    covered: attempted, total: totalQ, pace, coveragePct: Math.round(actualPct * 100),
    goalMet: rest ? true : doneQ >= qTarget,
    neededPerDay, feasibility, learnDaysLeft
  };
}

/* What to do today, as a list. */
function sprintToday(plan, chapters) {
  if (!plan || plan.state !== 'active') return [];
  if (plan.rest) return [{ kind: 'rest', label: 'Rest day. Nothing planned.', questions: 0 }];
  const items = [];
  if (plan.mock) {
    items.push({ kind: 'mock', label: 'Full mock paper', questions: plan.qTarget });
    if (plan.reviewQ > 0) items.push({ kind: 'review', label: 'Review missed questions', questions: plan.reviewQ });
    return items;
  }
  if (plan.reviewQ > 0) items.push({ kind: 'review', label: 'Review missed questions', questions: plan.reviewQ });
  const list = (Array.isArray(chapters) ? chapters : []).filter(c => c && c.total > 0);

  const fill = (cands, budget, kind, need) => {
    for (const c of cands) {
      if (budget <= 0) break;
      const take = Math.min(need(c), budget);
      if (take > 0) { items.push({ kind, lv: c.lv, ch: c.ch, label: c.label, questions: take }); budget -= take; }
    }
    return budget;
  };
  const newNeed = c => Math.max(0, c.total - c.attempted);

  const newPick = budget => {
    const pool = list.filter(c => newNeed(c) > 0);
    pool.sort((a, b) => (b.attempted > 0) - (a.attempted > 0));
    const gk = pool.filter(c => c.lv === 'gk'), l7 = pool.filter(c => c.lv !== 'gk');
    const gkRem = gk.reduce((n, c) => n + newNeed(c), 0), l7Rem = l7.reduce((n, c) => n + newNeed(c), 0);
    let gkBudget = gkRem > 0 ? Math.min(gkRem, Math.max(Math.min(10, budget), Math.round(budget * gkRem / (gkRem + l7Rem)))) : 0;
    let l7Budget = budget - gkBudget;
    l7Budget = fill(l7, l7Budget, 'new', newNeed);
    gkBudget = fill(gk, gkBudget + l7Budget, 'new', newNeed);
    if (gkBudget > 0) fill(l7.filter(c => !items.some(i => i.lv === c.lv && i.ch === c.ch && i.kind === 'new')), gkBudget, 'new', newNeed);
  };
  const weakPick = budget => {
    const need = c => newNeed(c) + Math.max(0, c.wrong || 0);
    const pool = list.filter(c => c.state !== 'complete' && need(c) > 0);
    pool.sort((a, b) => (a.attempted ? (a.accuracy == null ? 0.5 : a.accuracy) : 0.6) - (b.attempted ? (b.accuracy == null ? 0.5 : b.accuracy) : 0.6));
    fill(pool, budget, 'weak', need);
  };

  const budget = Math.max(0, plan.qTarget - plan.reviewQ);
  if (plan.phase === 'learn' && !plan.catchup) newPick(plan.newQ);
  else if (plan.catchup && plan.newQ > 0) newPick(plan.newQ);
  else weakPick(budget);
  return items;
}

/* ═══════════════════════════════════════════════════════════════════════
   EXAM TIMER WARNINGS (v1.33, pure, unit-tested)
   Announce at 10, 5 and 1 minute left. A warning is skipped when the whole exam is not longer than it (a 5-minute
   quiz has no "10 minutes left"), and one that was already passed when the exam was resumed is not announced late.
   `warned` is the list of thresholds already handled; the caller keeps the returned list.
   ═══════════════════════════════════════════════════════════════════════ */
const EXAM_WARN_AT = [600, 300, 60];
function examWarning(left, total, warned) {
  const done = Array.isArray(warned) ? warned.slice() : [];
  let fire = 0;
  EXAM_WARN_AT.forEach(t => {
    if (left <= t && done.indexOf(t) === -1) {
      done.push(t);
      if (t < total && left > t - 5) fire = t;
    }
  });
  return { fire, warned: done };
}
/* ═══════════════════════════════════════════════════════════════════════
   MASTERY (v1.33, pure, unit-tested)

   A chapter is COMPLETE only when all three hold:
     1. every question in it has been attempted at least once
     2. accuracy on those questions is at least 85%
     3. nothing from it is left in the wrong bank
   "Accuracy" uses each question's LATEST result (coverage bits: '1' right, '2' wrong), not lifetime totals, so an
   old mistake you have since corrected stops counting against you.

   The 60-day sprint is planned over Level 7 and General Knowledge only (Level 5 is a separate paper).
   ═══════════════════════════════════════════════════════════════════════ */
const MASTERY_THRESHOLD = 0.85;
const SPRINT_LEVELS = ['level7', 'gk'];

function sprintRefs(refs) {
  return (Array.isArray(refs) ? refs : []).filter(r => r && SPRINT_LEVELS.indexOf(r.lv) !== -1);
}

/* o = { fids:[file ids of the chapter], fcount:{fid: questionCount}, cov:{fid:{p}}, wr:[wrong-bank items], threshold }
   -> { state, attempted, right, wrong, total, accuracy (0..1 or null), wrongLeft, needs:[...] }
   state: 'unknown' (sizes not known yet), 'not-started', 'in-progress', 'complete' */
function chapterMastery(o) {
  o = o || {};
  const fids = Array.isArray(o.fids) ? o.fids : [];
  const fcount = o.fcount || {}, cov = o.cov || {};
  const need = Number(o.threshold) > 0 ? Number(o.threshold) : MASTERY_THRESHOLD;
  let total = 0, right = 0, wrong = 0, known = 0;
  fids.forEach(f => {
    const n = fcount[f];
    if (n != null) { total += Number(n) || 0; known++; }
    const p = (cov[f] && cov[f].p) ? String(cov[f].p) : '';
    for (let i = 0; i < p.length; i++) { if (p[i] === '1') right++; else if (p[i] === '2') wrong++; }
  });
  const attempted = right + wrong;
  const set = new Set(fids);
  const wrongLeft = (Array.isArray(o.wr) ? o.wr : []).filter(q => q && set.has(q.fileId) && !q._withdrawn).length;
  const accuracy = attempted ? right / attempted : null;
  const out = { attempted, right, wrong, total, accuracy, wrongLeft, needs: [] };
  if (!fids.length || known < fids.length || total <= 0) { out.state = 'unknown'; return out; }
  if (!attempted) { out.state = 'not-started'; out.needs.push('Start practising this chapter'); return out; }
  if (attempted < total) out.needs.push((total - attempted) + ' question' + (total - attempted === 1 ? '' : 's') + ' not attempted yet');
  if (accuracy < need) out.needs.push('Accuracy ' + Math.round(accuracy * 100) + '% (need ' + Math.round(need * 100) + '%)');
  if (wrongLeft > 0) out.needs.push(wrongLeft + ' in your wrong bank');
  out.state = out.needs.length ? 'in-progress' : 'complete';
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   MULTI-DEVICE PROGRESS MERGE (pure function, unit-tested)

   When two devices save progress, the server no longer lets the later save
   silently erase the earlier one. The loser gets the other copy back and
   merges it with its own using this function, then saves again.

   Rules: nothing is ever lost by a merge.
     sessions   union by timestamp, newest first, max 50
     chapStats  keep the record with more attempts
     cov        union of answered-question bits, max of counters
     bk/fl/wr   union by uid; this device's copy wins a conflict
     stk        union of study days
     qnotes     union; this device wins a conflict
     sprint     this device's start date, else the other's
   ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   RESET MARKERS (v1.33)

   A merge only ever adds, so a reset done on one device would be undone by the next sync. A reset therefore
   leaves a small marker (a timestamp) that travels with the data. Anything saved BEFORE the marker is ignored
   by every merge; anything saved after it is kept.

     resets = { all: ms,            reset all progress (sessions, chapter stats, coverage, wrong bank, study days, totals)
                wr: ms,             reset only the wrong bank
                exams: ms,          reset only exam history
                sprint: ms,         the 60-day sprint was restarted (the later start date wins)
                ch: { key: ms },    one chapter, key = file id or chapter name
                rm: { uid: ms } }   one question removed from the wrong bank

   Bookmarks, flags, notes, PDFs and reports are never touched by a reset.
   Wrong-bank items carry `_addedAt`, coverage entries carry `t`; a copy without one counts as older than any marker.
   ═══════════════════════════════════════════════════════════════════════ */
function mergeResets(a, b) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const A = isObj(a) ? a : {}, B = isObj(b) ? b : {};
  const out = {};
  ['all', 'wr', 'exams', 'sprint'].forEach(k => {
    const v = Math.max(Number(A[k]) || 0, Number(B[k]) || 0);
    if (v > 0) out[k] = v;
  });
  ['ch', 'rm'].forEach(k => {
    const m = {};
    [A[k], B[k]].forEach(src => {
      if (!isObj(src)) return;
      Object.keys(src).forEach(id => { const v = Number(src[id]) || 0; if (v > (m[id] || 0)) m[id] = v; });
    });
    let keys = Object.keys(m);
    if (!keys.length) return;
    if (keys.length > 400) { keys.sort((x, y) => m[y] - m[x]); keys = keys.slice(0, 400); }
    const t = {}; keys.forEach(id => { t[id] = m[id]; }); out[k] = t;
  });
  /* `un` lists markers that were undone (the 24-hour undo, or "Clear all" undone). A marker whose time is in
     that list is ignored everywhere, so an undo is not reversed by another device that still carries the marker. */
  const un = Array.from(new Set((Array.isArray(A.un) ? A.un : []).concat(Array.isArray(B.un) ? B.un : [])
    .map(Number).filter(v => v > 0))).sort((x, y) => y - x).slice(0, 40);
  if (un.length) {
    const lifted = v => un.indexOf(v) !== -1;
    ['all', 'wr', 'exams', 'sprint'].forEach(k => { if (lifted(out[k])) delete out[k]; });
    ['ch', 'rm'].forEach(k => {
      if (!out[k]) return;
      Object.keys(out[k]).forEach(id => { if (lifted(out[k][id])) delete out[k][id]; });
      if (!Object.keys(out[k]).length) delete out[k];
    });
    out.un = un;
  }
  return out;
}

function applyResets(d, rs) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const arr = v => Array.isArray(v) ? v : [];
  if (!isObj(d) || !isObj(rs) || !Object.keys(rs).length) return d;
  const allT = Number(rs.all) || 0, wrT = Number(rs.wr) || 0, exT = Number(rs.exams) || 0;
  const ch = isObj(rs.ch) ? rs.ch : {}, rm = isObj(rs.rm) ? rs.rm : {};
  const chT = k => (k ? (Number(ch[k]) || 0) : 0);
  const out = Object.assign({}, d);

  if (isObj(d.prog)) {
    const prog = Object.assign({}, d.prog);
    prog.sessions = arr(d.prog.sessions).filter(s => {
      if (!s) return false;
      const at = Number(s.at) || 0;
      if (allT && at <= allT) return false;
      if (exT && s.mode === 'exam' && at <= exT) return false;
      const t = Math.max(chT(s.fid), chT(s.chapter));
      return !(t && at <= t);
    });
    const gen = Number(d.prog.gen) || 0;
    if (allT && gen < allT) { prog.total = 0; prog.correct = 0; }
    if (allT) prog.gen = Math.max(gen, allT);
    out.prog = prog;
  }
  if (isObj(d.chapStats)) {
    const cs = {};
    Object.keys(d.chapStats).forEach(k => {
      const rec = d.chapStats[k], at = Number(rec && rec.lastAt) || 0;
      if (allT && at <= allT) return;
      const t = chT(k);
      if (t && at <= t) return;
      cs[k] = rec;
    });
    out.chapStats = cs;
  }
  if (isObj(d.cov)) {
    const cv = {};
    Object.keys(d.cov).forEach(fid => {
      const rec = d.cov[fid], at = Number(rec && rec.t) || 0;
      if (allT && at <= allT) return;
      const t = chT(fid);
      if (t && at <= t) return;
      cv[fid] = rec;
    });
    out.cov = cv;
  }
  if (Array.isArray(d.wr)) {
    out.wr = d.wr.filter(x => {
      if (!x) return false;
      const at = Number(x._addedAt) || 0;
      if (allT && at <= allT) return false;
      if (wrT && at <= wrT) return false;
      const r = Number(rm[x.uid]) || 0;
      if (r && at <= r) return false;
      const t = chT(x.fileId);
      return !(t && at <= t);
    });
  }
  if (allT && isObj(d.stk)) {
    const cut = localISODate(new Date(allT));
    const days = arr(d.stk.days).filter(x => String(x) >= cut);
    out.stk = Object.assign({}, d.stk, { days, last: days.length ? days[days.length - 1] : '' });
  }
  return out;
}

function mergeSyncData(local, remote) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const arr = v => Array.isArray(v) ? v : [];
  const L0 = isObj(local) ? local : {};
  const R0 = isObj(remote) ? remote : {};
  const resets = mergeResets(L0.resets, R0.resets);
  const L = applyResets(L0, resets);
  const R = applyResets(R0, resets);

  const unionBy = (a, b, keyOf) => {
    const seen = new Set(), out = [];
    arr(a).concat(arr(b)).forEach(x => {
      if (x === null || x === undefined) return;
      const k = keyOf(x);
      if (seen.has(k)) return;
      seen.add(k); out.push(x);
    });
    return out;
  };
  const uidOf = x => (x && x.uid !== undefined) ? 'u:' + x.uid : 'j:' + JSON.stringify(x);

  const lp = isObj(L.prog) ? L.prog : {}, rp = isObj(R.prog) ? R.prog : {};
  const sessKey = s => (s && s.at) ? 'a:' + s.at + ':' + (s.fid || s.chapter || '') : 'j:' + JSON.stringify(s);
  const sessions = unionBy(lp.sessions, rp.sessions, sessKey)
    .sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0)).slice(0, 50);
  /* Running totals must never go down. Each side's counter already includes its own sessions, so it is
     topped up with the sessions only the OTHER side has; the larger result wins. */
  const sum = (list, f) => list.reduce((n, x) => n + (Number(x && x[f]) || 0), 0);
  const onlyIn = (a, b) => { const k = new Set(arr(b).map(sessKey)); return arr(a).filter(x => !k.has(sessKey(x))); };
  const total = Math.max((Number(lp.total) || 0) + sum(onlyIn(rp.sessions, lp.sessions), 'total'), (Number(rp.total) || 0) + sum(onlyIn(lp.sessions, rp.sessions), 'total'));
  const correct = Math.max((Number(lp.correct) || 0) + sum(onlyIn(rp.sessions, lp.sessions), 'correct'), (Number(rp.correct) || 0) + sum(onlyIn(lp.sessions, rp.sessions), 'correct'));
  const badges = Object.assign({}, isObj(rp.badges) ? rp.badges : {}, isObj(lp.badges) ? lp.badges : {});
  const prog = Object.assign({}, rp, lp, { sessions, total, correct, badges });
  const gen = Math.max(Number(lp.gen) || 0, Number(rp.gen) || 0); if (gen) prog.gen = gen;

  const chapStats = Object.assign({}, isObj(R.chapStats) ? R.chapStats : {});
  Object.keys(isObj(L.chapStats) ? L.chapStats : {}).forEach(k => {
    const l = L.chapStats[k], r = chapStats[k];
    if (!r || (Number(l && l.attempted) || 0) >= (Number(r && r.attempted) || 0)) chapStats[k] = l;
  });

  const cov = {};
  const lc = isObj(L.cov) ? L.cov : {}, rc = isObj(R.cov) ? R.cov : {};
  new Set(Object.keys(lc).concat(Object.keys(rc))).forEach(fid => {
    const a = isObj(lc[fid]) ? lc[fid] : null, b = isObj(rc[fid]) ? rc[fid] : null;
    const tt = Math.max(Number(a && a.t) || 0, Number(b && b.t) || 0);
    if (!a || !b) { const o = a || b; cov[fid] = { p: String(o.p || ''), a: Number(o.a) || 0, c: Number(o.c) || 0 }; if (tt) cov[fid].t = tt; return; }
    const pa = String(a.p || ''), pb = String(b.p || ''); let p = '';
    for (let i = 0, n = Math.max(pa.length, pb.length); i < n; i++) { const x = pa[i] || '0'; p += x !== '0' ? x : (pb[i] || '0'); }
    cov[fid] = { p, a: Math.max(Number(a.a) || 0, Number(b.a) || 0), c: Math.max(Number(a.c) || 0, Number(b.c) || 0) };
    if (tt) cov[fid].t = tt;
  });

  const ls = isObj(L.stk) ? L.stk : {}, rs = isObj(R.stk) ? R.stk : {};
  const days = Array.from(new Set(arr(ls.days).concat(arr(rs.days)))).sort().slice(-400);
  const stk = Object.assign({}, rs, ls, { days, last: days.length ? days[days.length - 1] : (ls.last || rs.last || '') });

  const qnotes = Object.assign({}, isObj(R.qnotes) ? R.qnotes : {}, isObj(L.qnotes) ? L.qnotes : {});
  const okDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  let sprint = okDate(L.sprint) ? L.sprint : (okDate(R.sprint) ? R.sprint : '');
  if (resets.sprint && okDate(L.sprint) && okDate(R.sprint)) sprint = L.sprint > R.sprint ? L.sprint : R.sprint;

  return {
    prog, chapStats, cov, stk, qnotes, sprint, resets,
    bk: unionBy(L.bk, R.bk, uidOf),
    fl: unionBy(L.fl, R.fl, uidOf),
    wr: unionBy(L.wr, R.wr, uidOf)
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   frameThrottle: run immediately, then at most once per animation frame.

   Rendering functions such as HOME.render() and HOME.updateBadges() are
   called from many places, often several times in one burst (for example
   once per wrong answer when an exam is submitted). Each call rebuilt the
   same DOM. The first call still runs synchronously, so code that reads the
   DOM straight afterwards is unaffected; repeat calls in the same frame
   collapse into ONE trailing call that uses the latest arguments.
   ═══════════════════════════════════════════════════════════════════════ */
function frameThrottle(fn, schedule) {
  const next = schedule || ((typeof requestAnimationFrame === 'function')
    ? (f => requestAnimationFrame(f))
    : (f => setTimeout(f, 16)));
  let busy = false, queued = false, lastArgs = null, lastThis = null;
  function run(self, args) {
    busy = true;
    try { return fn.apply(self, args); }
    finally {
      next(() => {
        busy = false;
        if (queued) {
          queued = false;
          const a = lastArgs, s = lastThis;
          lastArgs = lastThis = null;
          try { run(s, a); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
        }
      });
    }
  }
  return function throttled(...args) {
    if (busy) { queued = true; lastArgs = args; lastThis = this; return undefined; }
    return run(this, args);
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   PROGRESS INSIGHTS (pure data, unit-tested): everything the Progress
   charts draw comes from here, so the maths is testable without a browser.

   sessions : S.prog.sessions   [{at, total, correct, durationSec, ...}]
   studyDays: S.stk.days        ['YYYY-MM-DD', ...]
   now      : Date
   ═══════════════════════════════════════════════════════════════════════ */
function localISODate(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function insightsData(sessions, studyDays, now) {
  const list = Array.isArray(sessions) ? sessions.filter(s => s && Number(s.at) > 0) : [];
  const days = new Set(Array.isArray(studyDays) ? studyDays : []);
  const today = new Date((now || new Date()).getTime());
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const byDate = {};
  list.forEach(s => {
    const k = localISODate(new Date(Number(s.at)));
    const r = byDate[k] || (byDate[k] = { q: 0, correct: 0, secs: 0 });
    r.q += Math.max(0, Number(s.total) || 0);
    r.correct += Math.max(0, Number(s.correct) || 0);
    r.secs += Math.max(0, Number(s.durationSec) || 0);
  });

  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() - i);
    const k = localISODate(d), r = byDate[k] || { q: 0, correct: 0, secs: 0 };
    last14.push({ date: k, label: WD[d.getDay()], q: r.q, correct: r.correct, mins: Math.round(r.secs / 60), isToday: i === 0 });
  }

  const recent = list.filter(s => Number(s.total) > 0).slice(0, 12).reverse()
    .map(s => ({ at: Number(s.at), pct: Math.max(0, Math.min(100, Math.round(Number(s.pct) || ((Number(s.correct) || 0) / Number(s.total)) * 100))) }));

  const week = last14.slice(7), prev = last14.slice(0, 7);
  const sum = (a, f) => a.reduce((n, x) => n + f(x), 0);
  const acc = a => { const q = sum(a, x => x.q); return q ? Math.round(sum(a, x => x.correct) / q * 100) : null; };
  const accWeek = acc(week), accPrev = acc(prev);

  const cells = [];
  for (let i = 83; i >= 0; i--) {
    const d = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() - i);
    const k = localISODate(d);
    cells.push({ date: k, active: days.has(k) || !!(byDate[k] && byDate[k].q > 0), q: byDate[k] ? byDate[k].q : 0 });
  }
  let streak = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i].active) streak++;
    else if (i === cells.length - 1) continue;   /* today not studied yet doesn't break the streak */
    else break;
  }

  return {
    last14, recent, cells, streak,
    weekQuestions: sum(week, x => x.q), prevWeekQuestions: sum(prev, x => x.q),
    weekMinutes: sum(week, x => x.mins),
    activeDays12w: cells.filter(c => c.active).length,
    accWeek, accPrev,
    accDelta: (accWeek !== null && accPrev !== null) ? accWeek - accPrev : null,
    bestDay: last14.reduce((b, x) => x.q > b.q ? x : b, { q: 0, date: '', label: '' })
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   STUDY PDFs (pure helpers, unit-tested): labels, filtering, "new" tracking.
   ═══════════════════════════════════════════════════════════════════════ */
const STUDYDOC_LABELS = {
  'model-answer': 'Model answers', 'notes': 'Notes', 'past-paper': 'Past papers', 'syllabus': 'Syllabus', 'other': 'Other'
};

/* opts: { cat: 'all' | category, q: search text }. Order is preserved. */
function studyDocsFilter(docs, opts) {
  const o = opts || {};
  const cat = o.cat && o.cat !== 'all' ? String(o.cat) : '';
  const words = String(o.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (Array.isArray(docs) ? docs : []).filter(d => {
    if (!d) return false;
    if (cat && d.category !== cat) return false;
    if (!words.length) return true;
    const hay = ((d.title || '') + ' ' + (d.description || '') + ' ' + (STUDYDOC_LABELS[d.category] || '')).toLowerCase();
    return words.every(w => hay.indexOf(w) !== -1);
  });
}

/* Documents the student has not opened the list for yet. */
function studyDocsNewIds(docs, seenIds) {
  const seen = new Set(Array.isArray(seenIds) ? seenIds : []);
  return (Array.isArray(docs) ? docs : []).filter(d => d && d.id && !seen.has(d.id)).map(d => d.id);
}

/* [{category, label, count}] for the chips, only categories that have documents. */
function studyDocsCategories(docs) {
  const counts = {};
  (Array.isArray(docs) ? docs : []).forEach(d => { if (d) counts[d.category] = (counts[d.category] || 0) + 1; });
  return Object.keys(STUDYDOC_LABELS).filter(c => counts[c]).map(c => ({ category: c, label: STUDYDOC_LABELS[c], count: counts[c] }));
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/* Published documents attached to one written-answer chapter (newest order preserved). */
function studyDocsForChapter(docs, chapterId) {
  const id = String(chapterId || '');
  if (!id) return [];
  return (Array.isArray(docs) ? docs : []).filter(d => d && d.chapterId === id);
}

/* Chapter name for a subjective chapter id ('' when unknown). */
function subjChapterName(chapterId) {
  try {
    const c = (window.SUBJECTIVE_CHAPTERS || []).find(x => x.id === chapterId);
    return c ? c.name : '';
  } catch (e) { return ''; }
}

/* ═══════════════════════════════════════════════════════════════════════
   CLOUD COPY ENCODING (v1.32)
   The server keeps one cell of at most ~45,000 characters per student. A large
   missed-question bank does not fit as plain JSON, and the old code solved that by
   CUTTING the lists down (a bank of 250 became 20) and, in the merge path, writing
   that cut-down copy back over the student's real data on the device.

   Now the full copy is compressed (gzip, then base64, prefixed "gz1:") so it fits.
   Plain JSON is still sent when it is small enough, so older app versions can read it.
   Nothing is ever trimmed any more: if even the compressed copy is too large the
   cloud save is skipped and the device keeps everything.
   ═══════════════════════════════════════════════════════════════════════ */
const SYNC_GZ_PREFIX = 'gz1:';

async function _bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function _b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function _pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/* json -> string to store. Returns null when compression is unavailable and the plain copy is too big. */
async function syncEncode(json, ceiling) {
  if (json.length <= ceiling) return json;
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const gz = await _pipe(new TextEncoder().encode(json), new CompressionStream('gzip'));
    const out = SYNC_GZ_PREFIX + await _bytesToB64(gz);
    return out.length <= ceiling ? out : null;
  } catch (e) { return null; }
}

/* stored string -> object. Accepts plain JSON and "gz1:" copies. Throws on anything else. */
async function syncDecode(text) {
  const s = String(text == null ? '' : text);
  if (s.indexOf(SYNC_GZ_PREFIX) !== 0) return JSON.parse(s);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read the compressed cloud copy. Update the browser.');
  const bytes = await _pipe(_b64ToBytes(s.slice(SYNC_GZ_PREFIX.length)), new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* ═══════════════════════════════════════════════════════════════════════
   v1.43: the two blocks that USED to sit here moved out.

   The QUESTION CORRECTIONS helpers (qTokens, qSimilarity, qUidParts,
   qOptionsSimilarity, sameQuestionAfterCorrection, matchCorrectedQuestion,
   questionContentChanged, applyQuestionCorrection, applyCorrectionsToList)
   now live in report/report-matching.js.

   The report section and offline queue helpers (reportSection,
   REPORT_REASONS, REPORT_QUEUE_MAX, reportQueueAdd, reportQueueRemove)
   now live in report/report-shared.js.

   Both files load right after this one on every page. Do not re-add them
   here: tests/check.js has a guard ('No duplicated report helpers') that
   fails the build if any of those names appears in more than one file.
   ═══════════════════════════════════════════════════════════════════════ */
   /* ═══════════════════════════════════════════════════════════════════════
   LOKSEWA MARK SCHEME (pure, unit-tested)

   Loksewa-style marking (+1 right, -0.2 wrong, 0 skipped) and the group / chapter
   breakdown belong to exactly three places: the weekly test, the daily 75-mark paper
   and the hourly 50-question sprint. Everything else (chapter practice, mixed, review)
   shows a plain percentage.

   The daily paper is built from a SCHEME the admin sets from the PSC syllabus: groups, the
   marks each group carries, and which chapters feed it. The app never invents weights.
   Until an admin sets one, the paper is 25 General Knowledge + the 50 Level 7 marks split by topic
   (LEVEL7_TOPIC_MARKS), or, when no chapter is loaded, 25 + 50 drawn evenly across chapters.
   ═══════════════════════════════════════════════════════════════════════ */
const LOKSEWA_NEGATIVE = 0.2;

function isLoksewaFormat(scope) {
  return !!(scope && (scope.weeklyId || scope.loksewaMock || scope.hourlySprint));
}

/* The 50 Level 7 marks, topic by topic (the syllabus table: Engineering Survey 7 ... Professional Practices 3).
   `match` finds a loaded chapter by its NAME (the real chapter ids come from Drive, so ids cannot be fixed here).
   `rank` is the order names are tried in when a name could fit two topics ("Reinforced Concrete" -> Concrete
   Technology, not Structural Analysis). */
const LEVEL7_TOPIC_MARKS = [
  { name: 'Engineering Survey',       marks: 7, rank: 6, match: /survey/ },
  { name: 'Construction Materials',   marks: 6, rank: 3, match: /construction material|building material/ },
  { name: 'Geotechnical Engineering', marks: 6, rank: 5, match: /geotech|soil/ },
  { name: 'Construction Management',  marks: 6, rank: 4, match: /construction manag|project manag/ },
  { name: 'Structural Analysis',      marks: 5, rank: 10, match: /structur/ },
  { name: 'Concrete Technology',      marks: 5, rank: 1, match: /concrete/ },
  { name: 'Estimating and Costing',   marks: 5, rank: 2, match: /estimat|costing/ },
  { name: 'Engineering Drawing',      marks: 4, rank: 7, match: /drawing|drafting/ },
  { name: 'Engineering Economics',    marks: 3, rank: 8, match: /economic/ },
  { name: 'Professional Practices',   marks: 3, rank: 9, match: /professional/ }
];

/* chapters: [{ id, name }] of Level 7 -> the default scheme with the 50 marks split by topic (GK stays 25), or null
   when no chapter name fits any topic. A topic with no matching chapter loses its group; its marks go to an
   "Other Level 7 chapters" group when there are chapters no topic claimed, otherwise the paper is that much shorter. */
function loksewaTopicScheme(chapters) {
  const ident = v => /^[A-Za-z0-9_.-]{1,40}$/.test(String(v));
  const list = (Array.isArray(chapters) ? chapters : []).filter(c => c && ident(c.id));
  if (!list.length) return null;
  const norm = t => ' ' + String(t == null ? '' : t).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const order = LEVEL7_TOPIC_MARKS.map((t, i) => i).sort((a, b) => LEVEL7_TOPIC_MARKS[a].rank - LEVEL7_TOPIC_MARKS[b].rank);
  const owner = {};
  list.forEach(c => {
    const n = norm(c.name || c.id);
    for (const i of order) if (LEVEL7_TOPIC_MARKS[i].match.test(n)) { owner[c.id] = i; break; }
  });
  const hit = new Set(Object.keys(owner).map(k => owner[k]));
  if (!hit.size) return null;
  const groups = [{ key: 'g0', name: 'General Knowledge', marks: 25, level: 'gk', chapters: [] }];
  let spare = 0;
  LEVEL7_TOPIC_MARKS.forEach((t, i) => {
    if (!hit.has(i)) { spare += t.marks; return; }
    groups.push({ key: 'g' + groups.length, name: t.name, marks: t.marks, level: 'level7',
      chapters: list.filter(c => owner[c.id] === i).map(c => String(c.id)) });
  });
  if (spare && list.some(c => owner[c.id] === undefined)) {
    groups.push({ key: 'g' + groups.length, name: 'Other Level 7 chapters', marks: spare, level: 'level7', chapters: [] });
  }
  const total = groups.reduce((n, g) => n + g.marks, 0);
  return { version: 1, isDefault: true, topicBased: true, total, groups };
}

function defaultLoksewaScheme() {
  /* Level 7 chapters that are loaded right now (student page and admin console). Nothing loaded -> the plain split. */
  try {
    if (typeof ChapterData !== 'undefined' && ChapterData && typeof ChapterData.allFileRefs === 'function') {
      const seen = {}, chs = [];
      ChapterData.allFileRefs().forEach(r => {
        if (r.lv !== 'level7' || seen[r.ch]) return;
        seen[r.ch] = 1;
        let name = ''; try { name = ChapterData.chapterName(r.lv, r.ch) || ''; } catch (e) {}
        chs.push({ id: r.ch, name: name || r.chName || r.ch });
      });
      const t = loksewaTopicScheme(chs);
      if (t) return t;
    }
  } catch (e) {}
  return { version: 1, isDefault: true, total: 75, groups: [
    { key: 'g0', name: 'General Knowledge', marks: 25, level: 'gk', chapters: [] },
    { key: 'g1', name: 'Level 7 Civil Engineering', marks: 50, level: 'level7', chapters: [] }
  ] };
}

/* Anything stored or typed -> a valid scheme, or the default. Never throws. */
function normalizeLoksewaScheme(raw) {
  try {
    const o = (typeof raw === 'string') ? JSON.parse(raw || 'null') : raw;
    if (!o || !Array.isArray(o.groups)) return defaultLoksewaScheme();
    const ident = v => /^[A-Za-z0-9_.-]{1,40}$/.test(String(v));
    const groups = [];
    o.groups.slice(0, 20).forEach(g => {
      if (!g) return;
      const name = String(g.name == null ? '' : g.name).replace(/\s+/g, ' ').trim().slice(0, 60);
      const marks = Math.round(Number(g.marks));
      const level = String(g.level == null ? '' : g.level).trim();
      if (!name || !isFinite(marks) || marks < 1 || marks > 100 || !ident(level)) return;
      const chapters = (Array.isArray(g.chapters) ? g.chapters : []).map(String).filter(ident).slice(0, 60);
      groups.push({ key: 'g' + groups.length, name, marks, level, chapters });
    });
    const total = groups.reduce((n, g) => n + g.marks, 0);
    if (!groups.length || total < 1 || total > 200) return defaultLoksewaScheme();
    return { version: 1, isDefault: false, total, groups };
  } catch (e) { return defaultLoksewaScheme(); }
}

/* Which group does a chapter belong to? A group that names the chapter wins over a catch-all group for the level. */
function loksewaGroupFor(scheme, lv, ch) {
  const gs = (scheme && scheme.groups) || [];
  return gs.find(g => g.level === lv && g.chapters.length && g.chapters.indexOf(ch) !== -1)
      || gs.find(g => g.level === lv && !g.chapters.length) || null;
}

function _shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/* pool: [{ q, lv, ch }]. Draws each group's marks from its own chapters, taking turns between chapters so no
   chapter dominates or goes missing. Returns { questions, perGroup, shortfalls, total }. */
function composeLoksewaPaper(scheme, pool, rng) {
  const sch = scheme || defaultLoksewaScheme();
  const byGroup = {}; sch.groups.forEach(g => { byGroup[g.key] = {}; });
  (pool || []).forEach(p => {
    const g = loksewaGroupFor(sch, p.lv, p.ch);
    if (!g) return;
    (byGroup[g.key][p.ch] = byGroup[g.key][p.ch] || []).push(p.q);
  });
  const questions = [], perGroup = {}, shortfalls = [];
  sch.groups.forEach(g => {
    const buckets = _shuffled(Object.keys(byGroup[g.key]), rng).map(ch => _shuffled(byGroup[g.key][ch], rng));
    const picked = [];
    for (let round = 0; picked.length < g.marks; round++) {
      let any = false;
      for (const b of buckets) { if (picked.length >= g.marks) break; if (round < b.length) { picked.push(b[round]); any = true; } }
      if (!any) break;
    }
    perGroup[g.key] = picked.length;
    if (picked.length < g.marks) shortfalls.push({ key: g.key, name: g.name, wanted: g.marks, got: picked.length });
    picked.forEach(q => questions.push(q));
  });
  return { questions, perGroup, shortfalls, total: sch.total };
}

/* Result-page rows: one per group of the scheme (target = its marks), plus "Other" for questions outside it. */
function loksewaGroupRows(scheme, items, useSchemeMarks) {
  const sch = scheme || defaultLoksewaScheme();
  const rows = {}; sch.groups.forEach(g => { rows[g.key] = { key: g.key, name: g.name, target: g.marks, total: 0, correct: 0, wrong: 0, skipped: 0 }; });
  items.forEach(it => {
    const g = (it.lv != null) ? loksewaGroupFor(sch, it.lv, it.ch) : null;
    const k = g ? g.key : 'other';
    const r = rows[k] || (rows[k] = { key: 'other', name: 'Other', target: 0, total: 0, correct: 0, wrong: 0, skipped: 0 });
    r.total++;
    if (it.state === 'skipped') r.skipped++; else if (it.state === 'correct') r.correct++; else r.wrong++;
  });
  return Object.keys(rows).map(k => rows[k]).filter(r => r.total > 0).map(r => {
    const score = Math.round((r.correct - r.wrong * LOKSEWA_NEGATIVE) * 10) / 10;
    const out = useSchemeMarks && r.target ? r.target : r.total;
    return Object.assign({}, r, { score, outOf: out, pct: out ? Math.round((score / out) * 100) : 0 });
  });
}

/* Rows typed into the admin editor -> '' when fine, else what to fix. A group with no chapters ticked takes every chapter
   of its level that no other group names, so one catch-all per level is fine; the same chapter in two groups is not. */
function loksewaSchemeConflict(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'Add at least one group.';
  const named = {}, catchAll = {};
  for (const r of rows) {
    const name = String(r && r.name || '').trim(), m = Number(r && r.marks);
    if (!name) return 'Every group needs a name.';
    if (!isFinite(m) || m < 1 || m > 100 || Math.floor(m) !== m) return 'Marks must be whole numbers from 1 to 100 (' + name + ').';
    const chs = Array.isArray(r.chapters) ? r.chapters : [];
    if (!chs.length) {
      if (catchAll[r.level]) return 'Two groups use every chapter of the same level ("' + catchAll[r.level] + '" and "' + name + '"). Tick chapters for one of them.';
      catchAll[r.level] = name;
    }
    for (const c of chs) {
      const k = r.level + '|' + c;
      if (named[k]) return 'A chapter can only belong to one group ("' + named[k] + '" and "' + name + '" both have it).';
      named[k] = name;
    }
  }
  return '';
}
