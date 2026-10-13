/* ═══════════════════════════════════════════════════════════════════════
   gas/report.gs — the backend half of the Abhyas reporting system.

   Paste into the Apps Script project as a NEW file called report.gs. It
   shares the global scope of code.gs and setup.gs, so functions here can
   call withLock_, getSpreadsheet_, logAction_, checkAdminCan_, authUser_,
   sanitizeSheetField_, readJsonFileById_, setSettingValue_,
   getSettingValue_, _isoOf_, _submissionDayBound_, and the rest of
   code.gs's helpers, and vice versa.

   ── WHEN LINKING IN ───────────────────────────────────────────────────
   Report.gs and code.gs are both loaded into the same Apps Script
   project, so they share one global namespace. Every name this file
   defines must be removed from code.gs, or the two definitions silently
   shadow each other (the later-loaded file wins).

   DELETE from code.gs — the schema and sheet helpers:

       const QREPORT_HEADERS = …
       const QREPORT_REASONS = …
       const QREPORT_SECTIONS = …
       const CORRECTIONS_SETTING_KEY = …
       const MAX_CORRECTIONS_KEPT = …
       function getQReportsSheet_() { … }
       function rowToQReport_(row) { … }
       function findQReportRow_(sheet, id) { … }
       function normalizeReportPayload_(p) { … }
       function updateCorrectionsMap_(map, fileId, nowMs, max) { … }
       function correctionsSince_(map, since) { … }
       function readCorrectionsMap_() { … }
       function markFileCorrected_(fileId) { … }
       function getCorrections(p) { … }
       function reportQuestion(p) { … }
       function adminListQuestionReports(p) { … }
       function adminUpdateQuestionReportStatus(p) { … }
       function adminMarkFileCorrected(p) { … }
       function adminDeleteQuestionReport(p) { … }
       function adminGetQuestion(p) { … }
       function adminUpdateQuestion(p) { … }
       function _questionArray_(raw) { … }
       function _pickKey_(obj, names) { … }
       function _questionView_(q) { … }

   AND from code.gs's doGet switch — these eight case statements:

       case "getcorrections":                   result = getCorrections(e.parameter); break;
       case "reportquestion":                   result = reportQuestion(e.parameter); break;
       case "adminlistquestionreports":         result = adminListQuestionReports(e.parameter); break;
       case "adminupdatequestionreportstatus":  result = adminUpdateQuestionReportStatus(e.parameter); break;
       case "adminmarkfilecorrected":           result = adminMarkFileCorrected(e.parameter); break;
       case "admindeletequestionreport":        result = adminDeleteQuestionReport(e.parameter); break;
       case "admingetquestion":                 result = adminGetQuestion(e.parameter); break;
       case "adminupdatequestion":              result = adminUpdateQuestion(e.parameter); break;

   AND REPLACE code.gs's doGet default case with:

       default: {
         const handled = REPORT_HANDLE_(action, e.parameter);
         if (handled !== null) { result = handled; break; }
         result = { success: false, error: "Unknown action: '" + action + "'." };
       }

   What stays in code.gs: QREPORTS_SHEET, MAX_LIST_QREPORTS, APP_VERSION,
   MAX_JSON_FILE_BYTES, and every helper (withLock_, _findRowFast_,
   _cachedSheetData_, _invalidateSheet_, _getOrCreateSheet_, _topUpHeaders_,
   _isoOf_, _submissionDayBound_, safeEqual_, checkRateLimit_, logAction_,
   authUser_, checkAdminCan_, sanitizeSheetField_, readJsonFileById_,
   setSettingValue_, getSettingValue_, getOrCreateFolder_).

   If any of the eight case statements is left behind, that endpoint keeps
   working but the router (REPORT_HANDLE_) is never consulted for it, and
   a later edit that removes them all at once can silently break it.

   tests/check.js already has a guard ('Apps Script global names') that
   fails if any name is defined twice across gas/*.gs — linking in without
   the delete will be caught by `npm test`.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Schema ──────────────────────────────────────────────────────────
   Column 18 (index 17) is new: the corrected snapshot, written by
   adminUpdateQuestion so the console can show before/after and export
   the corrected question without re-reading the file from Drive.
   _topUpHeaders_ adds the column on the next sheet touch. */
