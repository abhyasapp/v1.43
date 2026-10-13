/* ═══════════════════════════════════════════════════════════════════════
   report/report-matching.js — pure helpers used when the admin corrects a
   question and a student's saved copies (Missed / Saved / Flagged / weekly
   papers) have to be brought up to date.

   No DOM, no network, no storage. Every function is pure and can be
   unit-tested in Node. Loaded after report-shared.js, before userreport.js.

   When linking in, DELETE the copies that still live in js/core/shared.js:

       qTokens
       qSimilarity
       qUidParts
       qOptionsSimilarity
       sameQuestionAfterCorrection
       matchCorrectedQuestion
       questionContentChanged
       applyQuestionCorrection
       applyCorrectionsToList

   tests/check.js has a guard (group 'No duplicated report helpers') that
   fails if any of these names appears in more than one file, so a missed
   delete will be caught.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* Split text into distinct lowercased word tokens. Letters and digits of
   any script (Nepali and Devanagari included), because a question can be
   written in either. Empty input gives an empty list, never [''] . */
function qTokens(s) {
  return String(s == null ? '' : s)
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ').filter(Boolean);
}

/* 0..1: share of distinct words the two texts have in common. A text with
   no tokens is never similar to anything, including another empty text,
   so "did the wording change?" does not report a false positive when both
   sides are blank. */
function qSimilarity(a, b) {
  const A = new Set(qTokens(a)), B = new Set(qTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

/* Split a question uid into its file id and its position in that file.
   The uid is always "fileId_index" and file ids themselves never contain
   an underscore, but the regex is greedy anyway so a uid like
   "abc_123_5" (a file named abc_123) still splits at the LAST underscore.
   Returns null for anything that is not "…_<digits>". */
function qUidParts(uid) {
  const m = String(uid || '').match(/^(.*)_(\d+)$/);
  return m ? { fid: m[1], index: Number(m[2]) } : null;
}

/* How alike are the answer options of two questions? 1 when both have
   none (nothing to compare). Used as the tie-breaker when the question
   text has been rewritten but the options were left alone, or vice versa. */
function qOptionsSimilarity(a, b) {
  const oa = (a && a.options) || [], ob = (b && b.options) || [];
  if (!oa.length && !ob.length) return 1;
  return qSimilarity(oa.join(' '), ob.join(' '));
}

/* Is `fresh` the corrected version of `old`? A corrected answer key leaves
   the wording alone; a typo fix changes a word; a different question shares
   neither the wording nor the options.

   `minStem` is the lowest text similarity that still counts as the same
   question. Defaults to 0.6, which is what a caller wants when the
   question is expected at its original position. Callers that are looking
   anywhere in the file pass 0.9 explicitly (see matchCorrectedQuestion). */
function sameQuestionAfterCorrection(old, fresh, minStem) {
  const floor = (typeof minStem === 'number' && isFinite(minStem)) ? minStem : 0.6;
  const stem = qSimilarity(old && old.q, fresh && fresh.q);
  if (stem < floor) return false;
  return stem >= 0.9 || qOptionsSimilarity(old, fresh) >= 0.5;
}

/* Where is `old` in the corrected file? { index, question, kind }.
   kind: 'same' | 'moved' | 'none'.

   First tries the question's own position, where a close match is enough
   (0.6). If it is not there, searches the whole file but only accepts a
   near-identical match (0.9), so a question that was removed is never
   mistaken for a similar-looking neighbour. */
function matchCorrectedQuestion(old, fresh) {
  const parts = qUidParts(old && old.uid);
  const list = Array.isArray(fresh) ? fresh : [];
  if (parts) {
    const here = list.find(q => q && q.uid === old.uid);
    if (here && sameQuestionAfterCorrection(old, here, 0.6)) {
      return { index: parts.index, question: here, kind: 'same' };
    }
  }
  let best = null, bestSim = 0;
  list.forEach(q => {
    const sm = qSimilarity(old && old.q, q && q.q);
    if (sm > bestSim) { bestSim = sm; best = q; }
  });
  if (best && sameQuestionAfterCorrection(old, best, 0.9)) {
    return {
      index: (qUidParts(best.uid) || {}).index,
      question: best,
      kind: best.uid === (old && old.uid) ? 'same' : 'moved'
    };
  }
  return { index: -1, question: null, kind: 'none' };
}

/* Did any of the fields that a student sees change? Used to decide whether
   to mark a saved copy as freshly corrected, and to avoid a needless
   re-render when a save did not actually alter anything. */
function questionContentChanged(a, b) {
  const pick = q => JSON.stringify([
    q && q.q, q && q.options, String(q && q.correct),
    (q && q.explanation) || '',
    (q && q.img) || '',
    (q && q.imgCaption) || ''
  ]);
  return pick(a) !== pick(b);
}

/* Update a saved copy from the corrected question. Review settings
   (streak, next due, tag, note, reason) are kept; the fields a student
   sees are taken from the fresh copy in full, so a removed image or a
   cleared explanation is reflected rather than being kept as an orphan. */
function applyQuestionCorrection(item, q, nowMs) {
  const changed = questionContentChanged(item, q);
  const out = Object.assign({}, item, {
    q: q.q,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
    img: q.img,
    imgCaption: q.imgCaption,
    uid: q.uid,
    fileId: q.fileId
  });
  delete out._withdrawn;
  if (changed) out._corrected = nowMs;
  return out;
}

/* Bring one saved list up to date with the corrected file `fid`.

   opts.keepAll: never drop or merge items (a weekly paper must keep its
   length so answers still line up).

   Returns { list, updated, moved, merged, withdrawn }. Nothing is ever
   deleted: a question that is no longer in the file is marked _withdrawn
   so the app can show it as withdrawn and leave it out of practice.

   When most of the file appears to be missing (80%+ of the saved
   questions cannot be found, with a floor of 3), it is treated as a bad
   download and every change is skipped — a corrupted server reply must
   not silently withdraw a student's whole saved list. */
function applyCorrectionsToList(list, fid, fresh, nowMs, opts) {
  const o = opts || {};
  const items = Array.isArray(list) ? list : [];
  const mine = it => it && it.fileId === fid ||
    (it && String(it.uid || '').indexOf(fid + '_') === 0);
  const res = { list: items, updated: 0, moved: 0, merged: 0, withdrawn: 0 };
  if (!Array.isArray(fresh) || !fresh.length) return res;

  const planned = items.map(it =>
    mine(it) ? { it, m: matchCorrectedQuestion(it, fresh) } : { it, m: null });

  const lost = planned.filter(p => p.m && p.m.kind === 'none').length;
  const total = planned.filter(p => p.m).length;
  const suspicious = lost > 0 && lost >= Math.max(3, 0.8 * total);

  const seen = new Set();
  const out = [];
  planned.forEach(p => {
    if (!p.m) { out.push(p.it); seen.add(p.it && p.it.uid); return; }
    if (p.m.kind === 'none') {
      if (suspicious) { out.push(p.it); return; }
      if (!p.it._withdrawn) res.withdrawn++;
      out.push(Object.assign({}, p.it, { _withdrawn: true }));
      return;
    }
    const upd = applyQuestionCorrection(p.it, p.m.question, nowMs);
    if (upd.uid !== p.it.uid) res.moved++;
    if (!o.keepAll && seen.has(upd.uid)) { res.merged++; return; }
    if (questionContentChanged(p.it, p.m.question)) res.updated++;
    seen.add(upd.uid);
    out.push(upd);
  });
  res.list = out;
  return res;
}