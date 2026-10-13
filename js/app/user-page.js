/* ═══════════════════════════════════════════════════════════════════════
   Abhyas — page layer.
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';
const $   = id => document.getElementById(id);
const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };

/* ═══════════════════════════════════════════════════════════════════════
   SESSION — one button, one 30-minute session, with a preview sheet.

   Builds the right mix based on where the student is in the 60-day plan:
     Learn (days 1–35) : reviews due → misconceptions → new material → fill
     Drill (days 36–52): reviews due → misconceptions → weakest chapters → fill
     Mock  (days 53–60): reviews due → mixed content from every level

   Reviews and misconceptions always come first because they're the
   questions the student is about to forget or has already got wrong.
   ═══════════════════════════════════════════════════════════════════════ */
window.SESSION = {
  COUNT: 30,
  REVIEW_CAP_LEARN: 8,
  REVIEW_CAP_DRILL: 12,
  MISCONCEPTION_CAP_LEARN: 4,
  MISCONCEPTION_CAP_DRILL: 8,
  _pending: null,
  _cache: { at: 0, data: null },

  _phase(){
    try {
      const start = localStorage.getItem('abhyas_sprint_start') || '';
      if (!start) return 'learn';
      const exam = localStorage.getItem('abhyas_exam_date') || '';
      const day = sprintDayNumber(start, new Date());
      const total = sprintTotalDays(start, exam);
      const learnEnd = Math.round(total * 35 / 60);
      const drillEnd = Math.round(total * 52 / 60);
      if (!day || day < 1) return 'learn';
      if (day <= learnEnd) return 'learn';
      if (day <= drillEnd) return 'drill';
      return 'mock';
    } catch(e){ return 'learn'; }
  },

  async _buildWithBreakdown(){
    const phase = this._phase();
    const out = [], seen = new Set();
    const push = q => {
      if (!q || !q.uid || seen.has(q.uid)) return false;
      if (out.length >= this.COUNT) return false;
      seen.add(q.uid); out.push(q); return true;
    };
    const breakdown = { reviews: 0, misconceptions: 0, fresh: 0, weak: 0, fill: 0 };

    const due = (typeof REV !== 'undefined' && REV.dueWrong) ? REV.dueWrong() : [];
    const dueCap = phase === 'drill' ? this.REVIEW_CAP_DRILL : this.REVIEW_CAP_LEARN;
    for (const q of due) { if (out.length >= dueCap) break; if (push(q)) breakdown.reviews++; }

    const misc = (S.wr || []).filter(q => q._misconception && !q._withdrawn);
    const miscCap = out.length + (phase === 'drill' ? this.MISCONCEPTION_CAP_DRILL : this.MISCONCEPTION_CAP_LEARN);
    for (const q of misc) { if (out.length >= miscCap) break; if (push(q)) breakdown.misconceptions++; }

    if (phase === 'learn') {
      const fresh = await this._fresh(this.COUNT - out.length);
      for (const q of fresh) { if (push(q)) breakdown.fresh++; }
    } else if (phase === 'drill') {
      const weak = await this._weak(this.COUNT - out.length);
      for (const q of weak) { if (push(q)) breakdown.weak++; }
    } else {
      const mixed = await this._randomFill(this.COUNT - out.length);
      for (const q of mixed) { if (push(q)) breakdown.weak++; }
    }

    if (out.length < this.COUNT) {
      const fill = await this._randomFill(this.COUNT - out.length);
      for (const q of fill) { if (push(q)) breakdown.fill++; }
    }

    const headCount = Math.min(out.length, breakdown.reviews + breakdown.misconceptions);
    const ordered = out.slice(0, headCount).concat(shuf(out.slice(headCount)));
    return { qs: ordered, breakdown };
  },

  async _fresh(limit){
    if (limit <= 0) return [];
    const cov = S.cov || {};
    const fcount = S.fcount || {};
    const refs = (typeof ChapterData !== 'undefined') ? ChapterData.allFileRefs() : [];
    const scored = refs.map(r => {
      const c = cov[r.fid];
      const total = fcount[r.fid] || 0;
      const seen = c ? (c.a || 0) : 0;
      return { ref: r, pct: total ? seen / total : 0, total };
    }).filter(x => x.total > 0 && x.pct < MASTERY_THRESHOLD);
    scored.sort((a, b) => a.pct - b.pct);

    const picked = [];
    for (const s of scored) {
      if (picked.length >= limit) break;
      try {
        const raw = await QUIZ._fetch(s.ref.fid, s.ref.key);
        const qs = normQ(raw, s.ref.fid);
        const c = cov[s.ref.fid];
        const unseen = qs.filter(q => {
          const parts = q.uid.split('_');
          const idx = parseInt(parts[parts.length - 1], 10);
          return !c || !c.p || c.p[idx] === '0';
        });
        const pool = shuf(unseen.length ? unseen : qs);
        for (const q of pool) { picked.push(q); if (picked.length >= limit) break; }
      } catch(e){}
    }
    return picked;
  },

  async _weak(limit){
    if (limit <= 0) return [];
    let entries = [];
    try { entries = (typeof CHAPSTATS !== 'undefined') ? CHAPSTATS.entries() : []; } catch(e){}
    const weak = entries
      .filter(e => e.attempted >= 5 && e.accuracy < MASTERY_THRESHOLD * 100)
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 6);

    const picked = [];
    for (const w of weak) {
      if (picked.length >= limit) break;
      const refs = ChapterData.allFileRefs().filter(r =>
        ChapterData.chapterName(r.lv, r.ch) === w.chapter
      );
      for (const ref of refs) {
        if (picked.length >= limit) break;
        try {
          const raw = await QUIZ._fetch(ref.fid, ref.key);
          for (const q of shuf(normQ(raw, ref.fid))) {
            picked.push(q); if (picked.length >= limit) break;
          }
        } catch(e){}
      }
    }
    return picked;
  },

  async _randomFill(limit){
    if (limit <= 0) return [];
    const refs = (typeof ChapterData !== 'undefined') ? ChapterData.allFileRefs() : [];
    const picked = [];
    for (const ref of shuf(refs)) {
      if (picked.length >= limit) break;
      try {
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        for (const q of shuf(normQ(raw, ref.fid))) {
          picked.push(q); if (picked.length >= limit) break;
        }
      } catch(e){}
    }
    return picked;
  },

  async start(){
    if (S.quiz && S.quiz.active) {
      const ok = await ASK.confirm({
        title: 'Session already running',
        body:  'A quiz is in progress. Start a fresh 30-minute session anyway?',
        ok:    'Start new'
      });
      if (!ok) return;
    }

    const now = Date.now();
    if (this._cache.data && now - this._cache.at < 60000) {
      this._pending = this._cache.data.qs;
      this._showPreview(this._cache.data.qs, this._cache.data.breakdown);
      return;
    }

    QUIZ._showLoader('Building your session\u2026');
    let qs = [], breakdown = { reviews: 0, misconceptions: 0, fresh: 0, weak: 0, fill: 0 };
    try { const r = await this._buildWithBreakdown(); qs = r.qs; breakdown = r.breakdown; }
    catch(e){ console.warn('[SESSION] build failed', e); }
    QUIZ._hideLoader();

    if (!qs.length) {
      toast('Nothing to practice yet. Open Chapters once while online to download a set.', 6000);
      return;
    }

    this._cache = { at: Date.now(), data: { qs, breakdown } };
    this._pending = qs;
    this._showPreview(qs, breakdown);
  },

  _showPreview(qs, breakdown){
    const phase = this._phase();
    const phaseName = phase === 'learn' ? 'Learn' : phase === 'drill' ? 'Drill' : 'Mock';
    const phaseIcon = phase === 'learn' ? 'ph-books' : phase === 'drill' ? 'ph-target' : 'ph-note-pencil';
    const mins = Math.max(5, Math.round(qs.length * 0.8));

    const row = (icon, label, count, tone) => count > 0
      ? '<div class="sprint-row" style="padding:var(--sp-2) var(--sp-3)">' +
          '<i class="ph ' + icon + '" style="color:var(--' + (tone || 'ink-3') + ')"></i>' +
          '<span class="grow"><b>' + esc(label) + '</b>' +
            '<span class="t-cap" style="display:block;color:var(--ink-3)">' + this._describe(label) + '</span>' +
          '</span>' +
          '<span class="mono" style="font-weight:700;color:var(--ink)">' + count + '</span>' +
        '</div>'
      : '';

    const rows =
      row('ph-arrow-counter-clockwise', 'Reviews due', breakdown.reviews, 'accent') +
      row('ph-warning-circle', 'Misconceptions', breakdown.misconceptions, 'warning') +
      (phase === 'learn'
        ? row('ph-sparkle', 'New material', breakdown.fresh, 'accent')
        : row('ph-target', 'Weakest chapters', breakdown.weak, 'accent')) +
      (breakdown.fill ? row('ph-shuffle', 'Mixed fill', breakdown.fill, 'ink-3') : '');

    const body =
      '<div class="qotd-head" style="margin-bottom:var(--sp-3)">' +
        '<div>' +
          '<div class="qotd-meta">' + phaseName + ' session</div>' +
          '<div style="font-size:.9rem;font-weight:700;color:var(--ink);margin-top:.15rem">' +
            qs.length + ' questions \u00b7 about ' + mins + ' min' +
          '</div>' +
        '</div>' +
        '<div class="qotd-marks"><i class="ph ' + phaseIcon + '"></i></div>' +
      '</div>' +
      '<p class="t-callout" style="margin-bottom:var(--sp-3);line-height:1.55">' + this._why(phase) + '</p>' +
      '<div class="sprint-list" style="margin-bottom:var(--sp-4)">' + rows + '</div>' +
      '<button class="btn btn-solid btn-lg btn-blk" data-on-click="MODAL.close(\'sheet\');SESSION._begin()">' +
        '<i class="ph ph-play-circle"></i> Begin session' +
      '</button>' +
      '<button class="btn btn-quiet btn-blk mt2" data-on-click="MODAL.close(\'sheet\')">Cancel</button>';

    MODAL.sheet('Your 30-minute session', body, { wide: false });
  },

  _why(phase){
    if (phase === 'learn') return 'Reviews and misconceptions first \u2014 those are the questions you\u2019re about to forget or that you\u2019ve already got wrong. Then new material from the chapters you\u2019ve covered least.';
    if (phase === 'drill') return 'Reviews and misconceptions first, then questions from your weakest chapters. In this phase we stop adding new material and start converting what you\u2019ve seen into confident answers.';
    return 'Reviews first, then a mixed set from every level \u2014 a simulation run so nothing feels unfamiliar on exam day.';
  },

  _describe(label){
    if (label === 'Reviews due') return 'Ready again on their spacing schedule';
    if (label === 'Misconceptions') return 'You were sure and got them wrong \u2014 these cost the most marks';
    if (label === 'New material') return 'From chapters you\u2019ve covered least';
    if (label === 'Weakest chapters') return 'Lowest accuracy so far';
    if (label === 'Mixed fill') return 'Extra questions to reach the session length';
    return '';
  },

  _begin(){
    const phase = this._phase();
    const label = phase === 'learn' ? '📚 Learn session'
                : phase === 'drill' ? '🎯 Drill session'
                : '📝 Mock session';
    if (!this._pending) { toast('Session expired, tap again.'); return; }
    const qs = this._pending;
    this._pending = null;
    QUIZ._doStart(qs, 'flashcard', label, false, { session: true, phase });
  }
};

/* escAttrJs comes from shared.js (one copy) */

function applyTheme(dark){
  document.documentElement.classList.toggle('dark', dark);
  document.body.classList.remove('dark');
  try { localStorage.setItem('abhyas_theme', JSON.stringify(dark ? 'dark' : 'light')); } catch(e){}
  /* Both theme-color metas must move together — the browser picks whichever
     matches the OS preference. querySelector only returns the first, so a
     dark-OS device that switches to light keeps a dark status bar. */
  document.querySelectorAll('meta[name="theme-color"]').forEach(m =>
    m.setAttribute('content', dark ? '#080B14' : '#F2F4F3'));
}
if (typeof UI !== 'undefined') {
  UI.theme = function(){ applyTheme(!document.documentElement.classList.contains('dark')); };
}
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => document.body.classList.remove('dark'), 0);
});

function _cleanChip(id){
  const e = $(id);
  if (!e) return;
  e.textContent = e.textContent.replace(/^[^\w(]+/, '').trim();
}
function _ctr(id, cur, tot){ const e = $(id); if (e) e.innerHTML = cur + '<em>/' + tot + '</em>'; }
function _syncSkip(){
  if (!S.quiz || !S.quiz.ans) return;
  const n = S.quiz.ans.filter(a => a === null).length;
  const btn = $('ex-skip-nav');
  if (btn) { btn.style.display = n ? '' : 'none'; set('ex-skip-count', n); }
  const tot = S.quiz.qs ? S.quiz.qs.length : 0;
  set('ex-bottom-count', (tot - n) + ' / ' + tot);
  const bskip = $('ex-bottom-skip');
  if (bskip) { bskip.hidden = !n; set('ex-bottom-left', n); }
}

/* The answer bar is fixed on a phone, so it must only exist while a quiz is
   actually on screen — and the app's top bar steps aside for the same reason. */
(function(){
  const qw = $('quiz-wrap'), res = $('res-wrap');
  if (!qw || !window.MutationObserver) return;
  const paint = () => document.body.classList.toggle('quiz-on',
    qw.style.display !== 'none' && (!res || res.style.display === 'none'));
  const mo = new MutationObserver(paint);
  mo.observe(qw, { attributes:true, attributeFilter:['style'] });
  if (res) mo.observe(res, { attributes:true, attributeFilter:['style'] });
  paint();
})();

if (typeof QUIZ !== 'undefined') {
  // Per-question timing — reset whenever a new quiz starts
  const _doStart = QUIZ._doStart.bind(QUIZ);
  QUIZ._doStart = function(){
    if (typeof FAST_GUESS !== 'undefined') FAST_GUESS.reset();
    try { if (typeof RECOVERY !== 'undefined') RECOVERY.markActive(); } catch(e){}
    try { if (typeof READALOUD !== 'undefined') READALOUD.stop(); } catch(e){}
    if (S && S.quiz) S.quiz.conf = {};
    return _doStart.apply(QUIZ, arguments);
  };
  // Wrap fcAnswer so we know how long each question took
  const _fcAnswer = QUIZ.fcAnswer.bind(QUIZ);
  QUIZ.fcAnswer = function(i){
    if (S.quiz && !S.quiz.reviewOnly && S.quiz.ans[S.quiz.idx] === null) {
      if (typeof FAST_GUESS !== 'undefined') FAST_GUESS.markAnswered(S.quiz.idx);
    }
    const r = _fcAnswer(i);
    try { if (typeof PRACTICE_RESUME !== 'undefined') PRACTICE_RESUME.snapshot(); } catch(e){}
    return r;
  };

  /* Results screen: sort wrong-first, surface marked count, and persist
     marked questions as 'Need Check' bookmarks so they come back later. */
  const _origShowResults = QUIZ._showResults.bind(QUIZ);
  QUIZ._showResults = function(){
    _origShowResults();
    try {
      if (S.quiz && S.quiz.scope && S.quiz.scope.daily10 && typeof DAILY10 !== 'undefined') {
        DAILY10.markDone();
        DAILY10.render();
      }
      if (typeof PRACTICE_RESUME !== 'undefined'){ PRACTICE_RESUME.clear(); PRACTICE_RESUME.render(); }
    } catch(e){}
    try {
      const stats = document.getElementById('res-stats');

      /* Auto-bookmark marked questions with the 'Need Check' tag. */
      const marked = (S.quiz && S.quiz.marked) ? S.quiz.marked : new Set();
      if(marked.size && S.quiz && S.quiz.qs){
        let added = 0;
        marked.forEach(idx => {
          const q = S.quiz.qs[idx];
          if(!q || !q.uid) return;
          const existing = (S.bk || []).find(b => b.uid === q.uid);
          if(!existing){
            S.bk.push(Object.assign({}, q, { tag: 'Need Check' }));
            added++;
          } else if(!existing.tag){
            existing.tag = 'Need Check';
            added++;
          }
        });
        if(added){
          _save(LS.BK, S.bk);
          try { if(typeof HOME !== 'undefined' && HOME.updateBadges) HOME.updateBadges(); } catch(e){}
        }
      }

      if(stats && !stats.parentElement.querySelector('.marked-line') && marked.size > 0){
        const p = document.createElement('p');
        p.className = 'marked-line t-foot';
        p.style.cssText = 'text-align:center;color:var(--warning);margin-top:.4rem';
        p.innerHTML = '<i class="ph ph-flag"></i> You marked ' + marked.size +
          ' question' + (marked.size === 1 ? '' : 's') + ' for review';
        stats.parentElement.insertBefore(p, stats.nextSibling);
      }

      /* Reorder the review list: wrong first, then skipped, then correct. */
      const box = document.getElementById('res-review');
      if(box && S.quiz && S.quiz.qs){
        const cards = Array.from(box.children);
        if(cards.length === S.quiz.qs.length){
          const pairs = cards.map((c, i) => {
            const a = S.quiz.ans[i];
            const ok = isOk(a, S.quiz.qs[i].correct);
            const rank = (a === null) ? 1 : (ok ? 3 : 0);
            return { c: c, rank: rank, i: i };
          });
          pairs.sort((x, y) => x.rank - y.rank || x.i - y.i);
          pairs.forEach(p => box.appendChild(p.c));
        }
      }
    } catch (e) { /* cosmetic — never break results over it */ }
  };

  const _rf = QUIZ._renderFlashcard.bind(QUIZ);
  QUIZ._renderFlashcard = function(){
    _rf(); _cleanChip('fc-chip');
    if (typeof FAST_GUESS !== 'undefined') FAST_GUESS.markShown(S.quiz.idx);
    try { if (typeof CONF !== 'undefined') CONF.render(); } catch(e){}
    try { if (typeof READALOUD !== 'undefined') READALOUD.render(); } catch(e){}
    if (!S.quiz.qs) return;
    const i = S.quiz.idx, n = S.quiz.qs.length, last = i === n - 1;
    _ctr('fc-ctr', i + 1, n);
    set('fc-nav-n', (i + 1) + ' / ' + n);
    /* objective.js writes plain text into these, which drops the icons. */
    const prev = $('fc-prev');
    if (prev) prev.innerHTML = '<i class="ph ph-arrow-left"></i> <span class="fc-nav-lbl">Back</span>';
    const next = $('fc-next');
    if (next) {
      next.innerHTML = S.quiz.reviewOnly
        ? (last ? '<i class="ph ph-check"></i> Done' : 'Next <i class="ph ph-arrow-right"></i>')
        : (last ? '<i class="ph ph-check-circle"></i> Finish' : 'Next <i class="ph ph-arrow-right"></i>');
      next.setAttribute('aria-label', last ? 'Finish and see results' : 'Next question');
    }
  };

  /* A double tap on Next must not jump two questions. */
  const _fcNav = QUIZ.fcNav.bind(QUIZ);
  let _navAt = 0;
  QUIZ.fcNav = function(dir){
    const now = Date.now();
    if (now - _navAt < 200) return;
    _navAt = now;
    _fcNav(dir);
    try { if (typeof PRACTICE_RESUME !== 'undefined') PRACTICE_RESUME.snapshot(); } catch(e){}
  };

  const _uc = QUIZ._updateFcCounts.bind(QUIZ);
  QUIZ._updateFcCounts = function(){
    _uc();
    if (S.quiz.qs) { const pf = $('fc-pf'); if (pf) pf.style.width = ((S.quiz.idx / S.quiz.qs.length) * 100) + '%'; }
  };

  const _sw = QUIZ.startWith.bind(QUIZ);
  QUIZ.startWith = function(qs, mode, ch, scope){
    _sw(qs, mode, ch, scope);
    const nm = String(ch || 'Practice').replace(/^[^\w(]+/, '').trim();
    set('fc-chip', nm); set('ex-chip', nm);
    const isReview = !!(scope && scope.weeklyReviewMode);
    set('fc-mode-pill', isReview ? 'Review' : (mode === 'exam' ? 'Timed test' : 'Practice'));
    set('ex-mode-pill', 'Timed test');
    _ctr('fc-ctr', 1, qs.length); _ctr('ex-ctr', 0, qs.length);
  };

  const _origShowLimit = QUIZ._showLimitPicker.bind(QUIZ);
  QUIZ._showLimitPicker = function(qsArr, mode, chapterName, scope){
    _origShowLimit(qsArr, mode, chapterName, scope);
    const cb = $('qlm-shuffle');
    if (cb && !cb.disabled) cb.checked = false;
  };

  // Annotate the results card with a fast-guess warning
  (function(){
    const res = $('res-wrap');
    if (!res || !window.MutationObserver) return;
    new MutationObserver(() => {
      if (res.style.display === 'none') return;
      const stats = $('res-stats');
      if (!stats || stats.parentNode.querySelector('.fast-guess-line')) return;
      if (typeof FAST_GUESS === 'undefined' || !S.quiz) return;
      const fast = FAST_GUESS.fastWrongIndexes(S.quiz);
      if (!fast.length) return;
      const line = document.createElement('p');
      line.className = 'fast-guess-line';
      line.innerHTML = '<i class="ph ph-lightning"></i> ' + fast.length +
        ' wrong answer' + (fast.length > 1 ? 's' : '') +
        ' in under 10 seconds \u2014 you may have been guessing. Slow down on the next attempt.';
      stats.parentNode.insertBefore(line, stats.nextSibling);
    }).observe(res, { attributes: true, attributeFilter: ['style'] });
  })();

  const _re = QUIZ._renderExam.bind(QUIZ);
  QUIZ._renderExam = function(){
    _re(); _cleanChip('ex-chip');
    _ctr('ex-ctr', S.quiz.ans.filter(a => a !== null).length, S.quiz.qs.length);
    _syncSkip();
  };

  const _ea = QUIZ.exAnswer.bind(QUIZ);
  QUIZ.exAnswer = function(qi, oi){
    /* record pick changes so _showResults can report how many went
       right→wrong (overthinking) vs wrong→right. Must run BEFORE _ea,
       because _ea overwrites S.quiz.ans[qi] with the new value. */
    try {
      if (S.quiz && S.quiz.ans && S.quiz.ans[qi] !== null && S.quiz.ans[qi] !== undefined && S.quiz.ans[qi] !== oi) {
        if (!S.quiz.changed) S.quiz.changed = {};
        const prev = S.quiz.ans[qi];
        const wasRight = isOk(prev, S.quiz.qs[qi].correct);
        const nowRight = isOk(oi,   S.quiz.qs[qi].correct);
        if (!S.quiz.changed[qi]) S.quiz.changed[qi] = { from: prev, to: oi, wasRight: wasRight, nowRight: nowRight };
        else { S.quiz.changed[qi].to = oi; S.quiz.changed[qi].nowRight = nowRight; }
      }
    } catch(e){}
    _ea(qi, oi);
    const ans = S.quiz.ans.filter(a => a !== null).length, tot = S.quiz.qs.length;
    _ctr('ex-ctr', ans, tot);
    const pf = $('ex-pf'); if (pf) pf.style.width = ((ans / tot) * 100) + '%';
    _paintUrgency();
    _syncSkip();
  };

  function _paintUrgency(){
    if (!S.quiz || !S.quiz.active) return;
    const el = S.quiz.mode === 'exam' ? $('ex-tmr') : null;
    if (el) el.classList.toggle('urgent', S.quiz.left > 0 && S.quiz.left < S.quiz.qs.length * 18);
  }
  const _st = QUIZ._startTimer.bind(QUIZ);
  QUIZ._startTimer = function(){
    _st();
    if (QUIZ._urgTimer) clearInterval(QUIZ._urgTimer);
    QUIZ._urgTimer = setInterval(() => {
      if (!S.quiz || !S.quiz.active) { clearInterval(QUIZ._urgTimer); QUIZ._urgTimer = null; return; }
      _paintUrgency();
    }, 1000);
  };
}
let _tx = 0, _ty = 0;
document.addEventListener('touchstart', e => { _tx = e.touches[0].clientX; _ty = e.touches[0].clientY; }, { passive:true });
document.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - _tx;
  const dy = Math.abs(e.changedTouches[0].clientY - _ty);
  if (_tx < 22 && dx > 60 && dy < 70) UI.sidebarToggle();
}, { passive:true });

document.addEventListener('keydown', e => {
  /* "/" opens search, "?" opens the shortcut sheet — only when the
     student is not typing into a field and not inside another modal. */
  try {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
    const modOpen = document.querySelector('.mbg.show');
    if (!typing && !modOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '/') { e.preventDefault(); if (typeof QSEARCH !== 'undefined') QSEARCH.open(); return; }
      if (e.key === '?') { e.preventDefault(); if (typeof KEYSHEET !== 'undefined') KEYSHEET.open(); return; }
    }
  } catch(err){}

  if (e.key === 'Escape') {
    if (typeof BN !== 'undefined' && BN._activeKey) { BN.close(); return; }
    const mb = $('mbg');
    if (mb && mb.classList.contains('show')) { closeMod(); return; }
    if ($('sb') && $('sb').classList.contains('open')) { UI.sidebarClose(); return; }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && S.quiz?.active && S.quiz?.mode !== 'exam') {
    e.preventDefault();
    if (typeof SRCH !== 'undefined' && SRCH.quickSearch) SRCH.quickSearch();
  }
});