const QREPORT_HEADERS = [
  "id","uid","fileId","questionSnapshot","reason","note","reportedBy","reportedAt","status",
  "optionsSnapshot","correctIndex","chosenIndex","section","appVersion","resolvedAt","resolvedBy","corrected",
  "correctedSnapshot"
];
const QREPORT_REASONS = ["wrong_answer","unclear","typo","incomplete","image_problem","other"];
const QREPORT_SECTIONS = [
  "practice","exam","daily-paper","weekly","hourly",
  "results","review-missed","review-saved","review-flagged","other"
];

/* fileId -> time (ms) the admin said that file was corrected. Private, so
   it is not in the public settings. */
const CORRECTIONS_SETTING_KEY = "private_corrections";
const MAX_CORRECTIONS_KEPT = 400;

/* ── Sheets ────────────────────────────────────────────────────────── */
function getQReportsSheet_() {
  const sheet = _getOrCreateSheet_(
    QREPORTS_SHEET, QREPORT_HEADERS, [1,2,3],
    "#d81b60", SpreadsheetApp.BandingTheme.PINK, 340
  );
  _topUpHeaders_(sheet, QREPORT_HEADERS, "#d81b60");
  return sheet;
}
function findQReportRow_(sheet, id) { return id ? _findRowFast_(sheet, 1, id) : null; }

/* ── Row → object. Parses the correctedSnapshot column (index 17). ── */
function rowToQReport_(row) {
  const uid = String(row[1] || "");
  const m = uid.match(/^(.+)_(\d+)$/);
  let options = [];
  try { const o = JSON.parse(row[9] || "[]"); if (Array.isArray(o)) options = o; } catch (e) {}
  const num = v => (v === "" || v === null || v === undefined) ? null : Number(v);
  let correctedSnapshot = null;
  if (row.length > 17 && row[17]) {
    try {
      const o = JSON.parse(row[17]);
      if (o && typeof o === "object") correctedSnapshot = o;
    } catch (e) {}
  }
  return {
    id: row[0] || "",
    uid: uid,
    fileId: row[2] || "",
    questionNumber: m ? Number(m[2]) + 1 : null,
    questionSnapshot: row[3] || "",
    reason: row[4] || "",
    note: row[5] || "",
    reportedBy: row[6] || "",
    reportedAt: row[7] || "",
    status: row[8] || "open",
    options: options,
    correctIndex: num(row[10]),
    chosenIndex: num(row[11]),
    section: row[12] || "",
    appVersion: row[13] || "",
    resolvedAt: row[14] || "",
    resolvedBy: row[15] || "",
    corrected: String(row[16]).toLowerCase() === "true",
    correctedSnapshot: correctedSnapshot
  };
}

/* ── Payload validation (pure) ─────────────────────────────────────── */
function normalizeReportPayload_(p) {
  const uid = String(p.uid || "").trim().slice(0, 200);
  if (!uid) return { error: "Missing question reference." };
  if (!/^[A-Za-z0-9_.:-]+$/.test(uid)) return { error: "Invalid question reference." };
  const reason = String(p.reason || "").trim();
  if (QREPORT_REASONS.indexOf(reason) === -1) return { error: "Invalid report reason." };
  const m = uid.match(/^(.+)_(\d+)$/);
  const idx = v => {
    const n = Number(v);
    return (v !== "" && v !== null && v !== undefined &&
            isFinite(n) && n >= 0 && n < 10 && Math.floor(n) === n)
      ? n : "";
  };
  let opts = p.optionsSnapshot;
  if (typeof opts === "string") {
    try { opts = JSON.parse(opts); } catch (e) { opts = null; }
  }
  const optionsSnapshot = Array.isArray(opts)
    ? JSON.stringify(opts.slice(0, 6).map(o =>
        String(o == null ? "" : o).replace(/[\r\n]+/g, " ").slice(0, 200)
      )).slice(0, 1200)
    : "";
  const section = QREPORT_SECTIONS.indexOf(String(p.section || "")) !== -1
    ? String(p.section) : "other";
  return { value: {
    uid: uid,
    fileId: m ? m[1] : uid,
    reason: reason,
    note: sanitizeSheetField_(String(p.note || "").trim().slice(0, 500)),
    snapshot: sanitizeSheetField_(String(p.questionSnapshot || "").trim().slice(0, 1000)),
    optionsSnapshot: optionsSnapshot,
    correctIndex: idx(p.correctIndex),
    chosenIndex: idx(p.chosenIndex),
    section: section,
    appVersion: String(p.appVersion || "").replace(/[^0-9A-Za-z._-]/g, "").slice(0, 12)
  }};
}

