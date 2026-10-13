/* ═══════════════════════════════════════════════════════════════════════
   report/userreport.js — the student side of the reporting system.

   Loaded by user.html AFTER js/app/user-page.js. Classic script, no
   modules. Exposes window.USER_REPORT and installs compatibility shims
   on QUIZ so callers that still say QUIZ._reportX keep working.

   ── WHEN LINKING IN, DELETE THESE BLOCKS ──────────────────────────────
   From js/app/objective.js — the whole reporting block:
       QUIZ._openReport     = function(q, ctx) { … }
       QUIZ._submitReport   = async function() { … }
       QUIZ._reportCurrent  = function() { … }
       QUIZ._reportExam     = function(qi) { … }
       QUIZ._reportResult   = function(i) { … }
       QUIZ._queueReport    = function(rep, reason, note) { … }
       QUIZ._rqLoad         = function() { … }
       QUIZ._rqSave         = function(list) { … }
       QUIZ.flushReports    = async function() { … }
       QUIZ._rep            = null;    (the field itself)

   From js/app/user-page.js — the whole correction-polling block:
       window.CORRECTIONS = { … }                (starts at SEEN_KEY)
       UI.onEnter('home', () => { … CORRECTIONS.check() … });
       window.addEventListener('online', () => { … CORRECTIONS.check(true) … });
       setTimeout(() => { … CORRECTIONS.check(true) … }, 6000);
       setTimeout(() => { … flushReports() … }, 8000);

   If those are not deleted, every event fires two independent pollers
   (the new one and the old one) with separate running-flags, so both
   proceed. On a slow line this doubles the request count and can race
   two QUIZ._fetch calls for the same file into QDB.

   ── COMPAT SHIMS INSTALLED AT THE BOTTOM ──────────────────────────────
   QUIZ._openReport, QUIZ._submitReport, QUIZ._reportCurrent,
   QUIZ._reportExam, QUIZ._reportResult, QUIZ.flushReports.
   These exist so existing call sites inside objective.js keep working.
   Delete them once the objective.js bodies are gone.

   ── USES ──────────────────────────────────────────────────────────────
   From report/report-shared.js:  reportSection, reportQueueAdd,
     reportQueueRemove, REPORT_QUEUE_KEY, REPORT_REASON_LABELS,
     REPORT_REASONS
   From report/report-matching.js: applyCorrectionsToList
   From the app:  S, _load, _save, toast, openMod, closeMod, netFetch,
     APPS, QUIZ, esc, REV, HOME, UI, PSYNC, APP_VERSION, ChapterData,
     WEEKLY, QDB, normQ, LS, AUTH.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

const $ = id => document.getElementById(id);

/* ── the sheet ─────────────────────────────────────────────────────── */

let _rep = null;
let _submitting = false;

function _openSheet(q, ctx) {
  if (!q) { toast('No question to report.'); return; }
  if (!q.uid || q.fileId === 'local' || String(q.uid).indexOf('local_') === 0) {
    toast('Questions from your own question bank cannot be reported.');
    return;
  }
  _rep = {
    q: q,
    section: (ctx && ctx.section) || 'other',
    chosen: (ctx && ctx.chosen != null) ? ctx.chosen : null
  };
  const reasons = REPORT_REASONS.map(r =>
    '<option value="' + r + '">' + esc(REPORT_REASON_LABELS[r] || r) + '</option>'
  ).join('');
  openMod('Report an issue',
    '<div class="t-foot mb2" style="max-height:4.5em;overflow:hidden">' +
      esc(String(q.q || '').slice(0, 160)) +
    '</div>' +
    '<div class="sf"><label for="qr-reason">What\'s wrong?</label>' +
      '<select id="qr-reason">' + reasons + '</select>' +
    '</div>' +
    '<div class="sf"><label for="qr-note">Details (optional)</label>' +
      '<textarea id="qr-note" rows="3" maxlength="500" ' +
        'placeholder="Anything that would help, e.g. which option you think is correct">' +
      '</textarea>' +
    '</div>' +
    '<button class="btn" id="qr-send-btn">Send Report</button>'
  );
  const b = $('qr-send-btn');
  if (b) b.onclick = () => _submit();
}