window.BN = {
  _activeKey: null,
  open(key){
    const sec = NAV.sheet(key);
    if (!sec) return;
    set('bn-sheet-title-el', sec.title);
    $('bn-sheet-icon').className = 'ph ' + sec.icon;

    let adminCard = '';
    try {
      if (typeof S !== 'undefined' && S.user && S.user.adminCapable) {
        adminCard =
          '<button class="bn-sheet-item admin" data-on-click="BN.close();ACT.later(120,APP_SWITCH,\'toAdmin\')">' +
            '<span class="bn-sheet-ic"><i class="ph ph-shield-check"></i></span>' +
            '<span class="bn-sheet-info"><span class="bn-sheet-name">Admin console</span>' +
            '<span class="bn-sheet-sub">Students, payments and grading</span></span>' +
            '<i class="ph ph-arrow-square-out bn-sheet-arrow"></i>' +
          '</button>';
      }
    } catch(e){}

    const row = it => {
      const go = it.special === 'tutorial'
        ? "BN.close();setTimeout(function(){TUTORIAL.open()},140)"
        : "BN.close();setTimeout(function(){UI.go('" + it.view + "')},100)";
      return '<button class="bn-sheet-item" data-on-click="' + go + '">' +
        '<span class="bn-sheet-ic"><i class="ph ' + it.icon + '"></i></span>' +
        '<span class="bn-sheet-info"><span class="bn-sheet-name">' + esc(it.label) + '</span>' +
        (it.sub ? '<span class="bn-sheet-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
        '<i class="ph ph-caret-right bn-sheet-arrow"></i>' +
      '</button>';
    };
    $('bn-sheet-grid').innerHTML = sec.sections.map(sc =>
      (sc.label ? '<div class="bn-sheet-lbl">' + esc(sc.label) + '</div>' : '') + sc.items.map(row).join('')
    ).join('') + (key === 'more' ? adminCard : '');

    $('bn-sheet').classList.add('show');
    $('bn-sheet-backdrop').classList.add('show');
    document.body.style.overflow = 'hidden';
    this._activeKey = key;
    setTimeout(() => { const f = $('bn-sheet-grid').querySelector('button'); if (f) f.focus(); }, 60);
  },
  close(){
    $('bn-sheet').classList.remove('show');
    $('bn-sheet-backdrop').classList.remove('show');
    document.body.style.overflow = '';
    this._activeKey = null;
  }
};

function _updateBottomNav(v){
  document.querySelectorAll('.bn-item').forEach(e => e.classList.remove('active'));
  const b = $(NAV.tabForView(v));
  if (b) b.classList.add('active');
}

function _setAdminVisible(v){
  ['tb-admin-btn','sb-admin-promo','bn-admin'].forEach(id => {
    const el = $(id);
    if (el) el.hidden = !v;
  });
}

window.APP_SWITCH = {
  _capable: false,

  async refresh(){
    let user = null;
    try { user = (typeof S !== 'undefined' && S.user) ? S.user : null; } catch(e){}
    if (!user) { _setAdminVisible(false); return; }
    if (user.adminCapable) { this._capable = true; _setAdminVisible(true); }

    let online = false, token = '';
    try { online = (typeof S !== 'undefined' && S.online && !S.forcedOffline); token = user.token || ''; } catch(e){}
    if (!online || !token) return;

    let url = '';
    try { url = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || (typeof APPS !== 'undefined' ? APPS : ''); } catch(e){}
    if (!url) return;

    try {
      const r = await fetch(url, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({ action:'checkAdminCapable', username:user.username, token:user.token })
      });
      const data = await r.json();
      if (data && data.success && data.adminCapable) { this._capable = true; _setAdminVisible(true); }
    } catch(e){}
  },

  async toAdmin(){
    let user = null;
    try { user = (typeof S !== 'undefined' && S.user) ? S.user : null; } catch(e){}
    if (!user || !user.token) { toast('Please log in again.'); return; }

    let online = true;
    try { online = (typeof S !== 'undefined' && S.online && !S.forcedOffline); } catch(e){}
    if (!online) { toast('You need a connection to open the admin console.'); return; }

    const btn = $('tb-admin-btn');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin" style="margin:0"></span>'; }

    let url = '';
    try { url = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || ''; } catch(e){}
    if (!url) { if (btn) { btn.disabled = false; btn.innerHTML = orig; } return; }

    try {
      const r = await fetch(url, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({ action:'adminSwitchFromUser', username:user.username, token:user.token })
      });
      const data = await r.json();

      if (!data || !data.success) {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
        if (data && data.sessionInvalid) {
          toast('Your session expired — log in again.', 4500);
          try { localStorage.removeItem('abhyas_session'); localStorage.removeItem('abhyas_admin'); } catch(e){}
          setTimeout(() => { window.location.href = 'index.html'; }, 1500);
          return;
        }
        if (data && data.error && /does not have admin access/i.test(data.error)) {
          toast('This account is not an admin.', 4000);
          return;
        }
        toast((data && data.error) || 'Could not switch.');
        return;
      }

      localStorage.setItem('abhyas_admin', JSON.stringify({
        user: data.username || user.username,
        token: data.adminToken,
        expires: Date.now() + (data.expiresInMs || 86400000)
      }));
      try { if (typeof PSYNC !== 'undefined' && PSYNC._timer) PSYNC._beaconSync(); } catch(e){}
      toast('Opening the admin console…');
      setTimeout(() => { window.location.href = 'admin.html'; }, 250);
    } catch(e){
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
      toast(e.message || 'Network error.');
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   MY SUBMISSIONS — list your written submissions, open the uploaded
   PDF, and see the score once it's marked. Data comes from
   getMySubjectiveSubmissions; the PDF itself comes from
   getMySubmissionPdf, a small endpoint that returns the bytes of a
   submission you own.
   ═══════════════════════════════════════════════════════════════════ */
window.MY_SUBJ = {
  _loading: false,
  _loaded: false,
  _items: [],

  _url(){
    try { return (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || ''; }
    catch(e){ return ''; }
  },
  _user(){
    try { return (typeof S !== 'undefined' && S.user) ? S.user : null; }
    catch(e){ return null; }
  },
  _online(){
    try { return !!(typeof S !== 'undefined' && S.online && !S.forcedOffline); }
    catch(e){ return navigator.onLine; }
  },

  async load(force){
    const box = $('subj-mine-body');
    if (!box) return;
    if (this._loaded && !force) { this.render(); this.refreshHint(); return; }
    if (this._loading) return;
    this._loading = true;

    box.innerHTML = '<div class="card"><div class="skel w80"></div><div class="skel w60"></div><div class="skel w100"></div></div>';

    const user = this._user();
    const url = this._url();

    if (!user || !user.token) {
      box.innerHTML = '<div class="card"><div class="empty">' +
        '<div class="empty-i"><i class="ph ph-user"></i></div>' +
        '<p>Not signed in</p>' +
        '<p>Sign in to see your submissions.</p>' +
        '</div></div>';
      this._loading = false;
      return;
    }

    if (!this._online()) {
      box.innerHTML = '<div class="card"><div class="banner banner-warning">' +
        '<i class="ph ph-wifi-slash"></i>' +
        '<span>You are offline. Connect to the internet to see your submissions — nothing is lost while you wait.</span>' +
        '</div></div>';
      this._loading = false;
      return;
    }

    if (!url) {
      box.innerHTML = '<div class="card"><div class="banner banner-danger">' +
        '<i class="ph ph-warning-circle"></i>' +
        '<span>The backend address is not configured.</span>' +
        '</div></div>';
      this._loading = false;
      return;
    }

    try {
      const r = await fetch(url, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({
          action:'getMySubjectiveSubmissions',
          username:user.username,
          token:user.token
        })
      });
      const res = await r.json();
      if (!res || !res.success) throw new Error((res && res.error) || 'Could not load your submissions.');
      this._items = (res.submissions || []).slice().sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      this._loaded = true;
      this.render();
      this.refreshHint();
    } catch(e){
      box.innerHTML = '<div class="card"><div class="banner banner-danger">' +
        '<i class="ph ph-warning-circle"></i>' +
        '<span>' + esc(e.message || 'Could not load.') +
        ' <button class="btn btn-sm btn-quiet" data-on-click="MY_SUBJ.load(true)">Try again</button></span>' +
        '</div></div>';
    }
    this._loading = false;
  },

  refreshHint(){
    const n = this._items.length;
    const pending = this._items.filter(s => s.status !== 'graded').length;
    const badge = $('subj-mine-badge');
    const hint = $('subj-mine-hint');
    if (badge) {
      badge.hidden = pending === 0;
      badge.textContent = pending > 99 ? '99+' : pending;
    }
    if (hint) {
      hint.textContent = n === 0 ? 'Nothing submitted yet'
        : pending > 0 ? pending + ' awaiting marking'
        : n === 1 ? '1 marked' : n + ' marked';
    }
  },

  render(){
    const box = $('subj-mine-body');
    if (!box) return;
    if (!this._items.length) {
      box.innerHTML = '<div class="card"><div class="empty">' +
        '<div class="empty-i"><i class="ph ph-file-text"></i></div>' +
        '<p>No submissions yet</p>' +
        '<p>Send in a written answer and it will show up here with the PDF you uploaded.</p>' +
        '<div class="bg" style="justify-content:center;margin-top:var(--sp-4)">' +
          '<button class="btn btn-a" data-on-click="UI.go(\'subj-qotd\')"><i class="ph ph-sun-horizon"></i> Today\'s question</button>' +
        '</div>' +
        '</div></div>';
      return;
    }
    box.innerHTML = this._items.map(s => this._renderCard(s)).join('');
    if (!this._modelChecked && typeof STUDYDOCS !== 'undefined' && this._items.some(s => s.chapterId)) {
      this._modelChecked = true;
      STUDYDOCS.ensureLoaded().then(() => { if (STUDYDOCS.docs.length) this.render(); });
    }
  },

  _renderCard(s){
    const graded = s.status === 'graded';
    const cls = graded ? 'graded' : s.status === 'rejected' ? 'rejected' : 'pending';
    const kind = (s.kind === 'exam') ? 'Full paper' : 'Question of the day';
    const marks = s.questionMarks || (s.kind === 'exam' ? 100 : 10);
    const when = s.submittedAt ? new Date(s.submittedAt).toLocaleString() : '—';

    const marked = !!s.pdfReplacedAt;
    const pdfBtn = s.pdfUrl
      ? '<button class="subm-pdf-btn" data-on-click="MY_SUBJ.openPdf(\'' + escAttrJs(s.id) + '\',\'' + escAttrJs(kind) + '\')">' +
          '<i class="ph ph-file-pdf"></i> ' + (marked ? 'Open the marked paper' : 'Open my answer') + '</button>' +
        (marked ? '<span class="ctag tc"><i class="ph ph-highlighter-circle"></i> Marked by hand</span>' : '')
      : '<span class="t-cap">No PDF attached</span>';

    const statusChip = graded
      ? '<span class="ctag tg">Marked</span>'
      : s.status === 'rejected'
        ? '<span class="ctag tr">Returned</span>'
        : '<span class="ctag tw">Awaiting marking</span>';

    const gradeBlock = graded
      ? '<div class="subm-grade">' +
          '<span class="v">' + (s.score != null ? s.score : '—') + '</span>' +
          '<span class="out">/ ' + marks + '</span>' +
          '<span class="lbl">' + (s.gradedBy ? 'marked by ' + esc(s.gradedBy) : '') + '</span>' +
        '</div>'
      : '';

    const feedbackBlock = (graded && s.feedback)
      ? '<div class="subm-feedback"><strong>Feedback:</strong> ' + esc(s.feedback) + '</div>'
      : '';

    const qText = s.questionText
      ? '<div class="subm-q">' + esc(s.questionText) + '</div>'
      : '';

    const modelDocs = (typeof STUDYDOCS !== 'undefined' && s.chapterId) ? studyDocsForChapter(STUDYDOCS.docs, s.chapterId) : [];
    const modelBtn = modelDocs.length
      ? '<div class="subm-pdf-row"><button class="subm-pdf-btn" data-on-click="STUDYDOCS.showChapter(\'' + escAttrJs(s.chapterId) + '\')">' +
          '<i class="ph ph-book-open-text"></i> ' + (modelDocs.length === 1 ? 'Read the model answer' : 'Model answers for ' + esc(subjChapterName(s.chapterId) || 'this chapter') + ' (' + modelDocs.length + ')') + '</button></div>'
      : '';

    return '<div class="subm-card ' + cls + '">' +
      '<div class="subm-top">' +
        '<div>' +
          '<div class="subm-kind">' + kind + '</div>' +
          '<div class="subm-meta">' +
            '<span>' + esc(when) + '</span>' +
            '<span>' + marks + ' marks</span>' +
            (s.solveSec ? '<span>' + Math.round(s.solveSec / 60) + ' min spent</span>' : '') +
          '</div>' +
        '</div>' +
        statusChip +
      '</div>' +
      qText +
      '<div class="subm-pdf-row">' + pdfBtn + '</div>' +
      gradeBlock +
      feedbackBlock +
      modelBtn +
    '</div>';
  },

  /* The backend endpoint is getMySubmissionPdf — it streams the bytes of a
     submission you own, so the Drive files themselves stay private. */
  async openPdf(id, label){
    const user = this._user();
    const url = this._url();
    if (!user || !user.token) { toast('Please log in again.'); return; }
    if (!url) { toast('The backend address is not set up.'); return; }

    const fetchPdf = async () => {
      const r = await fetch(url, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({ action:'getMySubmissionPdf', username:user.username, token:user.token, id })
      });
      if (!r.ok) throw new Error('The server replied with an error (' + r.status + ').');
      const res = await r.json();
      if (!res || !res.success) throw new Error((res && res.error) || 'Could not load that PDF.');
      return res;
    };

    /* The in-app viewer keeps the student inside the app, is not affected by
       pop-up blockers, and reads properly on a phone. */
    if (window.PDFVIEW) {
      PDFVIEW.open({
        title: label || 'My answer paper',
        load: async () => {
          const res = await fetchPdf();
          return { base64: res.base64, filename: res.filename || 'answer.pdf' };
        }
      });
      return;
    }

    toast('Loading your PDF…');
    try {
      const res = await fetchPdf();
      const chars = atob(res.base64);
      const bytes = new Uint8Array(chars.length);
      for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || 'application/pdf' }));
      const tab = window.open(blobUrl, '_blank');
      if (!tab) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = res.filename || 'answer.pdf';
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 300000);
    } catch(e){
      toast(e.message || 'Could not open that PDF.', 5000);
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   EMAIL CONFIRMATION — an unconfirmed address means the student can
   never reset their own password, so it is worth one quiet nudge.
   ═══════════════════════════════════════════════════════════════════ */
window.VERIFY = {
  KEY: 'abhyas_verify_hidden',

  _unverified(){
    try {
      if (typeof S !== 'undefined' && S.user && S.user.emailVerified === false) return true;
      const raw = JSON.parse(localStorage.getItem('abhyas_session') || 'null');
      return !!(raw && raw.emailVerified === false);
    } catch(e){ return false; }
  },
  _hidden(){
    try { return Number(localStorage.getItem(this.KEY) || 0) > Date.now(); } catch(e){ return false; }
  },
  render(){
    const el = $('verify-banner');
    if (!el) return;
    el.hidden = !(this._unverified() && !this._hidden());
  },
  dismiss(){
    try { localStorage.setItem(this.KEY, String(Date.now() + 7 * 24 * 3600 * 1000)); } catch(e){}
    this.render();
  },
  _mark(){
    try {
      if (typeof S !== 'undefined' && S.user) S.user.emailVerified = true;
      const raw = JSON.parse(localStorage.getItem('abhyas_session') || 'null');
      if (raw) { raw.emailVerified = true; localStorage.setItem('abhyas_session', JSON.stringify(raw)); }
    } catch(e){}
  },
  async resend(){
    let user = null, url = '';
    try { user = (typeof S !== 'undefined' && S.user) ? S.user : null; } catch(e){}
    try { url = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || ''; } catch(e){}
    if (!user || !user.token || !url) return toast('Please sign in again.');
    const btn = $('verify-resend');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const r = await fetch(url, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({ action:'resendVerification', username:user.username, token:user.token })
      });
      const res = await r.json();
      if (!res || !res.success) throw new Error((res && res.error) || 'Could not send that email.');
      if (res.alreadyVerified) { this._mark(); this.render(); toast('Your email is already confirmed.'); }
      else toast('Sent — open the link in your inbox.', 5000);
    } catch(e){
      toast(e.message || 'Could not send that email right now.', 5000);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Send the link again'; }
  }
};

/* Screen hooks: what each screen does when it opens. (Replaces the wrapper that used
   to re-define UI._goRaw here; the alias and base behaviour live in UI itself.) */
UI.onEnterAny(v => { _updateBottomNav(v); BN.close(); setTimeout(_refreshHints, 50); });

UI.onEnter('online', () => { if (typeof CH_GRID !== 'undefined') CH_GRID.render(); });

UI.onEnter('weekly', () => {
  if (typeof WEEKLY === 'undefined') return;
  if (typeof WEEKLY._renderHomeCard === 'function') WEEKLY._renderHomeCard();
  const outer = $('weekly-sets-outer'), empty = $('weekly-empty');
  if (outer && empty) empty.style.display = (outer.style.display === 'none') ? '' : 'none';
});

UI.onEnter('subj-mine', () => { if (typeof MY_SUBJ !== 'undefined') MY_SUBJ.load(false); });

['subj-qotd', 'subj-exam', 'subj-list'].forEach(view => UI.onEnter(view, () => {
  if (typeof SUBJ !== 'undefined') {
    if (typeof SUBJ.ready === 'function' && SUBJ.ready()) {
      if (typeof SUBJ._renderQotd === 'function') SUBJ._renderQotd();
      if (typeof SUBJ._renderExam === 'function') SUBJ._renderExam();
      if (typeof SUBJ._renderList === 'function') SUBJ._renderList();
    } else if (typeof SUBJ.init === 'function') {
      SUBJ.init();
    }
  }
  if (view === 'subj-exam') setTimeout(() => { if (typeof SUBJ_BUILDER !== 'undefined') { SUBJ_BUILDER._populate(); SUBJ_BUILDER._updateCooldownUI(); } }, 80);
  if (view === 'subj-list') setTimeout(_populateChapterFilter, 80);
}));

UI.onEnter('progress',        () => { if (typeof CLOUD_UI !== 'undefined' && CLOUD_UI.render) setTimeout(CLOUD_UI.render, 0); });
['home', 'progress'].forEach(view => UI.onEnter(view, () => { if (typeof APP_SWITCH !== 'undefined') APP_SWITCH.refresh(); }));

function _populateChapterFilter(){
  const sel = $('subj-list-chapter');
  if (!sel || sel.options.length > 1) return;
  const refs = (window.SUBJECTIVE_FILE_REFS || []).filter(r => r.fileId && !/^REPLACE_WITH/.test(r.fileId));
  refs.forEach(r => {
    const o = document.createElement('option');
    o.value = r.chapterId;
    o.textContent = r.name;
    sel.appendChild(o);
  });
}

window.SUBJ_BUILDER = {
  _populated: false,
  _populate(){
    if (this._populated) return;
    const box = $('exam-builder-chapters');
    if (!box) return;
    const refs = (window.SUBJECTIVE_FILE_REFS || []).filter(r => r.fileId && !/^REPLACE_WITH/.test(r.fileId));
    if (!refs.length) {
      box.innerHTML = '<p class="t-foot" style="padding:.4rem .5rem">No chapters are set up yet.</p>';
      this._populated = true;
      return;
    }
    const byGroup = {};
    refs.forEach(r => { const g = r.group || 'A'; (byGroup[g] = byGroup[g] || []).push(r); });
    box.innerHTML = Object.keys(byGroup).sort().map(gk =>
      '<div class="t-cap" style="font-weight:700;padding:.35rem .5rem .1rem">Group ' + esc(gk) + '</div>' +
      byGroup[gk].map(r =>
        '<label class="ch-item" style="cursor:pointer">' +
          '<input type="checkbox" class="eb-ch" value="' + window.escAttrJs(r.chapterId) + '" checked>' +
          '<span class="ch-name" style="color:var(--ink)">' + esc(r.name) + '</span>' +
        '</label>'
      ).join('')
    ).join('');
    this._populated = true;
  },
  /* subjective.js rate-limits a custom paper to one every six hours. Showing
     the remaining time beats letting someone press Build and get refused. */
  _updateCooldownUI(){
    const btn = $('exam-builder-go');
    const note = $('exam-builder-note');
    if (!btn || typeof SUBJ === 'undefined' || typeof SUBJ.customExamIsLocked !== 'function') return;
    const locked = SUBJ.customExamIsLocked();
    btn.disabled = locked;
    btn.innerHTML = locked
      ? '<i class="ph ph-clock"></i> Available again in ' + SUBJ.customExamCooldownLabel()
      : '<i class="ph ph-shuffle"></i> Build the paper';
    if (note) note.textContent = locked ? 'You can build one custom paper every six hours.' : '';
  },
  selectAll(){ document.querySelectorAll('#exam-builder-chapters input.eb-ch').forEach(c => c.checked = true); },
  clear(){ document.querySelectorAll('#exam-builder-chapters input.eb-ch').forEach(c => c.checked = false); },
  generate(){
    const ids = [...document.querySelectorAll('#exam-builder-chapters input.eb-ch:checked')].map(c => c.value);
    if (!ids.length) return toast('Choose at least one chapter.');
    const marks = parseInt($('exam-builder-marks').value, 10) || 100;
    const mode = $('exam-builder-mode').value;
    if (typeof SUBJ === 'undefined' || typeof SUBJ._buildCustomExam !== 'function') {
      return toast('The question bank is still loading — try again in a moment.');
    }
    SUBJ._buildCustomExam(ids, marks, mode);
  }
};

function _briefDuration(ms){
  if (ms < 0) return 'now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return mins + ' min';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour' : ' hours');
  const d = Math.floor(hrs / 24);
  return d + (d === 1 ? ' day' : ' days');
}

function _dueItems(){
  const out = [];

  try {
    if (typeof SUBJ !== 'undefined' && SUBJ._hasBank && SUBJ._hasBank() && SUBJ._qotdPublicState) {
      const st = SUBJ._qotdPublicState();
      if (!st || st.phase === 'idle') {
        out.push({ icon:'ph-sun-horizon', title:"Today's written question", sub:'Ready when you are', meta:(st && st.marks ? st.marks + ' marks' : ''), go:"UI.go('subj-qotd')" });
      } else if (st.phase === 'solving') {
        out.push({ icon:'ph-pencil-line', title:'You are writing now', sub:'Time left to finish', meta:st.left, urgent:(st.leftSec || 0) < 120, go:"UI.go('subj-qotd')" });
      } else if (st.phase === 'upload') {
        out.push({ icon:'ph-upload-simple', title:'Upload your answer', sub:'The window closes soon', meta:st.left, urgent:true, go:"UI.go('subj-qotd')" });
      }
    }
  } catch(e){}

  try {
    if (typeof WEEKLY !== 'undefined') {
      const sets = WEEKLY.sets || [], attempts = WEEKLY.attempts || {};
      sets.forEach(s => {
        if (!s.released) {
          const ms = new Date(s.releaseAt).getTime() - Date.now();
          if (ms > 0 && ms < 24 * 60 * 60 * 1000) {
            out.push({ icon:'ph-lock-simple', title:s.title, sub:'Unlocks soon', meta:'in ' + _briefDuration(ms), go:"UI.go('weekly')" });
          }
          return;
        }
        if (attempts[s.id]) return;
        const closeAt = WEEKLY.examCloseAt ? WEEKLY.examCloseAt(s) : null;
        if (closeAt && Date.now() < closeAt) {
          const left = closeAt - Date.now();
          out.push({
            icon:'ph-calendar-check', title:s.title, sub:'One attempt, closes soon',
            meta:_briefDuration(left) + ' left', urgent:left < 60 * 60 * 1000, go:"UI.go('weekly')"
          });
        }
      });
    }
  } catch(e){}

  try {
    if (typeof REV !== 'undefined' && REV.dueCount) {
      const n = REV.dueCount();
      if (n > 0) out.push({
        icon:'ph-arrow-counter-clockwise',
        title:(n === 1 ? '1 question is' : n + ' questions are') + ' ready again',
        sub:'You missed these before',
        meta:'Review', go:"REV.start('wr','flashcard',true)"
      });
    }
  } catch(e){}

  return out;
}

function _renderDueStrip(){
  const box = $('due-strip');
  if (!box) return;
  const items = _dueItems();
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = items.slice(0, 3).map(i =>
    '<button class="due-item' + (i.urgent ? ' urgent' : '') + '" data-on-click="' + i.go + '">' +
      '<span class="due-ic"><i class="ph ' + i.icon + '"></i></span>' +
      '<span class="due-body">' +
        '<span class="due-title">' + esc(i.title) + '</span>' +
        '<span class="due-sub">' + esc(i.sub) + '</span>' +
      '</span>' +
      (i.meta ? '<span class="due-meta">' + esc(i.meta) + '</span>' : '') +
    '</button>'
  ).join('');
}

function _renderMarquee(){
  const bar = $('home-marquee'), track = $('marquee-track');
  if (!bar || !track) return;
  const items = _dueItems().filter(i => i.urgent);
  if (!items.length) { bar.style.display = 'none'; return; }
  const i = items[0];
  bar.style.display = '';
  bar.classList.add('urgent');
  track.innerHTML = '<span class="marquee-item"><strong>' + esc(i.title) + '</strong> — ' + esc(i.meta || i.sub) + '</span>';
}

window.SB_HINTS = {
  refresh(){
    const qHint = $('subj-qotd-hint'), qBadge = $('subj-qotd-badge');
    if (qHint && qBadge && typeof SUBJ !== 'undefined') {
      const st = SUBJ._qotdPublicState ? SUBJ._qotdPublicState() : null;
      const ready = SUBJ._hasBank ? SUBJ._hasBank() : false;
      if (!ready)                       { qHint.textContent = 'Nothing set up yet';        qBadge.hidden = true; }
      else if (!st || st.phase === 'idle'){ qHint.textContent = 'Ready — tap to begin';    qBadge.hidden = false; }
      else if (st.phase === 'solving')  { qHint.textContent = 'Writing · ' + (st.left||''); qBadge.hidden = true; }
      else if (st.phase === 'upload')   { qHint.textContent = 'Upload window is open';     qBadge.hidden = false; }
      else if (st.phase === 'submitted'){ qHint.textContent = 'Sent for marking';          qBadge.hidden = true; }
      else                              { qHint.textContent = 'Back tomorrow';             qBadge.hidden = true; }
    }

    const wHint = $('weekly-hint'), wBadge = $('weekly-badge');
    if (wHint && wBadge && typeof WEEKLY !== 'undefined') {
      const sets = WEEKLY.sets || [], attempts = WEEKLY.attempts || {};
      const live = sets.filter(s => s.released && !attempts[s.id] && WEEKLY.examOpen && WEEKLY.examOpen(s));
      const upcoming = sets.filter(s => !s.released);
      if (live.length) {
        wHint.textContent = live.length === 1 ? 'One test is open now' : live.length + ' tests are open now';
        wBadge.hidden = false;
      } else if (upcoming.length) {
        const next = upcoming.slice().sort((a,b) => new Date(a.releaseAt) - new Date(b.releaseAt))[0];
        wHint.textContent = 'Next unlocks in ' + _briefDuration(new Date(next.releaseAt).getTime() - Date.now());
        wBadge.hidden = true;
      } else if (sets.length) {
        wHint.textContent = sets.length === 1 ? 'One set to review' : sets.length + ' sets to review';
        wBadge.hidden = true;
      } else {
        wHint.textContent = 'No sets yet';
        wBadge.hidden = true;
      }
    }

    if (typeof MY_SUBJ !== 'undefined') MY_SUBJ.refreshHint();
    if (typeof VERIFY !== 'undefined') VERIFY.render();
    if (typeof SUBJ_BUILDER !== 'undefined') SUBJ_BUILDER._updateCooldownUI();

    _renderDueStrip();
    _renderMarquee();
  }
};
/* ═══════════════════════════════════════════════════════════════════════
   MASTERY: one place that answers "is this chapter complete?" using chapterMastery() from shared.js. */
window.MASTERY = {
  _fids(lv, ch){ return ChapterData.chapterFileRefs(lv, ch).map(r => r.fid); },
  chapter(lv, ch){
    return chapterMastery({ fids: this._fids(lv, ch), fcount: S.fcount, cov: S.cov, wr: S.wr });
  },
  /* the chapters the 60-day sprint is planned over: Level 7 and General Knowledge */
  filteredChapters(){
    const out = [];
    SPRINT_LEVELS.forEach(lv => {
      try { Object.keys(ChapterData.chapters(lv)).forEach(ch => { if (ChapterData.chapterFileRefs(lv, ch).length) out.push({ lv, ch }); }); } catch(e){}
    });
    return out;
  },
  summary(){
    const list = this.filteredChapters();
    let done = 0;
    list.forEach(c => { if (this.chapter(c.lv, c.ch).state === 'complete') done++; });
    return { done, total: list.length };
  }
};