/* ── Corrections map (pure helpers + reader/writer) ───────────────── */
function updateCorrectionsMap_(map, fileId, nowMs, max) {
  const out = {};
  Object.keys(map || {}).forEach(k => {
    if (isFinite(Number(map[k]))) out[k] = Number(map[k]);
  });
  out[fileId] = nowMs;
  const keys = Object.keys(out);
  if (keys.length > max) {
    keys.sort((a, b) => out[a] - out[b])
      .slice(0, keys.length - max)
      .forEach(k => delete out[k]);
  }
  return out;
}
function correctionsSince_(map, since) {
  const out = {}, s = Number(since) || 0;
  Object.keys(map || {}).forEach(k => {
    const t = Number(map[k]);
    if (isFinite(t) && t > s) out[k] = t;
  });
  return out;
}
function readCorrectionsMap_() {
  try {
    const o = JSON.parse(String(getSettingValue_(CORRECTIONS_SETTING_KEY, "{}")));
    return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}
function markFileCorrected_(fileId) {
  if (!fileId) return;
  setSettingValue_(
    CORRECTIONS_SETTING_KEY,
    JSON.stringify(updateCorrectionsMap_(
      readCorrectionsMap_(), fileId, Date.now(), MAX_CORRECTIONS_KEPT
    ))
  );
}

/* ── Endpoints: student side ───────────────────────────────────────── */

function getCorrections(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const since = Number(p.since) || 0;
  const mine = [];
  try {
    const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
    const me = auth.username.toLowerCase();
    for (let i = data.length - 1; i >= 1 && mine.length < 10; i--) {
      if (String(data[i][6]).toLowerCase() !== me) continue;
      if (String(data[i][8]) !== "resolved") continue;
      const at = new Date(_isoOf_(data[i][14])).getTime();
      if (isFinite(at) && at > since) {
        mine.push({ uid: String(data[i][1]), at: at });
      }
    }
  } catch (e) {}
  return {
    success: true,
    now: Date.now(),
    files: correctionsSince_(readCorrectionsMap_(), since),
    resolvedMine: mine
  };
}

function reportQuestion(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;
  const norm = normalizeReportPayload_(p);
  if (norm.error) return { success: false, error: norm.error };
  const r = norm.value;
  if (!checkRateLimit_("qreport_" + username.toLowerCase(), 30, 60 * 60 * 1000)) {
    return { success: false, error: "Too many reports \u2014 please try again later." };
  }
  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]) === r.uid &&
          String(data[i][6]) === username &&
          String(data[i][8]) === "open") {
        return { success: true, message: "You've already reported this question \u2014 it's in the queue." };
      }
    }
    sheet.appendRow([
      Utilities.getUuid(), r.uid, r.fileId, r.snapshot, r.reason, r.note,
      username, new Date().toISOString(), "open",
      r.optionsSnapshot, r.correctIndex, r.chosenIndex, r.section, r.appVersion,
      "", "", "", ""
    ]);
    _invalidateSheet_(QREPORTS_SHEET);
    return { success: true, message: "Thanks \u2014 this has been sent for review." };
  });
}

/* ── Endpoints: admin side ─────────────────────────────────────────── */

function adminListQuestionReports(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const totalCount = Math.max(0, data.length - 1);
  const limit = Math.min(totalCount, MAX_LIST_QREPORTS);
  const reports = [];
  for (let i = data.length - 1; i >= data.length - limit; i--) {
    reports.push(rowToQReport_(data[i]));
  }
  const openBy = {};
  reports.forEach(r => {
    if (r.status === "open") {
      (openBy[r.uid] = openBy[r.uid] || {})[r.reportedBy] = true;
    }
  });
  reports.forEach(r => {
    r.openReporters = r.status === "open"
      ? Object.keys(openBy[r.uid] || {}).length : 0;
  });
  reports.sort((a, b) => {
    if (a.status === "open" && b.status !== "open") return -1;
    if (a.status !== "open" && b.status === "open") return 1;
    if (a.status === "open" && b.status === "open" &&
        b.openReporters !== a.openReporters) {
      return b.openReporters - a.openReporters;
    }
    return new Date(b.reportedAt) - new Date(a.reportedAt);
  });
  return {
    success: true, reports: reports,
    totalCount: totalCount, truncated: totalCount > MAX_LIST_QREPORTS
  };
}