function _body(rep, reason, note) {
  const q = rep.q;
  return {
    action: 'reportQuestion',
    username: S.user.username, token: S.user.token,
    uid: q.uid,
    reason: reason,
    note: note,
    questionSnapshot: (q.q || '').slice(0, 1000),
    optionsSnapshot: (q.options || []).slice(0, 6),
    correctIndex: isNaN(Number(q.correct)) ? '' : Number(q.correct),
    chosenIndex: rep.chosen == null ? '' : rep.chosen,
    section: rep.section,
    appVersion: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : ''
  };
}

async function _submit() {
  if (_submitting) return;
  _submitting = true;
  try {
    const rep = _rep;
    const q = rep && rep.q;
    if (!q) { closeMod(); return; }
    const reason = ($('qr-reason') && $('qr-reason').value) || 'other';
    const note = (($('qr-note') && $('qr-note').value) || '').trim().slice(0, 500);
    if (!S.user || !S.user.username || !S.user.token) {
      toast('Please sign in again to report a question.'); return;
    }
    closeMod();
    if (!S.online || S.forcedOffline) { _queue(rep, reason, note); return; }
    toast('Sending report\u2026');
    try {
      const r = await netFetch(APPS, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(_body(rep, reason, note))
      }, 15000);
      const res = await r.json();
      if (res && res.success) toast('\u2705 ' + (res.message || 'Thanks, report sent.'));
      else toast('\u274c ' + ((res && res.error) || 'Could not send report.'));
    } catch (e) {
      _queue(rep, reason, note);
    }
  } finally {
    _submitting = false;
  }
}

/* ── offline queue ─────────────────────────────────────────────────── */

function _rqLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(REPORT_QUEUE_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function _rqSave(list) {
  try { localStorage.setItem(REPORT_QUEUE_KEY, JSON.stringify(list)); } catch (e) {}
}

function _queue(rep, reason, note) {
  const q = rep.q;
  const item = {
    uid: q.uid, reason: reason, note: note,
    section: rep.section, chosen: rep.chosen,
    q: (q.q || '').slice(0, 1000),
    options: (q.options || []).slice(0, 6),
    correct: (isNaN(Number(q.correct)) ? '' : Number(q.correct))
  };
  _rqSave(reportQueueAdd(_rqLoad(), item, Date.now()));
  toast('Saved. Your report will be sent when you are back online.', 5000);
}

let _flushBusy = false;
async function _flush() {
  if (_flushBusy) return;
  if (!S.user || !S.user.username || !S.user.token) return;
  if (!S.online || S.forcedOffline) return;
  let list = _rqLoad();
  if (!list.length) return;
  _flushBusy = true;
  let sent = 0;
  try {
    for (const it of list.slice()) {
      const rep = {
        q: { uid: it.uid, q: it.q, options: it.options, correct: it.correct },
        chosen: it.chosen, section: it.section
      };
      try {
        const r = await netFetch(APPS, {
          method: 'POST', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(_body(rep, it.reason, it.note))
        }, 15000);
        const res = await r.json();
        if (res.success || /invalid|already|missing/i.test(String((res && res.error) || ''))) {
          list = reportQueueRemove(list, it);
          _rqSave(list);
          if (res.success) sent++;
        } else if (/too many/i.test(String((res && res.error) || ''))) {
          break;
        }
      } catch (e) { break; }
    }
  } finally {
    _flushBusy = false;
  }
  if (sent) {
    toast('\u2705 ' + sent + ' queued report' +
      (sent === 1 ? '' : 's') + ' sent. Thank you.');
  }
}

/* ── corrections polling ─────────────────────────────────────────────
   The student's device learns about every corrected file, then fetches
   the fresh copy first, then swaps the cache and rewrites the saved
   lists. Fetch-first-then-swap so a mid-poll network drop never leaves
   the student with no cache and no new copy.

   Partial failures: if the server returns a set of corrected files and
   only some of them apply cleanly, _CORR_SEEN advances to just before
   the OLDEST failed timestamp. The next poll therefore asks the server
   about the files that failed, not about the whole set again. Without
   this, a single flaky file would force every successful file to be
   re-fetched on every subsequent poll, forever.
   ─────────────────────────────────────────────────────────────────── */

const _CORR_SEEN      = 'abhyas_corr_seen';
const _CORR_CHECKED   = 'abhyas_corr_checked';
const _CORR_MIN_GAP   = 10 * 60 * 1000;        /* server-side floor */
const _CORR_FIRST_WIN = 30 * 24 * 60 * 60 * 1000;
let _corrRunning = false;

function _corrNum(k) { try { return Number(localStorage.getItem(k)) || 0; } catch (e) { return 0; } }
function _corrSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }

async function _keysFor(fid) {
  const keys = new Set();
  try {
    ChapterData.allFileRefs().forEach(r => {
      if (r.fid === fid && r.key) keys.add(r.key);
    });
  } catch (e) {}
  try {
    (WEEKLY.sets || []).forEach(s => {
      if (s.fileId === fid) {
        keys.add('weekly_' + s.id);
        keys.add('weekly_' + s.id + '_retake');
      }
    });
  } catch (e) {}
  try {
    (await QDB.keys()).forEach(k => {
      if (String(k).indexOf(fid) !== -1) keys.add(k);
    });
  } catch (e) {}
  return [...keys];
}

/* Fetch the fresh file FIRST. Only if that succeeds do we purge the
   sibling caches and rewrite the saved lists. If the fetch fails, we
   leave the old cache in place and let the next poll retry. */
async function _applyCorrections(fid) {
  const out = { updated: 0, moved: 0, merged: 0, withdrawn: 0 };
  const keys = await _keysFor(fid);
  const primaryKey = keys[0] || fid;

  const isMine = it => it && (it.fileId === fid ||
    String(it.uid || '').indexOf(fid + '_') === 0);
  const weeklySets = (typeof WEEKLY !== 'undefined' ? (WEEKLY.sets || []) : [])
    .filter(s => s.fileId === fid);
  const hasSaved = [S.wr, S.bk, S.fl].some(l => (l || []).some(isMine));
  const hasPaper = weeklySets.some(s => {
    try { return !!WEEKLY._loadPaper(s.id); } catch (e) { return false; }
  });

  /* 1. fetch first. */
  let fresh;
  try {
    const raw = await QUIZ._fetch(fid, primaryKey, 1, 'bg');
    fresh = normQ(raw, fid);
    if (!fresh.length) throw new Error('empty');
  } catch (e) {
    /* No fresh copy: if nothing depends on this file, still drop the
       stale cache so the next open re-fetches. Otherwise leave it. */
    if (!hasSaved && !hasPaper) {
      const stamps = _load('abhyas_qts', {});
      for (const k of keys) {
        try { await QDB.del(k); } catch (e2) {}
        delete stamps[k];
      }
      _save('abhyas_qts', stamps);
    }
    throw e;
  }

  const now = Date.now();

  /* 2. purge sibling keys and clear "checked recently" stamps so the
     next open re-verifies every variant of this file. The primaryKey
     already holds the fresh copy. */
  const stamps = _load('abhyas_qts', {});
  for (const k of keys) {
    if (k !== primaryKey) { try { await QDB.del(k); } catch (e2) {} }
    delete stamps[k];
  }
  _save('abhyas_qts', stamps);

  /* 3a. rewrite saved copies. */
  [['wr', LS.WR], ['bk', LS.BK], ['fl', LS.FL]].forEach(([kind, lsKey]) => {
    const r = applyCorrectionsToList(S[kind], fid, fresh, now);
    if (r.updated || r.moved || r.merged || r.withdrawn) {
      S[kind] = r.list;
      _save(lsKey, S[kind]);
    }
    out.updated += r.updated;
    out.moved += r.moved;
    out.merged += r.merged;
    out.withdrawn += r.withdrawn;
  });

  /* 3b. rewrite weekly papers kept for review. */
  if (hasPaper) {
    try {
      const all = _load(WEEKLY.LS_PAPERS, {}) || {};
      let changed = false;
      weeklySets.forEach(s => {
        const p = all[s.id];
        if (!p || !Array.isArray(p.qs)) return;
        const r = applyCorrectionsToList(p.qs, fid, fresh, now, { keepAll: true });
        if (r.updated || r.moved || r.withdrawn) {
          p.qs = r.list; changed = true; out.updated += r.updated;
        }
      });
      if (changed) localStorage.setItem(WEEKLY.LS_PAPERS, JSON.stringify(all));
    } catch (e) {}
  }

  if (out.updated || out.moved || out.merged || out.withdrawn) {
    try {
      ['wrong', 'bookmarks', 'flagged'].forEach(v => {
        if (UI.cur === v) {
          REV.renderList(v === 'wrong' ? 'wr' : v === 'bookmarks' ? 'bk' : 'fl');
        }
      });
    } catch (e) {}
    try { HOME.updateBadges(); } catch (e) {}
    try { PSYNC.scheduleSync(); } catch (e) {}
  }
  return out;
}