window.CH_GRID = {
  lv: '',
  LEVELS: [['level7', 'Level 7'], ['level5', 'Level 5'], ['gk', 'General Knowledge']],

  _stats(refs){
    let seen = 0, total = 0, known = 0;
    refs.forEach(r => {
      const c = S.cov && S.cov[r.fid];
      if (c && c.p) for (let i = 0; i < c.p.length; i++) if (c.p[i] !== '0') seen++;
      const n = S.fcount && S.fcount[r.fid];
      if (n != null) { total += n; known++; }
    });
    return { seen: seen, total: total, complete: refs.length > 0 && known === refs.length };
  },

  _last(){
    return ((S.prog && S.prog.sessions) || []).find(x => x.fid && x.lv && x.ch) || null;
  },

  _ref(fid){
    return ChapterData.allFileRefs().find(r => r.fid === fid) || null;
  },

  render(){
    const box = $('chgrid');
    if (!box || typeof ChapterData === 'undefined') return;
    const last = this._last();
    if (!this.lv) this.lv = (last && last.lv) || 'level7';

    let html = '';
    const lastRef = last ? this._ref(last.fid) : null;
    if (lastRef) {
      const st = this._stats([lastRef]);
      html += '<div class="card" style="border-color:var(--accent-line);background:var(--accent-soft)">' +
        '<div class="t-cap" style="color:var(--accent);font-weight:700">Continue</div>' +
        '<div class="t-t3" style="margin:2px 0 var(--sp-2)">' + esc(ChapterData.chapterName(lastRef.lv, lastRef.ch)) + ': ' + esc(prettySub(lastRef.subtopic)) + '</div>' +
        '<div class="t-foot mb3">' + (st.total ? st.seen + ' of ' + st.total + ' seen' : st.seen + ' seen') + '</div>' +
        '<div class="bg"><button class="btn btn-solid" type="button" data-on-click="CH_GRID.startFid(\'' + lastRef.fid + '\',\'flashcard\')">Practise</button>' +
        '<button class="btn btn-quiet" type="button" data-on-click="CH_GRID.startFid(\'' + lastRef.fid + '\',\'exam\')">Timed test</button></div></div>';
    }

    const tabs = this.LEVELS.map(l =>
      '<button type="button" class="' + (l[0] === this.lv ? 'active' : '') + '" data-on-click="CH_GRID.setLevel(\'' + l[0] + '\')">' + esc(l[1]) + '</button>').join('');
    const chs = ChapterData.chapters(this.lv);
    const cards = Object.keys(chs).map(ch => {
      const refs = ChapterData.chapterFileRefs(this.lv, ch);
      const has = refs.length > 0;
      const st = this._stats(refs);
      const pct = (st.complete && st.total) ? Math.min(100, Math.round(st.seen / st.total * 100)) : null;
      const missed = (typeof WRONGBY !== 'undefined') ? WRONGBY.countForChapter(this.lv, ch) : 0;
      const mst = has ? MASTERY.chapter(this.lv, ch) : null;
      const done = !!mst && mst.state === 'complete';
      const gate = (mst && mst.state === 'in-progress' && mst.needs.length) ? mst.needs[0] : '';
      const meta = !has ? 'Coming soon'
        : (done ? 'Complete \u00b7 ' + Math.round(mst.accuracy * 100) + '% accuracy \u00b7 ' : (pct !== null ? pct + '% seen \u00b7 ' : (st.seen ? st.seen + ' seen \u00b7 ' : ''))) + refs.length + (refs.length === 1 ? ' set' : ' sets') +
          (missed ? ' \u00b7 ' + missed + ' missed' : '') + (gate ? ' \u00b7 ' + gate : '');
      const missedBadge = missed
        ? '<span class="ctag tr" style="position:absolute;top:.4rem;right:.4rem">' + missed + ' missed</span>'
        : '';
      return '<button type="button" class="chg-card" style="position:relative"' + (has ? '' : ' disabled') + ' data-on-click="CH_GRID.open(\'' + this.lv + '\',\'' + ch + '\')">' +
        missedBadge +
        '<span class="chg-name">' + (done ? '<i class="ph ph-seal-check" style="color:var(--success)" aria-label="Complete"></i> ' : '') + esc(chs[ch]) + '</span>' +
        (has ? '<span class="pb" style="display:block"><span class="pb-f" style="display:block;width:' + (pct === null ? 0 : pct) + '%"></span></span>' : '') +
        '<span class="chg-meta">' + esc(meta) + '</span></button>';
    }).join('');
    box.innerHTML = html + '<div class="chg-tabs">' + tabs + '</div><div class="chg-grid">' + cards + '</div>';
  },

  setLevel(id){ this.lv = id; this.render(); },

  async open(lv, ch){
    const refs = ChapterData.chapterFileRefs(lv, ch);
    if (!refs.length) return;
    const name = ChapterData.chapterName(lv, ch);
    let keys = new Set();
    try { keys = new Set(await QDB.keys()); } catch(e){}
    const offline = !(S.online && !S.forcedOffline);
    const missedFor = fid => (typeof WRONGBY !== 'undefined') ? WRONGBY.countFor(fid) : 0;
    const rows = refs.map(r => {
      const st = this._stats([r]);
      const cached = keys.has(r.key);
      const blocked = offline && !cached;
      const m = missedFor(r.fid);
      return '<div class="row" style="padding:var(--sp-2) 0">' +
        '<div class="row-main"><div class="t-callout" style="color:var(--ink);font-weight:600">' + esc(prettySub(r.subtopic)) + '</div>' +
        '<div class="t-cap">' + (st.total ? st.seen + ' of ' + st.total + ' seen' : (st.seen ? st.seen + ' seen' : 'Not started')) +
        (cached ? ' · saved on this device' : (blocked ? ' · needs a connection' : '')) +
        (m ? ' · ' + m + ' missed' : '') + '</div></div>' +
        '<button class="btn btn-sm btn-a" type="button"' + (blocked ? ' disabled' : '') + ' data-on-click="CH_GRID.go(\'' + r.fid + '\',\'flashcard\')">Practise</button>' +
        (m ? '<button class="btn btn-sm btn-r" type="button" data-on-click="closeMod();WRONGBY.startFile(\'' + escAttrJs(r.fid) + '\',false)">Missed (' + m + ')</button>' : '') +
        '<button class="btn btn-sm btn-quiet" type="button"' + (blocked ? ' disabled' : '') + ' data-on-click="CH_GRID.go(\'' + r.fid + '\',\'exam\')">Test</button>' +
        '<button class="btn btn-sm ch-row-print" type="button" title="Print a revision sheet"' + (blocked ? ' disabled' : '') + ' data-on-click="PRINT_Q.sheet(\'' + escAttrJs(r.fid) + '\')"><i class="ph ph-printer"></i></button>' +
        '</div>';
    }).join('');
    const head = refs.length > 1
      ? '<div class="bg mb3"><button class="btn btn-solid" type="button"' + (offline ? ' disabled' : '') + ' data-on-click="CH_GRID.startChapter(\'' + lv + '\',\'' + ch + '\',\'flashcard\')">Practise the whole chapter</button>' +
        '<button class="btn btn-quiet" type="button"' + (offline ? ' disabled' : '') + ' data-on-click="CH_GRID.startChapter(\'' + lv + '\',\'' + ch + '\',\'exam\')">Timed test</button></div>'
      : '';
    openMod(name, head + '<div class="rows">' + rows + '</div>');
  },

  go(fid, mode){ closeMod(); this.startFid(fid, mode); },

  startFid(fid, mode){
    const r = this._ref(fid);
    if (!r) { toast('That set is not available.'); return; }
    const name = ChapterData.chapterName(r.lv, r.ch) + ' \u2014 ' + r.book;
    QUIZ.load(r.fid, r.key, mode, name, { lv: r.lv, ch: r.ch, book: r.book, sub: r.subtopic, fid: r.fid });
  },

  async startChapter(lv, ch, mode){
    closeMod();
    const refs = ChapterData.chapterFileRefs(lv, ch);
    if (!refs.length) return;
    QUIZ._showLoader('Loading ' + refs.length + ' sets…');
    const all = [];
    let i = 0, done = 0, failed = 0;
    const worker = async () => {
      while (i < refs.length) {
        const ref = refs[i++];
        try { all.push(...normQ(await QUIZ._fetch(ref.fid, ref.key), ref.fid)); }
        catch(e){ failed++; }
        done++;
        const m = $('quiz-loader-msg');
        if (m) m.textContent = 'Loading sets (' + done + '/' + refs.length + ')…';
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
    QUIZ._hideLoader();
    if (!all.length) { toast('Could not load this chapter. Download it while online first.', 5000); return; }
    if (failed) toast(failed + ' set(s) could not load. Starting with ' + all.length + ' questions.', 4000);
    QUIZ.startWith(all, mode, ChapterData.chapterName(lv, ch) + ' \u2014 ' + refs[0].book, { lv: lv, ch: ch });
  }
};

/* Announcement banner from the admin console. Also watches the content
   version: when an admin fixes a question, this phone refreshes its
   downloaded chapters the next time they are opened. */
window.ANNOUNCE = {
  _last: 0,
  _text: '',
  async load(){
    if (Date.now() - this._last < 5 * 60 * 1000) { this.render(); return; }
    let url = '', online = true;
    try { url = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || ''; } catch(e){}
    try { online = !!(S.online && !S.forcedOffline); } catch(e){}
    if (!url || !online) { this.render(); return; }
    this._last = Date.now();
    try {
      const r = await fetch(url + '?action=getPublicInfo', { cache: 'no-store' });
      const res = await r.json();
      if (res && res.success) {
        this._text = String(res.announcement || '').trim();
        try { localStorage.setItem('abhyas_announce', this._text); } catch(e){}
        try { localStorage.setItem('abhyas_lscheme', String(res.loksewaScheme || '')); } catch(e){}
        const cv = String(res.contentVersion || '');
        if (cv) {
          try {
            if (localStorage.getItem('abhyas_cv') !== cv) {
              localStorage.removeItem('abhyas_qts');
              localStorage.setItem('abhyas_cv', cv);
            }
          } catch(e){}
        }
      }
    } catch(e){}
    this.render();
  },
  _key(t){ let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return String(h); },
  render(){
    const bar = $('announce-bar'), tx = $('announce-text');
    if (!bar || !tx) return;
    let t = this._text;
    if (!t) { try { t = localStorage.getItem('abhyas_announce') || ''; } catch(e){} }
    let hidden = '';
    try { hidden = localStorage.getItem('abhyas_announce_hidden') || ''; } catch(e){}
    if (!t || hidden === this._key(t)) { bar.hidden = true; return; }
    tx.textContent = t;
    bar.hidden = false;
  },
  dismiss(){
    let t = this._text || '';
    try { t = t || localStorage.getItem('abhyas_announce') || ''; localStorage.setItem('abhyas_announce_hidden', this._key(t)); } catch(e){}
    this.render();
  }
};

/* Text size: Normal, Large, Extra large. Everything is sized in rem, so this
   scales the whole app. */
window.FONT = {
  STEPS: [100, 112, 125],
  NAMES: ['Normal', 'Large', 'Extra large'],
  get(){
    try {
      const v = JSON.parse(localStorage.getItem('abhyas_fs') || '100');
      return this.STEPS.indexOf(v) === -1 ? 100 : v;
    } catch(e){ return 100; }
  },
  apply(v){ document.documentElement.style.fontSize = v === 100 ? '' : v + '%'; },
  cycle(){
    const i = (this.STEPS.indexOf(this.get()) + 1) % this.STEPS.length;
    const v = this.STEPS[i];
    try { localStorage.setItem('abhyas_fs', JSON.stringify(v)); } catch(e){}
    this.apply(v);
    toast('Text size: ' + this.NAMES[i]);
  }
};

function _renderHomeExtras(){
  try { if (typeof RECOVERY !== 'undefined') RECOVERY.render(); } catch(e){}
  try { if (typeof TODAY_PLAN !== 'undefined') TODAY_PLAN.render(); } catch(e){}
  try { if (typeof TODAY_PLAN !== 'undefined') TODAY_PLAN._renderResume(); } catch(e){}
  try { if (typeof READINESS !== 'undefined') READINESS.render(); } catch(e){}
  try { if (typeof PACE !== 'undefined') PACE.render(); } catch(e){}
  try { if (typeof BADGES_UI !== 'undefined') BADGES_UI.render(); } catch(e){}
  try { if (typeof WEEKLY_BOARD !== 'undefined') WEEKLY_BOARD.render(); } catch(e){}
}

/* ═══════════════════════════════════════════════════════════════════
   CONF — confidence rating after each flashcard answer.
   "Sure" + wrong  → misconception (surfaced on Home).
   "Guess" + right → not credited as mastery; SR doesn't advance.
   No tap          → treated as "not sure" (the default).
   ═══════════════════════════════════════════════════════════════════ */
window.CONF = {
  render(){
    const box = $('fc-conf');
    if (!box) return;
    if (!S.quiz || !S.quiz.qs) { box.innerHTML = ''; return; }
    const idx = S.quiz.idx;
    const answered = S.quiz.ans[idx] !== null && S.quiz.ans[idx] !== undefined;
    if (!answered || S.quiz.reviewOnly) { box.innerHTML = ''; return; }
    const chosen = (S.quiz.conf && S.quiz.conf[idx]) || null;
    box.innerHTML =
      '<div class="conf-prompt">' +
        '<div class="conf-q">How sure were you?</div>' +
        '<div class="conf-btns" role="group" aria-label="Confidence in this answer">' +
          '<button type="button" class="conf-btn' + (chosen === 'sure' ? ' on' : '') + '" data-level="sure" data-on-click="QUIZ.setConf(\'sure\')">Sure</button>' +
          '<button type="button" class="conf-btn' + (chosen === 'unsure' ? ' on' : '') + '" data-level="unsure" data-on-click="QUIZ.setConf(\'unsure\')">Not sure</button>' +
          '<button type="button" class="conf-btn' + (chosen === 'guess' ? ' on' : '') + '" data-level="guess" data-on-click="QUIZ.setConf(\'guess\')">Guessed</button>' +
        '</div>' +
      '</div>';
  }
};

QUIZ.setConf = function(level){
  if (!S.quiz || S.quiz.reviewOnly) return;
  const idx = S.quiz.idx;
  if (!S.quiz.conf) S.quiz.conf = {};
  S.quiz.conf[idx] = level;
  const q = S.quiz.qs[idx];
  const ans = S.quiz.ans[idx];
  if (!q || ans === null || ans === undefined) { CONF.render(); return; }
  const item = (S.wr || []).find(x => x.uid === q.uid);
  const wasWrong = !isOk(ans, q.correct);
  if (item) {
    if (wasWrong && level === 'sure') {
      item._misconception = true;
      item._reason = 'careless';
    } else if (wasWrong && (level === 'unsure' || level === 'guess')) {
      item._reason = 'concept';
      item._misconception = false;
    } else if (!wasWrong && level === 'guess' && item._nextDue) {
      item._nextDue = Date.now();
    }
    _save(LS.WR, S.wr);
  }
  CONF.render();
};

/* ═══════════════════════════════════════════════════════════════════
   MISCONCEPTIONS — questions you were confident about and got wrong.
   ═══════════════════════════════════════════════════════════════════ */
window.MISCONCEPTIONS = {
  list(){
    try { return (S.wr || []).filter(x => x._misconception); } catch(e){ return []; }
  },
  render(){
    const box = $('misconception-slot');
    if (!box) return;
    const items = this.list();
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML =
      '<section class="misconception-card">' +
        '<div class="head"><i class="ph ph-warning-circle"></i> Misconceptions to fix' +
          '<span class="count">' + items.length + '</span></div>' +
        '<p>You were <b>sure</b> of the wrong answer on these. Fixing a misconception raises your score faster than anything else \u2014 the idea is already in your head, it just needs correcting.</p>' +
        '<button class="btn btn-solid btn-blk" data-on-click="MISCONCEPTIONS.start()">' +
          '<i class="ph ph-target"></i> Review these ' + items.length + ' now' +
        '</button>' +
      '</section>';
  },
  start(){
    const items = this.list();
    if (!items.length) return;
    QUIZ.startWith(items.slice(), 'flashcard', '\U0001F3AF Misconceptions', null);
  }
};

/* ═══════════════════════════════════════════════════════════════════
   RECOVERY — welcome back after 3+ days away.
   A short, easy re-entry beats a full normal session when a student
   has been away: the worst thing is they open the app, see 400 wrong
   answers due, and close it again.
   ═══════════════════════════════════════════════════════════════════ */
window.RECOVERY = {
  KEY: 'abhyas_last_active',
  DAYS: 3,

  markActive(){
    try { localStorage.setItem(this.KEY, String(Date.now())); } catch(e){}
  },
  _gapMs(){
    try {
      const raw = Number(localStorage.getItem(this.KEY) || 0);
      if (!raw) return 0;
      return Date.now() - raw;
    } catch(e){ return 0; }
  },
  shouldShow(){
    const gap = this._gapMs();
    return gap >= this.DAYS * 24 * 60 * 60 * 1000;
  },
  render(){
    const box = $('recovery-slot');
    if (!box) return;
    if (!this.shouldShow()) { box.innerHTML = ''; return; }
    const days = Math.round(this._gapMs() / 86400000);
    box.innerHTML =
      '<section class="recovery-card">' +
        '<div class="head"><i class="ph ph-hand-waving"></i> Welcome back</div>' +
        '<p>It\u2019s been ' + days + ' day' + (days === 1 ? '' : 's') + '. Nothing is lost \u2014 your progress and streak are safe. Let\u2019s start with 5 gentle questions from the chapters you\u2019re strongest at.</p>' +
        '<div class="bg">' +
          '<button class="btn btn-solid" data-on-click="RECOVERY.start()"><i class="ph ph-play-circle"></i> Start gently</button>' +
          '<button class="btn btn-quiet" data-on-click="RECOVERY.dismiss()">Skip for now</button>' +
        '</div>' +
      '</section>';
  },
  dismiss(){
    // Do not mark active here — if they browse and close without studying,
    // the card should come back next time.
    const box = $('recovery-slot');
    if (box) box.innerHTML = '';
  },
  async start(){
    const refs = this._strongFiles();
    if (!refs.length) { QUIZ.daily(); return; }
    toast('Loading 5 gentle questions\u2026', 1500);
    const all = [];
    for (const ref of refs.slice(0, 2)) {
      try {
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        all.push(...normQ(raw, ref.fid));
      } catch(e){}
      if (all.length >= 15) break;
    }
    if (!all.length) { QUIZ.daily(); return; }
    QUIZ.startWith(shuf(all).slice(0, 5), 'flashcard', '\U0001F44B Back gently', null);
    this.markActive();
  },
  _strongFiles(){
    try {
      const entries = (typeof CHAPSTATS !== 'undefined' && CHAPSTATS.entries) ? CHAPSTATS.entries() : [];
      const strongChapters = new Set(
        entries.filter(e => e.attempted >= 5 && e.accuracy >= 70).map(e => e.chapter)
      );
      if (!strongChapters.size) return [];
      const all = ChapterData.allFileRefs();
      return shuf(all.filter(r => strongChapters.has(ChapterData.chapterName(r.lv, r.ch))));
    } catch(e){ return []; }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   READALOUD — SpeechSynthesis for the current question.
   ═══════════════════════════════════════════════════════════════════ */
window.READALOUD = {
  _btn: null,
  supported(){
    return typeof window.speechSynthesis !== 'undefined' &&
           typeof window.SpeechSynthesisUtterance !== 'undefined';
  },
  _text(){
    if (!S.quiz || !S.quiz.qs) return '';
    const q = S.quiz.qs[S.quiz.idx];
    if (!q) return '';
    const opts = (q.options || []).map((o, i) => String.fromCharCode(65 + i) + ': ' + o).join('. ');
    return (q.q || '') + '. ' + opts;
  },
  render(){
    const box = $('fc-tools');
    if (!box) return;
    if (!this.supported()) { box.innerHTML = ''; return; }
    const speaking = window.speechSynthesis.speaking;
    box.innerHTML =
      '<button type="button" class="tts-btn' + (speaking ? ' speaking' : '') + '" ' +
        'data-on-click="READALOUD.toggle()" aria-label="Read this question aloud">' +
        '<i class="ph ph-speaker-high"></i> ' + (speaking ? 'Stop' : 'Read') +
      '</button>';
  },
  toggle(){
    if (!this.supported()) return;
    if (window.speechSynthesis.speaking) { this.stop(); return; }
    const text = this._text();
    if (!text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-IN';
      u.rate = 0.95;
      u.onend = () => READALOUD.render();
      u.onerror = () => READALOUD.render();
      window.speechSynthesis.speak(u);
      this.render();
    } catch(e){}
  },
  stop(){
    if (!this.supported()) return;
    try { window.speechSynthesis.cancel(); } catch(e){}
    this.render();
  }
};

/* PACE — ahead or behind, in plain words under the study-time line. */
window.PACE = {
  render(){
    const el = $('hs-time');
    if (!el || !el.parentElement) return;
    let pace = null;
    try { pace = PACE._compute(); } catch(e){}
    let line = el.parentElement.querySelector('.pace-line');
    if (!line) {
      line = document.createElement('span');
      line.className = 'pace-line';
      el.parentElement.appendChild(line);
    }
    if (!pace) { line.textContent = ''; return; }
    if (pace.onTrack) {
      line.innerHTML = ' \u00b7 <span class="on-track"><i class="ph ph-check-circle"></i> on pace for your target</span>';
    } else {
      const gap = Math.max(1, Math.round((pace.target - pace.actual) / 60));
      line.innerHTML = ' \u00b7 <span class="behind"><i class="ph ph-warning-circle"></i> ' + gap + ' min behind your weekly pace</span>';
    }
  },
  _compute(){
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let actualSec = 0;
    ((S.prog && S.prog.sessions) || []).forEach(s => {
      if ((s.at || 0) >= weekAgo) actualSec += (s.durationSec || 0);
    });
    let targetSec = 5 * 3600;
    try {
      const v = (typeof EXAM_DATE !== 'undefined' && EXAM_DATE.get) ? EXAM_DATE.get() : '';
      if (v) {
        const p = v.split('-').map(Number);
        const target = new Date(p[0], p[1] - 1, p[2]).getTime();
        const days = Math.max(1, Math.round((target - Date.now()) / 86400000));
        targetSec = Math.min(20 * 3600, Math.max(3 * 3600, (120 * 3600) / Math.max(7, days) * 7));
      }
    } catch(e){}
    return { actual: actualSec, target: targetSec, onTrack: actualSec >= targetSec * 0.85 };
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   HARDQ — "X% of students miss this" badge. */
window.HARDQ = {
  _map: null,
  load(){
    try {
      const raw = localStorage.getItem('abhyas_hardq');
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.map && Date.now() - o.at < 24*60*60*1000) { this._map = o.map; return; }
      }
    } catch(e){}
    if (!S.online || S.forcedOffline) return;
    const url = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || '';
    if (!url) return;
    fetch(url + '?action=gethardquestions', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d && d.success && d.map) {
          this._map = d.map;
          try { localStorage.setItem('abhyas_hardq', JSON.stringify({ at: Date.now(), map: d.map })); } catch(e){}
        }
      })
      .catch(() => {});
  },
  forUid(uid){ return (this._map && this._map[uid]) || 0; }
};

function _refreshHints(){
  /* v1.25: focus mode removed — clear any leftover class. */
  try { document.documentElement.classList.remove('focus-mode'); } catch(e){}
  /* v1.29: paint the reset-recovery card if a recent snapshot exists. */
  try { if (typeof RESET_SNAPSHOT !== 'undefined') RESET_SNAPSHOT.renderCard(); } catch(e){}
  try { if (typeof SIDEBAR   !== 'undefined') SIDEBAR.init(); } catch(e){}
  try { SB_HINTS.refresh(); } catch(e){}
  try { TRIAL_PILL.render(); } catch(e){}
  try { ANNOUNCE.load(); } catch(e){}
  try { _renderHomeExtras(); } catch(e){}
  try { HARDQ.load(); } catch(e){}
  try { if (typeof SYLLABUS_MOCK     !== 'undefined') SYLLABUS_MOCK.render(); } catch(e){}
  try { if (typeof PRACTICE_RESUME   !== 'undefined') PRACTICE_RESUME.render(); } catch(e){}
  try { if (typeof SPRINT           !== 'undefined') SPRINT.render(); } catch(e){}
  try { if (typeof DAILY10           !== 'undefined') DAILY10.render(); } catch(e){}
  try { if (typeof DIGEST            !== 'undefined') DIGEST.render(); } catch(e){}
  try { if (typeof CALENDAR          !== 'undefined') CALENDAR.render(); } catch(e){}
  try { if (typeof FORECAST          !== 'undefined') FORECAST.render(); } catch(e){}
  try { if (typeof SYLLABUS_PROGRESS !== 'undefined') SYLLABUS_PROGRESS.render(); } catch(e){}
}

/* ═══════════════════════════════════════════════════════════════════════
   INSIGHTS — Progress charts drawn as inline SVG (no library, no network):
   14-day activity, accuracy trend, study-day consistency, and a
   this-week-vs-last-week summary. Data maths: insightsData() in shared.js.
   ═══════════════════════════════════════════════════════════════════════ */
window.INSIGHTS = {
  GOAL: 40,

  _bars(days){
    const W = 320, H = 120, padL = 4, padB = 18, padT = 8, n = days.length;
    const max = Math.max(this.GOAL, ...days.map(d => d.q), 1);
    const bw = (W - padL * 2) / n, plotH = H - padB - padT;
    const y = v => padT + plotH - (v / max) * plotH;
    const bars = days.map((d, i) => {
      const h = Math.max(d.q ? 2 : 0, (d.q / max) * plotH), x = padL + i * bw + 2;
      const col = d.q >= this.GOAL ? 'var(--grn)' : d.q > 0 ? 'var(--accent)' : 'transparent';
      return '<rect x="' + x.toFixed(1) + '" y="' + (padT + plotH - h).toFixed(1) + '" width="' + (bw - 4).toFixed(1) +
        '" height="' + h.toFixed(1) + '" rx="3" fill="' + col + '"' + (d.isToday ? ' opacity="1"' : ' opacity=".85"') + '></rect>' +
        '<text x="' + (x + (bw - 4) / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" font-size="8" fill="var(--t3)"' +
        (d.isToday ? ' font-weight="700"' : '') + '>' + d.label.charAt(0) + '</text>';
    }).join('');
    const gy = y(this.GOAL).toFixed(1);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Questions answered per day over the last 14 days">' +
      '<line x1="0" x2="' + W + '" y1="' + gy + '" y2="' + gy + '" stroke="var(--t3)" stroke-width=".8" stroke-dasharray="3 3" opacity=".6"></line>' +
      '<text x="' + (W - 2) + '" y="' + (Number(gy) - 3) + '" text-anchor="end" font-size="8" fill="var(--t3)">goal ' + this.GOAL + '</text>' +
      bars + '</svg>';
  },

  _line(points){
    if (points.length < 2) return '';
    const W = 320, H = 110, p = 10, n = points.length;
    const x = i => p + (i / (n - 1)) * (W - p * 2), y = v => p + (1 - v / 100) * (H - p * 2);
    const path = points.map((pt, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(pt.pct).toFixed(1)).join(' ');
    const dots = points.map((pt, i) => '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(pt.pct).toFixed(1) + '" r="' + (i === n - 1 ? 4 : 2.5) +
      '" fill="' + (pt.pct >= 70 ? 'var(--grn)' : pt.pct >= 50 ? 'var(--amb)' : 'var(--ros)') + '"></circle>').join('');
    const py = y(70).toFixed(1);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Score of your last ' + n + ' sessions">' +
      '<line x1="' + p + '" x2="' + (W - p) + '" y1="' + py + '" y2="' + py + '" stroke="var(--grn)" stroke-width=".8" stroke-dasharray="3 3" opacity=".6"></line>' +
      '<text x="' + (W - p) + '" y="' + (Number(py) - 3) + '" text-anchor="end" font-size="8" fill="var(--t3)">70% target</text>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>' + dots + '</svg>';
  },

  _strip(cells){
    const cols = 12, size = 14, gap = 3, W = cols * (size + gap), H = 7 * (size + gap);
    const out = cells.map((c, i) => {
      const col = Math.floor(i / 7), row = i % 7;
      const fill = c.active ? (c.q >= this.GOAL ? 'var(--grn)' : 'var(--accent)') : 'var(--t3)';
      return '<rect x="' + col * (size + gap) + '" y="' + row * (size + gap) + '" width="' + size + '" height="' + size + '" rx="3" fill="' + fill +
        '" opacity="' + (c.active ? '1' : '.18') + '"><title>' + c.date + (c.active ? ' \u2713' : '') + '</title></rect>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:260px" role="img" aria-label="Study days over the last 12 weeks">' + out + '</svg>';
  },

  _delta(label, cur, prev, unit){
    if (prev === null || cur === null) return '<div class="t-cap">' + label + ': <b>' + (cur === null ? '\u2014' : cur + unit) + '</b></div>';
    const d = cur - prev, cls = d > 0 ? 'ok' : d < 0 ? 'low' : 'mid', arrow = d > 0 ? '\u25B2' : d < 0 ? '\u25BC' : '\u25AC';
    return '<div class="t-cap">' + label + ': <b>' + cur + unit + '</b> <span class="pct ' + cls + '">' + arrow + ' ' + Math.abs(d) + unit + ' vs last week</span></div>';
  },

  render(){
    const box = $('insights-card');
    if (!box) return;
    const d = insightsData((S.prog && S.prog.sessions) || [], (S.stk && S.stk.days) || [], new Date());
    if (!d.recent.length && !d.activeDays12w) {
      box.innerHTML = '<div class="card-hd"><h3><i class="ph ph-chart-line-up"></i> Insights</h3></div>' +
        '<div class="empty"><p>Finish a quiz and your daily activity, score trend and study streak will appear here.</p></div>';
      return;
    }
    box.innerHTML =
      '<div class="card-hd"><h3><i class="ph ph-chart-line-up"></i> Insights</h3></div>' +
      '<div class="t-cap" style="margin-bottom:6px"><b>Questions per day</b> \u00b7 last 14 days</div>' + this._bars(d.last14) +
      '<div style="margin:10px 0 14px">' +
        this._delta('Questions this week', d.weekQuestions, d.prevWeekQuestions, '') +
        this._delta('Accuracy this week', d.accWeek, d.accPrev, '%') +
        '<div class="t-cap">Study time this week: <b>' + (d.weekMinutes >= 60 ? Math.floor(d.weekMinutes / 60) + ' h ' + (d.weekMinutes % 60) + ' min' : d.weekMinutes + ' min') + '</b></div>' +
      '</div>' +
      (d.recent.length > 1 ? '<div class="t-cap" style="margin-bottom:6px"><b>Score trend</b> \u00b7 last ' + d.recent.length + ' sessions</div>' + this._line(d.recent) : '') +
      '<div class="t-cap" style="margin:14px 0 6px"><b>Consistency</b> \u00b7 ' + d.activeDays12w + ' study days in 12 weeks' + (d.streak ? ' \u00b7 \ud83d\udd25 ' + d.streak + '-day streak' : '') + '</div>' + this._strip(d.cells);
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   STUDYDOCS — "Model answers & notes": PDFs the admin uploads for students.
   List: listStudyDocs. Bytes: getStudyDocPdf (the Drive files stay private and
   the paywall applies). Opened PDFs are kept on the device so they work offline
   (IndexedDB via QDB, newest 20, up to 8 MB each). Filtering and "new" tracking
   are pure helpers in shared.js (studyDocsFilter, studyDocsNewIds).
   ═══════════════════════════════════════════════════════════════════════ */
window.STUDYDOCS = {
  LIST_KEY: 'abhyas_studydocs', SEEN_KEY: 'abhyas_studydocs_seen', CACHE_KEY: 'abhyas_studydocs_cache',
  MAX_CACHE_BYTES: 8 * 1024 * 1024, STALE_MS: 10 * 60 * 1000,
  docs: [], loaded: false, loading: false, cat: 'all', q: '', chapter: '', newIds: new Set(), _at: 0,

  _user(){ try { return (typeof S !== 'undefined' && S.user) ? S.user : null; } catch(e){ return null; } },
  _url(){ try { return (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || ''; } catch(e){ return ''; } },
  _online(){ try { return !!(S.online && !S.forcedOffline); } catch(e){ return navigator.onLine; } },
  _read(key, dflt){ try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? dflt : v; } catch(e){ return dflt; } },
  _write(key, v){ try { localStorage.setItem(key, JSON.stringify(v)); } catch(e){} },

  async _post(body){
    const u = this._user(), url = this._url();
    if (!u || !u.token) throw new Error('Please sign in again.');
    if (!url) throw new Error('The backend address is not set up.');
    const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'text/plain' },
      body: JSON.stringify(Object.assign({ username:u.username, token:u.token }, body)) });
    if (!r.ok) throw new Error('The server replied with an error (' + r.status + ').');
    const res = await r.json();
    if (!res || !res.success) { const e = new Error((res && res.error) || 'Request failed.'); e.needsPayment = !!(res && res.needsPayment); throw e; }
    return res;
  },

  /* Fetch the list and update the sidebar badge. Quiet by default (no screen needed). */
  async _fetchList(){
    const res = await this._post({ action:'listStudyDocs' });
    this.docs = res.docs || [];
    this._write(this.LIST_KEY, this.docs);
    this.loaded = true; this._at = Date.now();
    this._purgeStale();
    return this.docs;
  },

  _updateBadge(){
    const seen = this._read(this.SEEN_KEY, null);
    const n = seen === null ? 0 : studyDocsNewIds(this.docs, seen).length;
    const b = $('sdc');
    if (b) { b.hidden = n === 0; b.textContent = n > 99 ? '99+' : String(n); }
    const hint = document.querySelector('#nav-studydocs');
    if (hint) hint.setAttribute('title', n ? n + ' new' : '');
    return n;
  },

  /* Called when the app opens: refresh the badge without touching the screen. */
  async refreshBadge(){
    if (!this._user() || !this._online() || (Date.now() - this._at) < this.STALE_MS) return;
    try { await this._fetchList(); this._updateBadge(); } catch(e){ /* the badge is a nicety */ }
  },

  async load(force){
    const box = $('studydocs-body');
    if (!box) return;
    if (this.loading) return;
    const fresh = this.loaded && (Date.now() - this._at) < this.STALE_MS;
    let offlineNote = '';
    if (!(fresh && !force)) {
      this.loading = true;
      if (!this.loaded) box.innerHTML = '<div class="card"><div class="skel w80"></div><div class="skel w60"></div><div class="skel w100"></div></div>';
      try {
        if (!this._online()) throw Object.assign(new Error('offline'), { offline: true });
        await this._fetchList();
      } catch(e){
        if (e.needsPayment) {
          box.innerHTML = '<div class="card"><div class="banner banner-warning"><i class="ph ph-lock"></i><span>' + esc(e.message) + '</span></div></div>';
          this.loading = false; return;
        }
        const saved = this._read(this.LIST_KEY, null);
        if (saved && saved.length) { this.docs = saved; this.loaded = true; offlineNote = e.offline ? 'You are offline. Showing the list from your last visit.' : (e.message || 'Could not refresh.') + ' Showing the list from your last visit.'; }
        else {
          box.innerHTML = '<div class="card"><div class="banner banner-' + (e.offline ? 'warning' : 'danger') + '"><i class="ph ph-' + (e.offline ? 'wifi-slash' : 'warning-circle') + '"></i><span>' +
            esc(e.offline ? 'You are offline. Connect once to download the list; PDFs you open are kept for offline reading.' : (e.message || 'Could not load.')) +
            ' <button class="btn btn-sm btn-quiet" data-on-click="STUDYDOCS.load(true)">Try again</button></span></div></div>';
          this.loading = false; return;
        }
      }
      this.loading = false;
    }
    /* Which are new is decided BEFORE marking them seen, so the tags show on this visit. */
    const seen = this._read(this.SEEN_KEY, null);
    this.newIds = new Set(seen === null ? [] : studyDocsNewIds(this.docs, seen));
    this.render(offlineNote);
    this._write(this.SEEN_KEY, this.docs.map(d => d.id));
    this._updateBadge();
  },

  /* Quiet load for other screens (My submissions) that only need to know what exists. */
  async ensureLoaded(){
    if (this.loaded && (Date.now() - this._at) < this.STALE_MS) return this.docs;
    if (!this._user() || !this._online()) { const saved = this._read(this.LIST_KEY, null); if (saved && !this.loaded) { this.docs = saved; this.loaded = true; } return this.docs; }
    try { await this._fetchList(); } catch(e){}
    return this.docs;
  },

  /* Jump to the list showing only one written-answer chapter's PDFs; one PDF opens straight away. */
  showChapter(chapterId){
    const docs = studyDocsForChapter(this.docs, chapterId);
    if (docs.length === 1) { this.open(docs[0].id); return; }
    this.chapter = chapterId || ''; this.cat = 'all'; this.q = '';
    const q = $('sd-q'); if (q) q.value = '';
    UI.go('studydocs');
  },
  clearChapter(){ this.chapter = ''; this.render(); },

  setCat(c){ this.cat = c || 'all'; this.render(); },
  setQuery(v){ this.q = String(v || ''); clearTimeout(this._qt); this._qt = setTimeout(() => this.render(), 120); },

  _cacheIndex(){ return this._read(this.CACHE_KEY, []); },
  _isCached(d){ const e = this._cacheIndex().find(x => x.id === d.id); return !!(e && e.updatedAt === d.updatedAt); },

  render(note){
    const box = $('studydocs-body'), chips = $('sd-chips');
    if (!box) return;
    const cats = studyDocsCategories(this.docs);
    if (this.cat !== 'all' && !cats.some(c => c.category === this.cat)) this.cat = 'all';
    if (chips) {
      chips.innerHTML = cats.length < 2 ? '' :
        '<button type="button" class="sd-chip' + (this.cat === 'all' ? ' on' : '') + '" data-on-click="STUDYDOCS.setCat(\'all\')">All<small>' + this.docs.length + '</small></button>' +
        cats.map(c => '<button type="button" class="sd-chip' + (this.cat === c.category ? ' on' : '') + '" data-on-click="STUDYDOCS.setCat(\'' + c.category + '\')">' + esc(c.label) + '<small>' + c.count + '</small></button>').join('');
    }
    const chapBar = this.chapter
      ? '<div class="banner" style="margin-bottom:var(--sp-2)"><i class="ph ph-funnel"></i><span>Showing PDFs for <b>' + esc(subjChapterName(this.chapter) || 'this chapter') + '</b>. <button class="btn btn-sm btn-quiet" data-on-click="STUDYDOCS.clearChapter()">Show all</button></span></div>' : '';
    const banner = chapBar + (note ? '<div class="banner banner-warning" style="margin-bottom:var(--sp-2)"><i class="ph ph-wifi-slash"></i><span>' + esc(note) + '</span></div>' : '');
    if (!this.docs.length) {
      box.innerHTML = banner + '<div class="card"><div class="empty"><div class="empty-i"><i class="ph ph-file-pdf"></i></div><p>No PDFs yet</p><p>When your teacher adds model answers or notes, they will appear here.</p></div></div>';
      return;
    }
    let list = studyDocsFilter(this.docs, { cat: this.cat, q: this.q });
    if (this.chapter) list = list.filter(d => d.chapterId === this.chapter);
    if (!list.length) {
      box.innerHTML = banner + '<div class="card"><div class="empty"><div class="empty-i"><i class="ph ph-magnifying-glass"></i></div><p>Nothing matches</p><p>Try a different word, or choose All.</p></div></div>';
      return;
    }
    box.innerHTML = banner + '<div class="sd-list">' + list.map(d => {
      const off = this._isCached(d);
      return '<div class="card sd-card">' +
        '<div class="sd-ic"><i class="ph ph-file-pdf"></i></div>' +
        '<div class="sd-main">' +
          '<div class="sd-title">' + esc(d.title) + '</div>' +
          (d.description ? '<div class="sd-desc">' + esc(d.description) + '</div>' : '') +
          '<div class="sd-meta"><span class="sd-tag">' + esc(STUDYDOC_LABELS[d.category] || 'Other') + '</span>' +
            (d.chapterId && subjChapterName(d.chapterId) ? '<span class="sd-tag">' + esc(subjChapterName(d.chapterId)) + '</span>' : '') +
            (this.newIds.has(d.id) ? '<span class="sd-new">New</span>' : '') +
            '<span>' + esc(formatBytes(d.sizeBytes)) + '</span>' +
            (off ? '<span class="sd-off"><i class="ph ph-check-circle"></i> Works offline</span>' : '') + '</div>' +
          '<div class="sd-acts"><button class="btn btn-solid btn-sm" data-on-click="STUDYDOCS.open(\'' + escAttrJs(d.id) + '\')"><i class="ph ph-book-open"></i> Read</button>' +
            (off ? '<button class="btn btn-quiet btn-sm" data-on-click="STUDYDOCS.removeOffline(\'' + escAttrJs(d.id) + '\')"><i class="ph ph-trash"></i> Free up space</button>' : '') +
          '</div>' +
        '</div></div>';
    }).join('') + '</div>';
  },

  async _cacheSet(d, res){
    try {
      if (typeof QDB === 'undefined' || !res.base64) return;
      if (res.base64.length * 0.75 > this.MAX_CACHE_BYTES) return;
      if (!(await QDB.set('studydoc:' + d.id, { base64: res.base64, filename: res.filename || d.fileName || 'study.pdf' }))) return;
      let idx = this._cacheIndex().filter(x => x.id !== d.id);
      idx.push({ id: d.id, at: Date.now(), updatedAt: d.updatedAt, size: Math.round(res.base64.length * 0.75) });
      idx.sort((a, b) => b.at - a.at);
      /* v1.37: nothing is evicted automatically. The list simply keeps growing; the storage meter warns at 80%
         and the student frees space with \"Free up space\" on any document. */
      this._write(this.CACHE_KEY, idx);
      this.render();
    } catch(e){}
  },

  /* v1.37: offline copies of documents the admin hid or deleted are KEPT (the student may still be using
     them). They are listed in storage and removed only when the student chooses \"Free up space\". */
  _purgeStale(){ /* intentionally does not delete anything */ },

  async removeOffline(id){
    try { await QDB.del('studydoc:' + id); } catch(e){}
    this._write(this.CACHE_KEY, this._cacheIndex().filter(x => x.id !== id));
    this.render();
    toast('Removed from this device');
  },

  open(id){
    const d = this.docs.find(x => x.id === id);
    if (!d) { toast('That PDF is no longer available.'); return; }
    if (!window.PDFVIEW) { toast('The PDF reader did not load. Reload the page and try again.', 5000); return; }
    PDFVIEW.open({
      title: d.title,
      load: async () => {
        if (this._isCached(d)) {
          const hit = await QDB.get('studydoc:' + d.id);
          if (hit && hit.base64) return { base64: hit.base64, filename: hit.filename || d.fileName };
        }
        if (!this._online()) throw new Error('You are offline and this PDF was not saved on this device yet. Open it once while online.');
        const res = await this._post({ action:'getStudyDocPdf', id: d.id });
        this._cacheSet(d, res);
        return { base64: res.base64, filename: res.filename || d.fileName };
      }
    });
  }
};

UI.onEnter('studydocs', () => STUDYDOCS.load(false));
UI.onEnterAny(v => { if (v !== 'studydocs') STUDYDOCS.chapter = ''; });
UI.onEnter('home', () => { try { STUDYDOCS.refreshBadge(); } catch(e){} });

/* ═══════════════════════════════════════════════════════════════════════
   RECOVER — Data > Recover data. Lists the safety copies this device took just before a
   sync, a restore or a file import changed anything, and the earlier cloud copies the server
   keeps. "Add back" ADDS a copy to the data on this device (PSYNC.mergeIn); it never deletes.
   ═══════════════════════════════════════════════════════════════════════ */
window.RECOVER = {
  REASONS: {
    'before-sync': 'Before combining with another device', 'before-restore': 'Before adding your cloud backup',
    'before-merge': 'Before a merge', 'before-import': 'Before loading a backup file',
    'before-recover': 'Before adding back a copy', 'before-account-switch': 'Before signing in as someone else', 'test': 'Test'
  },
  _msg(t, bad){ const m = $('recover-msg'); if (m) { m.textContent = t || ''; m.style.color = bad ? 'var(--danger)' : ''; } },
  _when(ms){ const d = new Date(ms); return isNaN(d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); },
  _line(c){ return [c.wr + ' missed', c.bk + ' saved', c.fl + ' flagged', c.sessions + ' sessions'].join(' \u00b7 '); },

  render(){
    const box = $('recover-local');
    if (!box) return;
    const snaps = (typeof PSYNC !== 'undefined') ? PSYNC.listSnapshots() : [];
    box.innerHTML = snaps.length ? snaps.map((s, i) =>
      '<div class="rec-row"><div class="rec-main"><div class="rec-t">' + esc(this._when(s.at)) + '</div>' +
      '<div class="rec-s">' + esc(this.REASONS[s.reason] || 'Before a sync') + '<br>' + esc(this._line(s.counts || {wr:0,bk:0,fl:0,sessions:0})) + '</div></div>' +
      '<button class="btn btn-a btn-sm" data-on-click="RECOVER.addLocal(' + i + ')">Add back</button></div>').join('')
      : '<div class="t-foot">Nothing yet. A copy is saved here automatically before any sync changes your data.</div>';
  },

  async addLocal(i){
    this._msg('Adding\u2026');
    const out = await PSYNC.recoverSnapshot(i);
    this._done(out);
  },

  async loadCloud(){
    const box = $('recover-cloud');
    if (!S.online) { this._msg('Connect to the internet to see earlier cloud copies.', true); return; }
    box.innerHTML = '<div class="t-foot">Checking\u2026</div>';
    try {
      const entries = await PSYNC.listCloudHistory();
      box.innerHTML = entries.length ? entries.map(e =>
        '<div class="rec-row"><div class="rec-main"><div class="rec-t">' + esc(this._when(new Date(e.savedAt).getTime())) + '</div>' +
        '<div class="rec-s">Earlier cloud copy \u00b7 ' + esc(formatBytes(e.chars)) + '</div></div>' +
        '<button class="btn btn-a btn-sm" data-on-click="RECOVER.addCloud(' + Number(e.slot) + ')">Add back</button></div>').join('')
        : '<div class="t-foot">No earlier cloud copies yet. The server starts keeping them from your next backup.</div>';
    } catch (e) {
      box.innerHTML = '<button class="btn btn-quiet btn-sm" data-on-click="RECOVER.loadCloud()"><i class="ph ph-cloud-arrow-down"></i> Check earlier cloud copies</button>';
      this._msg(e.message || 'Could not load earlier cloud copies.', true);
    }
  },

  async addCloud(slot){
    this._msg('Adding\u2026');
    this._done(await PSYNC.recoverCloud(slot));
  },

  _done(out){
    if (!out || !out.ok) { this._msg((out && out.error) || 'That copy could not be added.', true); return; }
    const a = out.added, n = a.wr + a.bk + a.fl + a.sessions + a.notes;
    this._msg(n > 0 ? 'Added ' + [a.wr && a.wr + ' missed', a.bk && a.bk + ' saved', a.fl && a.fl + ' flagged', a.sessions && a.sessions + ' sessions', a.notes && a.notes + ' notes'].filter(Boolean).join(', ') + '. Nothing was removed.' : 'That copy had nothing new. Nothing was removed.');
    this.render();
  }
};
UI.onEnter('data', () => RECOVER.render());

/* ═══════════════════════════════════════════════════════════════════════
   v1.43: CORRECTIONS removed from this file.

   The whole "corrected question" polling block — window.CORRECTIONS and
   its three triggers (UI.onEnter('home'), the online listener and the
   6-second boot timeout) — now lives in report/userreport.js as
   USER_REPORT.checkCorrections(). That module runs the check on seven
   different moments: every question-screen entry, a 3-minute timer while
   the tab is visible, tab-visible, back-online, session restore, boot,
   and again if any file failed.

   The behaviour is the same, plus partial-failure retry and a fetch-first
   order that no longer leaves a student without a cache if the network
   drops mid-poll. Do not re-add the block here — two pollers would run
   in parallel and double the request count.
   ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
   SPRINT — the 60-day plan. One card, one clear job for today:
   how many topics, how many questions, how much time, and whether you
   are ahead or behind. Plan maths lives in shared.js (sprintPlan).
   ═══════════════════════════════════════════════════════════════════ */
window.SPRINT = {
  KEY: 'abhyas_sprint_start',

  _start(){ try { return localStorage.getItem(this.KEY) || ''; } catch(e){ return ''; } },

  _iso(d){
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },

  begin(){
    try { localStorage.setItem(this.KEY, this._iso(new Date())); } catch(e){}
    toast('\ud83d\ude80 Day 1 of your 60-day sprint. Let\u2019s go!');
    this.render();
  },

  reset(){
    if (!confirm('Restart your 60-day sprint from today?')) return;
    this._saveOff([]);
    this.begin();
  },

  _questionsToday(){
    const t = new Date().toDateString();
    const fromSessions = ((S.prog && S.prog.sessions) || [])
      .filter(s => s && s.at && new Date(s.at).toDateString() === t)
      .reduce((n, s) => n + (Number(s.total) || 0), 0);
    return fromSessions;
  },

  _minutesToday(){
    const t = new Date().toDateString();
    const secs = ((S.prog && S.prog.sessions) || [])
      .filter(x => x && x.at && new Date(x.at).toDateString() === t)
      .reduce((n, x) => n + (Number(x.durationSec) || 0), 0);
    return Math.round(secs / 60);
  },

  OFF_KEY: 'abhyas_sprint_off',
  EXAM_KEY: 'abhyas_exam_date',
  _ISO: /^\d{4}-\d{2}-\d{2}$/,

  _offDays(){ try { const v = JSON.parse(localStorage.getItem(this.OFF_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => this._ISO.test(x)) : []; } catch(e){ return []; } },
  _saveOff(list){ try { localStorage.setItem(this.OFF_KEY, JSON.stringify(list.slice(-80))); } catch(e){} },
  _exam(){ try { const v = localStorage.getItem(this.EXAM_KEY) || ''; return this._ISO.test(v) ? v : ''; } catch(e){ return ''; } },

  /* the student's own speed: seconds per question over the last 20 sessions (60 until there is enough data) */
  _secPerQ(){
    const ss = ((S.prog && S.prog.sessions) || []).filter(x => x && Number(x.durationSec) > 0 && Number(x.total) > 0).slice(0, 20);
    const secs = ss.reduce((n, x) => n + Number(x.durationSec), 0), q = ss.reduce((n, x) => n + Number(x.total), 0);
    return q >= 20 ? Math.round(secs / q) : 60;
  },

  /* Level 7 + GK chapters with their real numbers (from the mastery rules) */
  _chapters(){
    const t = Date.now();
    if (this._chC && t - this._chC.t < 300) return this._chC.v;     /* one render asks several times */
    const out = [];
    try {
      MASTERY.filteredChapters().forEach(c => {
        const m = MASTERY.chapter(c.lv, c.ch);
        out.push({ lv: c.lv, ch: c.ch, label: ChapterData.chapterName(c.lv, c.ch) + (c.lv === 'gk' ? ' (GK)' : ''),
                   total: m.total, attempted: m.attempted, wrong: m.wrong, accuracy: m.accuracy, state: m.state });
      });
    } catch(e){}
    this._chC = { t, v: out };
    return out;
  },

  _inputs(){
    let total = 0, covered = 0;
    try {
      /* the sprint covers Level 7 and General Knowledge only (Level 5 is a separate paper) */
      const refs = sprintRefs(ChapterData.allFileRefs());
      total = refs.length;
      covered = refs.filter(r => { const c = (S.cov || {})[r.fid]; return c && c.a > 0; }).length;
    } catch(e){}
    let due = 0;
    try { due = REV.dueWrong().length; } catch(e){}
    /* real question counts: only chapters whose size is known count, so the plan never guesses */
    const known = this._chapters().filter(c => c.total > 0);
    const totalQ = known.reduce((n, c) => n + c.total, 0);
    const attemptedQ = Math.min(totalQ, known.reduce((n, c) => n + c.attempted, 0));
    const wrongQ = known.reduce((n, c) => n + (c.wrong || 0), 0);
    return {
      startISO: this._start(), now: new Date(),
      totalTopics: total, coveredTopics: covered,
      dueReview: due, questionsToday: this._questionsToday(),
      totalQ, attemptedQ, wrongQ, offDays: this._offDays(), examISO: this._exam(),
      secPerQ: this._secPerQ(), paperSize: 100
    };
  },

  render(){
    const box = $('sprint-card');
    if (!box) return;
    const plan = sprintPlan(this._inputs());
    box.style.display = '';

    if (plan.state === 'notstarted') {
      box.innerHTML =
        '<div class="sprint-head"><span><i class="ph ph-rocket-launch"></i>60-day PSC sprint</span>' +
        '<button class="btn btn-sm btn-a" data-on-click="SPRINT.begin()">Start</button></div>' +
        '<div class="sprint-meta">A fixed daily plan: learn every topic, drill weak chapters, then full mock papers.</div>';
      return;
    }
    if (plan.state === 'finished') {
      box.innerHTML =
        '<div class="sprint-head"><span><i class="ph ph-trophy"></i>Sprint complete</span>' +
        '<button class="btn btn-sm btn-a" data-on-click="SPRINT.reset()">Start another</button></div>' +
        '<div class="sprint-meta">Keep taking full mock papers and clearing your review queue until exam day.</div>';
      return;
    }

    if (plan.sized) { this._renderSized(box, plan); return; }
    const paceTxt = plan.pace === 'ahead' ? 'Ahead' : plan.pace === 'behind' ? 'Behind' : 'On track';
    const paceCls = plan.pace === 'behind' ? 'low' : plan.pace === 'ahead' ? 'ok' : 'mid';
    const dayPct = Math.round(plan.day / SPRINT_DAYS * 100);
    const bits = [];
    if (plan.due > 0)       bits.push(plan.due + ' to review');
    if (plan.newTopics > 0) bits.push(plan.newTopics + ' new topic' + (plan.newTopics === 1 ? '' : 's'));
    bits.push(plan.doneQ + '/' + plan.qTarget + (plan.mock ? ' paper' : ' questions'));
    bits.push(this._minutesToday() + '/' + plan.mins + ' min');
    bits.push(plan.coveragePct + '% covered');
    try { const m = MASTERY.summary(); if (m.total) bits.push(m.done + '/' + m.total + ' chapters mastered'); } catch(e){}
    box.innerHTML =
      '<div class="sprint-head"><span><i class="ph ph-rocket-launch"></i>Day ' + plan.day + ' of ' + SPRINT_DAYS + ' \u00b7 ' + esc(plan.label) + '</span>' +
      '<span class="pct ' + paceCls + '">' + paceTxt + '</span></div>' +
      (plan.goalMet ? '<div class="sprint-done" role="status"><i class="ph ph-check-circle"></i> Daily target met</div>' : '') +
      '<div class="sprint-bar"><div style="width:' + dayPct + '%"></div></div>' +
      '<div class="sprint-meta">' + bits.map(esc).join(' \u00b7 ') +
      ' <button class="linkish" type="button" data-on-click="SPRINT.reset()" title="Restart the 60 days from today">restart</button></div>';
  },

  _renderSized(box, plan){
    const items = sprintToday(plan, this._chapters());
    this._items = items;
    const spq = this._secPerQ();
    const paceTxt = plan.pace === 'ahead' ? 'Ahead' : plan.pace === 'behind' ? 'Behind' : 'On track';
    const paceCls = plan.pace === 'behind' ? 'low' : plan.pace === 'ahead' ? 'ok' : 'mid';
    const dayPct = Math.round(plan.day / plan.totalDays * 100);
    const left = plan.total - plan.covered;

    let feas = '';
    if (plan.feasibility === 'tight') {
      feas = 'Tight: covering the ' + left + ' questions you have not tried yet needs about ' + plan.neededPerDay + ' new questions a day. Keep every day, and avoid rest days if you can.';
    } else if (plan.feasibility === 'unrealistic') {
      feas = 'This pace is very hard: covering the ' + left + ' remaining questions needs about ' + plan.neededPerDay + ' new questions a day. Add study time, or decide which chapters to leave for revision rather than first learning.';
    }

    const bits = [];
    bits.push(plan.doneQ + '/' + plan.qTarget + (plan.mock ? ' paper' : ' questions'));
    if (plan.mins) bits.push('about ' + plan.mins + ' min');
    bits.push(plan.coveragePct + '% of questions tried');
    try { const m = MASTERY.summary(); if (m.total) bits.push(m.done + '/' + m.total + ' chapters mastered'); } catch(e){}
    const exam = this._exam();
    if (exam) {
      const dl = Math.round((Date.UTC(+exam.slice(0,4), +exam.slice(5,7) - 1, +exam.slice(8,10)) - Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000);
      if (dl >= 0) bits.push(dl + ' day' + (dl === 1 ? '' : 's') + ' to exam');
    }

    const icon = { review: 'ph-arrows-clockwise', new: 'ph-book-open', weak: 'ph-target', mock: 'ph-exam', rest: 'ph-moon' };
    const rows = items.map((it, i) => {
      const mins = it.questions ? Math.max(1, Math.round(it.questions * spq / 60)) : 0;
      const act = it.kind === 'rest' ? '' : '<button class="btn btn-sm btn-quiet" type="button" data-on-click="SPRINT.startItem(' + i + ')">Start</button>';
      return '<div class="sprint-row"><i class="ph ' + (icon[it.kind] || 'ph-circle') + '" aria-hidden="true"></i>' +
        '<span class="grow">' + esc(it.label) + (it.questions ? '<span class="t-cap" style="display:block">' + it.questions + ' questions \u00b7 about ' + mins + ' min</span>' : '') + '</span>' + act + '</div>';
    }).join('');

    const todayISO = this._iso(new Date()), isOffToday = this._offDays().indexOf(todayISO) !== -1;
    box.innerHTML =
      '<div class="sprint-head"><span><i class="ph ph-rocket-launch"></i>Day ' + plan.day + ' of ' + plan.totalDays + ' \u00b7 ' + esc(plan.label) + '</span>' +
      '<span class="pct ' + paceCls + '">' + paceTxt + '</span></div>' +
      (plan.goalMet && !plan.rest ? '<div class="sprint-done" role="status"><i class="ph ph-check-circle"></i> Daily target met</div>' : '') +
      (feas ? '<div class="banner banner-warning" role="status" style="margin:var(--sp-2) 0">' + esc(feas) + '</div>' : '') +
      '<div class="sprint-bar"><div style="width:' + dayPct + '%"></div></div>' +
      '<div class="sprint-meta">' + bits.map(esc).join(' \u00b7 ') + '</div>' +
      (plan.catchup ? '<div class="t-foot" style="margin:var(--sp-1) 0">Catch-up day: ' + (plan.backlogQ > 0 ? 'you are about ' + plan.backlogQ + ' questions behind, so today pays some of that back.' : 'you are on track, so today is a light review of weak spots.') + '</div>' : '') +
      '<div class="sprint-list">' + rows + '</div>' +
      '<div class="sprint-meta" style="margin-top:var(--sp-2)">' +
      '<button class="linkish" type="button" data-on-click="SPRINT.restDay()">' + (isOffToday ? 'Cancel rest day' : 'Take today off') + '</button> \u00b7 ' +
      '<button class="linkish" type="button" data-on-click="SPRINT.examDialog()">' + (exam ? 'Change exam date' : 'Set exam date') + '</button> \u00b7 ' +
      '<button class="linkish" type="button" data-on-click="SPRINT.reset()" title="Restart the plan from today">restart</button></div>';
  },

  /* start one line of today's list */
  startItem(i){
    const it = (this._items || [])[i];
    if (!it) return;
    if (it.kind === 'review') { try { if (REV.start) { REV.start('wr', 'flashcard', true); return; } } catch(e){} toast('Nothing to review right now.'); return; }
    if (it.kind === 'mock') { try { if (SYLLABUS_MOCK && SYLLABUS_MOCK.start) { SYLLABUS_MOCK.start(); return; } } catch(e){} toast('Mock papers are not available yet.'); return; }
    if (it.lv && it.ch) CH_GRID.startChapter(it.lv, it.ch, 'flashcard');
  },

  restDay(){
    const t = this._iso(new Date()), list = this._offDays(), at = list.indexOf(t);
    if (at === -1) { list.push(t); toast('Rest day set. The other days will carry a little more.'); }
    else { list.splice(at, 1); toast('Rest day cancelled.'); }
    this._saveOff(list);
    this.render();
  },

  examDialog(){
    const min = this._iso(new Date(Date.now() + 86400000));
    openMod('Exam date',
      '<p class="t-callout mb3">If your exam is sooner than 60 days away, the plan is shortened to finish the day before it. It never gets longer than 60 days.</p>' +
      '<label class="t-foot" for="sp-exam">Exam date</label>' +
      '<input class="input" type="date" id="sp-exam" min="' + min + '" value="' + esc(this._exam()) + '" style="margin:var(--sp-1) 0 var(--sp-3)">' +
      '<div class="bg"><button class="btn btn-a" type="button" data-on-click="SPRINT.saveExam()">Save</button>' +
      '<button class="btn btn-quiet" type="button" data-on-click="SPRINT.clearExam()">Remove date</button></div>');
  },
  saveExam(){
    const v = (document.getElementById('sp-exam') || {}).value || '';
    if (!this._ISO.test(v) || v <= this._iso(new Date())) { toast('Pick a date after today.'); return; }
    try { localStorage.setItem(this.EXAM_KEY, v); } catch(e){}
    closeMod(); toast('Exam date saved.'); this.render();
  },
  clearExam(){
    try { localStorage.removeItem(this.EXAM_KEY); } catch(e){}
    closeMod(); this.render();
  },

  go(){
    const plan = sprintPlan(this._inputs());
    if (plan.state === 'active' && plan.sized) {
      const items = sprintToday(plan, this._chapters());
      this._items = items;
      const first = items.findIndex(it => it.kind !== 'rest');
      if (first !== -1) { this.startItem(first); return; }
    }
    if (plan.state === 'active' && plan.mock) {
      try { if (typeof SYLLABUS_MOCK !== 'undefined' && SYLLABUS_MOCK.start) { SYLLABUS_MOCK.start(); return; } } catch(e){}
    }
    TODAY_PLAN.start();
  }
};
/* ═══════════════════════════════════════════════════════════════════
   TODAY_PLAN — what should I do right now?
   Combines weakest chapters, due spaced-repetition review, and one
   new topic into a single action. Removing the decision is the
   biggest UX win for a solo student.
   ═══════════════════════════════════════════════════════════════════ */
window.TODAY_PLAN = {
  _plan: null,

  _entries(){
    try {
      if (typeof CHAPSTATS === 'undefined' || !CHAPSTATS.entries) return [];
      return CHAPSTATS.entries().filter(e => e.attempted >= 5);
    } catch(e){ return []; }
  },

  _weakest(n){
    return this._entries()
      .slice()
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, n);
  },

  _dueReview(){
    try {
      if (typeof REV === 'undefined' || !REV.dueWrong) return 0;
      return REV.dueWrong().length;
    } catch(e){ return 0; }
  },

  _resumeCtx(){
    try {
      const sessions = (S.prog && S.prog.sessions) || [];
      const last = sessions.find(s => s.fid && s.lv && s.ch);
      if (!last || !last.fid) return null;
      const ref = ChapterData.allFileRefs().find(r => r.fid === last.fid);
      if (!ref) return null;
      const at = last.at || 0;
      if (Date.now() - at > 14 * 24 * 60 * 60 * 1000) return null;
      return {
        fid: ref.fid,
        title: ChapterData.chapterName(ref.lv, ref.ch),
        subtopic: ref.subtopic || ref.book || '',
        when: at
      };
    } catch(e){ return null; }
  },

  _renderResume(){
    const slot = $('resume-slot');
    if (!slot) return;
    const ctx = this._resumeCtx();
    if (!ctx) { slot.innerHTML = ''; return; }
    const mins = Math.max(1, Math.round((Date.now() - ctx.when) / 60000));
    const when = mins < 60 ? mins + ' min ago' : Math.round(mins / 60) + ' h ago';
    slot.innerHTML =
      '<button class="resume-chip" data-on-click="TODAY_PLAN.resume()">' +
        '<i class="ph ph-play"></i>' +
        '<span class="grow">Continue <b>' + esc(ctx.title) + '</b>' +
          (ctx.subtopic ? ' \u00b7 ' + esc(ctx.subtopic) : '') +
          '<span class="t-cap" style="display:block;opacity:.7">Last opened ' + when + '</span>' +
        '</span>' +
        '<i class="ph ph-arrow-right arrow"></i>' +
      '</button>';
  },

  resume(){
    const ctx = this._resumeCtx();
    if (!ctx) { toast('Nothing to resume yet.'); return; }
    const ref = ChapterData.allFileRefs().find(r => r.fid === ctx.fid);
    if (!ref) { toast('That chapter is no longer available.'); return; }
    QUIZ.load(ref.fid, ref.key, 'flashcard',
      ChapterData.chapterName(ref.lv, ref.ch) + ' \u2014 ' + ref.book,
      { lv: ref.lv, ch: ref.ch, book: ref.book, sub: ref.subtopic, fid: ref.fid });
  },

  render(){
    const box = $('today-body');
    if (!box) return;

    const weak = this._weakest(3);
    const due = this._dueReview();
    const newRef = this._pickNew();

    const lines = [];
    weak.forEach(w => {
      const pct = w.accuracy;
      const cls = pct < 50 ? 'low' : pct < 70 ? 'mid' : 'ok';
      lines.push(
        '<div class="today-row">' +
          '<i class="ph ph-target" style="color:var(--ink-3)"></i>' +
          '<span class="lbl">' + esc(w.chapter) + '</span>' +
          '<span class="pct ' + cls + '">' + pct + '%</span>' +
          '<span class="mins">10 min</span>' +
        '</div>'
      );
    });
    if (due > 0) {
      lines.push(
        '<div class="today-row">' +
          '<i class="ph ph-arrow-counter-clockwise" style="color:var(--accent)"></i>' +
          '<span class="lbl">Spaced review due</span>' +
          '<span class="pct mid">' + due + '</span>' +
          '<span class="mins">5 min</span>' +
        '</div>'
      );
    }
    if (newRef) {
      lines.push(
        '<div class="today-row">' +
          '<i class="ph ph-sparkle" style="color:var(--accent)"></i>' +
          '<span class="lbl">Try something new: ' + esc(ChapterData.chapterName(newRef.lv, newRef.ch)) + '</span>' +
          '<span class="pct ok">new</span>' +
          '<span class="mins">10 min</span>' +
        '</div>'
      );
    }
    if (!lines.length) {
      lines.push(
        '<div class="today-row">' +
          '<i class="ph ph-sparkle" style="color:var(--accent)"></i>' +
          '<span class="lbl">A general mix to warm you up</span>' +
          '<span class="pct ok">10 Q</span>' +
          '<span class="mins">10 min</span>' +
        '</div>'
      );
    }
    box.innerHTML = lines.join('');
    this._plan = { weak, due, newRef };
  },

  _pickNew(){
    try {
      const all = ChapterData.allFileRefs();
      const seen = new Set();
      Object.keys(S.cov || {}).forEach(fid => {
        const c = S.cov[fid];
        if (c && c.a > 0) seen.add(fid);
      });
      const fresh = all.filter(r => !seen.has(r.fid));
      if (!fresh.length) return null;
      return fresh[Math.floor(Math.random() * fresh.length)];
    } catch(e){ return null; }
  },

  start(){
    const p = this._plan;
    if (!p) { QUIZ.daily(); return; }
    if (p.due > 0 && typeof REV !== 'undefined' && REV.start) { REV.start('wr', 'flashcard', true); return; }
    if (p.weak.length) {
      const first = p.weak[0];
      const ref = ChapterData.allFileRefs().find(r =>
        ChapterData.chapterName(r.lv, r.ch) === first.chapter
      );
      if (ref) {
        QUIZ.load(ref.fid, ref.key, 'flashcard',
          ChapterData.chapterName(ref.lv, ref.ch) + ' \u2014 ' + ref.book,
          { lv: ref.lv, ch: ref.ch, book: ref.book, sub: ref.subtopic, fid: ref.fid });
        return;
      }
    }
    if (p.newRef) {
      const r = p.newRef;
      QUIZ.load(r.fid, r.key, 'flashcard',
        ChapterData.chapterName(r.lv, r.ch) + ' \u2014 ' + r.book,
        { lv: r.lv, ch: r.ch, book: r.book, sub: r.subtopic, fid: r.fid });
      return;
    }
    QUIZ.daily();
  },

  quick5(){
    toast('Loading 5 questions\u2026', 1500);
    const p = this._plan;
    const refs = p && p.newRef
      ? [p.newRef]
      : (typeof ChapterData !== 'undefined' ? ChapterData.allFileRefs() : []).slice(0, 3);
    if (!refs.length) { toast('No content available yet.'); return; }
    (async () => {
      const all = [];
      for (const ref of refs) {
        try {
          const raw = await QUIZ._fetch(ref.fid, ref.key);
          all.push(...normQ(raw, ref.fid));
        } catch(e){}
        if (all.length >= 15) break;
      }
      if (!all.length) { toast('Could not load a quick set \u2014 try again.'); return; }
      const picked = shuf(all).slice(0, 5);
      QUIZ.startWith(picked, 'flashcard', '\u26a1 Quick 5', null);
    })();
  }
};

/* ═══════════════════════════════════════════════════════════════════
   WEEKLY_BOARD — leaderboard for the most recently closed weekly test.
   Uses getWeeklyStanding, which already exists on the backend.
   ═══════════════════════════════════════════════════════════════════ */
window.WEEKLY_BOARD = {
  _cache: {},
  async _fetch(id){
    if(this._cache[id] !== undefined) return this._cache[id];
    if(!S.online || S.forcedOffline || !S.user || !S.user.token){
      this._cache[id] = null;
      return null;
    }
    try{
      const r = await netFetch(APPS, {
        method:'POST', headers:{'Content-Type':'text/plain'},
        body: JSON.stringify({ action:'getWeeklyStanding',
          username:S.user.username, token:S.user.token, weeklyId:id })
      }, 15000);
      const res = await r.json();
      const val = (res && res.success && res.ready && res.attempted) ? res : null;
      this._cache[id] = val;
      return val;
    }catch(e){ this._cache[id] = null; return null; }
  },
  async render(){
    const slot = $('weekly-board-slot');
    if(!slot) return;
    slot.innerHTML = '';
    if(typeof WEEKLY === 'undefined') return;

    const sets = WEEKLY.sets || [];
    const attempts = WEEKLY.attempts || {};
    const closed = sets.filter(s => s.released && !WEEKLY.examOpen(s) && attempts[s.id]);
    if(!closed.length) return;

    closed.sort((a,b) =>
      (attempts[b.id].submittedAt || 0) - (attempts[a.id].submittedAt || 0));
    const s = closed[0];
    const a = attempts[s.id];
    const st = a.standing || await this._fetch(s.id);
    if(!st || !st.rank) return;

    const pct = st.percentile || 0;
    const icon = pct >= 90 ? 'ph-trophy' : pct >= 75 ? 'ph-target' : pct >= 50 ? 'ph-thumbs-up' : 'ph-trend-up';
    const topPct = Math.max(1, 100 - pct);
    const beat = Math.max(0, st.total - st.rank);

    slot.innerHTML =
      '<section class="card" style="border-color:var(--accent-line)">' +
        '<div class="card-hd"><h3><i class="ph ' + icon + '"></i> Weekly leaderboard</h3>' +
          '<span class="ctag ta">' + esc(s.title) + '</span></div>' +
        '<div class="stats-row" style="margin-bottom:var(--sp-3)">' +
          '<div class="scard"><div class="sv ta2">' + st.rank + '</div><div class="stat-lbl">Your rank</div></div>' +
          '<div class="scard"><div class="sv">' + st.total + '</div><div class="stat-lbl">Attempts</div></div>' +
          '<div class="scard"><div class="sv tcy">' + (a.pct || 0) + '%</div><div class="stat-lbl">Your score</div></div>' +
          '<div class="scard"><div class="sv">' + (st.avgPct || 0) + '%</div><div class="stat-lbl">Average</div></div>' +
        '</div>' +
        '<p class="t-foot">Top ' + topPct + '% of students. You beat ' + beat + ' of them.</p>' +
      '</section>';
  }
};

/* ═══════════════════════════════════════════════════════════════════
   BADGES_UI — lightweight achievements strip on Home.
   ═══════════════════════════════════════════════════════════════════ */
window.BADGES_UI = {
  DEFS: [
    { id:'first_100',   icon:'ph-plant',     name:'First 100',  need:s => (s.prog.total||0) >= 100 },
    { id:'half_500',    icon:'ph-books',     name:'500 answered', need:s => (s.prog.total||0) >= 500 },
    { id:'streak_7',    icon:'ph-fire',      name:'7-day streak', need:() => STREAK.currentStreak() >= 7 },
    { id:'streak_30',   icon:'ph-mountains', name:'30-day streak', need:() => STREAK.currentStreak() >= 30 },
    { id:'perfect_exam',icon:'ph-medal',     name:'Perfect paper', need:s => (s.prog.sessions||[]).some(x => x.mode==='exam' && x.pct===100) },
    { id:'bookmark_50', icon:'ph-star',      name:'50 saved',     need:s => (s.bk||[]).length >= 50 },
    { id:'due_clear',   icon:'ph-target',    name:'Caught up',    need:() => S.wr && S.wr.length > 20 && REV.dueCount() === 0 }
  ],
  render(){
    const slot = $('badges-strip');
    if(!slot) return;
    if(!S.prog.badges) S.prog.badges = {};
    let changed = false;
    this.DEFS.forEach(d => {
      try{
        if(!S.prog.badges[d.id] && d.need(S)){
          S.prog.badges[d.id] = new Date().toISOString().slice(0,10);
          changed = true;
        }
      }catch(e){}
    });
    if(changed) _save(LS.PROG, S.prog);
    const earned = this.DEFS.filter(d => S.prog.badges[d.id]).length;
    if(!earned && this.DEFS.length === 0){ slot.innerHTML = ''; return; }
    slot.innerHTML =
      '<div class="card"><div class="card-hd"><h3><i class="ph ph-medal"></i> Achievements</h3>' +
        '<span class="t-cap">' + earned + ' / ' + this.DEFS.length + '</span></div>' +
        '<div tabindex="0" role="group" aria-label="Achievements" style="display:flex;gap:var(--sp-3);overflow-x:auto;padding-bottom:var(--sp-2)">' +
          this.DEFS.map(d => {
            const got = !!S.prog.badges[d.id];
            /* Locked ones fade only the icon; the name stays at full contrast so it can be read. */
            return '<div title="' + esc(d.name) + (got ? ' (earned)' : ' (locked)') + '" style="flex-shrink:0;width:82px;text-align:center">' +
              '<div style="font-size:1.5rem;opacity:' + (got ? 1 : 0.4) + ';color:' + (got ? 'var(--accent)' : 'var(--ink-3)') + '">' +
                '<i class="ph ' + d.icon + '"></i></div>' +
              '<div class="t-cap" style="margin-top:2px;line-height:1.25">' + esc(d.name) + '</div>' +
            '</div>';
          }).join('') +
        '</div></div>';
  }
};

/* ═══════════════════════════════════════════════════════════════════
   SIDEBAR_SEARCH — filter the sidebar items with a small input.
   ═══════════════════════════════════════════════════════════════════ */
window.SIDEBAR_SEARCH = {
  _debounceTimer: null,
  _qResults: [],
  _input: null,
  _results: null,

  init(){
    const sb = document.getElementById('sb');
    if (!sb) return;
    if (document.getElementById('sb-filter')) return;

    const wrap = document.createElement('div');
    wrap.id = 'sb-filter-wrap';
    wrap.className = 'sb-filter-wrap';
    wrap.innerHTML =
      '<div class="sb-filter-input">' +
        '<i class="ph ph-magnifying-glass"></i>' +
        '<input id="sb-filter" type="search" placeholder="Find a screen or question\u2026" autocomplete="off" spellcheck="false" enterkeyhint="search">' +
      '</div>' +
      '<div id="sb-filter-results" class="sb-filter-results" style="display:none"></div>';

    const anchor = sb.querySelector('#sb-admin-promo') || sb.querySelector('.sb-you');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    else sb.insertBefore(wrap, sb.firstChild);

    const input = wrap.querySelector('#sb-filter');
    const results = wrap.querySelector('#sb-filter-results');

    input.addEventListener('input', () => {
      clearTimeout(this._debounceTimer);
      const term = input.value;
      this.filter(term);
      this._debounceTimer = setTimeout(() => this._searchQuestions(term), 200);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        input.value = '';
        this.filter('');
        this._hideResults();
        input.blur();
        e.stopPropagation();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this._openAll();
      }
    });

    input.addEventListener('focus', () => {
      if (input.value && input.value.trim().length >= 2) this._searchQuestions(input.value);
    });

    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) this._hideResults();
    });

    this._input = input;
    this._results = results;
  },

  filter(q){
    const term = String(q || '').toLowerCase().trim();
    document.querySelectorAll('#sb .sb-item').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = (!term || text.indexOf(term) !== -1) ? '' : 'none';
    });
    document.querySelectorAll('#sb .sb-sec').forEach(sec => {
      const items = sec.querySelectorAll('.sb-item');
      const any = Array.from(items).some(i => i.style.display !== 'none');
      sec.style.display = any ? '' : 'none';
    });
  },

  _hideResults(){
    if (this._results) this._results.style.display = 'none';
  },

  async _searchQuestions(term){
    term = String(term || '').trim();
    if (term.length < 2){ this._hideResults(); this._qResults = []; return; }
    if (typeof QSEARCH === 'undefined') return;

    let hits = [];
    try { hits = await QSEARCH.search(term); } catch(e){}
    if (!this._input || !this._results) return;
    if (this._input.value.trim().length < 2) return;

    this._qResults = hits.slice(0, 5);
    const termLc = term.toLowerCase();

    if (!this._qResults.length) {
      this._results.innerHTML =
        '<div class="sb-filter-empty">' +
          '<i class="ph ph-magnifying-glass"></i> No questions match' +
        '</div>';
      this._results.style.display = '';
      return;
    }

    const rows = this._qResults.map((q, i) => {
      const stem = String(q.q || '');
      const pos = stem.toLowerCase().indexOf(termLc);
      const snip = pos < 0
        ? stem.slice(0, 100)
        : stem.slice(Math.max(0, pos - 25), pos + 75);
      const correct = q.correct != null ? String.fromCharCode(65 + Number(q.correct)) : '?';
      return '<button type="button" class="sb-filter-item" ' +
        'data-on-mousedown="SIDEBAR_SEARCH._pick(' + i + ');return false" ' +
        'data-on-click="return false">' +
          '<span class="sb-filter-badge">' + esc(correct) + '</span>' +
          '<span class="sb-filter-stem">' + esc(snip) + '</span>' +
        '</button>';
    }).join('');

    this._results.innerHTML =
      '<div class="sb-filter-head">Questions \u00b7 ' + hits.length + '</div>' +
      rows +
      '<button type="button" class="sb-filter-all" data-on-mousedown="SIDEBAR_SEARCH._openAll();return false" data-on-click="return false">' +
        'See all ' + hits.length + ' in full view' +
      '</button>';
    this._results.style.display = '';
  },

  _pick(i){
    const q = (this._qResults || [])[i];
    if (!q) return;
    this._close();
    if (typeof QSEARCH === 'undefined') return;
    QSEARCH._last = [q];
    QSEARCH.pick(0);
  },

  _openAll(){
    const term = this._input ? this._input.value.trim() : '';
    this._close();
    if (typeof QSEARCH === 'undefined') return;
    QSEARCH.open();
    if (term) {
      setTimeout(() => {
        const inp = document.getElementById('qs-input');
        if (inp) {
          inp.value = term;
          inp.dispatchEvent(new Event('input'));
        }
      }, 90);
    }
  },

  _close(){
    if (this._input) this._input.value = '';
    this.filter('');
    this._hideResults();
    if (typeof UI !== 'undefined' && UI.sidebarClose) UI.sidebarClose();
  }
};