function adminUpdateQuestionReportStatus(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const id = String(p.id || "").trim();
  const status = String(p.status || "").trim();
  if (!id) return { success: false, error: "id required." };
  if (["open", "resolved", "dismissed"].indexOf(status) === -1) {
    return { success: false, error: "Status must be open, resolved, or dismissed." };
  }
  const signal = status === "resolved" && String(p.corrected) !== "false";

  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const found = findQReportRow_(sheet, id);
    if (!found) return { success: false, error: "Report not found." };
    const stamp = status === "open"
      ? ["", "", ""]
      : [new Date().toISOString(), actor, signal ? "TRUE" : ""];
    sheet.getRange(found.rowIndex, 9).setValue(status);
    sheet.getRange(found.rowIndex, 15, 1, 3).setValues([stamp]);
    let alsoClosed = 0;
    if (status === "resolved") {
      const data = sheet.getDataRange().getValues();
      const uid = String(found.row[1] || "");
      for (let i = 1; i < data.length; i++) {
        if (i + 1 === found.rowIndex) continue;
        if (String(data[i][1]) === uid && String(data[i][8]) === "open") {
          sheet.getRange(i + 1, 9).setValue("resolved");
          sheet.getRange(i + 1, 15, 1, 3).setValues([stamp]);
          alsoClosed++;
        }
      }
    }
    _invalidateSheet_(QREPORTS_SHEET);
    if (signal) markFileCorrected_(String(found.row[2] || ""));
    logAction_(actor, "Update Question Report", id,
      "Status: " + status +
      (signal ? " (students told to refresh the file)" : "") +
      (alsoClosed
        ? "; also closed " + alsoClosed + " other report(s) on this question"
        : ""));
    return {
      success: true, id: id, status: status,
      alsoClosed: alsoClosed, refreshed: signal
    };
  });
}

function adminMarkFileCorrected(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const fileId = String(p.fileId || "").trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
    return { success: false, error: "That does not look like a Drive file id." };
  }
  return withLock_(() => {
    markFileCorrected_(fileId);
    setSettingValue_("contentVersion", String(Date.now()));
    logAction_(chk.actor, "Refresh Question File", fileId,
      "Students' apps will replace their copy");
    return { success: true };
  });
}

function adminDeleteQuestionReport(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "id required." };
  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const found = findQReportRow_(sheet, id);
    if (!found) return { success: false, error: "Report not found." };
    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(QREPORTS_SHEET);
    logAction_(actor, "Delete Question Report", id, "");
    return { success: true, deleted: id };
  });
}

/* ── Question editor helpers ──────────────────────────────────────── */

/* Shared with gas/content-index.gs. Keep this one definition; the copy in
   code.gs must be deleted (see the header). */
function _questionArray_(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const keys = ["questions", "data", "quiz", "items"];
    for (let i = 0; i < keys.length; i++) {
      if (Array.isArray(raw[keys[i]])) return raw[keys[i]];
    }
  }
  return null;
}
function _pickKey_(obj, names) {
  for (let i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(obj, names[i])) return names[i];
  }
  return null;
}
function _questionView_(q) {
  const tk = _pickKey_(q, ["q", "question", "Question", "stem", "ques", "text"]);
  const ok = _pickKey_(q, ["options", "opts", "choices", "Options"]);
  const ck = _pickKey_(q, ["correct", "answer", "ans", "Answer"]);
  const ek = _pickKey_(q, ["explanation", "explain", "exp", "solution", "hint"]);
  let correct = ck ? q[ck] : null;
  if (typeof correct === "string" && /^[a-eA-E]$/.test(correct.trim())) {
    correct = "abcde".indexOf(correct.trim().toLowerCase());
  }
  correct = (correct === null || correct === "" || isNaN(Number(correct)))
    ? null : Number(correct);
  return {
    q: tk ? String(q[tk]) : "",
    options: (ok && Array.isArray(q[ok])) ? q[ok].map(String) : [],
    correct: correct,
    explanation: ek ? String(q[ek] || "") : "",
    keys: { text: tk, options: ok, correct: ck, explanation: ek }
  };
}