async function _checkCorrections(force) {
  if (_corrRunning) return;
  if (!S.user || !S.user.token || !S.online || S.forcedOffline) return;
  if (!force && Date.now() - _corrNum(_CORR_CHECKED) < _CORR_MIN_GAP) return;
  _corrRunning = true;
  try {
    const since = _corrNum(_CORR_SEEN) || (Date.now() - _CORR_FIRST_WIN);
    const r = await netFetch(APPS, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action: 'getCorrections',
        username: S.user.username, token: S.user.token, since: since
      })
    }, 15000);
    const res = await r.json();
    if (!res || !res.success) return;

    const tot = { purged: 0, updated: 0, moved: 0, merged: 0, withdrawn: 0 };
    const filesMap = res.files || {};
    let oldestFailed = Infinity;

    for (const fid of Object.keys(filesMap)) {
      const correctedAt = Number(filesMap[fid]) || 0;
      try {
        const o = await _applyCorrections(fid);
        Object.keys(tot).forEach(k => { tot[k] += (o[k] || 0); });
      } catch (e) {
        if (correctedAt > 0 && correctedAt < oldestFailed) oldestFailed = correctedAt;
        else if (oldestFailed === Infinity) oldestFailed = 0;
      }
    }

    _corrSet(_CORR_CHECKED, Date.now());
    if (oldestFailed === Infinity) {
      /* Every file applied cleanly. Move the seen-marker to whatever the
         server says "now" is, so the next poll asks about new corrections
         only. */
      _corrSet(_CORR_SEEN, res.now || Date.now());
    } else if (oldestFailed > 0) {
      /* Some files failed. Advance _CORR_SEEN to just before the oldest
         failed timestamp so only the failed files come back next time.
         Never move it backwards. */
      const cur = _corrNum(_CORR_SEEN);
      _corrSet(_CORR_SEEN, Math.max(cur, oldestFailed - 1));
    }
    /* If oldestFailed === 0 (a failed file had no timestamp at all), leave
       _CORR_SEEN alone and retry the whole batch next time. */

    if (tot.updated || tot.moved) {
      toast('\u2705 ' + (tot.updated || tot.moved) + ' saved question' +
        ((tot.updated || tot.moved) === 1 ? '' : 's') + ' updated: your teacher corrected ' +
        ((tot.updated || tot.moved) === 1 ? 'it' : 'them') + '.', 5000);
    }
    if (tot.withdrawn) {
      toast(tot.withdrawn + ' saved question' +
        (tot.withdrawn === 1 ? ' was' : 's were') +
        ' withdrawn from the question bank.', 5000);
    }
    const mine = (res.resolvedMine || []).length;
    if (mine) {
      toast('\u2705 Thanks! ' + mine + ' question' +
        (mine === 1 ? '' : 's') + ' you reported ' +
        (mine === 1 ? 'was' : 'were') + ' corrected.', 6000);
    }
  } catch (e) {
    /* offline or busy: tried again later */
  } finally {
    _corrRunning = false;
  }
}

/* ── public module ─────────────────────────────────────────────────── */