/* ═══════════════════════════════════════════════════════════════════
   READINESS — predicted exam score, right on the Home screen.
   ═══════════════════════════════════════════════════════════════════ */
window.READINESS = {
  render(){
    const card = $('readiness-card');
    if (!card) return;
    let p = null;
    try { p = (typeof PROG !== 'undefined' && PROG.predict) ? PROG.predict() : null; } catch(e){}
    if (!p) { card.hidden = true; return; }
    card.hidden = false;
    const v = p.predicted;
    const cls = v >= 70 ? '' : v >= 50 ? 'warn' : 'low';
    const el = $('readiness-val');
    if (el) { el.textContent = v + '%'; el.className = 'readiness-val ' + cls; }
    const conf = $('readiness-conf');
    if (conf) conf.textContent = p.confidence + ' confidence \u00b7 \u00b1 ' + p.margin + '%';
    const fill = $('readiness-fill');
    if (fill) {
      fill.style.width = v + '%';
      fill.style.background = v >= 70 ? 'var(--success)' : v >= 50 ? 'var(--warning)' : 'var(--danger)';
    }
    const det = $('readiness-detail');
    if (det) {
      const weakest = TODAY_PLAN._weakest(2);
      if (weakest.length) {
        det.innerHTML = 'Focus on: ' +
          weakest.map(w => '<b>' + esc(w.chapter) + '</b> (' + w.accuracy + '%)').join(' \u00b7 ');
      } else {
        det.textContent = 'Complete a few more sessions for a sharper estimate.';
      }
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   CHAP_VERDICTS — one-line verdict per chapter.
   ═══════════════════════════════════════════════════════════════════ */
window.CHAP_VERDICTS = {
  render(){
    const box = $('chap-verdicts');
    if (!box) return;
    let entries = [];
    try { entries = (typeof CHAPSTATS !== 'undefined') ? CHAPSTATS.entries() : []; } catch(e){}
    entries = entries.filter(e => e.attempted >= 3);
    if (!entries.length) {
      box.innerHTML = '<p class="t-foot" style="padding:var(--sp-2) 0">Complete a few sessions to see which chapters are strongest.</p>';
      return;
    }
    entries.sort((a, b) => a.accuracy - b.accuracy);
    box.innerHTML = entries.slice(0, 5).map(e => {
      const pct = e.accuracy;
      const kind = pct >= 80 ? 'ready' : pct >= 60 ? 'needs' : 'weak';
      const icon = pct >= 80 ? 'ph-check-circle' : pct >= 60 ? 'ph-warning-circle' : 'ph-x-circle';
      return '<button class="chap-verdict ' + kind + '" data-on-click="CHAP_VERDICTS.go(\'' + escAttrJs(e.chapter) + '\')">' +
        '<i class="ph ' + icon + ' mark"></i>' +
        '<span class="lbl">' + esc(e.chapter) + '</span>' +
        '<span class="t-cap mono">' + e.correct + '/' + e.attempted + '</span>' +
        '<span class="t-cap" style="color:var(--ink-3);font-weight:650">' + pct + '%</span>' +
      '</button>';
    }).join('');
  },
  go(chapter){
    try {
      UI.go('online');
      setTimeout(() => {
        const refs = ChapterData.allFileRefs();
        const ref = refs.find(r => ChapterData.chapterName(r.lv, r.ch) === chapter);
        if (!ref) return;
        const lvSel = $('on-lv');
        if (lvSel && ref.lv) {
          lvSel.value = ref.lv;
          if (typeof ON !== 'undefined' && ON.onLv) ON.onLv();
          const chSel = $('on-ch');
          if (chSel) { chSel.value = ref.ch; if (ON.onCh) ON.onCh(); }
        }
      }, 200);
    } catch(e){ UI.go('progress'); }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   IMGZOOM — click any question image to open it full-screen.
   ═══════════════════════════════════════════════════════════════════ */
window.IMGZOOM = {
  open(src, alt){
    const box = $('img-fullscreen');
    const img = $('img-fullscreen-img');
    if (!box || !img) return;
    img.src = src;
    img.alt = alt || 'Question image';
    box.classList.add('show');
    document.body.style.overflow = 'hidden';
  },
  close(){
    const box = $('img-fullscreen');
    if (!box) return;
    box.classList.remove('show');
    document.body.style.overflow = '';
  }
};

/* ═══════════════════════════════════════════════════════════════════
   COPY_EXPL — copy an explanation so it can be shared.
   ═══════════════════════════════════════════════════════════════════ */
window.COPY_EXPL = {
  async copy(text, btn){
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="ph ph-check"></i>';
        setTimeout(() => { btn.innerHTML = orig; }, 1200);
      }
      if (typeof toast === 'function') toast('Explanation copied');
    } catch(e){
      if (typeof toast === 'function') toast('Could not copy \u2014 long-press the text instead');
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════
   FAST_GUESS — flag wrong answers made in under 10 seconds.
   ═══════════════════════════════════════════════════════════════════ */
window.FAST_GUESS = {
  _shownAt: {},
  _durations: {},
  markShown(idx){ if (this._shownAt[idx] == null) this._shownAt[idx] = Date.now(); },
  markAnswered(idx){
    if (this._shownAt[idx] == null) return;
    this._durations[idx] = Date.now() - this._shownAt[idx];
    delete this._shownAt[idx];
  },
  reset(){ this._shownAt = {}; this._durations = {}; },
  fastWrongIndexes(quiz){
    const out = [];
    if (!quiz || !quiz.qs || !quiz.ans) return out;
    quiz.qs.forEach((q, i) => {
      const ms = this._durations[i];
      if (ms == null) return;
      const wasWrong = !isOk(quiz.ans[i], q.correct);
      if (wasWrong && ms < 10000) out.push(i);
    });
    return out;
  }
};

/* Exam countdown and today's question goal. Stored on this device only. */
/* The exam-date field lives inside the SPRINT card ("Set exam date"
   link, which writes the same localStorage key). Only the getter is kept —
   SPRINT and PACE read it. */
window.EXAM_DATE = {
  KEY: 'abhyas_exam_date',
  get(){ try { return localStorage.getItem(this.KEY) || ''; } catch(e){ return ''; } }
};

/* Trial time left, visible on every screen, with a one-tap route to payment. */
window.TRIAL_PILL = {
  render(){
    const b = $('tb-trial'), t = $('tb-trial-txt');
    if (!b || !t) return;
    let a = null;
    try { a = (S.user && S.user.access) || null; } catch(e){}
    if (!a || a.level !== 'trial' || !a.trialExpiresAt) { b.hidden = true; return; }
    const ms = new Date(a.trialExpiresAt).getTime() - Date.now();
    b.hidden = false;
    if (!(ms > 0)) { t.textContent = 'Trial ended'; return; }
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    t.textContent = h >= 48 ? Math.floor(h / 24) + 'd left' : h > 0 ? h + 'h ' + m + 'm left' : m + 'm left';
  }
};

setInterval(_refreshHints, 30000);
/* v1.27: a rapid tab-switch storm fired every sub-renderer in sequence.
   Throttle to once per 3s — the data does not change faster than that. */
let _lastHintAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = Date.now();
    if (now - _lastHintAt > 3000) {
      _lastHintAt = now;
      _refreshHints();
    }
    if (UI.cur === 'subj-mine' && typeof MY_SUBJ !== 'undefined' && MY_SUBJ._loaded) {
      MY_SUBJ.load(true);
    }
  }
});
setTimeout(_refreshHints, 800);

/* ── Image zoom: any question figure opens full-screen on tap ── */
document.addEventListener('click', function(e){
  const img = e.target.closest && e.target.closest('.qcard img, #fc-img-wrap img, #ex-qs img, #res-review img');
  if (!img) return;
  if (img.classList.contains('avatar') || img.closest('.bd-mark') || img.closest('.img-fullscreen')) return;
  if ((img.naturalWidth || 0) < 200) return;
  e.preventDefault();
  IMGZOOM.open(img.src, img.alt);
});

/* Give every question figure a class so it is styled and cursorable. */
const _figureObserver = new MutationObserver(() => {
  document.querySelectorAll('.qcard img, #fc-img-wrap img, #ex-qs img, #res-review img').forEach(img => {
    if (!img.classList.contains('question-figure') && !img.classList.contains('avatar')) {
      img.classList.add('question-figure');
    }
  });
});
_figureObserver.observe(document.body, { childList: true, subtree: true });

/* ── Copy-explanation button on every shown explanation ── */
function _decorateExplanations(){
  document.querySelectorAll('.expl.show').forEach(el => {
    if (el.querySelector('.expl-copy')) return;
    const text = el.textContent.trim();
    if (!text) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'expl-copy ib';
    btn.style.cssText = 'width:26px;height:26px;border-radius:6px;background:var(--surface);color:var(--ink-3);border:1px solid var(--sep)';
    btn.title = 'Copy this explanation';
    btn.setAttribute('aria-label', 'Copy this explanation');
    btn.innerHTML = '<i class="ph ph-copy"></i>';
    btn.addEventListener('click', e => { e.stopPropagation(); COPY_EXPL.copy(text, btn); });
    el.insertBefore(btn, el.firstChild);
  });
}
new MutationObserver(() => { try { _decorateExplanations(); } catch(e){} })
  .observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

if (typeof HOME !== 'undefined' && HOME.updateBadges) {
  const _ub = HOME.updateBadges.bind(HOME);
  HOME.updateBadges = function(){
    _ub();
    const due = (typeof REV !== 'undefined' && REV.dueCount) ? REV.dueCount() : 0;
    const dot = $('bn-badge');
    const tab = $('bn-progress');
    if (tab) tab.classList.toggle('has-badge', due > 0);
    if (dot) dot.style.display = 'none';
  };
}

if (typeof AUTH !== 'undefined' && AUTH._enter) {
  const _origEnter = AUTH._enter.bind(AUTH);
  AUTH._enter = function(u){
    _origEnter(u);
    const chip = $('uchip');
    if (chip) chip.textContent = (u && (u.name || u.username)) || 'Student';
    setTimeout(() => {
      if (typeof APP_SWITCH !== 'undefined') APP_SWITCH.refresh();
      else { try { _setAdminVisible(!!(S.user && S.user.adminCapable)); } catch(e){} }
      _refreshHints();
      if (typeof MY_SUBJ !== 'undefined') MY_SUBJ.load(true);
      if (typeof SIDEBAR_SEARCH !== 'undefined') SIDEBAR_SEARCH.init();
      if (typeof BADGES_UI !== 'undefined') BADGES_UI.render();
    }, 300);
    /* Warm the written-answer bank in the background so the sidebar can say
       whether today's question is waiting without the student opening the tab. */
    setTimeout(() => {
      try {
        if (typeof SUBJ !== 'undefined' && typeof SUBJ.init === 'function' && !SUBJ.ready()) SUBJ.init();
      } catch(e){}
    }, 1800);
  };
}

/* manifest.json ships home-screen shortcuts that land on user.html#offline
   and user.html#subjective — without this they all just opened Home. */
(function(){
  const MAP = {
    home:'home', offline:'offline', downloads:'offline', progress:'progress',
    subjective:'subj-qotd', written:'subj-qotd', weekly:'weekly',
    chapters:'online', wrong:'wrong', bookmarks:'bookmarks'
  };
  function applyHash(){
    const key = String(location.hash || '').replace(/^#/, '').toLowerCase();
    const view = MAP[key];
    if (view && typeof UI !== 'undefined' && UI.go) UI.go(view);
  }
  window.addEventListener('hashchange', applyHash);
  if (!location.hash) return;
  let tries = 0;
  (function wait(){
    const app = $('app');
    if (app && app.classList.contains('on')) { applyHash(); return; }
    if (++tries < 80) setTimeout(wait, 250);
  })();
})();

/* ═══════════════════════════════════════════════════════════════════════
   WRONGBY — missed questions grouped by chapter and by file.
   ═══════════════════════════════════════════════════════════════════════ */
 /* ═══════════════════════════════════════════════════════════════════════
   QNOTE — personal notes attached to any question.

   A student can add a short note ("remember: this is asking for ULTIMATE
   and not working stress") to any question, right or wrong. The note is
   shown on the flashcard below the explanation, on the results review,
   and inside the wrong-bank card.

   Stored in localStorage as a uid → text map. Deliberately NOT synced to
   the server: notes are scratchpad, not graded progress, and keeping them
   local means the sync payload stays small.

   The "why did I miss this" field in the wrong bank writes to the
   same store, so a note typed there appears on the flashcard too.
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
   QHIST — "seen Nx · M correct" line under a flashcard.
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
   DAILY10 — a fixed set of 10 questions for today.
   ═══════════════════════════════════════════════════════════════════════ */
window.DAILY10 = {
  COUNT: 10,
  _dateKey(){
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
  },
  _seed(){ return parseInt(this._dateKey().replace(/-/g, ''), 10) || 20250101; },
  _rng(seed){
    let a = seed >>> 0;
    return function(){ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  },
  _openedFids(){
    const cov = S.cov || {};
    return Object.keys(cov).filter(f => cov[f] && (cov[f].a || 0) > 0);
  },
  _doneKey(){ return 'abhyas_daily10_done'; },
  isDone(){ try { return localStorage.getItem(this._doneKey()) === this._dateKey(); } catch(e){ return false; } },
  markDone(){ try { localStorage.setItem(this._doneKey(), this._dateKey()); } catch(e){} },
  async build(){
    const fids = this._openedFids();
    if (!fids.length) return [];
    const rng = this._rng(this._seed());
    const all = [];
    const shuffled = fids.slice();
    for (let i = shuffled.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t; }
    for (const fid of shuffled){
      const ref = (typeof ChapterData !== 'undefined') ? ChapterData.allFileRefs().find(r => r.fid === fid) : null;
      if (!ref) continue;
      try {
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        const qs = normQ(raw, ref.fid);
        for (const q of qs){
          const hist = (typeof QHIST !== 'undefined') ? QHIST.forUid(q.uid) : null;
          if (hist && hist.seen > 0 && hist.correct === hist.seen) continue;
          all.push(q);
        }
      } catch(e){}
      if (all.length >= 200) break;
    }
    for (let i = all.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); const t = all[i]; all[i] = all[j]; all[j] = t; }
    return all.slice(0, this.COUNT);
  },
  async start(){
    QUIZ._showLoader('Building today\u2019s 10\u2026');
    let picked = [];
    try { picked = await this.build(); } catch(e){}
    QUIZ._hideLoader();
    if (!picked.length){ toast('Open a chapter once and the daily set begins tomorrow.', 5000); return; }
    QUIZ.startWith(picked, 'flashcard', '\u2600\ufe0f Daily 10 \u2014 ' + this._dateKey(),
      { daily10: true, daily10Date: this._dateKey() });
  },
  render(){
    const box = document.getElementById('daily10-slot');
    if (!box) return;
    if (this.isDone()){ box.innerHTML = ''; return; }
    const fids = this._openedFids();
    if (!fids.length){ box.innerHTML = ''; return; }
    box.innerHTML =
      '<section class="card" style="border-color:var(--accent-line)">' +
        '<div class="card-hd"><h3><i class="ph ph-sun"></i> Daily 10</h3>' +
          '<span class="ctag ta">' + this.COUNT + ' questions</span></div>' +
        '<p class="t-foot" style="margin-bottom:var(--sp-3);line-height:1.5">A fresh set of ' + this.COUNT + ' questions from your opened chapters. Same for you all day, new one tomorrow.</p>' +
        '<button class="btn btn-solid btn-blk" data-on-click="DAILY10.start()">' +
          '<i class="ph ph-play-circle"></i> Start today\u2019s ' + this.COUNT + '</button>' +
      '</section>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   CALENDAR — 90-day study grid, GitHub-contribution style.
   ═══════════════════════════════════════════════════════════════════════ */
window.CALENDAR = {
  DAYS: 91,
  _byDay(){
    const map = {};
    const sessions = (S.prog && Array.isArray(S.prog.sessions)) ? S.prog.sessions : [];
    sessions.forEach(s => {
      if (!s || !s.at) return;
      const d = new Date(s.at), p = n => String(n).padStart(2, '0');
      const k = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
      map[k] = (map[k] || 0) + (s.total || 0);
    });
    return map;
  },
  render(){
    const box = document.getElementById('calendar-slot');
    if (!box) return;
    const byDay = this._byDay();
    if (!Object.keys(byDay).length){ box.innerHTML = ''; return; }
    const now = new Date();
    const cells = [];
    for (let i = this.DAYS - 1; i >= 0; i--){
      const d = new Date(now); d.setDate(d.getDate() - i);
      const p = n => String(n).padStart(2, '0');
      const k = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
      const n = byDay[k] || 0;
      const level = n === 0 ? 0 : n <= 5 ? 1 : n <= 15 ? 2 : n <= 30 ? 3 : 4;
      cells.push('<span class="cal-cell cal-' + level + '" title="' + esc(k) + ': ' + n + ' question' + (n === 1 ? '' : 's') + '"></span>');
    }
    let html = '';
    for (let i = 0; i < cells.length; i += 7){ html += '<div class="cal-week">' + cells.slice(i, i + 7).join('') + '</div>'; }
    const activeDays = Object.keys(byDay).length;
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-hd"><h3><i class="ph ph-calendar-check"></i> Study calendar</h3>' +
          '<span class="t-cap">' + activeDays + ' day' + (activeDays === 1 ? '' : 's') + ' studied</span></div>' +
        '<div class="cal-grid">' + html + '</div>' +
        '<div class="cal-legend"><span class="t-cap">Less</span>' +
          '<span class="cal-cell cal-0"></span><span class="cal-cell cal-1"></span>' +
          '<span class="cal-cell cal-2"></span><span class="cal-cell cal-3"></span>' +
          '<span class="cal-cell cal-4"></span><span class="t-cap">More</span></div>' +
      '</div>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   FORECAST — days-to-finish at the current pace, per level.
   ═══════════════════════════════════════════════════════════════════════ */
window.FORECAST = {
  render(){
    const box = document.getElementById('forecast-slot');
    if (!box) return;
    const sessions = (S.prog && Array.isArray(S.prog.sessions)) ? S.prog.sessions : [];
    const since = Date.now() - 14 * 86400000;
    const recent = sessions.filter(s => (s.at || 0) >= since);
    if (recent.length < 3){ box.innerHTML = ''; return; }
    const total = recent.reduce((n, s) => n + (s.total || 0), 0);
    const perDay = total / 14;
    if (perDay < 1){ box.innerHTML = ''; return; }
    const allRefs = (typeof ChapterData !== 'undefined') ? ChapterData.allFileRefs() : [];
    const cov = S.cov || {}, fcount = S.fcount || {};
    const levels = [['level7','Level 7'], ['level5','Level 5'], ['gk','GK']];
    const lines = [];
    for (const entry of levels){
      const lv = entry[0], label = entry[1];
      const refs = allRefs.filter(r => r.lv === lv);
      if (!refs.length) continue;
      let totalQ = 0, seen = 0, missing = 0;
      refs.forEach(r => {
        const n = fcount[r.fid];
        if (n == null){ missing++; return; }
        totalQ += n;
        const c = cov[r.fid];
        if (c && c.p) for (let i = 0; i < c.p.length; i++) if (c.p[i] !== '0') seen++;
      });
      if (missing > 0 || totalQ === 0) continue;
      const remaining = Math.max(0, totalQ - seen);
      const days = Math.ceil(remaining / perDay);
      lines.push({ label: label, seen: seen, totalQ: totalQ, remaining: remaining, days: days, target: new Date(Date.now() + days * 86400000) });
    }
    if (!lines.length){ box.innerHTML = ''; return; }
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-hd"><h3><i class="ph ph-trend-up"></i> At this pace</h3></div>' +
        '<p class="t-foot" style="margin-bottom:var(--sp-3);line-height:1.55">Based on the last 14 days \u2014 about <b>' + perDay.toFixed(1) + ' questions a day</b>.</p>' +
        lines.map(function(l){
          return '<div class="fc-line"><b>' + esc(l.label) + '</b> \u2014 ' + l.seen + ' of ' + l.totalQ + ' seen. ' +
            (l.remaining === 0
              ? '<span style="color:var(--success);font-weight:700">Complete</span>'
              : 'Finish in <b>' + l.days + ' day' + (l.days === 1 ? '' : 's') + '</b> <span class="t-foot">(' + l.target.toLocaleDateString() + ')</span>') + '</div>';
        }).join('') +
      '</div>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   DIGEST — last-7-days summary on Home.
   ═══════════════════════════════════════════════════════════════════════ */
window.DIGEST = {
  render(){
    const box = document.getElementById('digest-slot');
    if (!box) return;
    const sessions = (S.prog && Array.isArray(S.prog.sessions)) ? S.prog.sessions : [];
    const since = Date.now() - 7 * 86400000;
    const recent = sessions.filter(s => (s.at || 0) >= since);
    if (recent.length < 2){ box.innerHTML = ''; return; }
    let answered = 0, correct = 0;
    const dayCount = {}, chapMiss = {};
    recent.forEach(function(s){
      answered += s.total || 0; correct += s.correct || 0;
      const k = new Date(s.at).toDateString();
      dayCount[k] = (dayCount[k] || 0) + (s.total || 0);
      const c = s.chapter || 'Other';
      chapMiss[c] = (chapMiss[c] || 0) + ((s.total || 0) - (s.correct || 0));
    });
    const pct = answered ? Math.round((correct / answered) * 100) : 0;
    const bestDay = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0];
    const worstChapter = Object.entries(chapMiss).sort((a, b) => b[1] - a[1])[0];
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-hd"><h3><i class="ph ph-chart-bar"></i> This week</h3>' +
          '<span class="ctag ta">last 7 days</span></div>' +
        '<div class="g4" style="margin-bottom:var(--sp-3)">' +
          '<div class="sc"><div class="sv tcy">' + answered + '</div><div class="stat-lbl">Answered</div></div>' +
          '<div class="sc"><div class="sv ' + (pct >= 70 ? 'tc2' : pct >= 50 ? 'ta2' : 'tb2') + '">' + pct + '%</div><div class="stat-lbl">Accuracy</div></div>' +
          '<div class="sc"><div class="sv">' + recent.length + '</div><div class="stat-lbl">Sessions</div></div>' +
          '<div class="sc"><div class="sv">' + Object.keys(dayCount).length + '</div><div class="stat-lbl">Active days</div></div>' +
        '</div>' +
        (bestDay ? '<div class="t-foot">Best day: <b>' + esc(bestDay[0]) + '</b> (' + bestDay[1] + ' answered)</div>' : '') +
        (worstChapter && worstChapter[1] > 0 ? '<div class="t-foot" style="margin-top:2px">Needs work: <b>' + esc(worstChapter[0]) + '</b> (' + worstChapter[1] + ' missed)</div>' : '') +
      '</div>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   HARDEST20 — one-tap session of the student's 20 hardest questions.
   ═══════════════════════════════════════════════════════════════════════ */
window.HARDEST20 = {
  COUNT: 20,
  async build(){
    if (!QSEARCH._index) await QSEARCH._build();
    const list = QSEARCH._index || [];
    if (!list.length) return [];
    const scored = [];
    for (let i = 0; i < list.length; i++){
      const q = list[i];
      const hist = QHIST.forUid(q.uid);
      if (!hist || hist.seen < 2) continue;
      const rate = hist.correct / hist.seen;
      if (rate >= 0.7) continue;
      scored.push({ q: q, miss: WRONGBY.missCount(q.uid), rate: rate });
    }
    scored.sort(function(a, b){
      if (b.miss !== a.miss) return b.miss - a.miss;
      return a.rate - b.rate;
    });
    return scored.slice(0, this.COUNT).map(function(x){ return x.q; });
  },
  async start(){
    QUIZ._showLoader('Finding your hardest questions\u2026');
    let picked = [];
    try { picked = await this.build(); } catch(e){}
    QUIZ._hideLoader();
    if (!picked.length){ toast('Practice a few chapters first \u2014 then this drills the ones you keep missing.', 5000); return; }
    QUIZ.startWith(picked, 'flashcard', '\ud83c\udfaf Your hardest ' + picked.length, null);
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   SYLLABUS_PROGRESS — % complete per level.
   ═══════════════════════════════════════════════════════════════════════ */
window.SYLLABUS_PROGRESS = {
  render(){
    const box = document.getElementById('syllabus-slot');
    if (!box) return;
    const allRefs = (typeof ChapterData !== 'undefined') ? ChapterData.allFileRefs() : [];
    if (!allRefs.length){ box.innerHTML = ''; return; }
    const cov = S.cov || {}, fcount = S.fcount || {};
    const levels = [['level7','Level 7'], ['level5','Level 5'], ['gk','GK']];
    const rows = [];
    for (const entry of levels){
      const lv = entry[0], label = entry[1];
      const refs = allRefs.filter(r => r.lv === lv);
      if (!refs.length) continue;
      let total = 0, seen = 0;
      refs.forEach(r => {
        const n = fcount[r.fid];
        if (n != null) total += n;
        const c = cov[r.fid];
        if (c && c.p) for (let i = 0; i < c.p.length; i++) if (c.p[i] !== '0') seen++;
      });
      rows.push({ label: label, seen: seen, total: total, pct: total ? Math.min(100, Math.round((seen / total) * 100)) : 0 });
    }
    if (!rows.length){ box.innerHTML = ''; return; }
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-hd"><h3><i class="ph ph-books"></i> Syllabus progress</h3></div>' +
        rows.map(function(r){
          return '<div class="sp-item"><div class="sp-l"><span>' + esc(r.label) + '</span>' +
            '<span class="t-cap mono">' + r.seen + ' / ' + (r.total || '?') + ' \u00b7 ' + r.pct + '%</span></div>' +
            '<div class="pb"><div class="pb-f" style="width:' + r.pct + '%"></div></div></div>';
        }).join('') +
      '</div>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   SYLLABUS_MOCK — daily 75-mark paper: 25 GK + 50 Level 7 (by topic unless the admin set a scheme).
   ═══════════════════════════════════════════════════════════════════════ */
window.LKS = {
  scheme(){ let raw = ''; try { raw = localStorage.getItem('abhyas_lscheme') || ''; } catch(e){} return normalizeLoksewaScheme(raw); },
  minutes(){ return Math.max(10, Math.round(this.scheme().total * 0.8)); }     /* 75 marks = 60 minutes */
};

window.SYLLABUS_MOCK = {
  _dateKey(){
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
  },
  _seed(){ return parseInt(this._dateKey().replace(/-/g, ''), 10) || 20250101; },
  _rng(seed){
    let a = seed >>> 0;
    return function(){ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  },
  _allRefs(){ return (typeof ChapterData !== 'undefined') ? ChapterData.allFileRefs() : []; },
  async _pool(scheme){
    const pool = [];
    for (const ref of this._allRefs()){
      if (!loksewaGroupFor(scheme, ref.lv, ref.ch)) continue;
      try {
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        normQ(raw, ref.fid).forEach(q => pool.push({ q, lv: ref.lv, ch: ref.ch }));
      } catch(e){}
    }
    return pool;
  },
  async build(){
    const scheme = LKS.scheme();
    const pool = await this._pool(scheme);
    const r = composeLoksewaPaper(scheme, pool, this._rng(this._seed()));
    return { papers: r.questions, shortfalls: r.shortfalls, scheme, total: r.total };
  },
  async start(){
    QUIZ._showLoader('Building today\u2019s ' + LKS.scheme().total + '-mark paper\u2026');
    let built = { papers: [], shortfalls: [], total: 75 };
    try { built = await this.build(); } catch(e){}
    QUIZ._hideLoader();
    if (built.papers.length < 10){ toast('Not enough chapters cached yet. Open a few chapters in Chapters first.', 6000); return; }
    if (built.shortfalls.length){
      toast('Short of questions for ' + built.shortfalls.map(s => s.name + ' (' + s.got + ' of ' + s.wanted + ')').join(', ') + '. Running a ' + built.papers.length + '-question paper.', 7000);
    }
    QUIZ.startWith(
      built.papers, 'exam',
      '\ud83d\udcdd Daily ' + built.total + '-mark Loksewa paper \u2014 ' + this._dateKey(),
      { loksewaMock: true, timeLimitSec: LKS.minutes() * 60 }
    );
  },
  render(){
    const box = document.getElementById('syllabus-mock-slot');
    if (!box) return;
    const scheme = LKS.scheme();
    const refs = this._allRefs();
    if (!refs.some(r => loksewaGroupFor(scheme, r.lv, r.ch))){ box.innerHTML = ''; return; }
    box.innerHTML =
      '<section class="card" style="border-color:var(--accent-line)">' +
        '<div class="card-hd"><h3><i class="ph ph-note-pencil"></i> Today\u2019s ' + scheme.total + '-mark Loksewa paper</h3>' +
          '<span class="ctag ta">' + scheme.total + ' marks \u00b7 ' + LKS.minutes() + ' min</span></div>' +
        '<p class="t-foot" style="margin-bottom:var(--sp-3);line-height:1.55">' +
          'Built to the syllabus mark scheme. Same paper all day; new one tomorrow. ' +
          'Loksewa scoring: <b>+1</b> correct, <b>\u22120.2</b> wrong, <b>0</b> skipped.</p>' +
        scheme.groups.map(g => '<div class="syl-row"><span class="syl-label">' + esc(g.name) + '</span><span class="syl-marks">' + g.marks + '</span></div>').join('') +
        '<button class="btn btn-solid btn-blk" style="margin-top:var(--sp-3)" data-on-click="SYLLABUS_MOCK.start()">' +
          '<i class="ph ph-play-circle"></i> Start today\u2019s paper</button>' +
      '</section>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   PRACTICE_RESUME — an unfinished practice session survives a tab close.
   ═══════════════════════════════════════════════════════════════════════ */
window.PRACTICE_RESUME = {
  KEY: 'abhyas_practice_snap',
  MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  SIZE_CEILING: 500 * 1024,
  get(){ try { const r = localStorage.getItem(this.KEY); return r ? JSON.parse(r) : null; } catch(e){ return null; } },
  clear(){ try { localStorage.removeItem(this.KEY); } catch(e){} },
  snapshot(){
    try {
      if (!S.quiz || !S.quiz.active) return;
      if (S.quiz.mode !== 'flashcard') return;
      if (S.quiz.reviewOnly) return;
      if (!S.user || !S.user.username) return;
      if (S.quiz.scope && (S.quiz.scope.daily10 || S.quiz.scope.weeklyId)) return;
      const answered = (S.quiz.ans || []).filter(a => a !== null && a !== undefined).length;
      if (answered === 0) return;
      let snap = { username: S.user.username, ch: S.quiz.ch || 'Practice', qs: S.quiz.qs,
        ans: S.quiz.ans.slice ? S.quiz.ans.slice() : [], idx: S.quiz.idx || 0,
        scope: S.quiz.scope || null, startedAt: S.quiz.startedAt || Date.now(), savedAt: Date.now() };
      let json = JSON.stringify(snap);
      if (json.length > this.SIZE_CEILING){
        snap.qs = snap.qs.map(q => { const { img, imgCaption, ...rest } = q; return rest; });
        json = JSON.stringify(snap);
      }
      if (json.length > this.SIZE_CEILING) return;
      localStorage.setItem(this.KEY, json);
    } catch(e){}
  },
  valid(){
    const s = this.get();
    if (!s || !s.username || !Array.isArray(s.qs) || !s.qs.length) return null;
    if (!S.user || S.user.username !== s.username) return null;
    if (Date.now() - (s.savedAt||0) > this.MAX_AGE_MS) return null;
    if ((s.ans || []).filter(a => a !== null && a !== undefined).length === 0) return null;
    return s;
  },
  render(){
    const box = document.getElementById('practice-resume-slot');
    if (!box) return;
    const s = this.valid();
    if (!s){ box.innerHTML = ''; return; }
    const answered = (s.ans || []).filter(a => a !== null && a !== undefined).length;
    const mins = Math.max(1, Math.round((Date.now() - (s.savedAt||0)) / 60000));
    const when = mins < 60 ? mins + ' min ago' : Math.round(mins/60) + ' h ago';
    box.innerHTML =
      '<section class="card" style="border-color:var(--accent-line);background:var(--accent-soft)">' +
        '<div class="card-hd"><h3><i class="ph ph-arrow-clockwise"></i> Unfinished practice</h3></div>' +
        '<p class="t-foot" style="margin-bottom:var(--sp-3);line-height:1.55;color:var(--ink-2)">' +
          'You were ' + answered + ' of ' + s.qs.length + ' through <b>' + esc(s.ch || 'a practice session') + '</b>, last touched ' + when + '.' +
        '</p>' +
        '<div class="bg"><button class="btn btn-solid grow" data-on-click="PRACTICE_RESUME.start()"><i class="ph ph-play"></i> Continue</button>' +
          '<button class="btn btn-quiet" data-on-click="PRACTICE_RESUME.discard()">Discard</button></div>' +
      '</section>';
  },
  start(){
    const s = this.valid();
    if (!s){ toast('That session is no longer available.'); this.render(); return; }
    while (s.ans.length < s.qs.length) s.ans.push(null);
    if (s.ans.length > s.qs.length) s.ans = s.ans.slice(0, s.qs.length);
    S.quiz = { qs: s.qs.slice(), ans: s.ans.slice(), mode: 'flashcard',
      idx: Math.max(0, Math.min(s.idx | 0, s.qs.length-1)),
      timer: null, elapsed: 0, left: 0, active: true, ch: s.ch || 'Practice',
      skipped: new Set(), shown: new Set(), scope: s.scope || null,
      startedAt: s.startedAt || Date.now(), reviewOnly: false };
    document.getElementById('quiz-wrap').style.display = '';
    document.querySelectorAll('.view').forEach(e => e.classList.remove('on'));
    document.getElementById('ex-wrap').style.display = 'none';
    document.getElementById('fc-wrap').style.display = '';
    document.getElementById('res-wrap').style.display = 'none';
    try { QUIZ._renderFlashcard(); QUIZ._startTimer(); } catch(e){}
    window.scrollTo(0, 0);
    this.clear();
    this.render();
    toast('Resumed where you left off', 3000);
  },
  discard(){ this.clear(); this.render(); toast('Practice session discarded'); }
};

/* ═══════════════════════════════════════════════════════════════════════
   SIDEBAR — moves lower-priority items into a "More tools" section.
   ═══════════════════════════════════════════════════════════════════════ */
window.SIDEBAR = {
  SECONDARY: [],
  _expanded: false,
  init(){
    const target = document.getElementById('sb-more-items');
    if (!target || target.dataset.init === '1') return;
    target.dataset.init = '1';
    const focusBtn = document.getElementById('nav-focus');
    if (focusBtn && focusBtn.parentNode) focusBtn.parentNode.removeChild(focusBtn);
    this.SECONDARY.forEach(id => {
      const el = document.getElementById(id);
      if (!el || !el.parentNode) return;
      const clone = el.cloneNode(true);
      clone.classList.add('sb-secondary-item');
      target.appendChild(clone);
      el.style.display = 'none';
    });
    document.querySelectorAll('#sb .sb-sec').forEach(sec => {
      const items = sec.querySelectorAll('.sb-item');
      if (!items.length) return;
      const visible = Array.prototype.filter.call(items, el => el.style.display !== 'none');
      if (!visible.length) sec.style.display = 'none';
    });
    this._applyState();
  },
  _applyState(){
    const items = document.getElementById('sb-more-items');
    const chev  = document.getElementById('sb-more-chev');
    if (items) items.style.display = this._expanded ? '' : 'none';
    if (chev)  chev.className = 'ph ' + (this._expanded ? 'ph-caret-up' : 'ph-caret-down');
    try { localStorage.setItem('abhyas_sb_expanded', this._expanded ? '1' : '0'); } catch(e){}
  },
  restore(){
    try { if (localStorage.getItem('abhyas_sb_expanded') === '1'){ this._expanded = true; this._applyState(); } } catch(e){}
  }
};

window.QHIST = {
  _cache: null,
  _index(){
    if (this._cache) return this._cache;
    const map = {};
    const sessions = (S.prog && Array.isArray(S.prog.sessions)) ? S.prog.sessions : [];
    for (let i = 0; i < sessions.length; i++){
      const qres = sessions[i] && sessions[i].qres;
      if (!Array.isArray(qres)) continue;
      for (let j = 0; j < qres.length; j++){
        const r = qres[j];
        if (!r || !r.uid) continue;
        const rec = map[r.uid] || (map[r.uid] = { seen: 0, correct: 0 });
        rec.seen++;
        if (r.ok) rec.correct++;
      }
    }
    this._cache = map;
    return map;
  },
  forUid(uid){ return this._index()[uid] || null; },
  render(containerId, uid){
    const box = document.getElementById(containerId);
    if (!box) return;
    if (!uid){ box.innerHTML = ''; return; }
    const r = this.forUid(uid);
    if (!r || r.seen < 2){ box.innerHTML = ''; return; }
    const pct = Math.round((r.correct / r.seen) * 100);
    const cls = pct >= 70 ? 'ok' : pct >= 40 ? 'mid' : 'low';
    box.innerHTML =
      '<div class="qhist-line">' +
        '<i class="ph ph-clock-counter-clockwise"></i> ' +
        'Seen ' + r.seen + '\u00d7 \u00b7 ' + r.correct + ' correct ' +
        '<b class="' + cls + '">(' + pct + '%)</b>' +
      '</div>';
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   QSEARCH — search across every question cached on the device.
   ═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════
   v1.29: PRINTABLE QUESTION SHEET.
   ═══════════════════════════════════════════════════════════════════════ */
window.PRINT_Q = {
  async sheet(fid, title){
    if(!fid){ toast('Not available.'); return; }
    const ref = (typeof ChapterData !== 'undefined')
      ? ChapterData.allFileRefs().find(r => r.fid === fid)
      : null;
    if(!ref){ toast('That chapter is not registered.'); return; }

    toast('Preparing the sheet…', 2500);
    let qs = [];
    try {
      const raw = await QUIZ._fetch(ref.fid, ref.key);
      qs = normQ(raw, ref.fid);
    } catch(e){
      toast('Could not load the questions — try again online.');
      return;
    }
    if(!qs.length){ toast('No questions to print.'); return; }

    const label = title || (ChapterData.chapterName(ref.lv, ref.ch) + ' — ' + ref.book + ' — ' + ref.subtopic);
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(label) + '</title>' +
      '<style>' +
        '@page{size:A4;margin:14mm}' +
        'body{font:11pt/1.55 Georgia,"Times New Roman",serif;color:#111;max-width:186mm;margin:0 auto;padding:12px}' +
        'h1{font-size:14pt;font-weight:700;margin:0 0 4px;border-bottom:2px solid #111;padding-bottom:4px}' +
        '.meta{font-size:9pt;color:#666;margin-bottom:14px}' +
        '.q{margin:10px 0;padding:8px 0;border-bottom:1px solid #eee;page-break-inside:avoid}' +
        '.q-num{font-weight:700;margin-right:6px}' +
        '.opts{margin:4px 0 0 20px;font-size:10pt;color:#333}' +
        '.opt{display:inline-block;margin-right:14px}' +
        '.answers{margin-top:22px;padding:10px;background:#f5f5f5;border:1px solid #ccc;border-radius:4px;font-size:9pt;page-break-before:always}' +
        '.ans-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-top:6px}' +
        '.ans-cell{font-family:monospace;text-align:center;padding:2px 0}' +
        '.footer{margin-top:16px;font-size:8pt;color:#999;text-align:center}' +
      '</style></head><body>' +
      '<h1>' + esc(label) + '</h1>' +
      '<div class="meta">Abhyas revision sheet · ' + qs.length + ' questions · ' + new Date().toLocaleDateString() + '</div>' +
      qs.map((q,i) => {
        const opts = (q.options || []).map((o,j) =>
          '<span class="opt">' + String.fromCharCode(65+j) + '. ' + esc(String(o)) + '</span>'
        ).join('');
        return '<div class="q">' +
          '<div><span class="q-num">Q' + (i+1) + '.</span>' + esc(q.q) + '</div>' +
          (opts ? '<div class="opts">' + opts + '</div>' : '') +
        '</div>';
      }).join('') +
      '<div class="answers">' +
        '<strong>Answer key</strong>' +
        '<div class="ans-grid">' +
          qs.map((q,i) => '<span class="ans-cell">' + (i+1) + ': ' +
            (q.correct != null ? String.fromCharCode(65 + Number(q.correct)) : '?') + '</span>').join('') +
        '</div>' +
      '</div>' +
      '<div class="footer">Generated by Abhyas · abhyasbymku@gmail.com</div>' +
      '</body></html>';

    let w = null;
    try { w = window.open('', '_blank'); } catch(e){ w = null; }
    if(!w){
      const blob = new Blob([html], { type:'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (label.replace(/[^a-zA-Z0-9]+/g, '_') || 'sheet') + '.html';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Pop-up blocked — the sheet was downloaded instead.', 5000);
      return;
    }
     w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(function(){ try { w.focus(); w.print(); } catch(e){} }, 400);
  }
};

window.QSEARCH = {
  _index: null, _loading: false, _last: [],
  async _build(){
    if (this._index) return this._index;
    if (this._loading){ while (this._loading) await new Promise(r => setTimeout(r, 100)); return this._index; }
    this._loading = true;
    const out = [];
    try {
      const keys = await QDB.keys();
      for (const key of keys){
        try {
          const raw = await QDB.get(key);
          const valid = raw && !(typeof raw === 'object' && !Array.isArray(raw) && raw.success === false);
          if (!valid) continue;
          const qs = normQ(raw, key);
          for (const q of qs) out.push(q);
        } catch(e){}
        if (out.length >= 8000) break;
      }
    } catch(e){}
    this._index = out;
    this._loading = false;
    return out;
  },
  async search(term){
    const idx = await this._build();
    const t = String(term || '').toLowerCase().trim();
    if (!t || t.length < 2) return [];
    const hits = [];
    for (let i = 0; i < idx.length; i++){
      const q = idx[i];
      const stem = String(q.q || '').toLowerCase();
      const opts = (q.options || []).join(' ').toLowerCase();
      const pos = stem.indexOf(t);
      if (pos >= 0){ hits.push({ q: q, where: 'stem', pos: pos }); continue; }
      const opos = opts.indexOf(t);
      if (opos >= 0) hits.push({ q: q, where: 'option', pos: opos });
    }
    hits.sort((a, b) => {
      if (a.where !== b.where) return a.where === 'stem' ? -1 : 1;
      return a.pos - b.pos;
    });
    return hits.slice(0, 60).map(h => h.q);
  },
  open(){
    let modal = document.getElementById('qsearch-modal');
    if (!modal){
      modal = document.createElement('div');
      modal.id = 'qsearch-modal';
      modal.className = 'mbg';
      modal.style.zIndex = '10050';
      modal.innerHTML =
        '<div class="mbox wide" data-on-click="event.stopPropagation()">' +
          '<div class="mhd"><h3><i class="ph ph-magnifying-glass"></i> Search questions</h3>' +
            '<button class="mcl" type="button" aria-label="Close" data-on-click="QSEARCH.close()"><i class="ph ph-x"></i></button></div>' +
          '<div class="mbody" style="padding-top:0">' +
            '<input class="input qs-input" id="qs-input" type="search" placeholder="Type any word from the question or options\u2026" autocomplete="off">' +
            '<div id="qs-status" class="t-foot" style="margin:var(--sp-2) 0"></div>' +
            '<div id="qs-results" class="stack2"></div>' +
          '</div>' +
        '</div>';
      modal.addEventListener('click', e => { if (e.target === modal) QSEARCH.close(); });
      document.body.appendChild(modal);
      const inp = modal.querySelector('#qs-input');
      let timer = null;
      inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => QSEARCH._run(inp.value), 220); });
      inp.addEventListener('keydown', e => { if (e.key === 'Escape'){ e.preventDefault(); QSEARCH.close(); } });
    }
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
    setTimeout(() => { const inp = document.getElementById('qs-input'); if (inp){ inp.value=''; inp.focus(); } }, 40);
    this._run('');
  },
  close(){
    const m = document.getElementById('qsearch-modal');
    if (m) m.classList.remove('show');
    if (!document.querySelector('.mbg.show')) document.body.style.overflow = '';
  },
  async _run(term){
    const status = document.getElementById('qs-status');
    const box = document.getElementById('qs-results');
    if (!box) return;
    if (!term || term.length < 2){
      box.innerHTML = '';
      if (this._index && this._index.length === 0) {
        status.innerHTML =
          '<i class="ph ph-info"></i> No questions downloaded yet. ' +
          'Open <b>Chapters</b> once while online — then everything is searchable here, ' +
          'even with no connection.';
        return;
      }
      status.textContent = this._index
        ? this._index.length + ' questions indexed \u00b7 type at least 2 characters.'
        : 'Indexing questions\u2026';
      return;
    }
    status.textContent = 'Searching\u2026';
    const hits = await this.search(term);
    if (!hits.length){ box.innerHTML = ''; status.textContent = 'No matches.'; return; }
    status.textContent = hits.length + ' result' + (hits.length === 1 ? '' : 's');
    const termLc = term.toLowerCase();
    box.innerHTML = hits.map((q, i) => {
      const stemRaw = String(q.q || '');
      const pos = stemRaw.toLowerCase().indexOf(termLc);
      const snip = pos < 0
        ? esc(stemRaw.slice(0, 200))
        : esc(stemRaw.slice(Math.max(0, pos - 40), pos + 160));
      const hl = pos >= 0
        ? snip.replace(new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i'), '<mark>$1</mark>')
        : snip;
      const correct = q.correct != null ? String.fromCharCode(65 + Number(q.correct)) : '?';
      return '<button type="button" class="qs-item" data-on-click="QSEARCH.pick(' + i + ')">' +
        '<span class="qs-badge">' + esc(correct) + '</span>' +
        '<span class="qs-body"><span class="qs-stem">' + hl + '</span>' +
        '<span class="qs-meta">' + esc((q.options || []).slice(0, 2).join('  \u00b7  ')) + '</span></span>' +
      '</button>';
    }).join('');
    this._last = hits;
  },
  pick(i){
    const q = (this._last || [])[i];
    if (!q) return;
    this.close();
    if (typeof QUIZ === 'undefined' || typeof QUIZ.startWith !== 'function') return;
    const fid = fidFromUid(String(q.uid || ''));
    const ref = (typeof ChapterData !== 'undefined')
      ? ChapterData.allFileRefs().find(r => r.fid === fid) : null;
    if (!ref){ QUIZ.startWith([q], 'flashcard', 'Search result', null); return; }
    (async () => {
      let pool = [];
      try { const raw = await QUIZ._fetch(ref.fid, ref.key); pool = normQ(raw, ref.fid); }
      catch(e){ pool = [q]; }
      const i = pool.findIndex(x => x.uid === q.uid);
      const reordered = i >= 0 ? [pool[i]].concat(pool.filter((_, j) => j !== i)) : [q].concat(pool);
      const chapName = ChapterData.chapterName(ref.lv, ref.ch) + ' \u2014 ' + ref.book;
      QUIZ.startWith(reordered, 'flashcard', 'Search: ' + chapName,
        { lv: ref.lv, ch: ref.ch, book: ref.book, sub: ref.subtopic, fid: ref.fid });
    })();
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   KEYSHEET — press "?" to see every keyboard shortcut.
   ═══════════════════════════════════════════════════════════════════════ */
window.KEYSHEET = {
  ROWS: [
    ['Any view',  ['/', 'Open question search'],
                  ['?', 'Show this sheet'],
                  ['Esc', 'Close any open sheet / leave quiz']],
    ['In a practice quiz', ['A B C D', 'Answer the current question'],
                            ['1 to 5', 'Or use number keys'],
                            ['\u2190 \u2192', 'Previous / next question'],
                            ['Ctrl + F', 'Search the question on Google (AI)']],
    ['In a timed test', ['A\u2013D', 'Answer the current question'],
                        ['Esc', 'Quit the test']],
    ['In the PDF viewer', ['+ \u2212', 'Zoom in / out'],
                            ['0', 'Fit page'],
                            ['F', 'Fullscreen'],
                            ['Ctrl + F', 'Find in document'],
                            ['Ctrl + S', 'Save marks']]
  ],
  open(){
    if (document.getElementById('keysheet-modal')) { this._show(); return; }
    const m = document.createElement('div');
    m.id = 'keysheet-modal';
    m.className = 'mbg';
    m.style.zIndex = '10055';
    m.innerHTML =
      '<div class="mbox" data-on-click="event.stopPropagation()" style="max-width:520px">' +
        '<div class="mhd"><h3><i class="ph ph-keyboard"></i> Keyboard shortcuts</h3>' +
          '<button class="mcl" type="button" aria-label="Close" data-on-click="KEYSHEET.close()"><i class="ph ph-x"></i></button></div>' +
        '<div class="mbody">' +
          this.ROWS.map(([section, ...rows]) =>
            '<div class="ks-section">' + esc(section) + '</div>' +
            rows.map(([k, d]) =>
              '<div class="ks-row"><span class="ks-keys">' +
                k.split(' ').map(x => '<kbd>' + esc(x) + '</kbd>').join(' ') +
              '</span><span class="ks-desc">' + esc(d) + '</span></div>'
            ).join('')
          ).join('') +
        '</div>' +
      '</div>';
    m.addEventListener('click', e => { if (e.target === m) KEYSHEET.close(); });
    document.body.appendChild(m);
    this._show();
  },
  _show(){ document.getElementById('keysheet-modal').classList.add('show'); document.body.style.overflow = 'hidden'; },
  close(){ const m = document.getElementById('keysheet-modal'); if (m) m.classList.remove('show'); if (!document.querySelector('.mbg.show')) document.body.style.overflow = ''; }
};

/* ═══════════════════════════════════════════════════════════════════════
   FOCUSMODE — hides streaks/badges/leaderboards during exam week.
   ═══════════════════════════════════════════════════════════════════════ */
window.FOCUSMODE = {
  KEY: 'abhyas_focus_mode',
  on(){ try { return localStorage.getItem(this.KEY) === '1'; } catch(e){ return false; } },
  toggle(){
    const next = !this.on();
    try { localStorage.setItem(this.KEY, next ? '1' : '0'); } catch(e){}
    this.apply();
    toast(next ? 'Focus mode on \u2014 streaks and badges hidden' : 'Focus mode off', 3000);
  },
  apply(){
    const on = this.on();
    document.documentElement.classList.toggle('focus-mode', on);
    const banner = document.getElementById('focus-banner');
    if (banner) banner.hidden = !on;
    const btn = document.getElementById('nav-focus');
    if (btn) btn.classList.toggle('active', on);
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   EXPORTNOTES — download every personal note as a text file.
   ═══════════════════════════════════════════════════════════════════════ */
window.EXPORTNOTES = {
  run(){
    if (typeof QNOTE === 'undefined'){ toast('No notes to export.'); return; }
    const store = QNOTE._load();
    const uids = Object.keys(store);
    if (!uids.length){ toast('You have no personal notes yet.'); return; }
    const idxMap = {};
    if (typeof QSEARCH !== 'undefined' && QSEARCH._index){
      QSEARCH._index.forEach(q => { if (q.uid) idxMap[q.uid] = q.q; });
    }
    const lines = ['Abhyas \u2014 your notes', 'Exported ' + new Date().toLocaleString(), ''];
    uids.sort().forEach(uid => {
      lines.push('─'.repeat(50));
      const stem = idxMap[uid];
      lines.push('Question: ' + (stem ? stem.slice(0, 200) : uid));
      lines.push('');
      lines.push('Your note:');
      lines.push(store[uid]);
      lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'abhyas-notes-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('Exported ' + uids.length + ' note' + (uids.length === 1 ? '' : 's'));
  }
};

window.QNOTE = {
  KEY: 'abhyas_qnotes',
  MAX: 500,
  _cache: null,

  _load(){
    if (this._cache) return this._cache;
    try {
      const raw = localStorage.getItem(this.KEY);
      const o = raw ? JSON.parse(raw) : {};
      this._cache = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch(e){ this._cache = {}; }
    return this._cache;
  },
  _save(){
    try { localStorage.setItem(this.KEY, JSON.stringify(this._cache || {})); } catch(e){}
  },

  get(uid){
    if (!uid) return '';
    const m = this._load();
    return String(m[uid] || '');
  },
  set(uid, text){
    if (!uid) return;
    const m = this._load();
    const t = String(text == null ? '' : text).slice(0, this.MAX).trim();
    if (t) m[uid] = t; else delete m[uid];
    this._save();
  },
  remove(uid){ this.set(uid, ''); },

  render(containerId, uid, opts){
    const box = document.getElementById(containerId);
    if (!box) return;
    box.dataset.uid = uid || '';
    if (!uid) { box.innerHTML = ''; return; }

    const note = this.get(uid);
    const readOnly = !!(opts && opts.readOnly);
    const editing  = !!(opts && opts.editing);
    const safeUid  = escAttrJs(uid);
    const safeBox  = escAttrJs(containerId);
    const inputId  = 'qnote-input-' + String(uid).replace(/[^a-zA-Z0-9]/g, '_');

    if (editing) {
      box.innerHTML =
        '<div class="qnote-box editing">' +
          '<div class="qnote-hd"><i class="ph ph-note"></i> Your note</div>' +
          '<textarea class="qnote-input" id="' + inputId + '" maxlength="' + this.MAX + '" ' +
            'placeholder="Write something you want to remember about this question\u2026">' +
            esc(note) +
          '</textarea>' +
          '<div class="qnote-actions">' +
            '<button type="button" class="btn btn-sm btn-quiet" data-on-click="QNOTE.cancel(\'' + safeBox + '\')">Cancel</button>' +
            '<button type="button" class="btn btn-sm btn-solid" data-on-click="QNOTE.commit(\'' + safeUid + '\',\'' + safeBox + '\')">Save note</button>' +
          '</div>' +
        '</div>';
      setTimeout(() => { const t = document.getElementById(inputId); if (t) { t.focus(); t.selectionStart = t.value.length; } }, 30);
      return;
    }

    if (note) {
      box.innerHTML =
        '<div class="qnote-box">' +
          '<div class="qnote-hd">' +
            '<i class="ph ph-note"></i> Your note' +
            (readOnly ? '' :
              '<button type="button" class="qnote-act" data-on-click="QNOTE.edit(\'' + safeUid + '\',\'' + safeBox + '\')" aria-label="Edit your note"><i class="ph ph-pencil-simple"></i></button>' +
              '<button type="button" class="qnote-act danger" data-on-click="QNOTE.remove(\'' + safeUid + '\',\'' + safeBox + '\')" aria-label="Delete your note"><i class="ph ph-trash"></i></button>') +
          '</div>' +
          '<div class="qnote-text">' + esc(note) + '</div>' +
        '</div>';
      return;
    }

    if (readOnly) { box.innerHTML = ''; return; }

    box.innerHTML =
      '<button type="button" class="qnote-add" data-on-click="QNOTE.edit(\'' + safeUid + '\',\'' + safeBox + '\')">' +
        '<i class="ph ph-plus"></i> Add a personal note' +
      '</button>';
  },

  edit(uid, containerId){ this.render(containerId, uid, { editing: true }); },
  cancel(containerId){
    const box = document.getElementById(containerId);
    const uid = box && box.dataset ? box.dataset.uid : '';
    this.render(containerId, uid);
  },
  commit(uid, containerId){
    const inputId = 'qnote-input-' + String(uid).replace(/[^a-zA-Z0-9]/g, '_');
    const ta = document.getElementById(inputId);
    const txt = ta ? ta.value : '';
    this.set(uid, txt);
    toast(this.get(uid) ? 'Note saved' : 'Note cleared');
    this.render(containerId, uid);
  },
};

window.WRONGBY = {
  _open: {},
  _last: [],

  _ref(fid){ return ChapterData.allFileRefs().find(r => r.fid === fid) || null; },
  _due(q){ return q._nextDue == null || q._nextDue <= Date.now(); },
  _fidOf(q){ return fidFromUid(String((q && q.uid) || '')); },
  _reason(q){
    if (!q) return '';
    if (q._reason) return String(q._reason);
    if (q._misconception) return 'careless';
    return '';
  },

  groups(){
    const byFid = {};
    (S.wr || []).forEach(q => {
      if (q._withdrawn) return;
      const fid = this._fidOf(q);
      const ref = this._ref(fid);
      if (!ref) return;
      const g = byFid[fid] || (byFid[fid] = { fid: fid, ref: ref, items: [], due: 0, careless: 0, concept: 0 });
      g.items.push(q);
      if (this._due(q)) g.due++;
      const r = this._reason(q);
      if (r === 'careless') g.careless++;
      else if (r === 'concept') g.concept++;
    });
    const byCh = {};
    Object.values(byFid).forEach(g => {
      const k = g.ref.lv + '|' + g.ref.ch;
      const c = byCh[k] || (byCh[k] = {
        key: k, lv: g.ref.lv, ch: g.ref.ch,
        name: ChapterData.chapterName(g.ref.lv, g.ref.ch),
        files: [], n: 0, due: 0, careless: 0, concept: 0
      });
      c.files.push(g);
      c.n += g.items.length;
      c.due += g.due;
      c.careless += g.careless;
      c.concept += g.concept;
    });
    return Object.values(byCh).sort((a, b) => b.due - a.due || b.n - a.n);
  },

  countFor(fid){
    return (S.wr || []).filter(q => this._fidOf(q) === fid).length;
  },
  countForChapter(lv, ch){
    return (S.wr || []).filter(q => {
      const ref = this._ref(this._fidOf(q));
      return ref && ref.lv === lv && ref.ch === ch;
    }).length;
  },

  async start(fids, dueOnly, mode){
    let items = (S.wr || []).filter(q => !q._withdrawn && fids.indexOf(this._fidOf(q)) !== -1);
    if (dueOnly) items = items.filter(q => this._due(q));
    if (!items.length) { toast(dueOnly ? 'Nothing due here right now.' : 'No missed questions here.'); return; }
    QUIZ._showLoader('Getting your missed questions…');
    const fresh = {};
    for (const fid of fids) {
      const ref = this._ref(fid);
      if (!ref) continue;
      try {
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        normQ(raw, ref.fid).forEach(q => { fresh[q.uid] = q; });
      } catch(e){}
    }
    QUIZ._hideLoader();
    const merged = items.map(q => {
      const f = fresh[q.uid];
      if (!f || !sameQuestionAfterCorrection(q, f, 0.6)) return q;
      return Object.assign({}, f, {
        _streak: q._streak, _nextDue: q._nextDue,
        _reason: q._reason, _misconception: q._misconception, _note: q._note
      });
    });
    const ref0 = this._ref(fids[0]);
    const label = (ref0 ? ChapterData.chapterName(ref0.lv, ref0.ch) : 'Missed') + ' — Missed';
    QUIZ.startWith(shuf(merged), mode || 'flashcard', label);
  },

  startChapter(i, dueOnly, mode){
    const c = this._last[i];
    if (c) this.start(c.files.map(f => f.fid), dueOnly, mode);
  },
  startFile(fid, dueOnly, mode){ this.start([fid], dueOnly, mode); },
  toggle(i){ const c = this._last[i]; if (!c) return; this._open[c.key] = !this._open[c.key]; this.render(); },

  missCount(uid){
    if (!uid) return 0;
    if (!this._missCache) this._missCache = {};
    if (this._missCache[uid] != null) return this._missCache[uid];
    let n = 0;
    const sessions = (S.prog && Array.isArray(S.prog.sessions)) ? S.prog.sessions : [];
    for (let i = 0; i < sessions.length; i++){
      const qres = sessions[i] && sessions[i].qres;
      if (!Array.isArray(qres)) continue;
      for (let j = 0; j < qres.length; j++){
        const r = qres[j];
        if (r && r.uid === uid && r.ok === false) n++;
      }
    }
    this._missCache[uid] = n;
    return n;
  },

  async practiceSimilar(uid){
    if (!uid) return;
    const fid = fidFromUid(String(uid));
    const ref = this._ref(fid);
    if (!ref){ toast('That chapter is not available.'); return; }
    QUIZ._showLoader('Finding similar questions\u2026');
    let pool = [];
    try {
      const raw = await QUIZ._fetch(ref.fid, ref.key);
      pool = normQ(raw, ref.fid);
    } catch(e){ QUIZ._hideLoader(); toast('Could not load the chapter.'); return; }
    QUIZ._hideLoader();
    if (pool.length < 2){ toast('Not enough questions in this file.'); return; }
    const current = pool.find(q => q.uid === uid);
    if (!current){ toast('Could not find this question.'); return; }
    const STOP = new Set(['which','whose','what','where','when','there',
      'their','these','those','about','following','correct','choose',
      'select','given','below','above','value','values','calculate',
      'determine','find','state','explain','describe','consider','shall',
      'will','would','could','should','might','must','been','being',
      'while','other','another','first','second','third']);
    const tok = s => String(s||'').toLowerCase().split(/[^a-z0-9]+/)
      .filter(w => w.length >= 5 && !STOP.has(w));
    const curTok = new Set(tok(current.q));
    const scored = pool.filter(q => q.uid !== uid).map(q => {
      const t = tok(q.q);
      let hits = 0;
      for (const w of t) if (curTok.has(w)) hits++;
      return { q: q, score: hits };
    });
    scored.sort((a,b) => b.score - a.score);
    const picked = scored.filter(x => x.score > 0).slice(0, 5).map(x => x.q);
    if (!picked.length){ toast('No similar questions found in this file.'); return; }
    const chapName = ChapterData.chapterName(ref.lv, ref.ch) + ' \u2014 ' + ref.book;
    QUIZ.startWith(picked, 'flashcard', 'Similar \u2014 ' + chapName,
      { lv: ref.lv, ch: ref.ch, book: ref.book, sub: ref.subtopic, fid: ref.fid });
  },

  setNote(uid, note){
    if (typeof QNOTE !== 'undefined') { QNOTE.set(uid, note); return; }
    const q = (S.wr || []).find(x => x.uid === uid);
    if (!q) return;
    q._note = String(note || '').slice(0, 160).trim();
    _save(LS.WR, S.wr);
  },

  setReason(uid, reason){
    const q = (S.wr || []).find(x => x.uid === uid);
    if (!q) return;
    q._reason = reason || '';
    if (reason === 'careless') q._misconception = true;
    else if (reason === 'concept') q._misconception = false;
    _save(LS.WR, S.wr);
    this.render();
  },

  dueAll(){
    const allFids = this._last.flatMap(c => c.files.map(f => f.fid));
    if (!allFids.length) { toast('Nothing to review yet.'); return; }
    this.start(allFids, true);
  },

  /* v1.42: the four views the Weak spots tab bar always promised. */
  _tab: 'due',
  TABS: ['due', 'all', 'misconceptions', 'hardest'],
  _items(){ return (S.wr || []).filter(q => !q._withdrawn); },
  _wNote(){
    const n = (S.wr || []).filter(x => x._withdrawn).length;
    return n ? '<div class="t-foot" style="color:var(--ink-2);margin:0 0 var(--sp-3)"><i class="ph ph-prohibit"></i> ' + n + ' withdrawn question' + (n === 1 ? '' : 's') + ' (removed from the bank, never practised)</div>' : '';
  },
  _text(q){ return String((q && (q.q || q.question || q.text)) || '').replace(/\s+/g, ' ').trim(); },
  _syncTabs(){
    document.querySelectorAll('#view-wrong .tabbar button').forEach(b => {
      const on = b.getAttribute('data-tab') === WRONGBY._tab;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
    });
    const el = document.getElementById('wr-list'); if (el) el.setAttribute('role', 'tabpanel');
  },
  tab(name){
    WRONGBY._tab = WRONGBY.TABS.indexOf(name) === -1 ? 'due' : name;
    WRONGBY.render();
  },
  startList(items, label){
    if (!items.length) { toast('Nothing to practise here yet.'); return; }
    QUIZ.startWith(shuf(items.slice()), 'flashcard', label);
  },
  startReason(r){
    const want = r === 'concept' ? 'concept' : r === 'careless' ? 'careless' : '';
    const items = WRONGBY._items().filter(q => (WRONGBY._reason(q) || '') === want);
    WRONGBY.startList(items, (want === 'concept' ? 'Concept gaps' : want === 'careless' ? 'Careless mistakes' : 'Not sorted yet') + ' \u00b7 Missed');
  },
  _hardest(){
    return WRONGBY._items().map(q => ({ q: q, n: WRONGBY.missCount(q.uid) })).filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n || (a.q._streak || 0) - (b.q._streak || 0)).slice(0, 20);
  },
  startHardest(){ WRONGBY.startList(WRONGBY._hardest().map(x => x.q), 'Hardest 20 \u00b7 Missed'); },

  _renderDue(el){
    const due = this._last.map((c, i) => ({ c: c, i: i })).filter(x => x.c.due > 0);
    const total = this._last.reduce((n, c) => n + c.n, 0);
    const dueTotal = due.reduce((n, x) => n + x.c.due, 0);
    if (!dueTotal) {
      el.innerHTML = this._wNote() + '<div class="card"><div class="t-callout" style="color:var(--ink)"><b>Nothing is due right now.</b></div>' +
        '<div class="t-foot mt2" style="color:var(--ink-2)">' + total + ' missed question' + (total === 1 ? ' is' : 's are') + ' waiting. Each comes back for review on a spaced schedule.</div>' +
        '<button class="btn btn-quiet btn-blk mt3" data-on-click="WRONGBY.tab(\'all\')">See all missed questions</button></div>';
      return;
    }
    el.innerHTML = this._wNote() + '<div class="card" style="margin-bottom:var(--sp-3);background:var(--accent-soft);border-color:var(--accent-line)">' +
        '<div class="t-callout" style="color:var(--ink)"><b>' + dueTotal + '</b> ready for review now, in ' + due.length + ' chapter' + (due.length === 1 ? '' : 's') + '.</div>' +
        '<button class="btn btn-solid btn-blk mt3" data-on-click="WRONGBY.dueAll()"><i class="ph ph-repeat"></i> Review all ' + dueTotal + ' due now</button></div>' +
      due.map(x => '<div class="card" style="margin-bottom:var(--sp-2)"><div class="card-hd"><h3>' + esc(x.c.name) + '</h3><span class="ctag tr">' + x.c.due + ' due</span></div>' +
        '<div class="bg"><button class="btn btn-sm btn-solid" data-on-click="WRONGBY.startChapter(' + x.i + ',true)">Do what\'s due</button></div></div>').join('');
  },

  _renderReasons(el){
    const by = { concept: [], careless: [], other: [] };
    this._items().forEach(q => { const r = this._reason(q); by[r === 'concept' ? 'concept' : r === 'careless' ? 'careless' : 'other'].push(q); });
    const cards = [
      ['concept',  'Concept gaps',      'ph-book',      'You did not know it or had the idea wrong. Revise the idea, then practise.'],
      ['careless', 'Careless mistakes', 'ph-lightning', 'You knew it but slipped. Slow down and re-read the question.'],
      ['other',    'Not sorted yet',    'ph-question',  'Open All missed, choose Show every question, and say why you missed one. It moves into a group above.']
    ].filter(c => by[c[0]].length);
    if (!cards.length) { el.innerHTML = this._wNote() + '<div class="card"><div class="t-callout" style="color:var(--ink)">Nothing here yet. Missed questions are grouped by why you missed them.</div></div>'; return; }
    el.innerHTML = this._wNote() + cards.map(c => '<div class="card" style="margin-bottom:var(--sp-2)"><div class="card-hd"><h3><i class="ph ' + c[2] + '"></i> ' + c[1] + '</h3>' +
      '<span class="ctag ' + (c[0] === 'other' ? 'ta' : 'tr') + '">' + by[c[0]].length + '</span></div>' +
      '<p class="t-callout mb4">' + c[3] + '</p>' +
      '<div class="bg"><button class="btn btn-sm btn-solid" data-on-click="WRONGBY.startReason(\'' + c[0] + '\')">Practise these ' + by[c[0]].length + '</button></div></div>').join('');
  },

  _renderHardest(el){
    const top = this._hardest();
    if (!top.length) { el.innerHTML = this._wNote() + '<div class="card"><div class="t-callout" style="color:var(--ink)">No question has beaten you more than once yet.</div><div class="t-foot mt2" style="color:var(--ink-2)">Questions you miss again and again appear here, hardest first.</div></div>'; return; }
    el.innerHTML = this._wNote() + '<div class="card" style="margin-bottom:var(--sp-3);background:var(--accent-soft);border-color:var(--accent-line)">' +
        '<div class="t-callout" style="color:var(--ink)">Your <b>' + top.length + '</b> hardest question' + (top.length === 1 ? '' : 's') + ', most missed first.</div>' +
        '<button class="btn btn-solid btn-blk mt3" data-on-click="WRONGBY.startHardest()"><i class="ph ph-target"></i> Practise these ' + top.length + '</button></div>' +
      '<div class="card">' + top.map(x => '<div class="row" style="padding:var(--sp-2) 0"><div class="row-main"><div class="t-callout" style="color:var(--ink)">' + esc(this._text(x.q).slice(0, 120) || 'Question') +
        '</div><div class="t-cap">missed ' + x.n + ' time' + (x.n === 1 ? '' : 's') + '</div></div></div>').join('') + '</div>';
  },

  render(){
    const el = document.getElementById('wr-list');
    if (!el) return;
    this._syncTabs();
    this._last = this.groups();
    if (!this._last.length) { WRONGBY._plain('wr'); return; }
    const t = this._tab || 'due';
    if (t === 'due') return this._renderDue(el);
    if (t === 'misconceptions') return this._renderReasons(el);
    if (t === 'hardest') return this._renderHardest(el);
    return this._renderAll();
  },

  _renderAll(){
    const el = document.getElementById('wr-list');
    if (!el) return;
    this._last = this.groups();
    if (!this._last.length) { WRONGBY._plain('wr'); return; }

    const total = this._last.reduce((n, c) => n + c.n, 0);
    const dueTotal = this._last.reduce((n, c) => n + c.due, 0);
    const careless = this._last.reduce((n, c) => n + c.careless, 0);
    const concept = this._last.reduce((n, c) => n + c.concept, 0);
    const withdrawn = (S.wr || []).filter(x => x._withdrawn).length;

    const head =
      '<div class="card" style="margin-bottom:var(--sp-3);background:var(--accent-soft);border-color:var(--accent-line)">' +
        '<div class="t-callout" style="color:var(--ink)">' + total + ' missed question' + (total === 1 ? '' : 's') +
        ' across ' + this._last.length + ' chapter' + (this._last.length === 1 ? '' : 's') + '.' +
        (dueTotal ? ' <b>' + dueTotal + '</b> ready for review now.' : '') + '</div>' +
        (careless || concept
          ? '<div class="t-foot mt2" style="color:var(--ink-2)">' +
              (careless ? '<i class="ph ph-lightning"></i> ' + careless + ' careless' : '') +
              (careless && concept ? ' · ' : '') +
              (concept ? '<i class="ph ph-book"></i> ' + concept + ' concept gap' : '') +
            '</div>'
          : '') +
        (withdrawn ? '<div class="t-foot mt2" style="color:var(--ink-2)"><i class="ph ph-prohibit"></i> ' + withdrawn + ' withdrawn question' + (withdrawn === 1 ? '' : 's') + ' (removed from the question bank) ' + (withdrawn === 1 ? 'is' : 'are') + ' kept in the full list and left out of practice.</div>' : '') +
        (dueTotal ? '<button class="btn btn-solid btn-blk mt3" data-on-click="WRONGBY.dueAll()"><i class="ph ph-repeat"></i> Review all ' + dueTotal + ' due now</button>' : '') +
      '</div>';

    el.innerHTML = head + this._last.map((c, i) => {
      const open = this._open[c.key];
      const files = open ? c.files.map(f =>
        '<div class="row" style="padding:var(--sp-2) 0">' +
          '<div class="row-main">' +
            '<div class="t-callout" style="color:var(--ink);font-weight:600">' + esc(prettySub(f.ref.subtopic)) + '</div>' +
            '<div class="t-cap">' + f.items.length + ' missed · ' + f.due + ' due' + '</div>' +
          '</div>' +
          '<button class="btn btn-sm btn-a" data-on-click="WRONGBY.startFile(\'' + escAttrJs(f.fid) + '\',false)">Practise</button>' +
          '<button class="btn btn-sm btn-quiet" data-on-click="WRONGBY.startFile(\'' + escAttrJs(f.fid) + '\',false,\'exam\')">Test</button>' +
        '</div>'
      ).join('') : '';
      return '<div class="card" style="margin-bottom:var(--sp-2)">' +
        '<div class="card-hd"><h3>' + esc(c.name) + '</h3>' +
          '<span class="ctag ' + (c.due ? 'tr' : 'ta') + '">' + c.n + ' missed' + (c.due ? ' · ' + c.due + ' due' : '') + '</span>' +
        '</div>' +
        '<div class="bg">' +
          (c.due ? '<button class="btn btn-sm btn-solid" data-on-click="WRONGBY.startChapter(' + i + ',true)">Do what\'s due</button>' : '') +
          '<button class="btn btn-sm btn-a" data-on-click="WRONGBY.startChapter(' + i + ',false)">All ' + c.n + '</button>' +
          '<button class="btn btn-sm btn-quiet" data-on-click="WRONGBY.toggle(' + i + ')">' + (open ? 'Hide files' : 'By file (' + c.files.length + ')') + '</button>' +
        '</div>' +
        files +
      '</div>';
    }).join('') + '<button class="btn btn-quiet btn-blk" data-on-click="WRONGBY._plain(\'wr\')">Show every question (to report or remove one)</button>';
  }
};

WRONGBY._plain = REV.renderList.bind(REV);
REV.renderList = function(kind){
  return kind === 'wr' ? WRONGBY.render() : WRONGBY._plain(kind);
};

(function bootstrapSidebar(){
  function go(){ try { if (typeof SIDEBAR !== 'undefined'){ SIDEBAR.init(); SIDEBAR.restore(); } } catch(e){} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(go, 400));
  else setTimeout(go, 400);
})();

(function bootstrapAdmin(){
  let tries = 0;
  const check = () => {
    let user = null;
    try { user = (typeof S !== 'undefined' && S.user) ? S.user : null; } catch(e){}
    if (user) {
      _setAdminVisible(!!user.adminCapable);
      if (typeof APP_SWITCH !== 'undefined') APP_SWITCH.refresh();
      if (typeof MY_SUBJ !== 'undefined') MY_SUBJ.load(false);
      return;
    }
    if (++tries < 40) setTimeout(check, 250);
  };
  check();
})();

(function(){
  const bar = $('offbar');
  if (!bar) return;
  new MutationObserver(() => {
    const t = bar.textContent;
    if (/local cache/i.test(t))        bar.textContent = "Offline — showing what's saved on this device";
    else if (/forced|blocked by you/i.test(t)) bar.textContent = 'Offline mode is on — tap the signal icon to go back online';
  }).observe(bar, { childList:true, characterData:true, subtree:true });
})();

(function(){
  const mbg = $('mbg');
  if (!mbg) return;
  let prevFocus = null, handler = null;
  function focusables(){
    return Array.from(mbg.querySelectorAll('button,[href],input:not([type="hidden"]),select,textarea,[tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.disabled && el.offsetParent !== null);
  }
  function onKeydown(e){
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function activate(){
    if (handler) return;
    prevFocus = document.activeElement;
    handler = onKeydown;
    mbg.addEventListener('keydown', handler);
    setTimeout(() => { const l = focusables(); if (l.length) l[0].focus(); }, 0);
  }
  function deactivate(){
    if (!handler) return;
    mbg.removeEventListener('keydown', handler);
    handler = null;
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    prevFocus = null;
  }
  new MutationObserver(() => {
    if (mbg.classList.contains('show')) activate(); else deactivate();
  }).observe(mbg, { attributes:true, attributeFilter:['class'] });
})();

(function(){
  const sb = $('sb');
  if (!sb || !window.MutationObserver) return;
  new MutationObserver(() => {
    const open = sb.classList.contains('open');
    document.body.style.overflow = open ? 'hidden' : '';
    sb.setAttribute('aria-hidden', open || window.innerWidth > 960 ? 'false' : 'true');
  }).observe(sb, { attributes:true, attributeFilter:['class'] });
})();

(function(){
  try {
    const el = $('sb-version');
    if (el && !el.textContent.trim()) {
      el.textContent = 'Abhyas' + (typeof APP_VERSION !== 'undefined' ? ' v' + APP_VERSION : '');
    }
  } catch(e){}
})();

window.CLOUD_UI = (function(){
  function render(){
    const statusEl = $('cloud-status');
    if (!statusEl) return;
    if (typeof CLOUD === 'undefined') {
      statusEl.textContent = 'Drive backup is not available in this build.';
      const row = $('cloud-btn-row');
      if (row) row.style.display = 'none';
      return;
    }
    const st = CLOUD.status();
    const show = (id, on) => { const e = $(id); if (e) e.style.display = on ? '' : 'none'; };
    if (st.signedIn) {
      statusEl.textContent = st.email ? ('Signed in as ' + st.email) : 'Signed in to Google.';
      show('cloud-signin-btn', false);
      show('cloud-backup-btn', true);
      show('cloud-restore-btn', true);
      show('cloud-signout-btn', true);
    } else {
      statusEl.textContent = 'Sign in with Google to keep a copy in your own Drive.';
      show('cloud-signin-btn', true);
      show('cloud-backup-btn', false);
      show('cloud-restore-btn', false);
      show('cloud-signout-btn', false);
    }
  }
  function signIn(){
    toast('Opening Google sign-in…');
    CLOUD.signIn().then(r => {
      if (!r.success) { toast(r.error, 5000); return; }
      toast('Signed in' + (r.email ? ' as ' + r.email : ''));
      render();
    });
  }
  function signOut(){ CLOUD.signOut().then(() => { toast('Signed out of Drive backup.'); render(); }); }
  function backup(){
    toast('Backing up to your Drive…');
    CLOUD.backup().then(r => {
      if (!r.success) { toast(r.error, 5000); return; }
      toast(r.unchanged ? 'Nothing has changed since your last Drive backup.'
        : 'Backed up (' + Math.round(r.bytes / 1024) + ' KB). Your newest 5 versions are kept.');
      render();
    });
  }
  function restore(){
    toast('Looking for your backups…');
    CLOUD.listVersions().then(r => {
      if (!r.success) { toast(r.error, 5000); return; }
      if (!r.versions.length) { toast('No backup found in your Drive yet.', 4000); return; }
      const rows = r.versions.map((v, i) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.5rem 0;border-bottom:1px solid var(--sep)">' +
        '<div><b>' + esc(new Date(v.at).toLocaleString()) + '</b>' + (i === 0 ? ' <span class="ctag tg">Newest</span>' : '') + (v.legacy ? ' <span class="ctag">Older format</span>' : '') +
        '<div class="t-cap">' + Math.max(1, Math.round(v.size / 1024)) + ' KB</div></div>' +
        '<button class="btn btn-quiet btn-sm" data-on-click="CLOUD_UI.restoreVersion(\'' + esc(v.id) + '\')">Add this copy</button></div>').join('');
      openMod('Restore from Drive',
        '<p class="t-callout mb3">Adding a copy brings back anything this device is missing. <b>Nothing on this device is removed</b>, and a safety copy is saved first (Data &gt; Recover). If a copy is damaged you will be told and nothing changes.</p>' + rows);
    });
  }
  function restoreVersion(id){
    closeMod();
    toast('Restoring from your Drive…');
    CLOUD.restore(id).then(r => {
      if (!r.success) { toast(r.error, 6000); return; }
      render();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && UI.cur === 'progress') render();
  });
  return { render, signIn, signOut, backup, restore, restoreVersion };
})();

document.addEventListener('click', function warm(e){
  if (e.target.closest && e.target.closest('#nav-progress, #bn-progress')) {
    if (typeof CLOUD !== 'undefined') CLOUD.init().catch(() => {});
    document.removeEventListener('click', warm);
    setTimeout(CLOUD_UI.render, 50);
  }
});

const SERVER_PROG = {
  _loaded:false, _loading:false, _sort:'most', _rows:[],

  SORT_LABEL:{ most:'Most done first', least:'Least done first', name:'A to Z' },

  toggleSort(){
    this._sort = this._sort === 'most' ? 'least' : this._sort === 'least' ? 'name' : 'most';
    set('srv-sort-label', this.SORT_LABEL[this._sort]);
    this.render();
  },

  async load(force){
    const listEl = $('srv-list');
    if (!listEl) return;
    if (this._loaded && !force) { this.render(); return; }
    if (this._loading) return;
    this._loading = true;

    listEl.innerHTML = '<div class="skel w80"></div><div class="skel w60"></div><div class="skel w100"></div>';

    let online = true;
    try { online = (typeof S !== 'undefined' && S.online && !S.forcedOffline); } catch(e){}
    if (!online) {
      listEl.innerHTML = '<div class="empty"><div class="empty-i"><i class="ph ph-wifi-slash"></i></div>' +
        '<p>You are offline</p><p>This screen reads from your account, so it needs a connection.</p></div>';
      this._loading = false;
      return;
    }

    let backendUrl = '';
    try { backendUrl = (typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || (typeof APPS !== 'undefined' ? APPS : ''); } catch(e){}
    if (!backendUrl) {
      listEl.innerHTML = '<div class="banner banner-danger"><i class="ph ph-warning-circle"></i><span>The backend address is not configured.</span></div>';
      this._loading = false;
      return;
    }

    try {
      const r = await fetch(backendUrl, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({ action:'getProgress', username:S.user.username, token:S.user.token })
      });
      const res = await r.json();
      if (!res.success || !res.data) {
        listEl.innerHTML = '<div class="empty"><div class="empty-i"><i class="ph ph-tray"></i></div>' +
          '<p>Nothing recorded yet</p><p>Finish a quiz and your per-file coverage shows up here.</p></div>';
        this._loaded = true; this._loading = false;
        return;
      }
      this._compute(JSON.parse(res.data));
      this._loaded = true;
    } catch(e){
      listEl.innerHTML = '<div class="banner banner-danger"><i class="ph ph-warning-circle"></i><span>' +
        esc(e.message || 'Could not load your coverage.') +
        ' <button class="btn btn-sm btn-quiet" data-on-click="SERVER_PROG.load(true)">Try again</button></span></div>';
      this._loading = false;
      return;
    }
    this._loading = false;
    this.render();
  },

  _compute(data){
    const sessions = (data && data.prog && Array.isArray(data.prog.sessions)) ? data.prog.sessions : [];
    const byFile = new Map();
    sessions.forEach(sess => {
      (Array.isArray(sess.qres) ? sess.qres : []).forEach(q => {
        if (!q || !q.uid) return;
        const fid = typeof fidFromUid === 'function' ? fidFromUid(q.uid) : String(q.uid).replace(/_\d+$/, '');
        if (!byFile.has(fid)) byFile.set(fid, { fid, attempted:0, correct:0, wrong:0, practised:new Set() });
        const rec = byFile.get(fid);
        rec.attempted++;
        if (q.ok) rec.correct++; else rec.wrong++;
        rec.practised.add(q.uid);
      });
    });

    if (data && data.cov && typeof data.cov === 'object') {
      Object.keys(data.cov).forEach(fid => {
        const c = data.cov[fid];
        if (!c || typeof c !== 'object') return;
        const practised = new Set();
        String(c.p || '').split('').forEach((ch, i) => { if (ch !== '0') practised.add(fid + '_' + i); });
        const att = Number(c.a) || 0, cor = Number(c.c) || 0;
        byFile.set(fid, { fid, attempted: att, correct: cor, wrong: Math.max(0, att - cor), practised });
      });
    }
    const refMap = new Map();
    if (typeof ChapterData !== 'undefined') {
      ChapterData.allFileRefs().forEach(r => refMap.set(r.fid, r));
    }

    const rows = [];
    byFile.forEach(rec => {
      const found = refMap.get(rec.fid);
      const meta = found
        ? { lv:found.lv, ch:found.ch, book:found.book, subtopic:found.subtopic,
            name: ChapterData.chapterName(found.lv, found.ch) + ' — ' + found.book + ' — ' + found.subtopic }
        : { lv:'', ch:'', book:'', subtopic:'', name:rec.fid };
      const total = (typeof S !== 'undefined' && S.fcount && S.fcount[rec.fid]) || null;
      const practised = rec.practised.size;
      rows.push({ ...rec, practised, total, pct: total ? Math.round((practised / total) * 100) : null, ...meta });
    });
    this._rows = rows;
  },

  render(){
    const listEl = $('srv-list'), summaryEl = $('srv-summary'), levelSel = $('srv-filter-level');
    if (!listEl || !summaryEl) return;

    if (!this._rows.length) {
      listEl.innerHTML = '<div class="empty"><div class="empty-i"><i class="ph ph-tray"></i></div>' +
        '<p>Nothing recorded yet</p><p>Finish a quiz and your per-file coverage shows up here.</p></div>';
      summaryEl.innerHTML = '';
      return;
    }

    if (levelSel && levelSel.options.length <= 1 && typeof ChapterData !== 'undefined') {
      [...new Set(this._rows.map(r => r.lv).filter(Boolean))].sort().forEach(lv => {
        const o = document.createElement('option');
        o.value = lv; o.textContent = ChapterData.levelLabel(lv);
        levelSel.appendChild(o);
      });
    }

    const lvFilter = levelSel ? levelSel.value : '';
    const search = ($('srv-search')?.value || '').toLowerCase().trim();
    const onlyStarted = $('srv-only-started')?.checked;

    let rows = this._rows.slice();
    if (lvFilter)    rows = rows.filter(r => r.lv === lvFilter);
    if (search)      rows = rows.filter(r => (r.name || '').toLowerCase().includes(search));
    if (onlyStarted) rows = rows.filter(r => r.practised > 0);

    if (this._sort === 'most')       rows.sort((a,b) => (b.pct ?? -1) - (a.pct ?? -1) || b.practised - a.practised);
    else if (this._sort === 'least') rows.sort((a,b) => (a.pct ?? 999) - (b.pct ?? 999) || a.practised - b.practised);
    else                             rows.sort((a,b) => (a.name || '').localeCompare(b.name || ''));

    const totalFiles = this._rows.length;
    const started = this._rows.filter(r => r.practised > 0).length;
    const done = this._rows.filter(r => r.pct !== null && r.pct >= 100).length;
    summaryEl.innerHTML =
      '<div class="sc"><div class="sv tcy">' + totalFiles + '</div><div class="stat-lbl">Files seen</div></div>' +
      '<div class="sc"><div class="sv ta2">' + started + '</div><div class="stat-lbl">Started</div></div>' +
      '<div class="sc"><div class="sv tc2">' + done + '</div><div class="stat-lbl">Finished</div></div>';

    if (!rows.length) {
      listEl.innerHTML = '<div class="empty"><div class="empty-i"><i class="ph ph-magnifying-glass"></i></div>' +
        '<p>Nothing matches</p><p>Try a shorter search, or clear the level filter.</p></div>';
      return;
    }

    listEl.innerHTML = rows.map(r => {
      const pct = r.pct;
      const barColor = pct === null ? 'var(--sep-strong)' : pct >= 75 ? 'var(--success)' : pct >= 40 ? 'var(--accent)' : 'var(--info)';
      const acc = r.attempted ? Math.round((r.correct / r.attempted) * 100) : 0;
      const chapter = r.ch && typeof ChapterData !== 'undefined' ? ChapterData.chapterName(r.lv, r.ch) : r.ch;
      return '<div class="srv-row">' +
        '<div class="srv-row-top">' +
          '<div class="grow">' +
            '<div class="srv-name">' + esc(r.subtopic || r.fid) + '</div>' +
            '<div class="srv-sub">' + esc(r.book || '') + (chapter ? ' · ' + esc(chapter) : '') + '</div>' +
          '</div>' +
          '<div class="right" style="flex-shrink:0">' +
            (pct === null
              ? '<span class="mono t-foot">' + r.practised + ' done</span>'
              : '<span class="mono" style="font-size:var(--fs-t3);font-weight:700">' + pct + '%</span>' +
                '<div class="t-cap mono">' + r.practised + '/' + r.total + '</div>') +
          '</div>' +
        '</div>' +
        '<div class="pb"><div class="pb-f" style="width:' + (pct ?? Math.min(100, r.practised)) + '%;background:' + barColor + '"></div></div>' +
        '<div class="srv-meta">' +
          '<span>' + r.attempted + ' attempts</span>' +
          '<span style="color:var(--success)">' + r.correct + ' correct</span>' +
          '<span style="color:var(--danger)">' + r.wrong + ' missed</span>' +
          (r.attempted ? '<span>' + acc + '% accuracy</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }
};
window.HEATMAP = {
  render(){
    const box = document.getElementById('heatmap-body');
    if (!box || typeof ChapterData === 'undefined') return;
    const levels = [['level7','Level 7 — Civil'], ['level5','Level 5 — Diploma'], ['gk','General Knowledge']];
    const stats = {};
    (typeof CHAPSTATS !== 'undefined' ? CHAPSTATS.entries() : []).forEach(e => { stats[e.chapter] = e; });
    box.innerHTML = levels.map(([lv, name]) => {
      const chs = ChapterData.chapters(lv);
      const cards = Object.keys(chs).map(ch => {
        const refs = ChapterData.chapterFileRefs(lv, ch);
        if (!refs.length) return '';
        const label = ChapterData.chapterName(lv, ch);
        const s = stats[label];
        const acc = s ? s.accuracy : null;
        let seen = 0;
        refs.forEach(r => { const c = S.cov && S.cov[r.fid]; if (c && c.a) seen += c.a; });
        const cls = acc === null ? 'untouched' : acc >= 80 ? 'strong' : acc >= 60 ? 'workable' : 'weak';
        const missed = (typeof WRONGBY !== 'undefined') ? WRONGBY.countForChapter(lv, ch) : 0;
        const barColor = cls === 'strong' ? 'var(--success)'
                       : cls === 'workable' ? 'var(--accent)'
                       : cls === 'weak' ? 'var(--danger)'
                       : 'var(--sep-strong)';
        return '<button type="button" class="chg-card" style="border-left:4px solid ' + barColor + '" data-on-click="HEATMAP.go(\'' + lv + '\',\'' + ch + '\')">' +
          '<span class="chg-name">' + esc(chs[ch]) + '</span>' +
          '<span class="chg-meta">' +
            (acc === null ? 'Not started' : acc + '% · ' + seen + ' answered') +
            (missed ? ' · ' + missed + ' missed' : '') +
          '</span></button>';
      }).join('');
      if (!cards) return '';
      return '<div class="section-head"><h2>' + esc(name) + '</h2></div><div class="chg-grid">' + cards + '</div>';
    }).join('');
  },
  go(lv, ch){
    if (typeof CH_GRID !== 'undefined') { CH_GRID.lv = lv; CH_GRID.open(lv, ch); }
  }
};
window.SERVER_PROG = SERVER_PROG;

(function(){
  let wasOffline = !navigator.onLine;
  function paint(){
    const off = !navigator.onLine;
    if (off && !wasOffline) {
      toast('No connection — you can keep studying anything already downloaded.', 5000);
    } else if (!off && wasOffline) {
      toast('Back online.');
      try { if (typeof WEEKLY !== 'undefined') WEEKLY.retryUnsynced(); } catch(e){}
      _refreshHints();
      if (typeof MY_SUBJ !== 'undefined' && UI.cur === 'subj-mine') MY_SUBJ.load(true);
    }
    wasOffline = off;
  }
  window.addEventListener('online', paint);
  window.addEventListener('offline', paint);
})();

/* ═══════════════════════════════════════════════════════════════════════
   HOURLY — one written question + one 50-question sprint, every hour.
   ═══════════════════════════════════════════════════════════════════════ */
window.HOURLY = {
  LS_LV:    'abhyas_hourly_lv',
  LS_SUBJ:  'abhyas_hourly_subj_v1',
  LS_OBJ:   'abhyas_hourly_obj_v1',

  OBJ_COUNT:    50,
  OBJ_SECONDS:  60 * 60,
  SUBJ_SECONDS: 60 * 60,

  LEVEL_NAME: {
    level7: 'L7 Civil Engineering',
    level5: 'L5 Diploma',
    gk:     'General Knowledge'
  },

  _bank: null, _bankLoading: false,
  _clockTick: null, _subjTick: null,
  _pendingFile: null, _pick: null,

  get level(){
    try {
      const v = localStorage.getItem(this.LS_LV);
      return (v === 'level5' || v === 'gk') ? v : 'level7';
    } catch(e){ return 'level7'; }
  },
  setLevel(lv){
    if (lv !== 'level7' && lv !== 'level5' && lv !== 'gk') return;
    try { localStorage.setItem(this.LS_LV, lv); } catch(e){}
    this._pick = null;
    this.render();
  },

  _hourKey(){
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + p(d.getHours());
  },
  _msToNextHour(){
    const d = new Date();
    const n = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()+1, 0, 0, 0);
    return n.getTime() - d.getTime();
  },
  _fmtClock(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
  },
  _nextHourLabel(){
    const d = new Date();
    const n = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()+1, 0, 0, 0);
    return n.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  },

  _hash(str){
    let h = 2166136261;
    for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  },
  _rng(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
  _shuffle(arr, seed){
    const r = this._rng(seed), a = arr.slice();
    for (let i = a.length - 1; i > 0; i--){
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  _getSubj(){ try { const r = localStorage.getItem(this.LS_SUBJ); return r ? JSON.parse(r) : null; } catch(e){ return null; } },
  _setSubj(s){ try { s ? localStorage.setItem(this.LS_SUBJ, JSON.stringify(s)) : localStorage.removeItem(this.LS_SUBJ); } catch(e){} },
  _getObj(){ try { const r = localStorage.getItem(this.LS_OBJ); return r ? JSON.parse(r) : null; } catch(e){ return null; } },
  _setObj(s){ try { s ? localStorage.setItem(this.LS_OBJ, JSON.stringify(s)) : localStorage.removeItem(this.LS_OBJ); } catch(e){} },

  async _ensureBank(){
    if (this._bank) return this._bank;
    if (this._bankLoading){
      while (this._bankLoading) await new Promise(r => setTimeout(r, 120));
      return this._bank;
    }
    this._bankLoading = true;
    try {
      const refs = (window.SUBJECTIVE_FILE_REFS || []).filter(r => r.fileId && !/^REPLACE_WITH/.test(r.fileId));
      const all = [];
      const url = ((typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || APPS || '');
      for (const ref of refs){
        let raw = null;
        const ck = 'subj_' + ref.fileId;
        try { if (typeof QDB !== 'undefined') raw = await QDB.get(ck); } catch(e){}
        const stale = !raw || (typeof raw === 'object' && !Array.isArray(raw) && raw.success === false);
        if (stale && typeof S !== 'undefined' && S.online && !S.forcedOffline && url){
          try {
            if (typeof GETFILE_GATE !== 'undefined') await GETFILE_GATE.take();
            const params = new URLSearchParams({
              action:'getFile', fileId: ref.fileId,
              username:(S.user && S.user.username) || '',
              token:   (S.user && S.user.token)    || ''
            }).toString();
            const r = await fetch(url + '?' + params, { redirect:'follow' });
            let data = await r.json();
            if (data && data.rateLimited){
              if (typeof GETFILE_GATE !== 'undefined') GETFILE_GATE.backoff(12000);
            } else {
              if (data && data.result !== undefined) data = data.result;
              if (data && typeof QDB !== 'undefined') QDB.set(ck, data).catch(() => {});
              raw = data;
            }
          } catch(e){}
        }
        if (!raw) continue;
        all.push(...this._extract(raw, ref));
      }
      this._bank = all;
    } catch(e){ this._bank = []; }
    this._bankLoading = false;
    return this._bank;
  },
  _extract(raw, ref){
    const out = [];
    const push = (q, si, qi) => {
      if (!q || !q.q) return;
      out.push({
        id: q.id || (ref.fileId + '_' + si + '_' + qi),
        chapterId: ref.chapterId,
        topic: String(q.topic || q.chapter || '').trim(),
        q: String(q.q).trim(),
        marks: this._parseMarks(q.marks)
      });
    };
    if (raw && Array.isArray(raw.sections)){
      raw.sections.forEach((sec, si) => {
        const topic = String(sec.section || '').trim();
        (sec.questions || []).forEach((q, qi) => { if (q) q.topic = q.topic || topic; push(q, si, qi); });
      });
    } else if (Array.isArray(raw)){
      raw.forEach((q, qi) => push(q, 0, qi));
    }
    return out;
  },
  _parseMarks(raw){
    if (typeof raw === 'number') return (raw === 5 || raw === 10) ? raw : 10;
    const s = String(raw || '').trim();
    if (!s) return 10;
    const eq = s.lastIndexOf('=');
    if (eq > -1){
      const m = s.slice(eq+1).match(/\d+(?:\.\d+)?/);
      if (m){ const n = Math.round(parseFloat(m[0])); return (n===5||n===10)?n:10; }
    }
    if (s.includes('+')){
      const p = s.split('+').map(parseFloat).filter(isFinite);
      if (p.length){ const n = Math.round(p.reduce((a,b)=>a+b,0)); return (n===5||n===10)?n:10; }
    }
    const m = s.match(/\d+/); if (!m) return 10;
    const n = parseInt(m[0],10); return (n===5||n===10)?n:10;
  },

  mount(){ this.render(); this._startTicks(); },
  unmount(){ this._stopTicks(); },
  _startTicks(){
    this._stopTicks();
    this._clockTick = setInterval(() => {
      this._paintClock();
      this._refreshBadge();
    }, 1000);
    this._subjTick = setInterval(() => this._tickSubj(), 1000);
  },
  _stopTicks(){
    if (this._clockTick){ clearInterval(this._clockTick); this._clockTick = null; }
    if (this._subjTick){  clearInterval(this._subjTick);  this._subjTick  = null; }
  },
  _paintClock(){
    const el = document.getElementById('hourly-clock');
    if (!el) return;
    el.textContent = this._fmtClock(this._msToNextHour()) + ' to next hour';
  },

  async render(){
    ['level7','level5','gk'].forEach(lv => {
      const b = document.getElementById('hourly-lv-' + lv);
      if (b) b.classList.toggle('active', lv === this.level);
    });
    this._paintClock();
    await Promise.all([this._renderSubj(), this._renderObj()]);
    this._refreshBadge();
  },

  async _renderSubj(){
    const box     = document.getElementById('hourly-subj-body');
    const marksEl = document.getElementById('hourly-subj-marks');
    if (!box) return;

    const cur0 = this._getSubj();
    if (cur0 && !cur0.submitted && cur0.endsAt && Date.now() >= cur0.endsAt){
      this._setSubj(null);
      this._pendingFile = null;
    }
    const st = this._getSubj();

    if (st && st.submitted){
      if (marksEl) marksEl.textContent = st.marks + ' marks';
      box.innerHTML =
        '<div class="qotd-done">' +
          '<span class="big"><i class="ph ph-check-circle" style="color:var(--grn)"></i></span>' +
          '<h3>Submitted for review</h3>' +
          '<p>Your answer was sent to admin at ' + new Date(st.submittedAt).toLocaleTimeString() + '.</p>' +
          '<p style="margin-top:.5rem">A fresh question is served at the top of the next hour.</p>' +
        '</div>';
      return;
    }

    if (st){
      if (marksEl) marksEl.textContent = st.marks + ' marks';
      const chapName = this._chapterLabel(st.chapter);
      box.innerHTML =
        '<div class="qotd-meta">' + esc(chapName) + (st.topic ? ' · ' + esc(st.topic) : '') + '</div>' +
        '<div class="qotd-q" style="margin-top:var(--sp-2)">' + esc(st.q) + '</div>' +
        '<div class="qotd-timer" id="hourly-subj-tmr">—</div>' +
        '<div class="qotd-timer-lbl">Time left to finish and upload</div>' +
        '<div class="qotd-phase-bar"><div class="qotd-phase-fill" id="hourly-subj-bar" style="width:100%"></div></div>' +
        (this._pendingFile
          ? '<div class="qotd-file-chip"><i class="ph ph-file-pdf" style="color:var(--grn);font-size:1.1rem"></i>' +
              '<span class="fn">' + esc(this._pendingFile.filename) + '</span>' +
              '<span style="font-size:.66rem;color:var(--t3)">' + Math.round(this._pendingFile.size/1024) + ' KB</span>' +
              '<button type="button" aria-label="Remove file" data-on-click="HOURLY.clearFile()"><i class="ph ph-x"></i></button></div>'
          : '') +
        '<label class="qotd-drop" for="hourly-subj-file" style="margin-top:var(--sp-3)">' +
          '<input type="file" id="hourly-subj-file" accept="application/pdf,.pdf,image/*" multiple data-on-change="HOURLY.onFile(this)">' +
          '<span class="ii"><i class="ph ph-file-pdf"></i></span>' +
          '<span class="dn">Choose photos or a PDF of your answer</span>' +
          '<span class="ds">All page photos at once, or one PDF · under 8 MB</span>' +
        '</label>' +
        '<button class="btn btn-solid btn-lg btn-blk" id="hourly-subj-submit" style="margin-top:var(--sp-3)"' +
          (this._pendingFile ? '' : ' disabled') +
          ' data-on-click="HOURLY.submitSubj()"><i class="ph ph-paper-plane-tilt"></i> Submit for review</button>' +
        '<button class="btn btn-quiet btn-blk mt2" data-on-click="HOURLY.abandonSubj()">Give up this hour\'s attempt</button>';
      this._tickSubj();
      return;
    }

    if (marksEl) marksEl.textContent = '—';
    const bank = await this._ensureBank();
    if (!bank.length){
      box.innerHTML =
        '<div class="empty" style="padding:var(--sp-6) 0">' +
          '<div class="empty-i"><i class="ph ph-cloud-slash"></i></div>' +
          '<p>Written bank not available</p>' +
          '<p>Connect to the internet once so this device can save the questions.</p>' +
          '<div class="bg" style="justify-content:center;margin-top:var(--sp-3)">' +
            '<button class="btn btn-a" data-on-click="HOURLY.render()"><i class="ph ph-arrow-clockwise"></i> Try again</button>' +
          '</div>' +
        '</div>';
      return;
    }
    const seed = this._hash('subj|' + this._hourKey() + '|' + this.level);
    const q = bank[seed % bank.length];
    this._pick = q;
    if (marksEl) marksEl.textContent = q.marks + ' marks';

    const chapName = this._chapterLabel(q.chapterId);
    box.innerHTML =
      '<div class="qotd-meta">' + esc(chapName) + (q.topic ? ' · ' + esc(q.topic) : '') + '</div>' +
      '<div class="qotd-q" style="margin-top:var(--sp-2)">' + esc(q.q) + '</div>' +
      '<div class="t-foot" style="text-align:center;margin-bottom:var(--sp-3)">' +
        'You get <b>' + Math.round(this.SUBJ_SECONDS/60) + ' minutes</b> from the moment you tap Start to write and upload. ' +
        'This question changes at <b>' + esc(this._nextHourLabel()) + '</b>.' +
      '</div>' +
      '<button class="btn btn-solid btn-lg btn-blk" data-on-click="HOURLY.startSubj()">' +
        '<i class="ph ph-play"></i> Start ' + q.marks + '-mark question' +
      '</button>' +
      '<p class="t-cap text-center" style="margin-top:var(--sp-2)">Written bank is the Loksewa L7 Civil set.</p>';
  },

  _chapterLabel(chId){
    try {
      const c = (window.SUBJECTIVE_CHAPTERS || []).find(x => x.id === chId);
      return c ? ((c.icon ? c.icon + ' ' : '') + c.name) : (chId || 'Written');
    } catch(e){ return chId || 'Written'; }
  },

  _tickSubj(){
    const st = this._getSubj();
    if (!st || st.submitted || !st.endsAt) return;
    const el = document.getElementById('hourly-subj-tmr');
    if (!el) return;
    const left = Math.max(0, Math.round((st.endsAt - Date.now()) / 1000));
    el.textContent = this._fmtClock(left * 1000);
    el.classList.toggle('urgent', left < 120);
    const bar = document.getElementById('hourly-subj-bar');
    if (bar) bar.style.width = ((left / this.SUBJ_SECONDS) * 100) + '%';
    if (left <= 0) this.render();
  },

  startSubj(){
    const q = this._pick;
    if (!q){ toast('Still loading the written bank — try again in a moment.'); return; }
    this._setSubj({
      hourKey:    this._hourKey(),
      level:      this.level,
      questionId: q.id,
      chapter:    q.chapterId,
      topic:      q.topic,
      q:          q.q,
      marks:      q.marks,
      startedAt:  Date.now(),
      endsAt:     Date.now() + this.SUBJ_SECONDS * 1000,
      submitted:  false
    });
    this._pendingFile = null;
    toast('Write on paper, then upload. ' + Math.round(this.SUBJ_SECONDS/60) + ' minutes on the clock.', 4000);
    this.render();
  },

  async abandonSubj(){
    const ok = await ASK.confirm({
      title: 'Give up this hour?',
      body:  'Your in-progress attempt will be cleared. The next question is served at the top of the hour.',
      ok:    'Give up', danger: true
    });
    if (!ok) return;
    this._setSubj(null);
    this._pendingFile = null;
    this.render();
  },

  async onFile(input){
    const files = Array.from(input.files || []);
    if (!files.length) return;
    if (files.some(f => /^image\//i.test(f.type || ''))) toast('Preparing your PDF…', 2500);
    try {
      this._pendingFile = await this._prepareUpload(files);
      this.render();
    } catch(e){
      toast('❌ ' + (e.message || 'Could not read that file'));
      input.value = '';
    }
  },
  clearFile(){ this._pendingFile = null; this.render(); },

  async submitSubj(){
    const st = this._getSubj();
    if (!st || !this._pendingFile) return;
    const btn = document.getElementById('hourly-subj-submit');
    if (btn){ btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Uploading…'; }

    const url  = ((typeof ABHYAS_CONFIG !== 'undefined' && ABHYAS_CONFIG.GAS_URL) || APPS || '');
    const user = (typeof S !== 'undefined' && S.user) || null;
    if (!url || !user || !user.token){
      toast('Please sign in again.');
      if (btn){ btn.disabled = false; btn.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Submit for review'; }
      return;
    }
    try {
      const r = await fetch(url, {
        method:'POST', headers:{ 'Content-Type':'text/plain' },
        body: JSON.stringify({
          action: 'submitSubjectiveAnswer',
          username: user.username, token: user.token,
          kind: 'hourly',
          questionId: st.questionId + '_' + st.hourKey,
          questionText: String(st.q || '').slice(0, 2000),
          chapterId: st.chapter || 'hourly',
          marks: st.marks,
          solveSec: this.SUBJ_SECONDS,
          startedAt: st.startedAt,
          pdfData: this._pendingFile.dataUrl,
          filename: this._pendingFile.filename
        })
      });
      const res = await r.json();
      if (!res || !res.success) throw new Error((res && res.error) || 'Submit failed.');
      st.submitted   = true;
      st.submittedAt = Date.now();
      this._setSubj(st);
      this._pendingFile = null;
      toast('✅ Submitted — admin will grade it.');
      this.render();
    } catch(e){
      toast('❌ ' + (e.message || 'Could not submit.'));
      if (btn){ btn.disabled = false; btn.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Submit for review'; }
    }
  },

  async _renderObj(){
    const box = document.getElementById('hourly-obj-body');
    if (!box) return;
    const lv   = this.level;
    const key  = this._hourKey() + '|' + lv;
    const st   = this._getObj();
    const mine = (st && st.key === key) ? st : null;
    const lvLabel = this.LEVEL_NAME[lv];

    if (mine && mine.submitted){
      const pct = mine.pct || 0;
      const cls = pct >= 70 ? 'tg' : pct >= 50 ? 'ta' : 'tr';
      box.innerHTML =
        '<div class="t-foot" style="margin-bottom:var(--sp-2)">' + esc(lvLabel) + ' · 50 questions in 60 minutes</div>' +
        '<div class="flex center between g3" style="padding:var(--sp-3) 0;border-top:1px solid var(--sep);border-bottom:1px solid var(--sep)">' +
          '<div><div class="t-cap">Score</div>' +
            '<div class="mono" style="font-size:var(--fs-num-lg);font-weight:700;color:var(--ink)">' +
              (mine.correct || 0) + ' / ' + (mine.total || this.OBJ_COUNT) +
            '</div></div>' +
          '<span class="ctag ' + cls + '" style="font-size:var(--fs-t3);padding:.4rem .7rem">' + pct + '%</span>' +
        '</div>' +
        '<p class="t-cap text-center" style="margin-top:var(--sp-3)">Next sprint in ' + this._fmtClock(this._msToNextHour()) + '</p>';
      return;
    }

    if (mine && !mine.submitted){
      box.innerHTML =
        '<div class="banner banner-warning"><i class="ph ph-warning"></i>' +
          '<span>You started this hour\'s sprint but didn\'t finish it. The next hour brings a fresh set.</span>' +
        '</div>' +
        '<p class="t-cap text-center">Next sprint in ' + this._fmtClock(this._msToNextHour()) + '</p>';
      return;
    }

    box.innerHTML =
      '<div class="t-foot" style="margin-bottom:var(--sp-3)">' + esc(lvLabel) + ' · 50 questions in 60 minutes</div>' +
      '<div class="t-callout" style="margin-bottom:var(--sp-3)">A timed, graded run through the level you picked. One attempt per hour.</div>' +
      '<button class="btn btn-solid btn-lg btn-blk" data-on-click="HOURLY.startObj()">' +
        '<i class="ph ph-play-circle"></i> Start the 50-question sprint' +
      '</button>' +
      '<p class="t-cap text-center" style="margin-top:var(--sp-2)">Level: ' + esc(lvLabel) + ' · refreshes at ' + esc(this._nextHourLabel()) + '</p>';
  },

  async startObj(){
    const lv = this.level;
    const refs = (typeof ChapterData !== 'undefined' ? ChapterData.allFileRefs() : []).filter(r => r.lv === lv);
    if (!refs.length){ toast('No chapters for this level yet.'); return; }

    let canNet = false;
    try {
      canNet = !!(typeof S !== 'undefined' && S.online && !S.forcedOffline);
      if (!canNet && typeof navigator !== 'undefined') {
        canNet = !!navigator.onLine && !(typeof S !== 'undefined' && S.forcedOffline);
      }
    } catch(e){}

    QUIZ._showLoader('Building this hour\'s sprint…');

    const errors  = [];
    const all     = [];
    const seen    = new Set();
    let cacheHits = 0, netHits = 0, tried = 0;

    try {
      const seed  = this._hash('obj|' + this._hourKey() + '|' + lv);
      const order = this._shuffle(refs, seed);
      const MAX_FILES = Math.min(order.length, 25);

      for (let i = 0; i < MAX_FILES && all.length < 240; i++){
        const ref = order[i];
        tried++;
        const msgEl = document.getElementById('quiz-loader-msg');
        if (msgEl) msgEl.textContent = 'Loading sets (' + tried + '/' + MAX_FILES + ')…';

        let raw = null;
        try {
          if (typeof QDB !== 'undefined' && ref.key){
            const c = await QDB.get(ref.key);
            const valid = c && !(typeof c === 'object' && !Array.isArray(c) && c.success === false);
            if (valid){ raw = c; cacheHits++; }
          }
        } catch(e){}

        if (!raw && canNet){
          try {
            raw = await QUIZ._fetch(ref.fid, ref.key);
            netHits++;
          } catch(err){
            errors.push((ref.subtopic || ref.fid) + ': ' + ((err && err.message) || 'unknown error'));
            continue;
          }
        }

        if (!raw){
          errors.push((ref.subtopic || ref.fid) + ': not saved on this device');
          continue;
        }

        const qs = normQ(raw, ref.fid);
        if (!qs.length){
          errors.push((ref.subtopic || ref.fid) + ': file had no valid questions');
          continue;
        }
        for (const q of qs){
          if (q && q.uid && !seen.has(q.uid)){ seen.add(q.uid); all.push(q); }
        }
      }

      QUIZ._hideLoader();

      if (!all.length){
        let head;
        if (!canNet && !cacheHits){
          head = 'You are offline and none of this level\'s sets are saved on this device yet. Open Chapters once while online to download them.';
        } else if (!canNet){
          head = 'You are offline and nothing usable was in the local cache for this level.';
        } else if (cacheHits > 0){
          head = 'The sets on this device had no valid questions in them.';
        } else {
          head = 'No questions could be loaded from the server for this level.';
        }
        const detail = errors.length ? ' ' + errors.slice(0, 2).join(' · ') : '';
        console.warn('[HOURLY] sprint load failed', {
          level: lv, canNet, cacheHits, netHits, tried, errors
        });
        toast('❌ ' + head + detail, 8000);
        return;
      }

      if (all.length < this.OBJ_COUNT){
        console.info('[HOURLY] sprint has ' + all.length + ' questions (wanted ' + this.OBJ_COUNT + ')');
      }

      const picked = this._shuffle(all, seed ^ 0x9E3779B9).slice(0, Math.min(this.OBJ_COUNT, all.length));
      if (!picked.length){
        toast('Not enough questions at this level for a sprint.');
        return;
      }
      if (picked.length < this.OBJ_COUNT){
        toast('Running a ' + picked.length + '-question sprint — the full 50 aren\'t available at this level.', 5000);
      }

      this._setObj({
        key:       this._hourKey() + '|' + lv,
        level:     lv,
        startedAt: Date.now(),
        submitted: false
      });

      try {
        QUIZ._doStart(picked, 'exam', '⏱ Hourly sprint · ' + this.LEVEL_NAME[lv], false, {
          hourlySprint: true,
          timeLimitSec: this.OBJ_SECONDS,
          hourlyLevel:  lv
        });
      } catch(startErr){
        this._setObj(null);
        throw startErr;
      }

      const pill = document.getElementById('ex-mode-pill');
      if (pill) pill.textContent = 'Sprint · 60 min';
    } catch(e){
      QUIZ._hideLoader();
      console.error('[HOURLY] sprint start threw', e);
      toast(e && e.message ? e.message : 'Could not start the sprint.');
    }
  },

  _recordObjResult(correct, total, pct){
    const lv  = this.level;
    const key = this._hourKey() + '|' + lv;
    const st  = this._getObj();
    if (!st || st.key !== key) return;
    st.submitted   = true;
    st.submittedAt = Date.now();
    st.correct     = correct;
    st.total       = total;
    st.pct         = pct;
    this._setObj(st);
    if (typeof UI !== 'undefined' && UI.cur === 'hourly') this.render();
    else this._refreshBadge();
  },

  _readAsDataUrl(file){
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = () => rej(new Error('Could not read that file.'));
      r.readAsDataURL(file);
    });
  },
  _imageToJpeg(file, maxSide, quality){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight;
        const sc = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * sc); h = Math.round(h * sc);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
        cx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob(b => b
          ? b.arrayBuffer().then(buf => resolve({ bytes: new Uint8Array(buf), w, h }))
          : reject(new Error('Could not process a photo.')), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('One photo could not be opened.')); };
      img.src = url;
    });
  },
  _loadPdfLib(){
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf-lib/pdf-lib.min.js';
      s.onload  = () => window.PDFLib ? res(window.PDFLib) : rej(new Error('PDF tools did not load.'));
      s.onerror = () => rej(new Error('Could not load the PDF tools.'));
      document.head.appendChild(s);
    });
  },
  async _prepareUpload(files){
    const isPdf = f => /pdf/i.test(f.type || '') || /\.pdf$/i.test(f.name);
    const isImg = f => /^image\//i.test(f.type || '');
    if (files.length === 1 && isPdf(files[0])){
      const f = files[0];
      if (f.size > 8 * 1024 * 1024) throw new Error('PDF too large (max 8 MB).');
      return { dataUrl: await this._readAsDataUrl(f), filename: f.name, size: f.size };
    }
    if (!files.every(isImg)) throw new Error('Choose one PDF, or one or more photos.');
    if (files.length > 20)   throw new Error('Up to 20 photos at a time.');
    const lib = await this._loadPdfLib();
    const doc = await lib.PDFDocument.create();
    for (const f of files){
      const j   = await this._imageToJpeg(f, 1800, 0.78);
      const emb = await doc.embedJpg(j.bytes);
      const p   = doc.addPage([j.w, j.h]);
      p.drawImage(emb, { x: 0, y: 0, width: j.w, height: j.h });
    }
    const out = await doc.save();
    if (out.length > 8 * 1024 * 1024) throw new Error('Those photos are too large together.');
    let bin = '';
    for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return { dataUrl: 'data:application/pdf;base64,' + btoa(bin), filename: 'hourly-' + Date.now() + '.pdf', size: out.length };
  },

  // ── diagnostics / escape hatches ────────────────────────────────────
  async diagnose(){
    const lv = this.level;
    let online = false, forced = false, hasUser = false, hasToken = false, user = null;
    try {
      online = !!S.online; forced = !!S.forcedOffline;
      user = (S && S.user) || null;
      hasUser  = !!(user && user.username);
      hasToken = !!(user && user.token);
    } catch(e){}

    const refs = (typeof ChapterData !== 'undefined' ? ChapterData.allFileRefs() : []).filter(r => r.lv === lv);

    console.log('── HOURLY diagnose ──');
    console.log('level             :', lv);
    console.log('S.online          :', online);
    console.log('S.forcedOffline   :', forced);
    console.log('navigator.onLine  :', (typeof navigator !== 'undefined' ? navigator.onLine : '?'));
    console.log('user / token      :', hasUser, '/', hasToken);
    console.log('refs for level    :', refs.length);
    if (!refs.length){ console.warn('No refs found for this level.'); return; }

    let keys = new Set();
    try { if (typeof QDB !== 'undefined') keys = new Set(await QDB.keys()); } catch(e){}
    console.log('QDB cached keys   :', keys.size);

    const canNet = online && !forced;
    for (let i = 0; i < Math.min(5, refs.length); i++){
      const ref = refs[i];
      const cached = keys.has(ref.key);
      console.log(`  [${i+1}] key=${ref.key}  fid=${String(ref.fid).slice(0,12)}…  cached=${cached}`);
      if (cached){
        try {
          const c = await QDB.get(ref.key);
          const n = normQ(c, ref.fid).length;
          console.log(`       → ${n} questions in cache`);
        } catch(e){ console.warn('       → cache read failed', e); }
      } else if (canNet){
        try {
          const raw = await QUIZ._fetch(ref.fid, ref.key);
          console.log(`       → network fetch OK, ${normQ(raw, ref.fid).length} questions`);
        } catch(e){
          console.warn('       → network fetch FAILED —', e && e.message);
        }
      } else {
        console.log('       → skipped (offline + not cached)');
      }
    }
    console.log('── end diagnose ──');
    console.log('Tip: run HOURLY.resetHour() if you got stuck mid-attempt.');
  },

  resetHour(){
    this._setObj(null);
    this._setSubj(null);
    this._pendingFile = null;
    this._pick = null;
    try { toast('This hour\'s hourly state has been cleared.'); } catch(e){}
    try { if (typeof UI !== 'undefined' && UI.cur === 'hourly') this.render(); } catch(e){}
  },

  // ── badge + hint ─────────────────────────────────────────────────────
  _refreshBadge(){
    const b = document.getElementById('hourly-badge');
    const h = document.getElementById('hourly-hint');
    const lv = this.level;
    const objSt   = this._getObj();
    const subSt   = this._getSubj();
    const objDone = !!(objSt && objSt.key === (this._hourKey() + '|' + lv) && objSt.submitted);
    const subjDone = !!(subSt && subSt.submitted);
    if (b) b.hidden = objDone && subjDone;
    if (h){
      if (subSt && !subSt.submitted)        h.textContent = 'Written in progress';
      else if (!subjDone && !objDone)       h.textContent = 'New this hour';
      else if (subjDone && objDone)         h.textContent = 'Both done';
      else if (subjDone)                    h.textContent = 'Written done · sprint open';
      else                                  h.textContent = 'Sprint done · written open';
    }
  }
};

/* ══ HOURLY wiring ══════════════════════════════════════════════════ */
(function(){
  // Route UI.go('hourly') into HOURLY.mount(); tear the timers down on every other screen.
  UI.onEnter('hourly', () => setTimeout(() => { try { HOURLY.mount(); } catch(e){} }, 30));
  UI.onEnterAny(v => { if (v !== 'hourly') { try { HOURLY.unmount(); } catch(e){} } });

  // Honour scope.timeLimitSec on exam start (default is 90s per question,
  // which would be 75 minutes for a 50-question sprint — we want 60).
  const _prevDoStart = QUIZ._doStart.bind(QUIZ);
  QUIZ._doStart = function(qsArr, mode, chapterName, doShuffle, scope){
    _prevDoStart(qsArr, mode, chapterName, doShuffle, scope);
    if (scope && scope.timeLimitSec && S.quiz && S.quiz.mode === 'exam'){
      S.quiz.left      = scope.timeLimitSec;
      S.quiz.examEndAt = Date.now() + scope.timeLimitSec * 1000;
      const tEl = document.getElementById('ex-tmr');
      if (tEl) tEl.textContent = fmt(S.quiz.left);
      if (typeof QUIZ._snapshotExam === 'function') QUIZ._snapshotExam(true);
    }
  };

  // Record the sprint result the moment the results card is shown.
  const _prevShowResults = QUIZ._showResults.bind(QUIZ);
  QUIZ._showResults = function(){
    _prevShowResults();
    try {
      const scope = S.quiz && S.quiz.scope;
      if (scope && scope.hourlySprint && typeof HOURLY !== 'undefined'){
        const total = S.quiz.qs.length;
        let correct = 0;
        S.quiz.qs.forEach((q, i) => { if (isOk(S.quiz.ans[i], q.correct)) correct++; });
        const pct = total ? Math.round((correct / total) * 100) : 0;
        HOURLY._recordObjResult(correct, total, pct);
      }
    } catch(e){}
  };

  // Keep the sidebar hint and badge fresh even when HOURLY isn't mounted.
  setTimeout(() => { try { HOURLY._refreshBadge(); } catch(e){} }, 1500);
  setInterval(() => { try { HOURLY._refreshBadge(); } catch(e){} }, 5000);
})();

/* ═══════════════════════════════════════════════════════════════════════
   v1.22 additions — live Loksewa score, QSEARCH invalidation, filter reset
   ═══════════════════════════════════════════════════════════════════════ */
(function v122(){

  /* ── 1. Invalidate the QSEARCH index whenever the question cache changes.
     Otherwise a chapter downloaded after QSEARCH ran is invisible to
     search until the page reloads. */
  (function wireCacheInvalidation(){
    if (typeof QDB === 'undefined' || !QDB.set) return;
    const drop = () => { try { if (typeof QSEARCH !== 'undefined' && QSEARCH._index) QSEARCH._index = null; } catch(e){} };
    const origSet = QDB.set.bind(QDB);
    const origDel = QDB.del ? QDB.del.bind(QDB) : null;
    const origClear = QDB.clear ? QDB.clear.bind(QDB) : null;
    QDB.set = async function(k, v){ const r = await origSet(k, v); drop(); return r; };
    if (origDel)   QDB.del = async function(k){ const r = await origDel(k); drop(); return r; };
    if (origClear) QDB.clear = async function(){ const r = await origClear(); drop(); return r; };
  })();

  /* ── 2. (removed in v1.32) Live Loksewa score in the exam bar.
     It showed a running score while the exam was in progress, so a student
     could watch it move after each answer and learn which ones were right.
     Marks, with negative marking, now appear only on the result page. */

  /* ── 3. REV filter persistence ──
     v1.27 moved this into objective.js itself (REV._loadFilters / _saveFilters),
     where the filters live. Nothing to do here. */

})();

})();

/* ═══════════════════════════════════════════════════════════════════════
   PERF — v1.32. Must stay the LAST thing in the last script.
   HOME.render and HOME.updateBadges were being called dozens of times in a
   burst (submitting a 75-question exam called updateBadges 117 times). The
   first call still runs immediately; the rest of that frame collapse into one.
   ═══════════════════════════════════════════════════════════════════════ */
(function hookInsights(){
  try {
    if (typeof PROG === 'undefined' || typeof PROG.render !== 'function' || PROG.render.__ins) return;
    const base = PROG.render.bind(PROG);
    PROG.render = function(){ const r = base.apply(this, arguments); try { INSIGHTS.render(); } catch (e) { console.error(e); } return r; };
    PROG.render.__ins = true;
  } catch (e) { console.error('insights hook skipped:', e); }
})();

(function coalesceHomeRenders(){
  try {
    if (typeof HOME === 'undefined' || typeof frameThrottle !== 'function') return;
    ['render', 'updateBadges'].forEach(function(k){
      if (typeof HOME[k] === 'function' && !HOME[k].__throttled) {
        const t = frameThrottle(HOME[k].bind(HOME));
        t.__throttled = true;
        HOME[k] = t;
      }
    });
  } catch (e) { console.error('perf coalescing skipped:', e); }
})();

/* ═══════════════════════════════════════════════════════════════════════
   PROGRESS TABS — self-contained switcher.

   The tab bar's onclick calls PROG.tab() in app.js. When PROG.tab does not
   switch panels, or switches them but does not render their contents, the
   tabs feel dead. HEATMAP and SERVER_PROG both live in this file, so the
   wiring belongs here too.

   Runs alongside PROG.tab: its own behaviour still runs first, this is
   idempotent on top of it.
   ═══════════════════════════════════════════════════════════════════════ */
(function progressTabs(){
  const TABS = ['accuracy', 'heatmap', 'coverage'];
  const bar  = document.getElementById('prog-tabs');
  if (!bar) return;

  function show(name){
    if (TABS.indexOf(name) === -1) name = 'accuracy';

    /* 1. Buttons */
    bar.querySelectorAll('button').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    /* 2. Panels */
    TABS.forEach(t => {
      const el = document.getElementById('prog-tab-' + t);
      if (el) el.hidden = (t !== name);
    });

    /* 3. Paint the visible panel's content */
    try {
      if (name === 'heatmap'  && typeof HEATMAP !== 'undefined')      HEATMAP.render();
      if (name === 'coverage' && typeof SERVER_PROG !== 'undefined')  SERVER_PROG.load(false);
      if (name === 'accuracy') {
        if (typeof PROG !== 'undefined' && typeof PROG.render === 'function') PROG.render();
        if (typeof INSIGHTS !== 'undefined') INSIGHTS.render();
      }
    } catch (e) { console.warn('[progress tabs] render failed:', e); }
  }

  bar.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(() => show(btn.dataset.tab), 0));
  });

  try {
    if (typeof PROG !== 'undefined' && typeof PROG.tab === 'function' && !PROG.tab.__wired) {
      const orig = PROG.tab.bind(PROG);
      PROG.tab = function(name){
        const r = orig(name);
        try { setTimeout(() => show(name), 0); } catch (e) {}
        return r;
      };
      PROG.tab.__wired = true;
    }
  } catch (e) {}

  if (typeof UI !== 'undefined' && typeof UI.onEnter === 'function') {
    UI.onEnter('progress', () => {
      setTimeout(() => {
        const active = bar.querySelector('button.active');
        show((active && active.dataset.tab) || 'accuracy');
      }, 80);
    });
  }

  let tries = 0;
  (function settle(){
    const ready = typeof HEATMAP !== 'undefined' && typeof SERVER_PROG !== 'undefined';
    if (!ready && ++tries < 20) return setTimeout(settle, 250);
    const active = bar.querySelector('button.active');
    show((active && active.dataset.tab) || 'accuracy');
  })();
})();

/* "Share my progress" (Progress tab > Your tools). v1.38: the button existed but SHARECARD was never defined, so it did
   nothing. Shares a short text summary with the phone's share sheet, or copies it when sharing is not available.
   Only totals are shared: no name, no question text. */
const SHARECARD = {
  text(){
    const p = S.prog || {}, total = Number(p.total) || 0, correct = Number(p.correct) || 0;
    const pct = total ? Math.round(correct * 100 / total) : 0;
    const days = new Set(((S.stk && S.stk.days) || []).map(String)).size;
    return total
      ? `I have practised ${total} questions on Abhyas with ${pct}% accuracy` + (days ? ` over ${days} study days` : '') + '. Loksewa preparation, one day at a time.'
      : 'I have started my Loksewa preparation on Abhyas.';
  },
  async run(){
    const text = SHARECARD.text();
    try {
      if(navigator.share){ await navigator.share({ text }); return; }
    } catch(e){ if(e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it in a message to share.'); }
    catch(e){ toast('Could not share here. Your summary: ' + text, 8000); }
  }
};