function adminGetQuestion(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const fileId = String(p.fileId || "").trim();
  const index = Number(p.index);
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId) || !(index >= 0)) {
    return { success: false, error: "Invalid question reference." };
  }
  const res = readJsonFileById_(fileId);
  if (!res.success) return res;
  const arr = _questionArray_(res.result);
  if (!arr || !arr[index] || typeof arr[index] !== "object") {
    return { success: false, error: "That question was not found in the file." };
  }
  const view = _questionView_(arr[index]);
  if (!view.keys.text || !view.keys.options || view.options.length < 2) {
    return { success: false, error: "This question uses a format the editor cannot change. Edit the JSON file in Drive instead." };
  }
  return {
    success: true, index: index, total: arr.length,
    question: {
      q: view.q, options: view.options,
      correct: view.correct, explanation: view.explanation
    }
  };
}

function adminUpdateQuestion(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const fileId = String(p.fileId || "").trim();
  const index = Number(p.index);
  const expected = String(p.expectedQ || "").trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId) || !(index >= 0)) {
    return { success: false, error: "Invalid question reference." };
  }

  let fields;
  try {
    fields = (p.fields && typeof p.fields === "object")
      ? p.fields : JSON.parse(p.fields || "{}");
  } catch (e) { return { success: false, error: "The changes were not understood." }; }

  const newQ = String(fields.q || "").trim().slice(0, 2000);
  const options = Array.isArray(fields.options)
    ? fields.options.map(o => String(o == null ? "" : o).trim().slice(0, 500))
    : [];
  const correct = Number(fields.correct);
  const explanation = String(fields.explanation || "").trim().slice(0, 3000);
  if (!newQ) return { success: false, error: "The question text cannot be empty." };
  if (options.length < 2 || options.length > 6 || options.some(o => !o)) {
    return { success: false, error: "Every option needs text (2 to 6 options)." };
  }
  if (!(correct >= 0 && correct < options.length) ||
      Math.floor(correct) !== correct) {
    return { success: false, error: "Choose which option is correct." };
  }

  return withLock_(() => {
    let file;
    try { file = DriveApp.getFileById(fileId); }
    catch (e) {
      return { success: false, error: "Could not open the question file. (" + (e.message || e) + ")" };
    }
    if (file.getSize() > MAX_JSON_FILE_BYTES) {
      return { success: false, error: "The file is too large to edit here." };
    }

    let raw;
    try { raw = JSON.parse(file.getBlob().getDataAsString("UTF-8")); }
    catch (e) { return { success: false, error: "The question file is not valid JSON." }; }
    const arr = _questionArray_(raw);
    if (!arr || !arr[index] || typeof arr[index] !== "object") {
      return { success: false, error: "That question was not found in the file." };
    }

    const q = arr[index];
    const view = _questionView_(q);
    if (!view.keys.text || !view.keys.options) {
      return { success: false, error: "This question uses a format the editor cannot change." };
    }
    if (view.q.trim() !== expected) {
      return {
        success: false,
        error: "The file changed since you opened it. Close this and open the report again."
      };
    }

    /* A copy of the file is kept before every edit. */
    try {
      file.makeCopy("before-edit_" + Date.now() + "_" + file.getName(),
        getOrCreateFolder_("QuestionEditBackups"));
    } catch (e) {
      return { success: false, error: "Could not make a backup, so nothing was changed." };
    }

    q[view.keys.text] = newQ;
    q[view.keys.options] = options;
    const ck = view.keys.correct || "correct";
    const orig = q[ck];
    if (typeof orig === "string" && /^[a-eA-E]$/.test(orig.trim())) {
      q[ck] = (orig.trim() === orig.trim().toLowerCase())
        ? "abcde".charAt(correct)
        : "ABCDE".charAt(correct);
    } else if (typeof orig === "string") {
      q[ck] = String(correct);
    } else {
      q[ck] = correct;
    }
    q[view.keys.explanation || "explanation"] = explanation;

    try { file.setContent(JSON.stringify(raw, null, 2)); }
    catch (e) {
      return { success: false, error: "Could not write the file: " + (e.message || e) };
    }

    /* Store the corrected question on every report for this file+index,
       so the console always has a before/after pair without re-reading
       Drive. One setValues call, not one setValue per matching row — a
       question with fifty reporters would otherwise block every other
       request on the script lock for the length of fifty writes. */
    try {
      const reportsSheet = getQReportsSheet_();
      const reportData = reportsSheet.getDataRange().getValues();
      const correctedJson = JSON.stringify({
        q: newQ, options: options, correct: correct, explanation: explanation
      });
      const hits = [];
      for (let i = 1; i < reportData.length; i++) {
        const uid = String(reportData[i][1] || "");
        const m = uid.match(/^(.+)_(\d+)$/);
        if (m && m[1] === fileId && Number(m[2]) === index) hits.push(i + 1);
      }
      if (hits.length) {
        const lo = hits[0];
        const hi = hits[hits.length - 1];
        const col = reportsSheet.getRange(lo, 18, hi - lo + 1, 1);
        const vals = col.getValues();
        hits.forEach(rowIdx => { vals[rowIdx - lo][0] = correctedJson; });
        col.setValues(vals);
        _invalidateSheet_(QREPORTS_SHEET);
      }
    } catch (e) {
      /* The correctedSnapshot is a convenience, not the record of truth:
         the file itself already holds the fix. A failed write here must
         not stop the save. */
      console.error("adminUpdateQuestion: could not store correctedSnapshot:", e);
    }

    setSettingValue_("contentVersion", String(Date.now()));
    markFileCorrected_(fileId);
    logAction_(actor, "Edit Question", fileId + "#" + index,
      "Question text, options, answer or explanation changed (backup kept)");
    return { success: true };
  });
}