const USER_REPORT = {
  openSheet: _openSheet,
  submit:    _submit,
  flush:     _flush,
  checkCorrections: _checkCorrections,

  current() {
    if (!S.quiz || !S.quiz.qs) return;
    const q = S.quiz.qs[S.quiz.idx];
    const pick = S.quiz.ans ? S.quiz.ans[S.quiz.idx] : null;
    _openSheet(q, {
      section: reportSection(S.quiz.scope, S.quiz.mode),
      chosen: (typeof pick === 'number') ? pick : null
    });
  },
  exam(qi) {
    if (!S.quiz || !S.quiz.qs) return;
    const q = S.quiz.qs[qi];
    const pick = S.quiz.ans ? S.quiz.ans[qi] : null;
    _openSheet(q, {
      section: reportSection(S.quiz.scope, S.quiz.mode),
      chosen: (typeof pick === 'number') ? pick : null
    });
  },
  result(i) {
    if (!S.quiz || !S.quiz.qs) return;
    const q = S.quiz.qs[i];
    const pick = S.quiz.ans ? S.quiz.ans[i] : null;
    _openSheet(q, {
      section: reportSection(S.quiz.scope, S.quiz.mode, 'results'),
      chosen: (typeof pick === 'number') ? pick : null
    });
  },
  reportList(kind, uid) {
    const store = kind === 'bk' ? S.bk : kind === 'fl' ? S.fl : S.wr;
    const q = (store || []).find(x => x.uid === uid);
    if (!q) return;
    _openSheet(q, {
      section: kind === 'bk' ? 'review-saved'
             : kind === 'fl' ? 'review-flagged'
             : 'review-missed',
      chosen: null
    });
  }
};
window.USER_REPORT = USER_REPORT;

/* ── compat shims: keep the QUIZ._reportX names alive until objective.js
   is cleaned up. Delete once the old bodies are gone. ── */
if (typeof QUIZ !== 'undefined') {
  QUIZ._openReport    = (q, ctx) => _openSheet(q, ctx);
  QUIZ._submitReport  = () => _submit();
  QUIZ._reportCurrent = () => USER_REPORT.current();
  QUIZ._reportExam    = (qi) => USER_REPORT.exam(qi);
  QUIZ._reportResult  = (i) => USER_REPORT.result(i);
  QUIZ.flushReports   = () => _flush();
}

/* ── lifecycle: the seven triggers ─────────────────────────────────
   Every screen entry that can show a question, plus a 3-minute timer
   for a student who never leaves the screen they are on, plus tab
   visibility, plus back-online, plus the first moment after login, plus
   first boot, plus flush of any queued offline reports.

   The 10-minute floor inside _checkCorrections keeps server load low;
   these triggers only widen the moments at which the check is
   *considered*.
   ─────────────────────────────────────────────────────────────────── */

/* 1. Every screen that can show a question. */
const _QUESTION_VIEWS = [
  'home', 'online', 'psycho', 'weekly', 'hourly',
  'subj-qotd', 'subj-exam', 'subj-list', 'wrong', 'bookmarks'
];
if (typeof UI !== 'undefined' && UI.onEnter) {
  _QUESTION_VIEWS.forEach(v => {
    UI.onEnter(v, () => { try { _checkCorrections(); } catch (e) {} });
  });
}

/* 2. Periodic timer. Fires every 3 minutes while the tab is visible. */
setInterval(() => {
  if (document.visibilityState !== 'hidden') {
    try { _checkCorrections(); } catch (e) {}
  }
}, 3 * 60 * 1000);

/* 3. Tab becomes visible again. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    try { _checkCorrections(); } catch (e) {}
  }
});

/* 4. Back online. */
window.addEventListener('online', () => {
  setTimeout(() => { try { _checkCorrections(true); } catch (e) {} }, 2500);
});

/* 5. As soon as the session is restored, so the first paint is on fresh
   data when possible. AUTH._enter runs on login and on saved-session
   restore, so this covers both. */
if (typeof AUTH !== 'undefined' && AUTH._enter && !AUTH._enter._reportWrapped) {
  const _origEnter = AUTH._enter.bind(AUTH);
  AUTH._enter = function (u) {
    const r = _origEnter(u);
    setTimeout(() => { try { _checkCorrections(true); } catch (e) {} }, 800);
    return r;
  };
  AUTH._enter._reportWrapped = true;
}

/* 6. First boot, after everything else has settled. */
setTimeout(() => { try { _checkCorrections(true); } catch (e) {} }, 6000);

/* 7. Flush any queued offline reports shortly after boot. */
setTimeout(() => { try { _flush(); } catch (e) {} }, 8000);

})();