/* ── Corrections list + export ─────────────────────────────────────
   Every report that was closed by actually fixing the question,
   deduped by (fileId, question index). Returns both a flat list (for
   export and the UI) and a map keyed by fileId -> { index -> entry }
   so any file-preview screen can look up its marks in O(1). */
function adminListCorrections(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const byFile = {};
  const all = [];
  const seen = new Set();
  for (let i = 1; i < data.length; i++) {
    const r = rowToQReport_(data[i]);
    if (r.status !== "resolved" || !r.corrected) continue;
    const key = r.fileId + "#" +
      (r.questionNumber != null ? r.questionNumber : r.uid);
    if (seen.has(key)) continue;   /* many students can report one question: keep the newest */
    seen.add(key);
    const entry = {
      id: r.id,
      uid: r.uid,
      fileId: r.fileId,
      questionNumber: r.questionNumber,
      reason: r.reason,
      note: r.note || "",
      reportedBy: r.reportedBy,
      reportedAt: r.reportedAt,
      correctedAt: r.resolvedAt,
      correctedBy: r.resolvedBy,
      oldSnapshot: {
        question: r.questionSnapshot,
        options: r.options || [],
        correctIndex: r.correctIndex
      },
      newSnapshot: r.correctedSnapshot ? {
        question: r.correctedSnapshot.q,
        options: r.correctedSnapshot.options || [],
        correctIndex: r.correctedSnapshot.correct,
        explanation: r.correctedSnapshot.explanation || ""
      } : null
    };
    all.push(entry);
    const idx = r.questionNumber != null ? r.questionNumber - 1 : null;
    if (idx !== null) {
      byFile[r.fileId] = byFile[r.fileId] || {};
      byFile[r.fileId][idx] = entry;
    }
  }
  all.sort((a, b) => new Date(b.correctedAt) - new Date(a.correctedAt));
  return {
    success: true, all: all, byFile: byFile, totalCount: all.length
  };
}

function adminExportCorrections(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const r = adminListCorrections({ adminToken: p.adminToken });
  if (!r.success) return r;
  let list = r.all;
  const fileFilter = String(p.fileId || "").trim();
  if (fileFilter) list = list.filter(c => c.fileId === fileFilter);
  /* _submissionDayBound_ (code.gs) is the ONE date parser used across the
     backend: it accepts YYYY-MM-DD, an ISO string or epoch ms, and returns
     null for anything it cannot read. Using the same helper here means a
     future fix to date handling applies to reports, submissions and this
     export in one edit. */
  const fromT = p.dateFrom ? _submissionDayBound_(p.dateFrom, false) : null;
  const toT   = p.dateTo   ? _submissionDayBound_(p.dateTo,   true)  : null;
  if (fromT !== null) {
    list = list.filter(c => {
      const t = new Date(c.correctedAt).getTime();
      return isFinite(t) && t >= fromT;
    });
  }
  if (toT !== null) {
    list = list.filter(c => {
      const t = new Date(c.correctedAt).getTime();
      return isFinite(t) && t <= toT;
    });
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    totalCorrections: list.length,
    corrections: list.map(c => ({
      fileId: c.fileId,
      questionIndex: c.questionNumber != null ? c.questionNumber - 1 : null,
      uid: c.uid,
      reason: c.reason,
      note: c.note || "",
      reportedBy: c.reportedBy,
      reportedAt: c.reportedAt,
      correctedAt: c.correctedAt,
      correctedBy: c.correctedBy,
      before: c.oldSnapshot,
      after: c.newSnapshot
    }))
  };
  return {
    success: true,
    json: JSON.stringify(payload, null, 2),
    filename: "abhyas-corrections-" +
      new Date().toISOString().slice(0, 10) + ".json",
    count: list.length
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   DRIVETONEONTODRIVE SYNC — read-only endpoint
   Auth by SYNC_KEY only. Called once per pipeline run.
   ═══════════════════════════════════════════════════════════════════════ */

function setSyncKey() {
  const key = Utilities.getUuid().replace(/-/g, "")
            + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("SYNC_KEY", key);
  console.log("SYNC_KEY = " + key);
  return key;
}

function syncCorrectionsSince(p) {
  const key = String(p.key || "");
  const expected = PropertiesService
    .getScriptProperties()
    .getProperty("SYNC_KEY");
  if (!expected) {
    return { success: false, error: "Sync endpoint not configured. Run setSyncKey()." };
  }
  if (!key || !safeEqual_(key, expected)) {
    return { success: false, error: "Auth failed." };
  }

  const since = Number(p.since) || 0;
  const limit = Math.min(500, Number(p.limit) || 200);

  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const byUid = {};

  for (let i = 1; i < data.length; i++) {
    const r = rowToQReport_(data[i]);
    if (r.status !== "resolved" || !r.corrected) continue;
    if (!r.correctedSnapshot) continue;
    const at = new Date(r.resolvedAt).getTime();
    if (!isFinite(at) || at <= since) continue;

    const m = String(r.uid || "").match(/^(.+)_(\d+)$/);
    const entry = {
      uid: r.uid,
      fileId: r.fileId,
      questionIndex: m ? Number(m[2]) : null,
      questionNumber: r.questionNumber,
      reason: r.reason,
      note: r.note || "",
      reportedBy: r.reportedBy,
      reportedAt: r.reportedAt,
      correctedBy: r.resolvedBy,
      correctedAt: r.resolvedAt,
      before: {
        question: r.questionSnapshot || "",
        options: r.options || [],
        correctIndex: r.correctIndex
      },
      after: {
        question: r.correctedSnapshot.q || "",
        options: r.correctedSnapshot.options || [],
        correctIndex: r.correctedSnapshot.correct,
        explanation: r.correctedSnapshot.explanation || ""
      }
    };

    const prev = byUid[r.uid];
    if (!prev || new Date(prev.correctedAt) < new Date(entry.correctedAt)) {
      byUid[r.uid] = entry;
    }
  }

  const list = Object.keys(byUid).map(k => byUid[k]);
  list.sort((a, b) => new Date(a.correctedAt) - new Date(b.correctedAt));
  const out = list.slice(0, limit);

  return {
    success: true,
    now: Date.now(),
    count: out.length,
    corrections: out
  };
}

/* ── Router for code.gs's doGet default case ───────────────────────── */
const REPORT_ROUTES_ = {
  reportquestion:                  function (p) { return reportQuestion(p); },
  getcorrections:                  function (p) { return getCorrections(p); },
  adminlistquestionreports:        function (p) { return adminListQuestionReports(p); },
  adminupdatequestionreportstatus: function (p) { return adminUpdateQuestionReportStatus(p); },
  admindeletequestionreport:       function (p) { return adminDeleteQuestionReport(p); },
  admingetquestion:                function (p) { return adminGetQuestion(p); },
  adminupdatequestion:             function (p) { return adminUpdateQuestion(p); },
  adminmarkfilecorrected:          function (p) { return adminMarkFileCorrected(p); },
  adminlistcorrections:            function (p) { return adminListCorrections(p); },
  adminexportcorrections:          function (p) { return adminExportCorrections(p); },
  synccorrectionssince:            function (p) { return syncCorrectionsSince(p); }
};

/* Returns the result object for a report action, or null for anything
   else, so code.gs can fall through to its own "Unknown action". */
function REPORT_HANDLE_(action, params) {
  const fn = REPORT_ROUTES_[String(action || "").toLowerCase()];
  return fn ? fn(params || {}) : null;
}