/* ═══════════════════════════════════════════════════════════════════════
   Abhyas V1 — Apps Script backend (runtime only)

   VERSION: see APP_VERSION below (kept equal to js/core/version.js)

   ─────────────────────────────────────────────────────────────────────
   v1.43 - the reporting system moved to its own file, gas/report.gs.
     Everything that had to do with question reports, the corrections
     map, the question editor and the Drive-sync endpoint now lives
     there. The eight actions they served are still routed through
     doGet's default branch, which delegates to REPORT_HANDLE_() when
     report.gs is loaded and returns "Unknown action" when it is not.
     Fixes found in review (all in this file):
       • adminGrantAccess wrote createdAt and approvedAt into the wrong
         columns, destroying the original join date and putting the
         string "verified" into a timestamp field. It also never set
         paymentStatus.
       • adminStats used a module-level variable as a 30-second cache;
         Apps Script runs every request in a fresh context, so the
         cache never hit. It now uses CacheService.
       • adminChangePassword and adminCreateAdmin only checked password
         length. They now reject common passwords, repeated characters
         and passwords containing the username, the same way signup and
         password reset already do.
   v1.42 - the version number, in lockstep with js/core/version.js.
   v1.40 - encrypted CDN files: getContentKey. See content-repo/README.md.
   v1.38 - PBKDF2-HMAC-SHA256 password storage, old hashes upgrade on
           login.
   v1.34 - getFiles: several question files in one request.
   v1.33 - scoped reset, storage meter, exam warnings.
   v1.32 - weekly test hardening, per-user getfile budget, getFiles,
           content registry, admin auth audit, single-file edit.
   v1.27 - admin stats cache, dashboard speedup.
   v1.26 - newest-first listing for Users / Payments / Reports.
   v1.22 - weekly admin summary, question editor backup.
   v1.21 - one system folder, standard filenames.
   v1.20 - public "hardest questions" feed.
   v1.13 - self-service data control: deleteMyAccount / resetMyProgress.
   v1.11 - security and robustness hardening (see git history).
   v1.10 - adminReplaceSubmissionPdf.
   v1.09 - adminPromoteUserToAdmin; setup.gs and debug.gs split out.
   v1.08 - backend v1.11 client realignment.
   v1.07 - modular split.
   v1.00 - initial release.

   ─────────────────────────────────────────────────────────────────────
   BREAKING CHANGES YOU MUST MATCH IN THE CLIENT (or flip the flags below)
     1. login / googleLogin / signup / resetPassword / adminLogin /
        adminChangePassword / adminCreateAdmin (and adminUpdateUser when
        it carries a password) must be sent as POST (JSON body).
     2. getfile must include username + token (or adminToken).
     3. Handle `mustChangePassword: true` from login / adminLogin.
   ═══════════════════════════════════════════════════════════════════════ */

const APP_VERSION = "1.43";

const DEFAULT_SPREADSHEET_ID = "1yJF3kIGcwKHHdlcmw7ZUWBoUBMDeRWP7eaGBdDtUD_o";

const ADMIN_SEED_USERNAME = "admin";
/* Used ONLY to detect installations still on the old default password so
   they can be forced to change it. Never used to create accounts. */
const LEGACY_DEFAULT_ADMIN_PASSWORD = "ChangeMe123!";

/* ── Security switches ── */
const REQUIRE_POST_FOR_CREDENTIALS     = true;   // passwords / reset codes / id tokens never in a URL
const ALLOW_PASSWORD_PER_REQUEST_AUTH  = false;  // adminUser/adminPass on every request (bypasses lockout) — debug only
const GETFILE_REQUIRES_AUTH            = true;   // getfile needs username+token (or adminToken)
const ENFORCE_ACCESS_ON_CONTENT        = true;   // expired/unpaid users can't use paid endpoints even with a valid token
const MIN_ADMIN_PASSWORD_LENGTH        = 8;
const MIN_USER_PASSWORD_LENGTH         = 8;
const PRIVATE_SETTING_PREFIXES         = ["private_", "secret_"];
const RESERVED_USERNAMES               = ["admin", "administrator", "root", "owner", "system", "support", "abhyas"];

const USERS_SHEET            = "Users";
const PAYMENTS_SHEET         = "Payments";
const SETTINGS_SHEET         = "Settings";
const LOGS_SHEET             = "Logs";
const ADMINS_SHEET           = "Admins";
const PROGRESS_SHEET         = "Progress";
const PROGRESS_IMPORTS_SHEET = "ProgressImports";
const PROGRESS_BACKUPS_SHEET = "ProgressBackups";
const PUSHTOKENS_SHEET       = "PushTokens";
const WEEKLYSETS_SHEET       = "WeeklySets";
const WEEKLYATTEMPTS_SHEET   = "WeeklyAttempts";
const QREPORTS_SHEET         = "QuestionReports";
const SUBJ_SUBMISSIONS_SHEET = "SubjectiveSubmissions";
const ADMIN_PERMS_SHEET      = "AdminPermissions";
const WEEKLYSTARTS_SHEET     = "WeeklyStarts";
const STUDYDOCS_SHEET        = "StudyDocs";
const PROGRESS_HISTORY_SHEET = "ProgressHistory";

const USER_HEADERS = [
  "username","passHash","name","email","mobile",
  "contact","contactType","status","createdAt","approvedAt",
  "role","trialExpiresAt","paymentStatus","permanentAccess",
  "accessType","accessExpiresAt","sessionToken","sessionTokenExpiresAt",
  "emailVerified"
];
const PAYMENT_HEADERS = [
  "username","name","email","mobile","txId","remarks",
  "status","rejectionReason","screenshotUrl","submittedAt","reviewedAt"
];
const SETTINGS_HEADERS = ["key","value"];
const LOG_HEADERS = ["timestamp","admin","action","target","details"];
const ADMIN_HEADERS = [
  "username","passHash","createdAt","createdBy","token","tokenExpires","role"
];
const PROGRESS_HEADERS = ["username","data","updatedAt"];
const PUSHTOKENS_HEADERS = ["username","fcmToken","updatedAt"];
const WEEKLYSET_HEADERS = [
  "id","title","fileId","chapterLabel","status","uploadedBy","uploadedAt","releaseAt"
];
const WEEKLYATTEMPT_HEADERS = [
  "username","weeklyId","answersJson","totalQuestions",
  "correctClaimed","skippedCount","startedAt","submittedAt","durationSec"
];
const SUBJ_SUBMISSION_HEADERS = [
  "id","username","kind","questionId","questionText","questionMarks",
  "chapterId","solveSec","startedAt","submittedAt",
  "pdfFileId","pdfUrl","status","score","feedback","gradedBy","gradedAt",
  "pdfReplacedAt","pdfReplacedBy","pdfOriginalBackupId"
];
const ADMIN_PERM_HEADERS = ["username","featureKey","enabled","updatedAt","updatedBy"];
const PROGRESS_HISTORY_HEADERS = ["username","data1","savedAt1","data2","savedAt2","data3","savedAt3"];
const PROGRESS_HISTORY_MIN_GAP_MS = 30 * 60 * 1000;
const PROGRESS_GZ_PREFIX = "gz1:";
const STUDYDOC_HEADERS = [
  "id","title","category","chapterId","description","fileId","fileName",
  "sizeBytes","status","sortOrder","uploadedBy","uploadedAt","updatedAt"
];
const STUDYDOC_CATEGORIES = ["model-answer","notes","past-paper","syllabus","other"];
const MAX_STUDYDOC_DATA_CHARS = 14 * 1024 * 1024;   /* base64 text; about 10 MB of PDF */
const WEEKLYSTART_HEADERS = ["username","weeklyId","startedAt"];
/* Keep equal to WEEKLY_EXAM_WINDOW_HOURS (12) in app.js. */
const WEEKLY_EXAM_WINDOW_MS = 12 * 60 * 60 * 1000;
const PROGRESS_IMPORT_HEADERS = [
  "importId","admin","mode","status","recordsReceived",
  "recordsAccepted","recordsSkipped","errorCount","createdAt",
  "completedAt","details"
];
const PROGRESS_BACKUP_HEADERS = [
  "backupId","importId","username","data","createdAt","createdBy"
];

const TRIAL_HOURS = 24;
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const USER_TOKEN_TTL_MS  = 30 * 24 * 60 * 60 * 1000;

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const GETFILE_RATE_LIMIT_PER_MINUTE = 600;
const GETFILE_RATE_LIMIT_PER_USER_PER_MINUTE = 60;
const GETFILES_MAX_BATCH = 8;
const GETFILES_PER_USER_FILES_PER_MINUTE = 360;
const GETFILES_MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
const SIGNUP_RATE_LIMIT_PER_MINUTE = 15;
const UNKNOWN_LOGIN_LIMIT_PER_MINUTE = 120;

const MAX_LIST_USERS = 3000;
const MAX_LIST_PAYMENTS = 3000;
const MAX_LIST_QREPORTS = 2000;
const MAX_LIST_WEEKLYSETS = 500;
const MAX_MISSED_SCAN_ROWS = 5000;
const MAX_SUBJ_SUBMISSIONS = 500;
const LOGS_MAX_ROWS_READ = 1000;

const MAX_IMPORT_BODY_CHARS = 450000;
const MAX_IMPORT_RECORDS = 500;
const MAX_IMPORT_DATA_CHARS_PER_USER = 45000;
const MAX_REPORT_LIMIT = 500;
const MAX_REPORT_MIN_ATTEMPTS = 1000000;

const TRIAL_WARNING_WINDOW_MS = 2 * 60 * 60 * 1000;

/* ── System folder layout ──
   Every folder the app creates lives under one parent, so the Drive root
   stays clean. Old flat folders are adopted transparently the first time
   they are touched, so nothing is orphaned. */
const SYSTEM_FOLDER_NAME = "Abhyas System Data";

function getOrCreateSystemFolder_(name) {
  const props = PropertiesService.getScriptProperties();
  let parentId = props.getProperty("SYSTEM_FOLDER_ID");
  let parent = null;
  if (parentId) { try { parent = DriveApp.getFolderById(parentId); } catch (e) { parent = null; } }
  if (!parent) {
    const it = DriveApp.getFoldersByName(SYSTEM_FOLDER_NAME);
    parent = it.hasNext() ? it.next() : DriveApp.createFolder(SYSTEM_FOLDER_NAME);
    props.setProperty("SYSTEM_FOLDER_ID", parent.getId());
  }
  const sub = parent.getFoldersByName(name);
  if (sub.hasNext()) return sub.next();
  const flat = DriveApp.getFoldersByName(name);
  if (flat.hasNext()) {
    const legacy = flat.next();
    try { legacy.moveTo(parent); } catch (e) { /* read-only or already moved */ }
    return legacy;
  }
  return parent.createFolder(name);
}

function getOrCreateFolder_(name) {
  const iter = DriveApp.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : DriveApp.createFolder(name);
}

/* YYYY-MM-DD_HHmmss_username_kind.ext — sortable, stable across devices. */
function _uploadFilename_(username, kind, ext) {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const stamp = d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate())
              + "_" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  const safeUser = String(username || "user").replace(/[^\w.\-]+/g, "_").slice(0, 40);
  const safeKind = String(kind || "file").replace(/[^\w.\-]+/g, "_").slice(0, 24);
  return stamp + "_" + safeUser + "_" + safeKind + "." + String(ext || "bin").replace(/^\./, "");
}

/* Input length caps */
const MAX_USERNAME_LEN = 64;
const MAX_PASSWORD_LEN = 256;
const MAX_NAME_LEN = 80;
const MAX_EMAIL_LEN = 120;

const MAX_JSON_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCREENSHOT_DATA_CHARS = 8 * 1024 * 1024;

const ADMIN_ROLE_OWNER = "owner";
const ADMIN_ROLE_ADMIN = "admin";

const FEATURES = {
  dashboard:          "Dashboard overview",
  users_view:         "View users list",
  users_manage:       "Edit / delete users, grant access",
  users_bulk:         "Bulk operations on users",
  payments_view:      "View payments list",
  payments_review:    "Verify / reject payments",
  payments_bulk:      "Bulk payment review",
  screenshots:        "Download payment screenshots",
  weeklysets_view:    "View weekly sets",
  weeklysets_manage:  "Create / edit / delete weekly sets",
  studydocs_view:     "View study PDFs",
  studydocs_manage:   "Upload / edit / delete study PDFs",
  qreports_view:      "View question reports",
  qreports_manage:    "Update / dismiss question reports",
  subjective_view:    "View subjective submissions",
  subjective_grade:   "Grade subjective submissions",
  subjective_import:  "Upload subjective JSON / import questions",
  logs_view:          "View activity logs",
  settings_view:      "View settings",
  settings_manage:    "Edit settings",
  admins_view:        "View other admin accounts",
  admins_manage:      "Create / delete admins, change permissions",
  maintenance:        "Data maintenance (prune / clear backups)",
  exports:            "Export CSV data",
  imports:            "Import progress data"
};

const GOOGLE_CLIENT_ID = "242226857075-hpkbjoqhlem95fu6vkf712e8ijs33sng.apps.googleusercontent.com";

let SKIP_CREATION_FORMATTING = false;   // toggled by setup() in setup.gs

/* Set to true by doPost() only. A module global is per-execution, so a
   GET request can never spoof it through query parameters. */
let _REQUEST_VIA_POST = false;

/* Actions that carry secrets and therefore must be POST. */
const POST_ONLY_ACTIONS = {
  login: 1, googlelogin: 1, signup: 1, resetpassword: 1,
  adminlogin: 1, adminchangepassword: 1, admincreateadmin: 1,
  deletemyaccount: 1, resetmyprogress: 1
};

/* ── Request-scoped caches ── */
const _sheetRefCache = {};
const _sheetDataCache = {};
const _migratedSheets = {};

function _invalidateSheet_(name) { delete _sheetDataCache[name]; }

function _cachedSheetData_(name, getter) {
  if (_sheetDataCache[name]) return _sheetDataCache[name];
  const sheet = getter ? getter() : getSpreadsheet_().getSheetByName(name);
  const data = sheet.getDataRange().getValues();
  _sheetDataCache[name] = { sheet, data };
  return _sheetDataCache[name];
}

/* ═══════════════════════════════════════════════════════════════════════
   SPREADSHEET + SHEET GETTERS
   ═══════════════════════════════════════════════════════════════════════ */

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty("SHEET_ID") || DEFAULT_SPREADSHEET_ID;
  let ss = null;
  try { ss = SpreadsheetApp.openById(ssId); } catch (e) { /* fall through */ }
  if (!ss) {
    ss = SpreadsheetApp.create("Abhyas V1");
    props.setProperty("SHEET_ID", ss.getId());
    console.log("⚠️ Created a NEW spreadsheet: " + ss.getUrl());
  } else if (props.getProperty("SHEET_ID") !== ssId) {
    props.setProperty("SHEET_ID", ssId);
  }
  return ss;
}

function _getOrCreateSheet_(name, headers, formatAsText, headerColor, bandTheme, maxWidthPx) {
  if (_sheetRefCache[name]) return _sheetRefCache[name];

  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    if (formatAsText && formatAsText.length) {
      const maxRows = sheet.getMaxRows() - 1;
      formatAsText.forEach(col => sheet.getRange(2, col, maxRows, 1).setNumberFormat("@"));
    }
    if (!SKIP_CREATION_FORMATTING) {
      applyTableFormat_(sheet, headers, headerColor, bandTheme, maxWidthPx);
    }
  }
  _sheetRefCache[name] = sheet;
  return sheet;
}

/* Sheets gain columns over time. On first touch per request we top up the
   header row so reads/writes stay aligned with the *_HEADERS constants. */
function _topUpHeaders_(sheet, headers, headerColor) {
  const name = sheet.getName();
  if (_migratedSheets[name]) return;
  _migratedSheets[name] = true;
  const lastCol = sheet.getLastColumn();
  if (lastCol >= headers.length) return;
  const missing = headers.slice(lastCol);
  sheet.getRange(1, lastCol + 1, 1, missing.length)
    .setValues([missing])
    .setFontWeight("bold")
    .setBackground(headerColor)
    .setFontColor("white");
  _invalidateSheet_(name);
  console.log("Migrated " + name + " — added: " + missing.join(", "));
}

function getUsersSheet_() {
  const sheet = _getOrCreateSheet_(USERS_SHEET, USER_HEADERS, [1,5,6], "#4285f4", SpreadsheetApp.BandingTheme.BLUE, 300);
  _topUpHeaders_(sheet, USER_HEADERS, "#4285f4");
  return sheet;
}
function getPaymentsSheet_()   { return _getOrCreateSheet_(PAYMENTS_SHEET, PAYMENT_HEADERS, [4,5], "#34a853", SpreadsheetApp.BandingTheme.GREEN, 300); }
function getSettingsSheet_()   { return _getOrCreateSheet_(SETTINGS_SHEET, SETTINGS_HEADERS, [2], "#fbbc04", SpreadsheetApp.BandingTheme.YELLOW, 400); }
function getLogsSheet_()       { return _getOrCreateSheet_(LOGS_SHEET, LOG_HEADERS, [], "#9c27b0", SpreadsheetApp.BandingTheme.PURPLE, 320); }
function getProgressSheet_()   { return _getOrCreateSheet_(PROGRESS_SHEET, PROGRESS_HEADERS, [1], "#0f9d58", SpreadsheetApp.BandingTheme.GREEN, 300); }
function getPushTokensSheet_() { return _getOrCreateSheet_(PUSHTOKENS_SHEET, PUSHTOKENS_HEADERS, [1], "#e67c00", SpreadsheetApp.BandingTheme.ORANGE, 300); }
function getWeeklySetsSheet_() { return _getOrCreateSheet_(WEEKLYSETS_SHEET, WEEKLYSET_HEADERS, [1,3], "#00acc1", SpreadsheetApp.BandingTheme.CYAN, 320); }
function getWeeklyAttemptsSheet_()  { return _getOrCreateSheet_(WEEKLYATTEMPTS_SHEET, WEEKLYATTEMPT_HEADERS, [1,2], "#00897b", SpreadsheetApp.BandingTheme.TEAL, 300); }
function getAdminPermsSheet_()      { return _getOrCreateSheet_(ADMIN_PERMS_SHEET, ADMIN_PERM_HEADERS, [1,2], "#7c3aed", SpreadsheetApp.BandingTheme.PURPLE, 320); }
function getProgressImportsSheet_() { return _getOrCreateSheet_(PROGRESS_IMPORTS_SHEET, PROGRESS_IMPORT_HEADERS, [], "#5e35b1", SpreadsheetApp.BandingTheme.PURPLE, 320); }
function getProgressBackupsSheet_() { return _getOrCreateSheet_(PROGRESS_BACKUPS_SHEET, PROGRESS_BACKUP_HEADERS, [], "#455a64", SpreadsheetApp.BandingTheme.GREY, 320); }
function getWeeklyStartsSheet_()    { return _getOrCreateSheet_(WEEKLYSTARTS_SHEET, WEEKLYSTART_HEADERS, [1,2], "#00897b", SpreadsheetApp.BandingTheme.TEAL, 300); }

function getSubjSubmissionsSheet_() {
  const sheet = _getOrCreateSheet_(SUBJ_SUBMISSIONS_SHEET, SUBJ_SUBMISSION_HEADERS, [1,2,4,11], "#0891b2", SpreadsheetApp.BandingTheme.CYAN, 400);
  _topUpHeaders_(sheet, SUBJ_SUBMISSION_HEADERS, "#0891b2");
  return sheet;
}
function getProgressHistorySheet_() {
  return _getOrCreateSheet_(PROGRESS_HISTORY_SHEET, PROGRESS_HISTORY_HEADERS, [1], "#455a64", SpreadsheetApp.BandingTheme.LIGHT_GREY, 300);
}
function getStudyDocsSheet_() {
  const sheet = _getOrCreateSheet_(STUDYDOCS_SHEET, STUDYDOC_HEADERS, [1,4,6], "#dc2626", SpreadsheetApp.BandingTheme.LIGHT_GREY, 360);
  _topUpHeaders_(sheet, STUDYDOC_HEADERS, "#dc2626");
  return sheet;
}
function getAdminsSheet_() {
  if (_sheetRefCache[ADMINS_SHEET]) return _sheetRefCache[ADMINS_SHEET];

  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(ADMINS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ADMINS_SHEET);
    sheet.appendRow(ADMIN_HEADERS);
    const maxRows = sheet.getMaxRows() - 1;
    sheet.getRange(2, 1, maxRows, 1).setNumberFormat("@");
    if (!SKIP_CREATION_FORMATTING) {
      applyTableFormat_(sheet, ADMIN_HEADERS, "#ea4335", SpreadsheetApp.BandingTheme.RED, 300);
    }
    const seedPw = generateStrongPassword_();
    sheet.appendRow([
      ADMIN_SEED_USERNAME,
      makeStoredHash_(seedPw),
      new Date().toISOString(),
      "system",
      "", "",
      ADMIN_ROLE_OWNER
    ]);
    PropertiesService.getScriptProperties().setProperty("INITIAL_ADMIN_PASSWORD", seedPw);
    setAdminMustChange_(ADMIN_SEED_USERNAME, true);
    console.log("⚠️ Admin sheet created. Run showInitialAdminPassword() in the editor to see the one-time owner password.");
    _sheetRefCache[ADMINS_SHEET] = sheet;
    return sheet;
  }

  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headerRow.indexOf("role") === -1) {
    const newCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, newCol).setValue("role");
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const usernames = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      const roles = usernames.map(r => [
        String(r[0] || "").toLowerCase() === ADMIN_SEED_USERNAME.toLowerCase()
          ? ADMIN_ROLE_OWNER : ADMIN_ROLE_ADMIN
      ]);
      sheet.getRange(2, newCol, roles.length, 1).setValues(roles);
    }
  }
  _sheetRefCache[ADMINS_SHEET] = sheet;
  return sheet;
}

/* ═══════════════════════════════════════════════════════════════════════
   ROW LOOKUP
   ═══════════════════════════════════════════════════════════════════════ */

/* TextFinder is scoped to the key column, so searching cannot cross-hit a
   value in a different column of an earlier row. A cached hint remembers
   WHERE a key lives (row number only); the live row is always re-read and
   re-verified, so a stale hint falls through to the slow search. */
function _findRowFast_(sheet, col, value) {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value);
  const want = str.toLowerCase().trim();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const lastCol = sheet.getLastColumn();

  const cache = CacheService.getScriptCache();
  let ck = "rix_" + sheet.getName() + "_" + col + "_" + want;
  if (ck.length > 240) ck = "rix_" + hashPass_(ck).slice(0, 48);
  const hint = Number(cache.get(ck)) || 0;
  if (hint >= 2 && hint <= lastRow) {
    const r = sheet.getRange(hint, 1, 1, lastCol).getValues()[0];
    if (String(r[col - 1]).toLowerCase().trim() === want) return { rowIndex: hint, row: r };
    cache.remove(ck);
  }

  const hit = sheet.getRange(2, col, lastRow - 1, 1)
    .createTextFinder(str)
    .matchCase(false)
    .matchEntireCell(true)
    .findNext();
  if (!hit) return null;
  const rowIndex = hit.getRow();
  if (rowIndex < 2) return null;
  const row = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  if (String(row[col - 1]).toLowerCase().trim() !== want) return null;
  try { cache.put(ck, String(rowIndex), 21600); } catch (e) {}
  return { rowIndex, row };
}

function findUserRow_(sheet, username)       { return username ? _findRowFast_(sheet, 1, username) : null; }
function findAdminRow_(sheet, username)      { return username ? _findRowFast_(sheet, 1, username) : null; }
function findProgressRow_(sheet, username)   { return username ? _findRowFast_(sheet, 1, username) : null; }
function findPushTokenRow_(sheet, username)  { return username ? _findRowFast_(sheet, 1, username) : null; }
function findWeeklySetRow_(sheet, id)        { return id ? _findRowFast_(sheet, 1, id) : null; }
function findUserByField_(sheet, colIndex, value) { return value ? _findRowFast_(sheet, colIndex + 1, value) : null; }

function findWeeklyAttemptRow_(sheet, username, weeklyId) {
  if (!username || !weeklyId) return null;
  const target = String(username).toLowerCase().trim();
  const wid = String(weeklyId).trim();
  const data = _cachedSheetData_(WEEKLYATTEMPTS_SHEET, getWeeklyAttemptsSheet_).data;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === target && String(data[i][1]).trim() === wid) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function findAdminByToken_(sheet, token) {
  if (!token) return null;
  const data = _cachedSheetData_(ADMINS_SHEET, getAdminsSheet_).data;
  const now = Date.now();
  const SLIDE_THRESHOLD_MS = 60 * 60 * 1000;
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] && tokenMatches_(data[i][4], token)) {
      const expires = Number(data[i][5] || 0);
      if (expires && now <= expires) {
        if (expires - now < ADMIN_TOKEN_TTL_MS - SLIDE_THRESHOLD_MS) {
          try {
            sheet.getRange(i + 1, 6).setValue(String(now + ADMIN_TOKEN_TTL_MS));
            _invalidateSheet_(ADMINS_SHEET);
          } catch (e) {}
        }
        return { rowIndex: i + 1, row: data[i] };
      }
    }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   ROW → OBJECT MAPPERS
   ═══════════════════════════════════════════════════════════════════════ */

function rowToUser_(row) {
  return {
    username: row[0] || "",
    name: row[2] || "",
    email: row[3] || "",
    mobile: String(row[4] || ""),
    contact: row[5] || "",
    contactType: row[6] || "",
    status: row[7] || "trial",
    createdAt: row[8] || "",
    approvedAt: row[9] || "",
    role: row[10] || "user",
    trialExpiresAt: row[11] || "",
    paymentStatus: row[12] || "none",
    permanentAccess: row[13] === "true" || row[13] === true,
    accessType: row[14] || "",
    accessExpiresAt: row[15] || "",
    emailVerified: row[18] === "true" || row[18] === true
  };
}
function rowToWeeklySet_(row) {
  return {
    id: row[0] || "", title: row[1] || "", fileId: row[2] || "",
    chapterLabel: row[3] || "", status: row[4] || "active",
    uploadedBy: row[5] || "", uploadedAt: row[6] || "", releaseAt: row[7] || ""
  };
}
function rowToWeeklyAttempt_(row) {
  let answers = [];
  try { answers = JSON.parse(row[2] || "[]"); } catch (e) {}
  const total = Number(row[3] || 0);
  const correct = Number(row[4] || 0);
  return {
    weeklyId: row[1] || "", answers, total, correct,
    pct: weeklyMarks_(correct, row[5], total).pct,
    skipped: Number(row[5] || 0),
    startedAt: Number(row[6] || 0),
    submittedAt: Number(row[7] || 0),
    durationSec: Number(row[8] || 0),
    synced: true
  };
}
function rowToSubjSubmission_(row) {
  return {
    id: row[0] || "", username: row[1] || "", kind: row[2] || "qotd",
    questionId: row[3] || "", questionText: row[4] || "",
    questionMarks: Number(row[5] || 0), chapterId: row[6] || "",
    solveSec: Number(row[7] || 0),
    startedAt: Number(row[8] || 0), submittedAt: Number(row[9] || 0),
    pdfFileId: row[10] || "", pdfUrl: row[11] || "",
    status: row[12] || "pending",
    score: row[13] === "" ? null : Number(row[13]),
    feedback: row[14] || "",
    gradedBy: row[15] || "", gradedAt: row[16] || "",
    pdfReplacedAt: row[17] || "",
    pdfReplacedBy: row[18] || "",
    pdfOriginalBackupId: row[19] || ""
  };
}
function rowToStudyDoc_(row, forAdmin) {
  const d = {
    id: String(row[0] || ""), title: String(row[1] || ""), category: String(row[2] || "other"),
    chapterId: String(row[3] || ""), description: String(row[4] || ""),
    fileName: String(row[6] || ""), sizeBytes: Number(row[7]) || 0,
    status: String(row[8] || "published"),
    sortOrder: (row[9] === "" || row[9] === null || row[9] === undefined) ? NaN : Number(row[9]),
    uploadedAt: Number(row[11]) || 0, updatedAt: Number(row[12]) || 0
  };
  if (!isFinite(d.sortOrder)) d.sortOrder = 100;
  if (forAdmin) { d.uploadedBy = String(row[10] || ""); d.hasFile = !!String(row[5] || "").trim(); }
  return d;
}

/* ═══════════════════════════════════════════════════════════════════════
   LOGGING
   ═══════════════════════════════════════════════════════════════════════ */

function logAction_(admin, action, target, details) {
  try {
    getLogsSheet_().appendRow([
      new Date().toISOString(), admin || "admin",
      action || "", target || "", details || ""
    ]);
    _invalidateSheet_(LOGS_SHEET);
  } catch (err) { console.error("logAction_ failed:", err); }
}

/* Short crash reports from the app (page, message, browser). Public, rate
   limited, and never contains answers or personal details. */
function logClientError(p) {
  if (!checkRateLimit_("clienterr", 20, 60000)) return { success: true };
  const clip = (v, n) => sanitizeSheetField_(String(v == null ? "" : v).replace(/[\r\n]+/g, " ").slice(0, n));
  logAction_("client", "Client Error", clip(p.page, 60),
    clip(p.msg, 200) + " @ " + clip(p.src, 80) + ":" + clip(p.line, 8) + " v" + clip(p.v, 10) + " " + clip(p.ua, 80));
  return { success: true };
}

/* ═══════════════════════════════════════════════════════════════════════
   SHEET FORMATTING (called by _getOrCreateSheet_ on first-ever creation)
   ═══════════════════════════════════════════════════════════════════════ */

function applyTableFormat_(sheet, headers, headerColor, bandTheme, maxWidthPx) {
  const numCols = headers.length;
  const maxRows = Math.max(1, sheet.getMaxRows() - 1);

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, numCols)
    .setFontWeight("bold")
    .setBackground(headerColor)
    .setFontColor("white");

  const fullRange = sheet.getRange(1, 1, maxRows + 1, numCols);
  if (maxRows >= 1) applyBandingOrFallback_(sheet, fullRange, headerColor, bandTheme);
  fullRange.setBorder(true, true, true, true, true, true, "#d0d0d0", SpreadsheetApp.BorderStyle.SOLID);
  autoResizeCapped_(sheet, 1, numCols, maxWidthPx || 300);
}

function applyBandingOrFallback_(sheet, fullRange, headerColor, bandTheme) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      sheet.getBandings().forEach(b => {
        const r = b.getRange();
        const overlaps = r.getSheet().getSheetId() === sheet.getSheetId() &&
          r.getRow() <= fullRange.getLastRow() && r.getLastRow() >= fullRange.getRow() &&
          r.getColumn() <= fullRange.getLastColumn() && r.getLastColumn() >= fullRange.getColumn();
        if (overlaps) b.remove();
      });
      SpreadsheetApp.flush();
      const banding = fullRange.applyRowBanding(bandTheme, true, false);
      banding.setHeaderRowColor(headerColor);
      if (fullRange.getNumRows() > 1) {
        sheet.getRange(fullRange.getRow() + 1, fullRange.getColumn(),
                       fullRange.getNumRows() - 1, fullRange.getNumColumns())
          .setBackground(null);
      }
      return;
    } catch (err) {
      if (attempt === 2) console.log("Using manual banding for '" + sheet.getName() + "'.");
      else Utilities.sleep(600);
    }
  }
  applyManualBanding_(sheet, fullRange, bandTheme);
}

function bandThemeStripeColor_(bandTheme) {
  const name = (function () {
    for (const k in SpreadsheetApp.BandingTheme) {
      if (SpreadsheetApp.BandingTheme[k] === bandTheme) return k;
    }
    return "BLUE";
  })();
  const map = {
    BLUE: "#e8f0fe", GREEN: "#e6f4ea", YELLOW: "#fef7e0", PURPLE: "#f3e8fd",
    RED: "#fce8e6", ORANGE: "#fef0e0", CYAN: "#e0f7fa", PINK: "#fce4ec",
    GREY: "#f1f3f4", TEAL: "#e0f2f1"
  };
  return map[name] || "#f3f3f3";
}

function applyManualBanding_(sheet, fullRange, bandTheme) {
  const startRow = fullRange.getRow();
  const numCols = fullRange.getNumColumns();
  const dataRows = fullRange.getNumRows() - 1;
  if (dataRows < 1) return;
  const stripe = bandThemeStripeColor_(bandTheme);
  const base = "#ffffff";
  const colors = [];
  for (let r = 0; r < dataRows; r++) colors.push(new Array(numCols).fill(r % 2 === 0 ? base : stripe));
  sheet.getRange(startRow + 1, fullRange.getColumn(), dataRows, numCols).setBackgrounds(colors);
}

function autoResizeCapped_(sheet, colStart, colCount, maxWidthPx) {
  sheet.autoResizeColumns(colStart, colCount);
  const maxRows = Math.max(1, sheet.getMaxRows() - 1);
  for (let c = colStart; c < colStart + colCount; c++) {
    if (sheet.getColumnWidth(c) > maxWidthPx) {
      sheet.setColumnWidth(c, maxWidthPx);
      sheet.getRange(2, c, maxRows, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   SMALL HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeSheetField_(value) {
  const s = String(value == null ? "" : value);
  return /^[\s]*[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function _isoOf_(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v === null || v === undefined ? "" : v);
}
/* ═══════════════════════════════════════════════════════════════════════
   ENTRY POINTS
   ═══════════════════════════════════════════════════════════════════════ */

function doGet(e) {
  if (!e || typeof e !== 'object') {
    return jsonResponse({ success: false, error: "Invalid request: no event object. Use the deployed Web App URL (/exec)." });
  }
  if (!e.parameter) e.parameter = {};

  const action = String(e.parameter.action || "").trim().toLowerCase();

  /* Email-verification link is opened in a browser: returns an HTML page. */
  if (action === "verifyemail") return handleVerifyEmail_(e.parameter);

  if (REQUIRE_POST_FOR_CREDENTIALS && !_REQUEST_VIA_POST &&
      (POST_ONLY_ACTIONS[action] || (action === "adminupdateuser" && e.parameter.password))) {
    return jsonResponse({
      success: false, mustUsePost: true,
      error: "This action must be sent as a POST request so credentials never appear in the URL."
    });
  }

  let result;

  try {
    switch (action) {
      case "ping": return jsonResponse({ success: true, pong: true, version: APP_VERSION });

      case "login":                result = handleLogin(e.parameter); break;
      case "googlelogin":          result = handleGoogleLogin(e.parameter); break;
      case "signup":               result = handleSignup(e.parameter); break;
      case "logclienterror":       result = logClientError(e.parameter); break;
      case "checksession":         result = checkSession(e.parameter); break;
      case "requestpasswordreset": result = requestPasswordReset(e.parameter); break;
      case "resetpassword":        result = resetPassword(e.parameter); break;
      case "resendverification":   result = resendVerificationEmail(e.parameter); break;
      case "updateownmobile":      result = updateOwnMobile(e.parameter); break;
      case "deletemyaccount":      result = deleteMyAccount(e.parameter); break;
      case "resetmyprogress":      result = resetMyProgress(e.parameter); break;
      case "checkadmincapable":    result = checkAdminCapable(e.parameter); break;
      case "adminswitchfromuser":  result = adminSwitchFromUser(e.parameter); break;

      case "saveprogress":         result = saveProgress(e.parameter); break;
      case "getprogress":          result = getProgress(e.parameter); break;
      case "savepushtoken":        result = savePushToken(e.parameter); break;
      case "listweeklysets":       result = listWeeklySets(e.parameter); break;
      case "getweeklyattempt":     result = getWeeklyAttempt(e.parameter); break;
      case "getmyweeklyattempts":  result = getMyWeeklyAttempts(e.parameter); break;
      case "startweeklyattempt":   result = startWeeklyAttempt(e.parameter); break;
      case "getweeklystanding":    result = getWeeklyStanding(e.parameter); break;
      case "submitweeklyattempt":  result = submitWeeklyAttempt(e.parameter); break;

      case "submitsubjectiveanswer":     result = submitSubjectiveAnswer(e.parameter); break;
      case "getmysubjectivesubmissions": result = getMySubjectiveSubmissions(e.parameter); break;
      case "getmysubmissionpdf":         result = getMySubmissionPdf(e.parameter); break;
      case "getprogresshistory":         result = getProgressHistory(e.parameter); break;
      case "liststudydocs":              result = listStudyDocs(e.parameter); break;
      case "getstudydocpdf":             result = getStudyDocPdf(e.parameter); break;

      case "submitpayment":        result = submitPayment(e.parameter); break;
      case "getpaymentstatus":     result = getPaymentStatus(e.parameter); break;

      case "getpublicinfo":        result = getPublicInfo(); break;
      case "gethardquestions":     result = { success: true, map: getHardQuestionsCache_() }; break;
      case "getsettings":          result = getSettings(); break;
      case "getfile":              result = handleGetFile(e.parameter); break;
      case "getfiles":             result = handleGetFiles(e.parameter); break;
      case "getcontentkey":        result = handleGetContentKey(e.parameter); break;

      case "adminlogin":           result = adminLogin(e.parameter); break;
      case "adminchangepassword":  result = adminChangePassword(e.parameter); break;
      case "adminlistadmins":      result = adminListAdmins(e.parameter); break;
      case "admincreateadmin":     result = adminCreateAdmin(e.parameter); break;
      case "admindeleteadmin":     result = adminDeleteAdmin(e.parameter); break;
      case "adminlistadminpermissions": result = adminListAdminPermissions(e.parameter); break;
      case "adminsetadminpermissions":  result = adminSetAdminPermissions(e.parameter); break;
      case "adminpromoteowner":         result = adminPromoteOwner(e.parameter); break;
      case "adminpromoteusertoadmin":   result = adminPromoteUserToAdmin(e.parameter); break;

      case "admintrends":          result = adminTrends(e.parameter); break;
      case "adminstats":           result = adminStats(e.parameter); break;
      case "adminlistusers":       result = adminListUsers(e.parameter); break;
      case "adminupdateuser":      result = adminUpdateUser(e.parameter); break;
      case "admindeleteuser":      result = adminDeleteUser(e.parameter); break;
      case "admindeleteusersbatch": result = adminDeleteUsersBatch(e.parameter); break;
      case "admingrantaccess":     result = adminGrantAccess(e.parameter); break;
      case "admingrantaccessbatch": result = adminGrantAccessBatch(e.parameter); break;

      case "adminlistpayments":    result = adminListPayments(e.parameter); break;
      case "adminreviewpayment":   result = adminReviewPayment(e.parameter); break;
      case "adminreviewpaymentsbatch": result = adminReviewPaymentsBatch(e.parameter); break;
      case "admindownloadscreenshot":  result = adminDownloadScreenshot(e.parameter); break;
      case "admindeletepayment":   result = adminDeletePayment(e.parameter); break;
      case "adminrevokescreenshotsharing": result = adminRevokeScreenshotSharing(e.parameter); break;
      case "adminexpiringtrials":  result = adminExpiringTrials(e.parameter); break;

      case "admincreateweeklyset":     result = adminCreateWeeklySet(e.parameter); break;
      case "adminuploadweeklysetfile": result = adminUploadWeeklySetFile(e.parameter); break;
      case "adminupdateweeklyset":     result = adminUpdateWeeklySet(e.parameter); break;
      case "admindeleteweeklyset":     result = adminDeleteWeeklySet(e.parameter); break;
      case "adminlistweeklysets":      result = adminListWeeklySets(e.parameter); break;
      case "adminweeklysetresults":    result = adminWeeklySetResults(e.parameter); break;

      case "adminlistsubjectivesubmissions":   result = adminListSubjectiveSubmissions(e.parameter); break;
      case "admingradesubjectivesubmission":   result = adminGradeSubjectiveSubmission(e.parameter); break;
      case "adminuploadsubjectivefile":        result = adminUploadSubjectiveFile(e.parameter); break;
      case "admincommitsubjectiveimport":      result = adminCommitSubjectiveImport(e.parameter); break;
      case "adminreplacesubmissionpdf":        result = adminReplaceSubmissionPdf(e.parameter); break;
      case "admindownloadsubmissionpdf":       result = adminDownloadSubmissionPdf(e.parameter); break;

      case "adminliststudydocs":     result = adminListStudyDocs(e.parameter); break;
      case "adminaddstudydoc":       result = adminAddStudyDoc(e.parameter); break;
      case "adminupdatestudydoc":    result = adminUpdateStudyDoc(e.parameter); break;
      case "admindeletestudydoc":    result = adminDeleteStudyDoc(e.parameter); break;
      case "admindownloadstudydoc":  result = adminDownloadStudyDoc(e.parameter); break;

      case "adminupdatesettings":      result = adminUpdateSettings(e.parameter); break;
      case "adminupdatesettingsbatch": result = adminUpdateSettingsBatch(e.parameter); break;
      case "admingetsettings":         result = adminGetSettings(e.parameter); break;
      case "adminlistlogs":            result = adminListLogs(e.parameter); break;
      case "adminmostmissedquestions": result = adminMostMissedQuestions(e.parameter); break;

      case "adminimportprogress":       result = adminImportProgress(e.parameter); break;
      case "adminimportstatus":         result = adminImportStatus(e.parameter); break;
      case "adminclearprogressbackups": result = adminClearProgressBackups(e.parameter); break;
      case "adminpruneoldbackups":      result = adminPruneOldBackups(e.parameter); break;
      case "admintrimlogs":             result = adminTrimLogs(e.parameter); break;

      /* Everything else — including every action defined in gas/report.gs —
         is handled through the module router. If report.gs is not present
         in this project, REPORT_HANDLE_ returns null and the fallback
         below reports "Unknown action" exactly as before. This is what
         lets report.gs be added or removed without editing this switch. */
      default: {
        const handled = (typeof REPORT_HANDLE_ === 'function') ? REPORT_HANDLE_(action, e.parameter) : null;
        if (handled !== null) { result = handled; break; }
        result = { success: false, error: "Unknown action: '" + action + "'." };
      }
    }
  } catch (err) {
    console.error("doGet ERROR [" + action + "]:", err);
    result = { success: false, error: "Server error: " + (err && err.message ? err.message : String(err)) };
  }

  return jsonResponse(result);
}

function doPost(e) {
  _REQUEST_VIA_POST = true;
  if (e && e.postData && e.postData.contents) {
    try {
      const payload = JSON.parse(e.postData.contents);
      e.parameter = e.parameter || {};
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        for (const key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) e.parameter[key] = payload[key];
        }
      }
    } catch (parseErr) {
      console.log("doPost: JSON parse failed, using raw parameters");
    }
  }
  return doGet(e);
}

/* ═══════════════════════════════════════════════════════════════════════
   LOCK / RATE LIMIT
   ═══════════════════════════════════════════════════════════════════════ */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); }
  catch (e) { return { success: false, error: "Server is busy, please try again in a moment." }; }
  try { return fn(); }
  finally { lock.releaseLock(); }
}

/* Windowed counter in CacheService (fast, self-expiring, cannot fill the
   500 KB Script Properties store). Best-effort: two truly simultaneous
   requests can under-count by one, which is fine for abuse limiting.
   Keep windowMs <= 6h (CacheService's max TTL). */
function checkRateLimit_(bucket, maxCount, windowMs, logLabel, inc) {
  const cache = CacheService.getScriptCache();
  const windowBucket = Math.floor(Date.now() / windowMs);
  let key = "rl_" + bucket + "_" + windowBucket;
  if (key.length > 240) key = "rl_" + hashPass_(String(bucket)).slice(0, 48) + "_" + windowBucket;
  const ttl = Math.min(21600, Math.max(60, Math.ceil(windowMs / 1000) + 5));
  const count = (Number(cache.get(key)) || 0) + (inc > 0 ? inc : 1);
  cache.put(key, String(count), ttl);
  const withinLimit = count <= maxCount;
  if (!withinLimit && logLabel && count > maxCount && count - (inc > 0 ? inc : 1) <= maxCount) {
    logAction_("system", logLabel, "",
      "Exceeded " + maxCount + " per " + Math.round(windowMs / 1000) + "s (bucket: " + bucket + ").");
  }
  return withinLimit;
}

function checkGetFileRateLimit_() {
  return checkRateLimit_("getfile", GETFILE_RATE_LIMIT_PER_MINUTE, 60000, "GetFile Rate Limited");
}
function checkSignupRateLimit_() {
  return checkRateLimit_("signup", SIGNUP_RATE_LIMIT_PER_MINUTE, 60000, "Signup Rate Limited");
}

/* Lockouts live in Script Properties (they must survive cache eviction)
   but are ONLY ever written for accounts that exist, so they are bounded
   by the number of accounts. cleanupExpiredProperties() prunes stale
   entries. */
function checkLoginRateLimit_(kind, username) {
  const raw = PropertiesService.getScriptProperties().getProperty("loginlock_" + kind + "_" + String(username).toLowerCase().trim());
  if (!raw) return { locked: false };
  let state;
  try { state = JSON.parse(raw); } catch (e) { return { locked: false }; }
  if (state.lockUntil && Date.now() < state.lockUntil) {
    return { locked: true, minutesLeft: Math.ceil((state.lockUntil - Date.now()) / 60000) };
  }
  return { locked: false };
}
function recordLoginFailure_(kind, username) {
  const props = PropertiesService.getScriptProperties();
  const key = "loginlock_" + kind + "_" + String(username).toLowerCase().trim();
  let state = { count: 0 };
  const raw = props.getProperty(key);
  if (raw) { try { state = JSON.parse(raw); } catch (e) {} }
  if (state.lockUntil && Date.now() >= state.lockUntil) state = { count: 0 };
  state.count = (state.count || 0) + 1;
  state.at = Date.now();
  if (state.count >= MAX_LOGIN_ATTEMPTS) state.lockUntil = Date.now() + LOCKOUT_MINUTES * 60 * 1000;
  props.setProperty(key, JSON.stringify(state));
}
function _ghostKey_(username) { return "ghostlock_" + hashPass_(String(username).toLowerCase().trim()).slice(0, 40); }
function ghostLoginCheck_(username) {
  let state = null;
  try { const raw = CacheService.getScriptCache().get(_ghostKey_(username)); if (raw) state = JSON.parse(raw); } catch (e) {}
  if (state && state.lockUntil && Date.now() < state.lockUntil) {
    return { locked: true, minutesLeft: Math.ceil((state.lockUntil - Date.now()) / 60000) };
  }
  return { locked: false };
}
function ghostLoginFail_(username) {
  const cache = CacheService.getScriptCache();
  const key = _ghostKey_(username);
  let state = { count: 0 };
  try { const raw = cache.get(key); if (raw) state = JSON.parse(raw); } catch (e) {}
  if (state.lockUntil && Date.now() >= state.lockUntil) state = { count: 0 };
  state.count = (state.count || 0) + 1;
  if (state.count >= MAX_LOGIN_ATTEMPTS) state.lockUntil = Date.now() + LOCKOUT_MINUTES * 60 * 1000;
  try { cache.put(key, JSON.stringify(state), LOCKOUT_MINUTES * 60); } catch (e) {}
}
function clearLoginLock_(kind, username) {
  PropertiesService.getScriptProperties().deleteProperty("loginlock_" + kind + "_" + String(username).toLowerCase().trim());
}

/* Students could register with "123456". Reject the most-guessed
   passwords and ones that just repeat the username. Returns "" when fine. */
const COMMON_PASSWORDS_ = ["12345678","123456789","1234567890","password","password1","password123","qwerty123","qwertyuiop","11111111","00000000","12341234","abcd1234","iloveyou","admin123","letmein1","abhyas123","loksewa123","nepal123","987654321","asdfghjkl","1q2w3e4r","q1w2e3r4"];
function weakPasswordReason_(password, username) {
  const pw = String(password || "");
  if (pw.length < MIN_USER_PASSWORD_LENGTH) return "Password must be at least " + MIN_USER_PASSWORD_LENGTH + " characters.";
  const low = pw.toLowerCase();
  if (COMMON_PASSWORDS_.indexOf(low) !== -1 || /^(.)\1+$/.test(pw)) return "That password is too easy to guess. Choose something less common.";
  if (username && low.indexOf(String(username).toLowerCase()) !== -1 && String(username).length >= 4) return "Your password shouldn't contain your username.";
  return "";
}

/* ═══════════════════════════════════════════════════════════════════════
   HASHING + TOKENS
   ═══════════════════════════════════════════════════════════════════════ */

function hashPass_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0")).join("");
}
function makeSalt_() { return Utilities.getUuid().replace(/-/g, ""); }
function hashPassSalted_(password, salt) { return hashPass_(salt + password); }

/* Constant-time string comparison. */
function safeEqual_(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---- Password storage ----
   New hashes are PBKDF2-HMAC-SHA256: "p2:<iterations>:<salt>:<hex>". The
   iteration count lives inside each hash, so it can be raised later and
   old hashes keep verifying. Apps Script has no native PBKDF2, so this
   runs HMAC in a loop; run benchmarkPasswordHash() once from the editor
   and set PW_ITERATIONS to what login speed allows.
   Old formats still verify and are upgraded on the next successful login:
     "<sha256>"            unsalted (oldest)
     "<salt>:<sha256>"     salted, single round (older versions) */
const PW_ITERATIONS = 1000;

function bytesToHex_(bytes) {
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0")).join("");
}
/* PBKDF2 with HMAC-SHA256 and a 32-byte output (one block), as in RFC 8018. */
function pbkdf2Sha256_(password, salt, iterations) {
  const key = Utilities.newBlob(String(password)).getBytes();
  const saltBytes = Utilities.newBlob(String(salt)).getBytes();
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), key);
  const t = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return bytesToHex_(t);
}
function makeStoredHash_(password) {
  const salt = makeSalt_();
  return "p2:" + PW_ITERATIONS + ":" + salt + ":" + pbkdf2Sha256_(password, salt, PW_ITERATIONS);
}

function verifyPassword_(password, storedHash) {
  const s = String(storedHash || "");
  if (!s) return { ok: false };
  if (s.indexOf("p2:") === 0) {
    const parts = s.split(":");                       // ["p2", iterations, salt, hex]
    const iters = parseInt(parts[1], 10);
    if (parts.length !== 4 || !(iters >= 1 && iters <= 1000000)) return { ok: false };
    if (!safeEqual_(parts[3], pbkdf2Sha256_(password, parts[2], iters))) return { ok: false };
    return iters < PW_ITERATIONS ? { ok: true, upgradedHash: makeStoredHash_(password) } : { ok: true };
  }
  const sep = s.indexOf(":");
  const legacyOk = sep === -1
    ? safeEqual_(s, hashPass_(password))
    : safeEqual_(s.slice(sep + 1), hashPassSalted_(password, s.slice(0, sep)));
  return legacyOk ? { ok: true, upgradedHash: makeStoredHash_(password) } : { ok: false };
}

/* After a hash is upgraded, keep a linked user/admin pair identical so
   adminSwitchFromUser keeps working. */
function syncLinkedHash_(username, oldHash, newHash, fromSheet) {
  try {
    if (!oldHash || String(oldHash).indexOf(":") === -1) return;     // unsalted hashes were never linked
    if (fromSheet !== "user") {
      const us = getUsersSheet_(), uf = findUserRow_(us, username);
      if (uf && safeEqual_(uf.row[1], oldHash)) { us.getRange(uf.rowIndex, 2).setValue(newHash); _invalidateSheet_(USERS_SHEET); }
    }
    if (fromSheet !== "admin") {
      const as = getAdminsSheet_(), af = findAdminRow_(as, username);
      if (af && safeEqual_(af.row[1], oldHash)) { as.getRange(af.rowIndex, 2).setValue(newHash); _invalidateSheet_(ADMINS_SHEET); }
    }
  } catch (e) { console.error("syncLinkedHash_ failed:", e); }
}

/* Session/admin tokens are stored as "h:<sha256>" so anyone who can read
   the spreadsheet can't replay them. Legacy plaintext values still verify
   until they expire naturally. */
function tokenHash_(token) { return "h:" + hashPass_(String(token)); }
function tokenMatches_(stored, token) {
  if (!stored || !token) return false;
  stored = String(stored); token = String(token);
  if (stored.indexOf("h:") === 0) return safeEqual_(stored, tokenHash_(token));
  return safeEqual_(stored, token);
}

function issueUserToken_(sheet, rowIndex) {
  const token = Utilities.getUuid();
  const expires = Date.now() + USER_TOKEN_TTL_MS;
  sheet.getRange(rowIndex, 17, 1, 2).setValues([[tokenHash_(token), String(expires)]]);
  return token;
}
function issueAdminToken_(sheet, rowIndex) {
  const token = Utilities.getUuid();
  const expires = Date.now() + ADMIN_TOKEN_TTL_MS;
  sheet.getRange(rowIndex, 5, 1, 2).setValues([[tokenHash_(token), String(expires)]]);
  return token;
}
function verifyUserToken_(found, token) {
  if (!token) return false;
  const expires = Number(found.row[17] || 0);
  if (!tokenMatches_(found.row[16], token)) return false;
  if (!expires || Date.now() > expires) return false;
  return true;
}

/* A user row and an admin row are "linked" (same human) only when their
   stored password hashes are identical salted hashes. */
function userLinkedToAdmin_(userHash, adminHash) {
  const u = String(userHash || ""), a = String(adminHash || "");
  if (!u || !a || u.indexOf(":") === -1) return false;
  return safeEqual_(u, a);
}

function generateStrongPassword_() {
  const a = Utilities.getUuid().replace(/-/g, "").slice(0, 14);
  const b = Utilities.getUuid().replace(/-/g, "").slice(0, 6).toUpperCase();
  return a + "-" + b;
}

/* Secrets for stateless signed links (email verification). */
function getSecret_(name) {
  const props = PropertiesService.getScriptProperties();
  let v = props.getProperty(name);
  if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); props.setProperty(name, v); }
  return v;
}

/* ── Forced password change for the default/initial owner password ── */
function mustChangeKey_(u) { return "mustchange_" + String(u).toLowerCase().trim(); }
function adminMustChangePassword_(u) {
  return PropertiesService.getScriptProperties().getProperty(mustChangeKey_(u)) === "1";
}
function setAdminMustChange_(u, on) {
  const props = PropertiesService.getScriptProperties();
  if (on) props.setProperty(mustChangeKey_(u), "1"); else props.deleteProperty(mustChangeKey_(u));
}

/* ═══════════════════════════════════════════════════════════════════════
   GENERIC AUTH HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

/* Verifies username + session token in one place. Unknown user and bad
   token return the SAME error so account existence isn't leaked. */
function authUser_(p) {
  const username = String(p.username || "").trim();
  if (!username) return { ok: false, error: { success: false, error: "Username required." } };
  const sessionErr = { ok: false, error: { success: false, error: "Session expired. Please log in again.", sessionInvalid: true } };
  if (username.length > MAX_USERNAME_LEN) return sessionErr;
  const found = findUserRow_(getUsersSheet_(), username);
  if (!found || !verifyUserToken_(found, p.token)) return sessionErr;
  return { ok: true, username: String(found.row[0]), found };
}

/* Does this user row currently have paid/trial access? (Evaluated from the
   dates, so it's correct even if the status cell hasn't been refreshed.) */
function userHasContentAccess_(row) {
  const status = String(row[7] || "");
  const permanent = row[13] === true || String(row[13]).toLowerCase() === "true";
  const accessType = String(row[14] || "");
  const accessExpiresAt = row[15] ? new Date(row[15]) : null;
  const now = new Date();
  if (permanent || status === "active") {
    if (accessType === "yearly" && accessExpiresAt && !isNaN(accessExpiresAt) && now > accessExpiresAt) return false;
    return true;
  }
  if (status === "trial") {
    const t = row[11] ? new Date(row[11]) : null;
    if (!t || isNaN(t)) return true;
    return now <= t;
  }
  return false;
}

/* Returns null when allowed, or an error object to return to the client. */
function requireAccess_(auth) {
  if (!ENFORCE_ACCESS_ON_CONTENT) return null;
  if (userHasContentAccess_(auth.found.row)) return null;
  return { success: false, needsPayment: true, error: "Your access has expired. Please complete payment to continue." };
}
/* ═══════════════════════════════════════════════════════════════════════
   ADMIN AUTH + PERMISSIONS
   ═══════════════════════════════════════════════════════════════════════ */

function checkAdmin_(p) {
  const sheet = getAdminsSheet_();

  /* Debug-only path. Off by default because it would be a lockout-free
     password oracle on every admin endpoint. When enabled it still
     honours the same lockout as the login screens. */
  if (ALLOW_PASSWORD_PER_REQUEST_AUTH && p.adminUser && p.adminPass) {
    const uname = String(p.adminUser).trim();
    if (!uname || uname.length > MAX_USERNAME_LEN) return null;
    const found = findAdminRow_(sheet, uname);
    if (!found) return null;
    if (checkLoginRateLimit_('admin', uname).locked) return null;
    const verify = verifyPassword_(String(p.adminPass), found.row[1]);
    if (!verify.ok) { recordLoginFailure_('admin', uname); return null; }
    clearLoginLock_('admin', uname);
    if (verify.upgradedHash) {
      sheet.getRange(found.rowIndex, 2).setValue(verify.upgradedHash);
      _invalidateSheet_(ADMINS_SHEET);
      syncLinkedHash_(uname, found.row[1], verify.upgradedHash, "admin");
    }
    return found.row[0];
  }
  if (!p.adminToken) return null;
  const found = findAdminByToken_(sheet, p.adminToken);
  return found ? found.row[0] : null;
}

function getAdminRecord_(username) {
  if (!username) return null;
  const found = findAdminRow_(getAdminsSheet_(), username);
  if (!found) return null;
  const role = String(found.row[6] || "").trim().toLowerCase() || ADMIN_ROLE_ADMIN;
  return { rowIndex: found.rowIndex, row: found.row, role };
}

function getAdminPermissions_(username) {
  const rec = getAdminRecord_(username);
  if (!rec) return new Set();
  if (rec.role === ADMIN_ROLE_OWNER) return new Set(Object.keys(FEATURES));

  const data = _cachedSheetData_(ADMIN_PERMS_SHEET, getAdminPermsSheet_).data;
  const target = String(username).toLowerCase().trim();
  const granted = new Set();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === target) {
      const enabled = data[i][2] === true || data[i][2] === "true" || data[i][2] === 1;
      if (enabled) granted.add(String(data[i][1]));
    }
  }
  return granted;
}

function checkAdminCan_(p, feature) {
  const actor = checkAdmin_(p);
  if (!actor) return { ok: false, error: "Admin auth failed." };
  const rec = getAdminRecord_(actor);
  if (!rec) return { ok: false, error: "Admin auth failed." };
  if (adminMustChangePassword_(actor)) {
    return { ok: false, actor, mustChangePassword: true,
             error: "You must change the default admin password before using admin features." };
  }
  if (rec.role === ADMIN_ROLE_OWNER) return { ok: true, actor, role: rec.role };
  const perms = getAdminPermissions_(actor);
  if (!perms.has(feature)) {
    return { ok: false, error: "You don't have permission for this action (" + feature + ").", actor };
  }
  return { ok: true, actor, role: rec.role };
}

/* True only when an admin row exists for this username AND it is linked to
   the supplied user hash. */
function userIsAlsoAdmin_(username, userHash) {
  if (!username) return false;
  const a = findAdminRow_(getAdminsSheet_(), username);
  if (!a) return false;
  return userLinkedToAdmin_(userHash, a.row[1]);
}

/* ═══════════════════════════════════════════════════════════════════════
   ADMIN LOGIN + ACCOUNT MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════ */

function adminLogin(p) {
  const username = String(p.username || "").trim();
  const password = String(p.password == null ? "" : p.password);
  if (!username || !password) return { success: false, error: "Enter admin username and password." };
  if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) return { success: false, error: "Invalid admin credentials." };

  const sheet = getAdminsSheet_();
  const found = findAdminRow_(sheet, username);
  if (!found) return { success: false, error: "Invalid admin credentials." };

  const lock = checkLoginRateLimit_('admin', username);
  if (lock.locked) return { success: false, error: `Too many failed attempts. Try again in ${lock.minutesLeft} minute(s).` };

  const verify = verifyPassword_(password, found.row[1]);
  if (!verify.ok) {
    recordLoginFailure_('admin', username);
    return { success: false, error: "Invalid admin credentials." };
  }
  clearLoginLock_('admin', username);
  if (verify.upgradedHash) {
    sheet.getRange(found.rowIndex, 2).setValue(verify.upgradedHash);
    _invalidateSheet_(ADMINS_SHEET);
    syncLinkedHash_(username, found.row[1], verify.upgradedHash, "admin");
  }
  if (password === LEGACY_DEFAULT_ADMIN_PASSWORD) setAdminMustChange_(found.row[0], true);

  const token = issueAdminToken_(sheet, found.rowIndex);
  logAction_(found.row[0], "Admin Login", "", "");

  return {
    success: true, isAdmin: true, adminToken: token,
    mustChangePassword: adminMustChangePassword_(found.row[0]),
    user: { username: found.row[0], name: "Administrator", role: "admin" },
    message: "Welcome to Admin World"
  };
}

function adminChangePassword(p) {
  const actor = checkAdmin_(p);
  if (!actor) return { success: false, error: "Admin auth failed." };
  const currentPassword = String(p.currentPassword == null ? "" : p.currentPassword);
  const newPassword = String(p.newPassword == null ? "" : p.newPassword);
  if (!newPassword || newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return { success: false, error: "New password must be at least " + MIN_ADMIN_PASSWORD_LENGTH + " characters." };
  }
  if (newPassword.length > MAX_PASSWORD_LEN) return { success: false, error: "New password is too long." };
  if (newPassword === LEGACY_DEFAULT_ADMIN_PASSWORD) return { success: false, error: "Choose a password that isn't the default one." };
  if (newPassword === currentPassword) return { success: false, error: "New password must be different from the current one." };
  /* v1.43: an admin token is the key to student data, so the same
     rules that guard student passwords guard admin passwords too:
     no common passwords, no repeated characters, nothing that
     contains the username. */
  const weak = weakPasswordReason_(newPassword, actor);
  if (weak) return { success: false, error: weak };

  return withLock_(() => {
    const sheet = getAdminsSheet_();
    const found = findAdminRow_(sheet, actor);
    if (!found) return { success: false, error: "Admin account not found." };
    const verify = verifyPassword_(currentPassword, found.row[1]);
    if (!verify.ok) return { success: false, error: "Current password is incorrect." };

    /* Keep a linked user account linked: they share a password by design. */
    const userSheet = getUsersSheet_();
    const userFound = findUserRow_(userSheet, actor);
    const wasLinked = !!userFound && userLinkedToAdmin_(userFound.row[1], found.row[1]);

    const newHash = makeStoredHash_(newPassword);
    sheet.getRange(found.rowIndex, 2).setValue(newHash);
    _invalidateSheet_(ADMINS_SHEET);
    if (wasLinked) {
      userSheet.getRange(userFound.rowIndex, 2).setValue(newHash);
      _invalidateSheet_(USERS_SHEET);
    }
    setAdminMustChange_(actor, false);
    logAction_(actor, "Change Admin Password", actor, "");
    return { success: true, message: "Password changed." };
  });
}

function adminCreateAdmin(p) {
  const chk = checkAdminCan_(p, "admins_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  if (chk.role !== ADMIN_ROLE_OWNER) return { success: false, error: "Only the main admin can create admin accounts." };
  const actor = chk.actor;

  const username = String(p.username || "").trim();
  const password = String(p.password == null ? "" : p.password);
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return { success: false, error: "Username must be 3-30 characters: letters, numbers, dots, dashes, underscores only." };
  if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH) return { success: false, error: "Password must be at least " + MIN_ADMIN_PASSWORD_LENGTH + " characters." };
  if (password.length > MAX_PASSWORD_LEN) return { success: false, error: "Password is too long." };
  /* v1.43: same weak-password rules as adminChangePassword. */
  const weak = weakPasswordReason_(password, username);
  if (weak) return { success: false, error: weak };

  return withLock_(() => {
    const sheet = getAdminsSheet_();
    if (findAdminRow_(sheet, username)) return { success: false, error: "That admin username already exists." };

    /* If a user account with this username exists AND the supplied password is
       that user's own password, reuse the user's hash so the two rows are
       linked (one person, two roles). Otherwise the admin gets its own hash
       and stays unlinked from any same-named user. */
    let hash = null;
    const usersSheet = getUsersSheet_();
    const uFound = findUserRow_(usersSheet, username);
    if (uFound) {
      const uv = verifyPassword_(password, uFound.row[1]);
      if (uv.ok) {
        hash = uv.upgradedHash || uFound.row[1];
        if (uv.upgradedHash) {
          usersSheet.getRange(uFound.rowIndex, 2).setValue(hash);
          _invalidateSheet_(USERS_SHEET);
        }
      }
    }
    if (!hash) {
      hash = makeStoredHash_(password);
    }

    sheet.appendRow([username, hash, new Date().toISOString(), actor, "", "", ADMIN_ROLE_ADMIN]);
    _invalidateSheet_(ADMINS_SHEET);

    if (p.permissions) applyAdminPermissions_(username, p.permissions, actor);
    logAction_(actor, "Create Admin", username, "");
    return { success: true, message: "Admin account created." };
  });
}

function adminDeleteAdmin(p) {
  const chk = checkAdminCan_(p, "admins_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  if (chk.role !== ADMIN_ROLE_OWNER) return { success: false, error: "Only the main admin can delete admin accounts." };
  const actor = chk.actor;

  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };
  if (username.toLowerCase() === actor.toLowerCase()) return { success: false, error: "You can't delete the admin account you're currently logged in as." };

  return withLock_(() => {
    const sheet = getAdminsSheet_();
    if (sheet.getLastRow() - 1 <= 1) return { success: false, error: "Can't delete the last remaining admin account." };
    const found = findAdminRow_(sheet, username);
    if (!found) return { success: false, error: "Admin not found." };
    const targetRec = getAdminRecord_(username);
    if (targetRec && targetRec.role === ADMIN_ROLE_OWNER) return { success: false, error: "The main admin account cannot be deleted." };
    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(ADMINS_SHEET);
    purgeAdminPermissions_(username);
    setAdminMustChange_(username, false);
    logAction_(actor, "Delete Admin", username, "");
    return { success: true, message: "Admin account deleted." };
  });
}

function adminListAdmins(p) {
  const actor = checkAdmin_(p);
  if (!actor) return { success: false, error: "Admin auth failed." };
  const myRec = getAdminRecord_(actor);
  const isOwner = myRec && myRec.role === ADMIN_ROLE_OWNER;

  const data = _cachedSheetData_(ADMINS_SHEET, getAdminsSheet_).data;
  const admins = [];
  for (let i = 1; i < data.length; i++) {
    const uname = String(data[i][0] || "");
    const role = String(data[i][6] || "").trim().toLowerCase() || ADMIN_ROLE_ADMIN;
    if (!isOwner && uname.toLowerCase() !== actor.toLowerCase()) continue;
    admins.push({
      username: uname,
      createdAt: data[i][2],
      createdBy: data[i][3],
      role,
      permissions: role === ADMIN_ROLE_OWNER ? Object.keys(FEATURES) : [...getAdminPermissions_(uname)]
    });
  }
  return { success: true, admins, allFeatures: Object.keys(FEATURES), features: FEATURES, isOwner };
}

function adminListAdminPermissions(p) {
  const chk = checkAdminCan_(p, "admins_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  if (chk.role !== ADMIN_ROLE_OWNER) return { success: false, error: "Only the main admin can view permissions." };

  const target = String(p.username || "").trim();
  if (!target) return { success: false, error: "username required." };
  const rec = getAdminRecord_(target);
  if (!rec) return { success: false, error: "Admin not found." };

  const granted = getAdminPermissions_(target);
  const features = {};
  Object.keys(FEATURES).forEach(k => { features[k] = granted.has(k); });
  return { success: true, username: target, role: rec.role, features, allFeatures: Object.keys(FEATURES), featureLabels: FEATURES };
}

function adminSetAdminPermissions(p) {
  const chk = checkAdminCan_(p, "admins_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  if (chk.role !== ADMIN_ROLE_OWNER) return { success: false, error: "Only the main admin can change permissions." };
  const actor = chk.actor;

  const target = String(p.username || "").trim();
  if (!target) return { success: false, error: "username required." };
  const rec = getAdminRecord_(target);
  if (!rec) return { success: false, error: "Admin not found." };
  if (rec.role === ADMIN_ROLE_OWNER) return { success: false, error: "The owner's permissions cannot be changed." };

  let features;
  try { features = (typeof p.features === "object" && p.features) ? p.features : JSON.parse(p.features || "{}"); }
  catch (e) { return { success: false, error: "features must be a JSON object." }; }

  return withLock_(() => {
    applyAdminPermissions_(target, features, actor);
    logAction_(actor, "Set Admin Permissions", target,
      "Granted: " + Object.keys(features).filter(k => features[k]).join(", "));
    return { success: true, username: target };
  });
}

function adminPromoteOwner(p) {
  const chk = checkAdminCan_(p, "admins_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  if (chk.role !== ADMIN_ROLE_OWNER) return { success: false, error: "Only the main admin can promote admins." };
  const actor = chk.actor;
  const target = String(p.username || "").trim();
  if (!target) return { success: false, error: "username required." };

  return withLock_(() => {
    const sheet = getAdminsSheet_();
    const found = findAdminRow_(sheet, target);
    if (!found) return { success: false, error: "Admin not found." };
    sheet.getRange(found.rowIndex, 7).setValue(ADMIN_ROLE_OWNER);
    _invalidateSheet_(ADMINS_SHEET);
    logAction_(actor, "Promote to Owner", target, "");
    return { success: true, username: target };
  });
}

function adminPromoteUserToAdmin(p) {
  const chk = checkAdminCan_(p, "admins_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  if (chk.role !== ADMIN_ROLE_OWNER) {
    return { success: false, error: "Only the main admin can promote users to admin." };
  }
  const actor = chk.actor;

  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  return withLock_(() => {
    const usersSheet = getUsersSheet_();
    const userFound = findUserRow_(usersSheet, username);
    if (!userFound) return { success: false, error: "User not found." };

    if (String(userFound.row[18] == null ? "" : userFound.row[18]).toLowerCase() === "false") {
      return { success: false, error: "This user hasn't verified their email yet. Ask them to verify it (or sign in with Google) first." };
    }

    const adminSheet = getAdminsSheet_();
    if (findAdminRow_(adminSheet, username)) {
      return { success: false, error: "This user is already an admin." };
    }

    const userHash = userFound.row[1];

    adminSheet.appendRow([
      String(userFound.row[0]),
      userHash,
      new Date().toISOString(),
      actor,
      "", "",
      ADMIN_ROLE_ADMIN
    ]);
    _invalidateSheet_(ADMINS_SHEET);

    if (p.permissions) applyAdminPermissions_(username, p.permissions, actor);
    logAction_(actor, "Promote User to Admin", username, "");
    return { success: true, message: "User promoted to admin.", username };
  });
}

function applyAdminPermissions_(username, features, actor) {
  let parsed = features;
  if (typeof features === "string") {
    try { parsed = JSON.parse(features); } catch (e) { return; }
  }
  if (!parsed || typeof parsed !== "object") return;

  const sheet = getAdminPermsSheet_();
  const data = sheet.getDataRange().getValues();
  const targetLc = String(username).toLowerCase().trim();

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).toLowerCase().trim() === targetLc) sheet.deleteRow(i + 1);
  }
  _invalidateSheet_(ADMIN_PERMS_SHEET);

  const rows = [];
  const now = new Date().toISOString();
  Object.keys(FEATURES).forEach(key => {
    if (parsed[key] === true) rows.push([username, key, true, now, actor]);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ADMIN_PERM_HEADERS.length).setValues(rows);
}

function purgeAdminPermissions_(username) {
  const sheet = getAdminPermsSheet_();
  const data = sheet.getDataRange().getValues();
  const targetLc = String(username).toLowerCase().trim();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).toLowerCase().trim() === targetLc) sheet.deleteRow(i + 1);
  }
  _invalidateSheet_(ADMIN_PERM_SHEET);
}

/* ═══════════════════════════════════════════════════════════════════════
   USER AUTH — LOGIN / SIGNUP / SESSION
   ═══════════════════════════════════════════════════════════════════════ */

/* An email address or a Nepali mobile number can be used to sign in.
   Unknown values fall through and fail with the same "Invalid username or
   password" message as before, so nothing new is revealed. */
function resolveLoginIdentifier_(id) {
  const s = String(id || "").trim();
  if (!s || s.length > MAX_EMAIL_LEN) return s;
  try {
    const sheet = getUsersSheet_();
    if (s.indexOf("@") > 0) {
      const f = findUserByField_(sheet, 3, s);
      if (f) return String(f.row[0]);
    } else if (/^(98|97|96|99)\d{8}$/.test(s)) {
      const f = findUserByField_(sheet, 4, s);
      if (f) return String(f.row[0]);
    }
  } catch (e) { /* fall back to the value as typed */ }
  return s;
}

function handleLogin(p) {
  let username = String(p.username || "").trim();
  const password = String(p.password == null ? "" : p.password);
  if (!username || !password) return { success: false, error: "Enter username and password." };
  username = resolveLoginIdentifier_(username);
  if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
    return { success: false, error: "Invalid username or password." };
  }

  const adminSheet = getAdminsSheet_();
  const adminFound = findAdminRow_(adminSheet, username);
  if (adminFound) {
    const lock = checkLoginRateLimit_('admin', username);
    if (lock.locked) return { success: false, error: `Too many failed attempts. Try again in ${lock.minutesLeft} minute(s).` };

    const verify = verifyPassword_(password, adminFound.row[1]);
    if (!verify.ok) {
      recordLoginFailure_('admin', username);
      return { success: false, error: "Invalid username or password." };
    }
    clearLoginLock_('admin', username);
    let adminHashNow = adminFound.row[1];
    if (verify.upgradedHash) {
      adminSheet.getRange(adminFound.rowIndex, 2).setValue(verify.upgradedHash);
      adminHashNow = verify.upgradedHash;
      _invalidateSheet_(ADMINS_SHEET);
      syncLinkedHash_(username, adminFound.row[1], verify.upgradedHash, "admin");
    }
    if (password === LEGACY_DEFAULT_ADMIN_PASSWORD) setAdminMustChange_(adminFound.row[0], true);

    const adminToken = issueAdminToken_(adminSheet, adminFound.rowIndex);

    let userSide = null;
    try {
      const userSheet = getUsersSheet_();
      const userFound = findUserRow_(userSheet, username);
      if (userFound) {
        const uv = verifyPassword_(password, userFound.row[1]);
        if (uv.ok) {
          /* The same password was just proven for BOTH roles, so this is the
             same human: link the two rows by making the stored hashes
             identical. adminSwitchFromUser relies on this link. */
          if (!safeEqual_(userFound.row[1], adminHashNow)) {
            userSheet.getRange(userFound.rowIndex, 2).setValue(adminHashNow);
            userFound.row[1] = adminHashNow;
            _invalidateSheet_(USERS_SHEET);
          }
          const built = buildLoginResult_(userSheet, userFound);
          if (built && built.success) {
            userSide = { user: built.user, token: built.token, access: built };
          }
        }
      }
    } catch (e) { console.error("handleLogin: dual-role lookup failed:", e); }

    return {
      success: true,
      isAdmin: true,
      adminToken,
      adminCapable: true,
      mustChangePassword: adminMustChangePassword_(adminFound.row[0]),
      user: userSide ? userSide.user : undefined,
      token: userSide ? userSide.token : undefined,
      permanentAccess: userSide ? userSide.access.permanentAccess : undefined,
      accessType: userSide ? userSide.access.accessType : undefined,
      accessExpiresAt: userSide ? userSide.access.accessExpiresAt : undefined,
      isTrial: userSide ? userSide.access.isTrial : undefined,
      needsPayment: userSide ? userSide.access.needsPayment : undefined,
      settings: userSide ? userSide.access.settings : undefined,
      message: userSide ? "Welcome back — opening your dashboard." : "Welcome to Admin World"
    };
  }

  const userSheet = getUsersSheet_();
  const found = findUserRow_(userSheet, username);
  if (!found) {
    /* Unknown names lock after the same number of failures as real
       accounts (same message), so an attacker cannot tell which usernames
       exist by seeing who locks. State lives in the evicting cache, never
       in Script Properties, so it stays bounded. */
    const ghost = ghostLoginCheck_(username);
    if (ghost.locked) return { success: false, error: `Too many failed attempts. Try again in ${ghost.minutesLeft} minute(s).` };
    if (!checkRateLimit_("login_unknown", UNKNOWN_LOGIN_LIMIT_PER_MINUTE, 60000, "Unknown-user Login Flood")) {
      return { success: false, error: "Too many login attempts. Please try again in a minute." };
    }
    ghostLoginFail_(username);
    return { success: false, error: "Invalid username or password." };
  }
  const lock = checkLoginRateLimit_('user', username);
  if (lock.locked) return { success: false, error: `Too many failed attempts. Try again in ${lock.minutesLeft} minute(s).` };

  const verify = verifyPassword_(password, found.row[1]);
  if (!verify.ok) {
    recordLoginFailure_('user', username);
    return { success: false, error: "Invalid username or password." };
  }
  clearLoginLock_('user', username);
  if (verify.upgradedHash) {
    userSheet.getRange(found.rowIndex, 2).setValue(verify.upgradedHash);
    _invalidateSheet_(USERS_SHEET);
    syncLinkedHash_(username, found.row[1], verify.upgradedHash, "user");
  }

  const result = buildLoginResult_(userSheet, found);
  if (result.success) result.adminCapable = false;
  return result;
}

function buildLoginResult_(sheet, found) {
  const row = found.row;
  if (String(row[7]) === "rejected") return { success: false, error: "Account rejected. Contact admin." };

  const sessionToken = issueUserToken_(sheet, found.rowIndex);

  let status = row[7];
  const trialExpiresAt = row[11] ? new Date(row[11]) : null;
  const now = new Date();

  if (status === "trial" && trialExpiresAt && now > trialExpiresAt) {
    status = "expired";
    sheet.getRange(found.rowIndex, 8).setValue("expired");
    _invalidateSheet_(USERS_SHEET);
  }

  const user = rowToUser_(row);
  user.status = status;
  status = checkYearlyExpiry_(sheet, found, user, status);
  user.status = status;

  if (user.permanentAccess || status === "active") {
    return {
      success: true, user, token: sessionToken,
      permanentAccess: true,
      accessType: user.accessType || "permanent",
      accessExpiresAt: user.accessExpiresAt || "",
      message: user.accessType === "yearly" ? "Welcome back! Yearly access active." : "Welcome back! Permanent access active."
    };
  }
  if (status === "trial") {
    const hoursLeft = Math.max(0, Math.ceil((trialExpiresAt - now) / (1000 * 60 * 60)));
    return { success: true, user, token: sessionToken, isTrial: true, hoursLeft,
             trialExpiresAt: user.trialExpiresAt,
             message: "You got 1-day free trial. Pay to get long-term access." };
  }
  if (status === "expired" || status === "payment_pending") {
    const settings = getSettings();
    return { success: true, user, token: sessionToken, needsPayment: true,
             settings: settings.success ? settings.settings : {},
             message: "Your trial has expired. Please complete payment to continue." };
  }
  return { success: true, user, token: sessionToken };
}

function checkYearlyExpiry_(sheet, found, user, status) {
  if (user.accessType === "yearly" && user.accessExpiresAt) {
    const expiresAt = new Date(user.accessExpiresAt);
    if (!isNaN(expiresAt) && new Date() > expiresAt) {
      sheet.getRange(found.rowIndex, 8, 1, 1).setValue("expired");
      sheet.getRange(found.rowIndex, 14, 1, 3).setValues([["false", "", ""]]);
      _invalidateSheet_(USERS_SHEET);
      user.permanentAccess = false;
      user.accessType = "";
      user.accessExpiresAt = "";
      return "expired";
    }
  }
  return status;
}

function isUsernameReserved_(username) {
  const u = String(username || "").toLowerCase().trim();
  if (RESERVED_USERNAMES.indexOf(u) !== -1) return true;
  return !!findAdminRow_(getAdminsSheet_(), username);
}

function handleGoogleLogin(p) {
  const idToken = String(p.idToken || "").trim();
  if (!idToken) return { success: false, error: "Missing Google ID token." };
  if (idToken.length > 4096) return { success: false, error: "Invalid Google ID token." };
  if (!checkRateLimit_("googlelogin", 30, 60000, "GoogleLogin Rate Limited")) {
    return { success: false, error: "Too many sign-in attempts, please try again in a minute." };
  }

  let payload;
  try {
    const resp = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return { success: false, error: "Google sign-in could not be verified. Please try again." };
    payload = JSON.parse(resp.getContentText());
  } catch (err) {
    return { success: false, error: "Google sign-in verification failed: " + (err.message || err) };
  }

  if (!payload.aud || payload.aud !== GOOGLE_CLIENT_ID) return { success: false, error: "This Google sign-in was not issued for this app." };
  if (payload.iss && payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    return { success: false, error: "Google sign-in issuer is not valid." };
  }
  if (payload.email_verified !== "true" && payload.email_verified !== true) return { success: false, error: "Your Google email is not verified." };
  const email = String(payload.email || "").trim().toLowerCase();
  if (!email) return { success: false, error: "Google did not return an email address." };
  if (email.length > MAX_EMAIL_LEN) return { success: false, error: "Email address is too long." };
  const name = sanitizeSheetField_(String(payload.name || email.split("@")[0]).slice(0, MAX_NAME_LEN));

  return withLock_(() => {
    const sheet = getUsersSheet_();
    let found = findUserByField_(sheet, 3, email);

    if (!found) {
      let base = email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24) || "user";
      let candidate = base;
      let n = 1;
      while (findUserRow_(sheet, candidate) || isUsernameReserved_(candidate)) { candidate = base + n; n++; }

      const now = new Date();
      const trialHours = Number(getSettingValue_("trialHours", TRIAL_HOURS)) || TRIAL_HOURS;
      const trialExpiresAt = new Date(now.getTime() + trialHours * 60 * 60 * 1000);
      const lockoutProof = Utilities.getUuid() + Utilities.getUuid();

      sheet.appendRow([
        candidate,
        makeStoredHash_(lockoutProof),
        name,
        sanitizeSheetField_(email),
        "",
        sanitizeSheetField_(email),
        "email",
        "trial",
        now.toISOString(), now.toISOString(),
        "user",
        trialExpiresAt.toISOString(),
        "none",
        "false",
        "", "", "", "",
        "true"
      ]);
      _invalidateSheet_(USERS_SHEET);
      const newRowIndex = sheet.getLastRow();
      found = { rowIndex: newRowIndex, row: sheet.getRange(newRowIndex, 1, 1, USER_HEADERS.length).getValues()[0] };
      logAction_("system", "Google Signup", candidate, "email=" + email);
    } else if (String(found.row[18] == null ? "" : found.row[18]).toLowerCase() === "false") {
      /* Pre-registration hijack defence: this email was claimed through the
         password signup form but never verified, and Google has now proven
         who really owns it. Revoke the password and every session so
         whoever registered it first is locked out. */
      const lockoutProof = Utilities.getUuid() + Utilities.getUuid();
      const newHash = makeStoredHash_(lockoutProof);
      sheet.getRange(found.rowIndex, 2).setValue(newHash);
      sheet.getRange(found.rowIndex, 17, 1, 2).setValues([["", ""]]);
      sheet.getRange(found.rowIndex, 19).setValue("true");
      found.row[1] = newHash; found.row[16] = ""; found.row[17] = ""; found.row[18] = "true";
      _invalidateSheet_(USERS_SHEET);
      clearLoginLock_("user", found.row[0]);
      logAction_("system", "Unverified Email Claimed via Google", String(found.row[0]),
        "Password + sessions revoked; owner of the email proved via Google");
    }

    const result = buildLoginResult_(sheet, found);
    if (result.success) result.adminCapable = userIsAlsoAdmin_(result.user.username, found.row[1]);
    return result;
  });
}

function handleSignup(p) {
  if (!checkSignupRateLimit_()) return { success: false, error: "Too many signups right now, please try again in a minute." };

  const username = String(p.username || "").trim();
  const password = String(p.password == null ? "" : p.password);
  const nameRaw = String(p.name || "").trim();
  const emailRaw = String(p.email || "").trim();
  const mobile = String(p.mobile || "").trim();

  if (!username || !password || !nameRaw || !emailRaw || !mobile) return { success: false, error: "All fields required." };
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return { success: false, error: "Username must be 3-30 characters: letters, numbers, dots, dashes, underscores only." };
  const weakSignup = weakPasswordReason_(password, username);
  if (weakSignup) return { success: false, error: weakSignup };
  if (password.length > MAX_PASSWORD_LEN) return { success: false, error: "Password is too long." };
  if (nameRaw.length > MAX_NAME_LEN) return { success: false, error: "Name is too long." };
  if (emailRaw.length > MAX_EMAIL_LEN) return { success: false, error: "Email address is too long." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) return { success: false, error: "Invalid email address." };
  if (!/^(98|97|96|99)\d{8}$/.test(mobile)) return { success: false, error: "Invalid Nepali mobile number. Use 10 digits starting with 98/97/96/99." };

  const name = sanitizeSheetField_(nameRaw);
  const email = sanitizeSheetField_(emailRaw);
  const contact = sanitizeSheetField_(emailRaw || mobile);
  const contactType = emailRaw ? "email" : (mobile ? "phone" : "other");

  let verifyTarget = null;
  const result = withLock_(() => {
    const sheet = getUsersSheet_();
    if (isUsernameReserved_(username)) return { success: false, error: "Username already taken." };
    if (findUserRow_(sheet, username)) return { success: false, error: "Username already taken." };
    if (findUserByField_(sheet, 3, email)) return { success: false, error: "An account with this email already exists. Please log in instead." };
    if (findUserByField_(sheet, 4, mobile)) return { success: false, error: "An account with this mobile number already exists. Please log in instead." };

    const now = new Date();
    const trialHours = Number(getSettingValue_("trialHours", TRIAL_HOURS)) || TRIAL_HOURS;
    const trialExpiresAt = new Date(now.getTime() + trialHours * 60 * 60 * 1000);

    sheet.appendRow([
      username,
      makeStoredHash_(password),
      name, email, mobile, contact, contactType,
      "trial", now.toISOString(), now.toISOString(),
      "user", trialExpiresAt.toISOString(),
      "none", "false",
      "", "", "", "",
      "false"
    ]);
    _invalidateSheet_(USERS_SHEET);
    const newRowIndex = sheet.getLastRow();
    const sessionToken = issueUserToken_(sheet, newRowIndex);
    verifyTarget = { username, email: emailRaw, name: nameRaw };

    return {
      success: true, isTrial: true, token: sessionToken,
      trialExpiresAt: trialExpiresAt.toISOString(),
      emailVerified: false,
      message: "Account created! You got 1-day free trial. Pay to get long-term access."
    };
  });

  /* Send the verification mail outside the lock (MailApp is slow). */
  if (result.success && verifyTarget) {
    result.verificationEmailSent = sendVerificationEmail_(verifyTarget.username, verifyTarget.email, verifyTarget.name);
  }
  return result;
}

/* ── Email verification (stateless signed link — nothing stored per signup) ── */

const EMAIL_VERIFY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function _emailVerifySig_(username, email, expiresAt) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(username).toLowerCase() + "|" + String(email).toLowerCase() + "|" + expiresAt,
    getSecret_("EMAIL_VERIFY_SECRET")
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function sendVerificationEmail_(username, email, name) {
  try {
    const to = String(email || "").replace(/^'/, "").trim();
    if (!to) return false;
    if (MailApp.getRemainingDailyQuota() < 5) return false;
    const base = ScriptApp.getService().getUrl();
    if (!base) return false;
    const expiresAt = Date.now() + EMAIL_VERIFY_TTL_MS;
    const code = username + "~" + expiresAt + "~" + _emailVerifySig_(username, to, expiresAt);
    const link = base + "?action=verifyemail&code=" + encodeURIComponent(code);
    MailApp.sendEmail({
      to,
      subject: "Verify your email for Abhyas",
      body: `Hi ${name || username},\n\nPlease confirm your email address for your Abhyas account (${username}) by opening this link:\n\n${link}\n\nThe link is valid for 3 days. If you didn't create this account, you can ignore this email.\n`
    });
    return true;
  } catch (err) {
    console.error("sendVerificationEmail_ failed:", err);
    return false;
  }
}

function _verifyPage_(title, message) {
  const safe = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + safe(title) + '</title></head>' +
    '<body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 20px;color:#222">' +
    '<h2>' + safe(title) + '</h2><p>' + safe(message) + '</p></body></html>'
  ).setTitle(title);
}

function handleVerifyEmail_(p) {
  const code = String(p.code || "").trim();
  const parts = code.split("~");
  if (parts.length !== 3) return _verifyPage_("Link not valid", "This verification link is not valid.");
  const username = parts[0];
  const expiresAt = Number(parts[1]);
  const sig = parts[2];
  if (!username || username.length > MAX_USERNAME_LEN || !expiresAt || Date.now() > expiresAt) {
    return _verifyPage_("Link expired", "This verification link has expired. Open the app and request a new one.");
  }
  if (!checkRateLimit_("verifyemail", 60, 60000)) return _verifyPage_("Try again", "Too many attempts. Please try again in a minute.");

  return withLockHtml_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, username);
    if (!found) return _verifyPage_("Link not valid", "This verification link is not valid.");
    const currentEmail = String(found.row[3] || "").replace(/^'/, "");
    if (!safeEqual_(sig, _emailVerifySig_(found.row[0], currentEmail, expiresAt))) {
      return _verifyPage_("Link not valid", "This verification link is not valid.");
    }
    sheet.getRange(found.rowIndex, 19).setValue("true");
    _invalidateSheet_(USERS_SHEET);
    return _verifyPage_("Email verified ✅", "Thanks! Your email is verified. You can return to the Abhyas app.");
  });
}

function withLockHtml_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); }
  catch (e) { return _verifyPage_("Busy", "The server is busy. Please open the link again in a moment."); }
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function resendVerificationEmail(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const row = auth.found.row;
  const ev = String(row[18] == null ? "" : row[18]).toLowerCase();
  if (ev === "true") return { success: true, alreadyVerified: true, message: "Your email is already verified." };
  if (!checkRateLimit_("resendverify_" + auth.username.toLowerCase(), 3, 60 * 60 * 1000)) {
    return { success: false, error: "Too many requests — please wait a while before asking again." };
  }
  const sent = sendVerificationEmail_(auth.username, row[3], row[2]);
  return sent ? { success: true, message: "Verification email sent." }
              : { success: false, error: "Could not send the email right now. Please try again later." };
}

function checkSession(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;
  const found = auth.found;
  const sheet = getUsersSheet_();

  const row = found.row;
  if (String(row[7]) === "rejected") return { success: false, error: "Account rejected. Contact admin." };

  const adminCapable = userIsAlsoAdmin_(username, row[1]);

  let status = row[7];
  const trialExpiresAt = row[11] ? new Date(row[11]) : null;
  const now = new Date();

  if (status === "trial" && trialExpiresAt && now > trialExpiresAt) {
    status = "expired";
    sheet.getRange(found.rowIndex, 8).setValue("expired");
    _invalidateSheet_(USERS_SHEET);
  }

  const user = rowToUser_(row);
  user.status = status;
  status = checkYearlyExpiry_(sheet, found, user, status);
  user.status = status;

  if (user.permanentAccess || status === "active") {
    return { success: true, user, token: p.token, permanentAccess: true,
             accessType: user.accessType || "permanent",
             accessExpiresAt: user.accessExpiresAt || "", adminCapable };
  }
  if (status === "trial") {
    const hoursLeft = Math.max(0, Math.ceil((trialExpiresAt - now) / (1000 * 60 * 60)));
    return { success: true, user, token: p.token, isTrial: true, hoursLeft, adminCapable };
  }
  if (status === "expired" || status === "payment_pending") {
    const settings = getSettings();
    return { success: true, user, token: p.token, needsPayment: true,
             settings: settings.success ? settings.settings : {}, adminCapable };
  }
  return { success: true, user, token: p.token, adminCapable };
}

function updateOwnMobile(p) {
  const mobile = String(p.mobile || "").trim();
  if (!/^(98|97|96|99)\d{8}$/.test(mobile)) return { success: false, error: "Invalid Nepali mobile number." };
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, auth.username);
    if (!found) return { success: false, error: "Account not found." };
    if (!verifyUserToken_(found, p.token)) return { success: false, error: "Session expired.", sessionInvalid: true };
    const other = findUserByField_(sheet, 4, mobile);
    if (other && String(other.row[0]).toLowerCase() !== String(found.row[0]).toLowerCase()) {
      return { success: false, error: "An account with this mobile number already exists." };
    }
    sheet.getRange(found.rowIndex, 5).setValue(mobile);
    _invalidateSheet_(USERS_SHEET);
    return { success: true, message: "Mobile number saved." };
  });
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

function requestPasswordReset(p) {
  const identifier = String(p.identifier || p.username || p.email || "").trim();
  if (!identifier) return { success: false, error: "Enter your username or email." };
  const generic = { success: true, message: "If that account exists, a reset link has been sent to its email address." };
  if (identifier.length > MAX_EMAIL_LEN) return generic;
  if (!checkRateLimit_("pwreset_global", 40, 60 * 60 * 1000, "PasswordReset Rate Limited")) return generic;
  try { if (MailApp.getRemainingDailyQuota() < 5) return generic; } catch (e) {}

  const sheet = getUsersSheet_();
  let found = findUserRow_(sheet, identifier);
  if (!found) found = findUserByField_(sheet, 3, identifier);
  if (!found) return generic;

  const username = found.row[0];
  const email = String(found.row[3] || "").replace(/^'/, "");
  if (!email) return generic;

  const props = PropertiesService.getScriptProperties();
  const cdKey = "pwreset_cd_" + String(username).toLowerCase();
  const last = Number(props.getProperty(cdKey) || 0);
  if (Date.now() - last < RESET_REQUEST_COOLDOWN_MS) return generic;

  const token = Utilities.getUuid();
  props.setProperty("pwreset_" + token, JSON.stringify({ username, expiresAt: Date.now() + RESET_TOKEN_TTL_MS }));
  props.setProperty(cdKey, String(Date.now()));

  try {
    MailApp.sendEmail({
      to: email,
      subject: "Reset your Abhyas password",
      body: `Hi ${found.row[2] || username},\n\nSomeone (hopefully you) requested a password reset for your Abhyas account (${username}).\n\nOpen this link on your phone to choose a new password:\n\n${getSettingValue_("appUrl", "https://app.mku.name.np/")}#resetToken=${token}\n\nOr paste this code into the app: ${token}\n\nThis code expires in 1 hour. If you didn't request this, you can safely ignore this email.\n`
    });
  } catch (err) { console.error("requestPasswordReset: MailApp send failed:", err); }
  return generic;
}

function resetPassword(p) {
  const token = String(p.token || "").trim();
  const newPassword = String(p.newPassword == null ? "" : p.newPassword);
  if (!token) return { success: false, error: "Reset code required." };
  if (token.length > 100) return { success: false, error: "This reset code is invalid or has already been used." };
  if (!newPassword) return { success: false, error: "New password required." };
  const weakReset = weakPasswordReason_(newPassword, "");
  if (weakReset) return { success: false, error: weakReset };
  if (newPassword.length > MAX_PASSWORD_LEN) return { success: false, error: "New password is too long." };
  if (!checkRateLimit_("resetpassword", 60, 60000)) return { success: false, error: "Too many attempts, please try again in a minute." };

  const props = PropertiesService.getScriptProperties();
  const key = "pwreset_" + token;
  const raw = props.getProperty(key);
  if (!raw) return { success: false, error: "This reset code is invalid or has already been used." };

  let state;
  try { state = JSON.parse(raw); } catch (e) { props.deleteProperty(key); return { success: false, error: "Invalid reset code." }; }
  props.deleteProperty(key);
  if (!state.expiresAt || Date.now() > state.expiresAt) return { success: false, error: "This reset code has expired — request a new one." };

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, state.username);
    if (!found) return { success: false, error: "Account not found." };
    sheet.getRange(found.rowIndex, 2).setValue(makeStoredHash_(newPassword));
    sheet.getRange(found.rowIndex, 17, 1, 2).setValues([["", ""]]);
    sheet.getRange(found.rowIndex, 19).setValue("true");
    _invalidateSheet_(USERS_SHEET);
    clearLoginLock_("user", state.username);
    logAction_("system", "Password Reset", state.username, "Self-service reset via emailed code");
    return { success: true, username: state.username, message: "Password reset — please log in with your new password." };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   DUAL-ROLE SWITCH
   ═══════════════════════════════════════════════════════════════════════ */

function checkAdminCapable(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  return { success: true, adminCapable: userIsAlsoAdmin_(auth.username, auth.found.row[1]) };
}

function adminSwitchFromUser(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;

  if (!checkRateLimit_("adminswitch_" + username.toLowerCase(), 10, 60000)) {
    return { success: false, error: "Too many switches — try again in a minute." };
  }

  /* The switch only works when the user row and admin row are LINKED (same
     stored hash → the same password was proven for both). */
  const adminFound = findAdminRow_(getAdminsSheet_(), username);
  if (!adminFound || !userLinkedToAdmin_(auth.found.row[1], adminFound.row[1])) {
    return { success: false, error: "This account does not have admin access." };
  }

  return withLock_(() => {
    const adminSheet = getAdminsSheet_();
    const adminToken = issueAdminToken_(adminSheet, adminFound.rowIndex);
    _invalidateSheet_(ADMINS_SHEET);
    logAction_(adminFound.row[0], "Switch to Admin (from user session)", username, "");
    return {
      success: true, isAdmin: true, adminToken,
      username: adminFound.row[0],
      mustChangePassword: adminMustChangePassword_(adminFound.row[0]),
      expiresInMs: ADMIN_TOKEN_TTL_MS
    };
  });
}
/* ═══════════════════════════════════════════════════════════════════════
   PROGRESS SYNC
   ═══════════════════════════════════════════════════════════════════════ */

/* Pure: is this string a copy the server may store? Plain JSON, or a
   gzip+base64 copy marked "gz1:". */
function isAcceptableProgressData_(dataStr) {
  const d = String(dataStr || "");
  if (!d) return false;
  if (d.indexOf(PROGRESS_GZ_PREFIX) === 0) return d.length > 24 && /^gz1:[A-Za-z0-9+\/]+={0,2}$/.test(d);
  try { JSON.parse(d); return true; } catch (e) { return false; }
}

/* Pure: should the copy about to be replaced be kept in history? Yes when
   no history exists yet, when the newest history entry is at least 30
   minutes older than it, or when the new copy is much smaller (a shrink is
   exactly when the old copy is worth keeping). */
function shouldArchiveProgress_(prevData, prevAtMs, newData, newestHistoryData, newestHistoryAtMs) {
  const prev = String(prevData || "");
  if (prev.length < 50) return false;
  if (newestHistoryData && String(newestHistoryData) === prev) return false;
  if (!newestHistoryData) return true;
  if ((prevAtMs - (newestHistoryAtMs || 0)) >= PROGRESS_HISTORY_MIN_GAP_MS) return true;
  const sameKind = (prev.indexOf(PROGRESS_GZ_PREFIX) === 0) === (String(newData).indexOf(PROGRESS_GZ_PREFIX) === 0);
  return sameKind && String(newData).length < prev.length * 0.7;
}

function _archivePreviousProgress_(username, prevData, prevAt, newData) {
  try {
    const prevMs = new Date(_isoOf_(prevAt)).getTime() || Date.now();
    const sheet = getProgressHistorySheet_();
    const f = _findRowFast_(sheet, 1, username);
    const slots = f ? [[f.row[1], f.row[2]], [f.row[3], f.row[4]], [f.row[5], f.row[6]]] : [["", ""], ["", ""], ["", ""]];
    const newestMs = slots[0][1] ? (new Date(_isoOf_(slots[0][1])).getTime() || 0) : 0;
    if (!shouldArchiveProgress_(prevData, prevMs, newData, slots[0][0], newestMs)) return;
    const next = [[String(prevData), new Date(prevMs).toISOString()], slots[0], slots[1]];
    const rowVals = [username, next[0][0], next[0][1], next[1][0], next[1][1], next[2][0], next[2][1]];
    if (f) sheet.getRange(f.rowIndex, 1, 1, 7).setValues([rowVals]); else sheet.appendRow(rowVals);
    _invalidateSheet_(PROGRESS_HISTORY_SHEET);
  } catch (e) { /* history is a safety net: it must never stop a save */ }
}

/* Two devices saving progress used to overwrite each other (last write
   wins). A client that sends baseUpdatedAt (the revision it last saw) is
   now told about a conflict, receives the newer copy, merges, and saves
   again. Clients that do not send baseUpdatedAt keep the old behaviour.
   The copy being replaced is first kept in ProgressHistory. */
function _sameRevision_(a, b) {
  return _isoOf_(a).slice(0, 19) === _isoOf_(b).slice(0, 19);
}

function saveProgress(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;

  const dataStr = String(p.data || "");
  if (!dataStr) return { success: false, error: "No data provided." };
  if (dataStr.length > 45000) return { success: false, error: "Progress data too large to sync." };
  if (!isAcceptableProgressData_(dataStr)) return { success: false, error: "Malformed progress data." };
  const checkRevision = Object.prototype.hasOwnProperty.call(p, "baseUpdatedAt");

  return withLock_(() => {
    const sheet = getProgressSheet_();
    const found = findProgressRow_(sheet, username);
    if (found && checkRevision && !_sameRevision_(p.baseUpdatedAt, found.row[2])) {
      return { success: false, conflict: true, data: found.row[1], updatedAt: _isoOf_(found.row[2]) };
    }
    const now = new Date().toISOString();
    if (found) {
      _archivePreviousProgress_(username, found.row[1], found.row[2], dataStr);
      sheet.getRange(found.rowIndex, 2, 1, 2).setValues([[dataStr, now]]);
    } else sheet.appendRow([username, dataStr, now]);
    _invalidateSheet_(PROGRESS_SHEET);
    return { success: true, updatedAt: now };
  });
}

/* Earlier cloud copies. No slot: the list. With slot (1-3): that copy, to
   be ADDED to the device by the client. */
function getProgressHistory(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const f = _findRowFast_(getProgressHistorySheet_(), 1, auth.username);
  if (!f) return { success: true, entries: [] };
  const slot = Number(p.slot);
  if (slot >= 1 && slot <= 3) {
    const data = String(f.row[1 + (slot - 1) * 2] || "");
    if (!data) return { success: false, error: "That copy is not available." };
    return { success: true, data, savedAt: _isoOf_(f.row[2 + (slot - 1) * 2]) };
  }
  const entries = [];
  for (let i = 0; i < 3; i++) {
    const d = String(f.row[1 + i * 2] || "");
    if (d) entries.push({ slot: i + 1, savedAt: _isoOf_(f.row[2 + i * 2]), chars: d.length });
  }
  return { success: true, entries };
}

function getProgress(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;

  const found = findProgressRow_(getProgressSheet_(), auth.username);
  if (!found) return { success: true, data: null };
  return { success: true, data: found.row[1], updatedAt: _isoOf_(found.row[2]) };
}

/* ═══════════════════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════════════ */

function getFcmAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const clientEmail = props.getProperty("FCM_CLIENT_EMAIL");
  const privateKey = props.getProperty("FCM_PRIVATE_KEY");
  if (!clientEmail || !privateKey) throw new Error("Push notifications not configured: missing FCM_CLIENT_EMAIL or FCM_PRIVATE_KEY.");

  const now = Math.floor(Date.now() / 1000);
  const b64url = obj => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, "");
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const claim = b64url({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  });
  const unsigned = header + "." + claim;
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, privateKey)
  ).replace(/=+$/, "");
  const jwt = unsigned + "." + signature;

  const resp = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt },
    muteHttpExceptions: true
  });
  const body = JSON.parse(resp.getContentText());
  if (!body.access_token) throw new Error("Could not get FCM access token: " + (body.error_description || resp.getContentText()));
  return body.access_token;
}

function _fcmBuildRequest_(accessToken, projectId, token, title, body) {
  return {
    url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    payload: JSON.stringify({ message: { token, notification: { title, body }, webpush: { fcm_options: { link: "/" } } } }),
    muteHttpExceptions: true
  };
}

function _fcmParseResponse_(resp) {
  let result = {};
  try { result = JSON.parse(resp.getContentText() || "{}"); } catch (e) {}
  if (resp.getResponseCode() >= 400) {
    const unregistered = result.error && result.error.details &&
      result.error.details.some(d => d.errorCode === "UNREGISTERED");
    return { success: false, unregistered: !!unregistered, error: (result.error && result.error.message) || resp.getContentText() };
  }
  return { success: true };
}

function _fcmSendToToken(accessToken, projectId, token, title, body) {
  const req = _fcmBuildRequest_(accessToken, projectId, token, title, body);
  const resp = UrlFetchApp.fetch(req.url, req);
  return _fcmParseResponse_(resp);
}

function sendPushNotification_(username, title, body) {
  const found = findPushTokenRow_(getPushTokensSheet_(), username);
  if (!found || !found.row[1]) return { success: false, error: "No push token on file." };

  const projectId = PropertiesService.getScriptProperties().getProperty("FCM_PROJECT_ID");
  if (!projectId) return { success: false, error: "Push notifications not configured: missing FCM_PROJECT_ID." };

  let accessToken;
  try { accessToken = getFcmAccessToken_(); } catch (err) { return { success: false, error: err.message }; }

  const result = _fcmSendToToken(accessToken, projectId, found.row[1], title, body);
  if (!result.success) {
    if (result.unregistered) {
      getPushTokensSheet_().deleteRow(found.rowIndex);
      _invalidateSheet_(PUSHTOKENS_SHEET);
    }
    return { success: false, error: result.error };
  }
  return { success: true };
}

/* Sends in parallel batches (fetchAll) with a wall-clock guard so a large
   audience can't run into the 6-minute execution limit. */
function broadcastPushToAll_(title, body) {
  const data = _cachedSheetData_(PUSHTOKENS_SHEET, getPushTokensSheet_).data;
  if (data.length <= 1) return { success: true, sent: 0, failed: 0, complete: true };

  const projectId = PropertiesService.getScriptProperties().getProperty("FCM_PROJECT_ID");
  if (!projectId) return { success: false, error: "Push notifications not configured: missing FCM_PROJECT_ID." };

  let accessToken;
  try { accessToken = getFcmAccessToken_(); } catch (err) { return { success: false, error: err.message }; }

  const queue = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][1]) queue.push({ row: i + 1, token: data[i][1] });
  }

  const BATCH = 50;
  const MAX_MS = 4 * 60 * 1000;
  const started = Date.now();
  let sent = 0, failed = 0, complete = true;
  const deadRows = [];

  for (let s = 0; s < queue.length; s += BATCH) {
    if (Date.now() - started > MAX_MS) { complete = false; break; }
    const slice = queue.slice(s, s + BATCH);
    let responses;
    try {
      responses = UrlFetchApp.fetchAll(slice.map(q => _fcmBuildRequest_(accessToken, projectId, q.token, title, body)));
    } catch (err) {
      failed += slice.length;
      console.error("broadcastPushToAll_ batch failed:", err);
      continue;
    }
    responses.forEach((resp, idx) => {
      const r = _fcmParseResponse_(resp);
      if (r.success) sent++;
      else { failed++; if (r.unregistered) deadRows.push(slice[idx].row); }
    });
  }
  deadRows.sort((a, b) => b - a).forEach(r => getPushTokensSheet_().deleteRow(r));
  if (deadRows.length) _invalidateSheet_(PUSHTOKENS_SHEET);
  return { success: true, sent, failed, complete };
}

function savePushToken(p) {
  const token = String(p.fcmToken || "").trim();
  if (!token) return { success: false, error: "Username and fcmToken required." };
  if (token.length > 4096) return { success: false, error: "fcmToken is too long." };
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;

  return withLock_(() => {
    const sheet = getPushTokensSheet_();
    const found = findPushTokenRow_(sheet, auth.username);
    const now = new Date().toISOString();
    if (found) sheet.getRange(found.rowIndex, 2, 1, 2).setValues([[token, now]]);
    else sheet.appendRow([auth.username, token, now]);
    _invalidateSheet_(PUSHTOKENS_SHEET);
    return { success: true };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   TRIGGER HANDLERS
   ═══════════════════════════════════════════════════════════════════════ */

function checkTrialExpiryWarnings() {
  const data = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  let sent = 0;

  for (let i = 1; i < data.length; i++) {
    const status = data[i][7];
    const username = data[i][0];
    const trialExpiresAt = data[i][11] ? new Date(data[i][11]).getTime() : null;
    const warnKey = "trialwarned_" + String(username).toLowerCase();

    const inWindow = status === "trial" && trialExpiresAt &&
      (trialExpiresAt - now) > 0 && (trialExpiresAt - now) <= TRIAL_WARNING_WINDOW_MS;
    if (!inWindow) {
      if (props.getProperty(warnKey)) props.deleteProperty(warnKey);
      continue;
    }
    if (props.getProperty(warnKey)) continue;
    try {
      const result = sendPushNotification_(username, "Your trial is ending soon",
        "Your Abhyas trial expires in under 2 hours. Complete payment to keep your access.");
      if (result.success) { props.setProperty(warnKey, "1"); sent++; }
    } catch (err) { console.error("checkTrialExpiryWarnings failed for " + username + ":", err); }
  }
  if (sent) console.log("Sent " + sent + " trial-expiry warning(s).");
  return "Checked. Sent " + sent + " warning(s).";
}

function checkWeeklySetUnlocks_() {
  const data = _cachedSheetData_(WEEKLYSETS_SHEET, getWeeklySetsSheet_).data;
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  let notified = 0;

  for (let i = 1; i < data.length; i++) {
    const s = rowToWeeklySet_(data[i]);
    if (s.status !== "active") continue;
    const releaseTime = new Date(s.releaseAt).getTime();
    if (isNaN(releaseTime) || now < releaseTime) continue;

    const notifyKey = "wsnotified_" + s.id;
    if (props.getProperty(notifyKey)) continue;

    try {
      const result = broadcastPushToAll_("New weekly set unlocked! 🎉",
        s.title + (s.chapterLabel ? " — " + s.chapterLabel : "") + " is now available to solve.");
      if (result.success) {
        props.setProperty(notifyKey, "1");
        notified++;
        logAction_("system", "Weekly Set Unlock Notification", s.title,
          `Sent to ${result.sent}, failed ${result.failed}` + (result.complete === false ? " (PARTIAL — time limit reached)" : ""));
      }
    } catch (err) { console.error("checkWeeklySetUnlocks_ failed for " + s.id + ":", err); }
  }
  if (notified) console.log("Sent unlock notifications for " + notified + " weekly set(s).");
  return "Checked. Notified for " + notified + " newly-unlocked set(s).";
}

/* Nightly copy of the whole spreadsheet into the AbhyasBackups Drive folder
   (the last 14 are kept). Installed by setup(); also safe to run by hand. */
function backupSpreadsheet() {
  const folder = getOrCreateFolder_("AbhyasBackups");
  const name = "Abhyas backup " + Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
  if (!folder.getFilesByName(name).hasNext()) {
    DriveApp.getFileById(getSpreadsheet_().getId()).makeCopy(name, folder);
  }
  const list = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); list.push({ f, t: f.getDateCreated().getTime() }); }
  list.sort((a, b) => b.t - a.t);
  list.slice(14).forEach(x => { try { x.f.setTrashed(true); } catch (e) {} });
  return "Backup done: " + name;
}

/* Daily trigger: keeps the Script Properties store small. Never touches
   SHEET_ID, FCM_*, mustchange_*, wsnotified_*, or secrets. */
function cleanupExpiredProperties() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  let removed = 0;
  const del = k => { props.deleteProperty(k); removed++; };

  let trialUsers = null;
  const getTrialUsers = () => {
    if (trialUsers) return trialUsers;
    trialUsers = new Set();
    const data = getUsersSheet_().getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][7] === "trial") trialUsers.add(String(data[i][0]).toLowerCase());
    }
    return trialUsers;
  };

  Object.keys(all).forEach(key => {
    const raw = all[key];
    try {
      if (key.indexOf("ratelimit_") === 0) {
        del(key);
      } else if (key.indexOf("pwreset_cd_") === 0) {
        if (now - Number(raw || 0) > RESET_REQUEST_COOLDOWN_MS) del(key);
      } else if (key.indexOf("pwreset_") === 0) {
        const s = JSON.parse(raw);
        if (!s.expiresAt || now > s.expiresAt) del(key);
      } else if (key.indexOf("loginlock_") === 0) {
        const s = JSON.parse(raw);
        const stale = s.lockUntil ? now > s.lockUntil : (now - Number(s.at || 0) > 24 * 60 * 60 * 1000);
        if (stale) del(key);
      } else if (key.indexOf("trialwarned_") === 0) {
        if (!getTrialUsers().has(key.slice("trialwarned_".length))) del(key);
      }
    } catch (e) {
      if (/^(pwreset_|loginlock_)/.test(key)) del(key);
    }
  });
  console.log("cleanupExpiredProperties: removed " + removed + " stale propert" + (removed === 1 ? "y" : "ies") + ".");
  return "Removed " + removed + ".";
}

/* Nudge users who were active 2-7 days ago but have since gone quiet. */
function nudgeInactiveUsers() {
  const users = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const progress = _cachedSheetData_(PROGRESS_SHEET, getProgressSheet_).data;
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const lastActive = {};
  for (let i = 1; i < progress.length; i++) {
    const u = String(progress[i][0] || "").toLowerCase().trim();
    if (!u) continue;
    const t = new Date(progress[i][2]).getTime();
    if (!isNaN(t) && (!lastActive[u] || t > lastActive[u])) lastActive[u] = t;
  }

  let sent = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 1; i < users.length; i++) {
    const username = String(users[i][0] || "");
    const status = String(users[i][7] || "");
    if (!username) continue;
    if (status !== "trial" && status !== "active") continue;

    const fallback = new Date(users[i][8]).getTime();
    const last = lastActive[username.toLowerCase()] || fallback;
    const daysAgo = (now - last) / DAY;
    if (daysAgo < 2 || daysAgo > 7) continue;

    const sentKey = "nudged_" + username.toLowerCase() + "_" + today;
    if (props.getProperty(sentKey)) continue;

    try {
      const result = sendPushNotification_(username,
        "Your review queue is ready",
        "A few questions are waiting for you. Open Abhyas and take 5 minutes.");
      if (result.success) {
        props.setProperty(sentKey, "1");
        sent++;
      }
    } catch (e) { /* best effort */ }
  }
  console.log("nudgeInactiveUsers: sent " + sent + " nudge(s).");
  return "Sent " + sent + " nudge(s).";
}

/* Weekly admin summary email, Sundays at 08:00 via setup.gs. */
function sendWeeklyAdminSummary() {
  const ss = getSpreadsheet_();
  const owner = (function () {
    const data = getAdminsSheet_().getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][6] || "").toLowerCase() === ADMIN_ROLE_OWNER) return String(data[i][0]);
    }
    return ADMIN_SEED_USERNAME;
  })();

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const userData = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const payData  = _cachedSheetData_(PAYMENTS_SHEET, getPaymentsSheet_).data;

  let newUsers = 0, active = 0, trial = 0;
  for (let i = 1; i < userData.length; i++) {
    const created = new Date(userData[i][8]).getTime();
    if (!isNaN(created) && created >= weekAgo) newUsers++;
    const s = userData[i][7];
    if (s === "active") active++;
    else if (s === "trial") trial++;
  }
  let pendPay = 0, verifiedThisWeek = 0, rejectedThisWeek = 0;
  for (let i = 1; i < payData.length; i++) {
    const s = payData[i][6];
    if (s === "pending") { pendPay++; continue; }
    const reviewed = new Date(payData[i][10]).getTime();
    if (!isNaN(reviewed) && reviewed >= weekAgo) {
      if (s === "verified") verifiedThisWeek++;
      else if (s === "rejected") rejectedThisWeek++;
    }
  }

  const to = getSettingValue_("adminEmail", "");
  if (!to) {
    console.log("Weekly summary: no adminEmail setting configured, skipping send.");
    return "no adminEmail set";
  }
  const lines = [
    "Abhyas weekly summary — " + new Date().toISOString().slice(0, 10),
    "",
    "New signups this week: " + newUsers,
    "Active (paid) students: " + active,
    "On trial: " + trial,
    "",
    "Payments waiting for review: " + pendPay,
    "Payments verified this week: " + verifiedThisWeek,
    "Payments rejected this week: " + rejectedThisWeek,
    "",
    "Admin console: https://app.mku.name.np/admin.html",
    "Sheet: " + ss.getUrl()
  ];
  try {
    MailApp.sendEmail({
      to,
      subject: "Abhyas weekly summary — " + newUsers + " new student" + (newUsers === 1 ? "" : "s"),
      body: lines.join("\n")
    });
    return "sent to " + to;
  } catch (e) {
    console.error("Weekly summary send failed:", e);
    return "send failed: " + e.message;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   WEEKLY SETS
   ═══════════════════════════════════════════════════════════════════════ */

function adminUploadWeeklySetFile(p) {
  const chk = checkAdminCan_(p, "weeklysets_manage");
  if (!chk.ok) return { success: false, error: chk.error };

  const fileData = String(p.fileData || "");
  const filename = String(p.filename || "weeklyset.json").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "weeklyset.json";
  if (!fileData) return { success: false, error: "No file data provided." };
  if (fileData.length > 5 * 1024 * 1024) return { success: false, error: "File too large — question-bank JSON should be well under 4MB." };

  let jsonText;
  try {
    jsonText = fileData.startsWith("data:")
      ? Utilities.newBlob(Utilities.base64Decode(fileData.split(",")[1])).getDataAsString("UTF-8")
      : fileData;
    JSON.parse(jsonText);
  } catch (e) { return { success: false, error: "That file isn't valid JSON — check the format." }; }

  try {
    const safeName = _uploadFilename_(chk.actor, "weeklyset", "json");
    const blob = Utilities.newBlob(jsonText, "application/json", safeName);
    const folder = getOrCreateSystemFolder_("WeeklySets");
    const file = folder.createFile(blob);
    logAction_(chk.actor, "Upload Weekly Set File", filename, "fileId: " + file.getId());
    return { success: true, fileId: file.getId(), filename: file.getName() };
  } catch (e) { return { success: false, error: "Drive upload failed: " + (e.message || e) }; }
}

function adminCreateWeeklySet(p) {
  const chk = checkAdminCan_(p, "weeklysets_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const title = sanitizeSheetField_(String(p.title || "").trim());
  const fileId = String(p.fileId || "").trim();
  const chapterLabel = sanitizeSheetField_(String(p.chapterLabel || "").trim());
  const releaseAtRaw = String(p.releaseAt || "").trim();

  if (!title) return { success: false, error: "Title required." };
  if (!fileId) return { success: false, error: "Drive fileId required." };
  const releaseAt = new Date(releaseAtRaw);
  if (!releaseAtRaw || isNaN(releaseAt)) return { success: false, error: "A valid release date/time is required." };

  return withLock_(() => {
    const sheet = getWeeklySetsSheet_();
    const existing = sheet.getDataRange().getValues();
    let duplicateOf = null;
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][2]).trim() === fileId) { duplicateOf = existing[i][1]; break; }
    }

    const id = Utilities.getUuid();
    const now = new Date().toISOString();
    sheet.appendRow([id, title, fileId, chapterLabel, "active", actor, now, releaseAt.toISOString()]);
    _invalidateSheet_(WEEKLYSETS_SHEET);
    logAction_(actor, "Create Weekly Set", title, "Releases: " + releaseAt.toISOString() + (duplicateOf ? " — WARNING: fileId already used by \"" + duplicateOf + "\"" : ""));
    return {
      success: true, id, title, releaseAt: releaseAt.toISOString(),
      duplicateWarning: duplicateOf ? `This fileId is already used by weekly set "${duplicateOf}" — double check this wasn't a mistake.` : null
    };
  });
}

function adminUpdateWeeklySet(p) {
  const chk = checkAdminCan_(p, "weeklysets_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "id required." };

  return withLock_(() => {
    const sheet = getWeeklySetsSheet_();
    const found = findWeeklySetRow_(sheet, id);
    if (!found) return { success: false, error: "Weekly set not found." };

    const changes = [];
    const updates = [];
    if (p.title !== undefined) { updates.push([2, sanitizeSheetField_(String(p.title).trim())]); changes.push("title"); }
    if (p.fileId !== undefined) { updates.push([3, String(p.fileId).trim()]); changes.push("fileId"); }
    if (p.chapterLabel !== undefined) { updates.push([4, sanitizeSheetField_(String(p.chapterLabel).trim())]); changes.push("chapterLabel"); }
    if (p.status !== undefined && ["active","archived"].indexOf(p.status) !== -1) { updates.push([5, p.status]); changes.push("status→" + p.status); }
    if (p.releaseAt !== undefined) {
      const d = new Date(p.releaseAt);
      if (isNaN(d)) return { success: false, error: "Invalid release date/time." };
      updates.push([8, d.toISOString()]);
      changes.push("releaseAt→" + d.toISOString());
    }
    updates.forEach(([col, val]) => sheet.getRange(found.rowIndex, col).setValue(val));
    _invalidateSheet_(WEEKLYSETS_SHEET);
    logAction_(actor, "Update Weekly Set", id, changes.join(", "));
    return { success: true, id };
  });
}

function adminDeleteWeeklySet(p) {
  const chk = checkAdminCan_(p, "weeklysets_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "id required." };

  return withLock_(() => {
    const sheet = getWeeklySetsSheet_();
    const found = findWeeklySetRow_(sheet, id);
    if (!found) return { success: false, error: "Weekly set not found." };
    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(WEEKLYSETS_SHEET);
    PropertiesService.getScriptProperties().deleteProperty("wsnotified_" + id);
    logAction_(actor, "Delete Weekly Set", id, "");
    return { success: true, deleted: id };
  });
}

function adminListWeeklySets(p) {
  const chk = checkAdminCan_(p, "weeklysets_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(WEEKLYSETS_SHEET, getWeeklySetsSheet_).data;
  const totalCount = Math.max(0, data.length - 1);
  const limit = Math.min(totalCount, MAX_LIST_WEEKLYSETS);
  const sets = [];
  for (let i = data.length - 1; i >= data.length - limit; i--) sets.push(rowToWeeklySet_(data[i]));
  sets.sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt));
  return { success: true, sets, totalCount, truncated: totalCount > MAX_LIST_WEEKLYSETS };
}

function listWeeklySets(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;

  const data = _cachedSheetData_(WEEKLYSETS_SHEET, getWeeklySetsSheet_).data;
  const now = Date.now();
  const sets = [];
  for (let i = 1; i < data.length; i++) {
    const s = rowToWeeklySet_(data[i]);
    const releaseTime = new Date(s.releaseAt).getTime();
    const released = !isNaN(releaseTime) && now >= releaseTime;
    if (s.status !== "active" && !(s.status === "archived" && released)) continue;
    sets.push({
      id: s.id, title: s.title, chapterLabel: s.chapterLabel, releaseAt: s.releaseAt,
      released, fileId: released ? s.fileId : undefined
    });
  }
  sets.sort((a, b) => new Date(a.releaseAt) - new Date(b.releaseAt));
  return { success: true, sets };
}

/* The moment a student opens the graded weekly test, the start is recorded
   here. Restarting later cannot be used to look at the questions and try
   again: a second start is a "resume", and the client only allows that on
   the device that still holds the saved test. */
function startWeeklyAttempt(p) {
  const weeklyId = String(p.weeklyId || "").trim();
  if (!weeklyId) return { success: false, error: "Missing parameters." };
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const username = auth.username;

  const wsFound = findWeeklySetRow_(getWeeklySetsSheet_(), weeklyId);
  if (!wsFound) return { success: false, error: "Weekly set not found." };
  const ws = rowToWeeklySet_(wsFound.row);
  const release = new Date(ws.releaseAt).getTime();
  if (isNaN(release) || Date.now() < release) return { success: false, error: "This weekly set is not open yet." };

  return withLock_(() => {
    const done = findWeeklyAttemptRow_(getWeeklyAttemptsSheet_(), username, weeklyId);
    if (done) return { success: true, alreadyAttempted: true, attempt: rowToWeeklyAttempt_(done.row) };
    if (Date.now() > release + WEEKLY_EXAM_WINDOW_MS) return { success: true, windowClosed: true };

    const sheet = getWeeklyStartsSheet_();
    const data = sheet.getDataRange().getValues();
    const target = username.toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === target && String(data[i][1]) === weeklyId) {
        return { success: true, resumed: true, startedAt: Number(data[i][2]) || 0, serverNow: Date.now() };
      }
    }
    const now = Date.now();
    sheet.appendRow([username, weeklyId, now]);
    _invalidateSheet_(WEEKLYSTARTS_SHEET);
    return { success: true, resumed: false, startedAt: now, serverNow: now };
  });
}

/* Rank and percentile, shown only after the exam window closes. */
function getWeeklyStanding(p) {
  const weeklyId = String(p.weeklyId || "").trim();
  if (!weeklyId) return { success: false, error: "Missing parameters." };
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;

  const wsFound = findWeeklySetRow_(getWeeklySetsSheet_(), weeklyId);
  if (!wsFound) return { success: false, error: "Weekly set not found." };
  const ws = rowToWeeklySet_(wsFound.row);
  const release = new Date(ws.releaseAt).getTime();
  if (isNaN(release) || Date.now() <= release + WEEKLY_EXAM_WINDOW_MS) {
    return { success: true, ready: false, message: "Rankings appear when the exam window closes." };
  }

  const data = _cachedSheetData_(WEEKLYATTEMPTS_SHEET, getWeeklyAttemptsSheet_).data;
  const me = auth.username.toLowerCase();
  const scores = [];
  let mine = null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() !== weeklyId) continue;
    const total = Number(data[i][3] || 0);
    const correct = Number(data[i][4] || 0);
    const pct = weeklyMarks_(correct, data[i][5], total).exactPct;
    scores.push(pct);
    if (String(data[i][0]).toLowerCase().trim() === me) mine = pct;
  }
  if (mine === null) return { success: true, ready: true, attempted: false };
  const better = scores.filter(s => s > mine).length;
  const rank = better + 1;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return {
    success: true, ready: true, attempted: true,
    rank, total: scores.length,
    percentile: scores.length > 1 ? Math.round(((scores.length - rank) / (scores.length - 1)) * 100) : 100,
    avgPct: Math.max(0, Math.round(avg))
  };
}

function getWeeklyAttempt(p) {
  const weeklyId = String(p.weeklyId || "").trim();
  if (!weeklyId) return { success: false, error: "Missing parameters." };
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;

  const found = findWeeklyAttemptRow_(getWeeklyAttemptsSheet_(), auth.username, weeklyId);
  return { success: true, attempt: found ? rowToWeeklyAttempt_(found.row) : null };
}

function getMyWeeklyAttempts(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;

  const data = _cachedSheetData_(WEEKLYATTEMPTS_SHEET, getWeeklyAttemptsSheet_).data;
  const target = auth.username.toLowerCase().trim();
  const attempts = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === target) attempts.push(rowToWeeklyAttempt_(data[i]));
  }
  return { success: true, attempts };
}

/* Answer-key extraction shared by submit-time scoring and admin re-scoring. */
function extractCorrectAnswers_(raw) {
  let qs = [];
  if (Array.isArray(raw)) qs = raw;
  else if (raw && typeof raw === "object") {
    qs = raw.questions || raw.data || raw.quiz || raw.items || [];
    if ((!Array.isArray(qs) || !qs.length) && Array.isArray(raw.sections)) {
      qs = raw.sections.reduce((acc, s) => acc.concat(Array.isArray(s && s.questions) ? s.questions : []), []);
    }
  }
  if (!Array.isArray(qs)) return null;
  return qs.map(q => {
    if (!q || typeof q !== "object") return undefined;
    let c = q.correct !== undefined ? q.correct
          : q.answer  !== undefined ? q.answer
          : q.ans     !== undefined ? q.ans
          : q.Answer  !== undefined ? q.Answer : undefined;
    if (typeof c === "string" && /^[a-eA-E]$/.test(c.trim())) c = "abcde".indexOf(c.trim().toLowerCase());
    return c;
  });
}

function loadWeeklyCorrectAnswers_(fileId) {
  try {
    const res = readJsonFileById_(fileId);
    if (!res.success) return null;
    return extractCorrectAnswers_(res.result);
  } catch (e) {
    console.error("loadWeeklyCorrectAnswers_ failed:", e);
    return null;
  }
}

/* Weekly sets are marked the Loksewa way: +1 right, -0.2 wrong, 0 skipped.
   Every weekly percentage comes from this one function. `pct` is clamped
   at 0 for display; `marks` is exact and is what rankings compare. */
const WEEKLY_NEGATIVE_MARK = 0.2;
function weeklyMarks_(correct, skipped, total) {
  const t = Math.max(0, Number(total) || 0);
  const c = Math.max(0, Math.min(t, Number(correct) || 0));
  const sk = Math.max(0, Number(skipped) || 0);
  const wrong = Math.max(0, t - c - sk);
  const marks = c - wrong * WEEKLY_NEGATIVE_MARK;
  return {
    wrong,
    marks: Math.round(marks * 10) / 10,
    pct: t ? Math.max(0, Math.round((marks / t) * 1000) / 10) : 0,
    exactPct: t ? (marks / t) * 100 : 0
  };
}

function scoreAnswers_(answers, correctAnswers) {
  let correct = 0, wrong = 0, skipped = 0;
  answers.forEach((a, idx) => {
    const expected = correctAnswers[idx];
    if (a === null) { skipped++; return; }
    const ok = (typeof expected === "number" && a === expected) ||
               (typeof expected === "string" && String(a) === String(expected));
    if (ok) correct++; else wrong++;
  });
  return { correct, wrong, skipped };
}

function submitWeeklyAttempt(p) {
  const weeklyId = String(p.weeklyId || "").trim();
  if (!weeklyId) return { success: false, error: "Missing parameters." };

  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const username = auth.username;

  const wsFound = findWeeklySetRow_(getWeeklySetsSheet_(), weeklyId);
  if (!wsFound) return { success: false, error: "Weekly set not found." };
  const ws = rowToWeeklySet_(wsFound.row);
  const releaseTime = new Date(ws.releaseAt).getTime();
  if (isNaN(releaseTime) || Date.now() < releaseTime) return { success: false, error: "This weekly set hasn't been released yet." };
  if (Date.now() > releaseTime + WEEKLY_EXAM_WINDOW_MS + 3 * 60 * 60 * 1000) return { success: false, error: "The exam window for this set has closed." };

  let answers;
  try { answers = JSON.parse(p.answers || "[]"); } catch (e) { return { success: false, error: "Malformed answers array." }; }
  if (!Array.isArray(answers) || !answers.length || answers.length > 500) return { success: false, error: "Invalid answers array." };

  const normalized = answers.map(a => {
    if (a === null || a === undefined) return null;
    const n = Number(a);
    return Number.isInteger(n) && n >= 0 && n < 10 ? n : null;
  });
  const total = normalized.length;
  const skipped = normalized.filter(a => a === null).length;

  /* Score on the server. The client's correctCount is only used as a
     fallback when the answer key can't be matched to this submission. */
  const key = loadWeeklyCorrectAnswers_(ws.fileId);
  let correctFinal, serverScored = false;
  if (key && key.length !== total) {
    return { success: false, error: "Your answers don't match this set. Please reload the test and try again." };
  }
  if (key) {
    correctFinal = scoreAnswers_(normalized, key).correct;
    serverScored = true;
  } else {
    correctFinal = Math.max(0, Math.min(total, Number(p.correctCount) || 0));
  }

  return withLock_(() => {
    const sheet = getWeeklyAttemptsSheet_();
    const existing = findWeeklyAttemptRow_(sheet, username, weeklyId);
    if (existing) {
      return { success: false, alreadyAttempted: true,
               attempt: rowToWeeklyAttempt_(existing.row),
               error: "This weekly set has already been submitted." };
    }

    const submittedAt = Date.now();
    /* Use the start time the SERVER recorded in startWeeklyAttempt.
       Client values are only a fallback when no start record exists
       (e.g. an attempt queued offline), and are clamped to sane bounds. */
    let startedAt = 0;
    const startRows = getWeeklyStartsSheet_().getDataRange().getValues();
    const who = username.toLowerCase();
    for (let i = 1; i < startRows.length; i++) {
      if (String(startRows[i][0]).toLowerCase() === who && String(startRows[i][1]) === weeklyId) {
        startedAt = Number(startRows[i][2]) || 0; break;
      }
    }
    let durationSec;
    if (startedAt > 0 && startedAt <= submittedAt) {
      durationSec = Math.max(0, Math.min(6 * 60 * 60, Math.round((submittedAt - startedAt) / 1000)));
    } else {
      durationSec = Math.max(0, Math.min(6 * 60 * 60, Number(p.durationSec) || 0));
      startedAt = submittedAt - durationSec * 1000;
    }

    sheet.appendRow([
      username, weeklyId, JSON.stringify(normalized), total, correctFinal,
      skipped, startedAt, submittedAt, durationSec
    ]);
    _invalidateSheet_(WEEKLYATTEMPTS_SHEET);
    logAction_("system", "Weekly Set Attempt", username,
      `${weeklyId} — ${correctFinal}/${total} in ${durationSec}s` + (serverScored ? " (server-scored)" : " (client-claimed)"));
    return {
      success: true,
      attempt: {
        weeklyId, answers: normalized, total, correct: correctFinal,
        pct: weeklyMarks_(correctFinal, skipped, total).pct,
        skipped, startedAt, submittedAt, durationSec, synced: true
      }
    };
  });
}

function adminWeeklySetResults(p) {
  const chk = checkAdminCan_(p, "weeklysets_view");
  if (!chk.ok) return { success: false, error: chk.error };

  const weeklyId = String(p.weeklyId || "").trim();
  if (!weeklyId) return { success: false, error: "weeklyId required." };

  const wsFound = findWeeklySetRow_(getWeeklySetsSheet_(), weeklyId);
  if (!wsFound) return { success: false, error: "Weekly set not found." };
  const ws = rowToWeeklySet_(wsFound.row);

  const correctAnswers = loadWeeklyCorrectAnswers_(ws.fileId);

  const data = _cachedSheetData_(WEEKLYATTEMPTS_SHEET, getWeeklyAttemptsSheet_).data;
  const attempts = [];

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() !== weeklyId) continue;
    const at = rowToWeeklyAttempt_(data[i]);
    let pct, correct, wrong, skipped;
    if (correctAnswers && at.answers.length === correctAnswers.length) {
      const sc = scoreAnswers_(at.answers, correctAnswers);
      correct = sc.correct; wrong = sc.wrong; skipped = sc.skipped;
      const denom = at.total || correctAnswers.length;
      pct = weeklyMarks_(correct, skipped, denom).pct;
    } else {
      correct = at.correct;
      skipped = at.skipped;
      wrong = Math.max(0, at.total - correct - skipped);
      pct = weeklyMarks_(correct, skipped, at.total).pct;
    }
    attempts.push({
      username: String(data[i][0] || ""),
      pct, correct, wrong, skipped, total: at.total,
      durationSec: at.durationSec, submittedAt: at.submittedAt
    });
  }

  if (!attempts.length) {
    return { success: true, weeklyId, title: ws.title, attempts: 0, uniqueStudents: 0, rescored: !!correctAnswers };
  }

  const pcts = attempts.map(a => a.pct);
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const sorted = [...pcts].sort((a, b) => a - b);
  const variance = pcts.reduce((acc, v) => acc + (v - mean) ** 2, 0) / pcts.length;

  const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i*10}-${i*10+9}`, count: 0 }));
  pcts.forEach(v => { buckets[Math.min(9, Math.floor(v / 10))].count++; });

  return {
    success: true, weeklyId, title: ws.title,
    attempts: attempts.length, uniqueStudents: attempts.length,
    avgPct: Math.round(mean),
    minPct: sorted[0], maxPct: sorted[sorted.length - 1],
    stdDev: Math.round(Math.sqrt(variance)),
    distribution: buckets,
    recent: attempts.sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 50),
    rescored: !!correctAnswers
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   SUBJECTIVE SUBMISSIONS
   ═══════════════════════════════════════════════════════════════════════ */

function submitSubjectiveAnswer(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const username = auth.username;

  const kind = String(p.kind || "qotd").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30) || "qotd";
  const questionId = sanitizeSheetField_(String(p.questionId || "").trim().slice(0, 200));
  const questionText = sanitizeSheetField_(String(p.questionText || "").trim().slice(0, 3000));
  const questionMarks = Math.max(1, Math.min(100, Number(p.marks) || 10));
  const solveSec = Math.max(0, Math.min(6 * 60 * 60, Number(p.solveSec) || 0));
  const startedAt = Number(p.startedAt) || Date.now();
  const pdfData = String(p.pdfData || "");
  const chapterId = sanitizeSheetField_(String(p.chapterId || "").trim().slice(0, 80));

  if (!questionId) return { success: false, error: "Missing questionId." };
  if (!pdfData.startsWith("data:")) return { success: false, error: "Missing PDF data." };
  if (pdfData.length > 12 * 1024 * 1024) return { success: false, error: "PDF too large — max ~8 MB." };

  if (!checkRateLimit_("subjsubmit_" + username.toLowerCase(), 20, 60 * 60 * 1000)) {
    return { success: false, error: "Too many submissions — please wait a while and try again." };
  }

  const parsed = parsePdfDataUrl_(pdfData, 12 * 1024 * 1024);
  if (parsed.error) return { success: false, error: parsed.error };

  /* Slow Drive upload happens BEFORE the script-wide lock is taken, so
     several students uploading at once no longer cause "server busy". */
  let pdfFileId = "", pdfUrl = "";
  try {
    const safeName = _uploadFilename_(username, kind, "pdf");
    const folder = getOrCreateSystemFolder_("SubjectiveAnswers");
    const blob = Utilities.newBlob(parsed.bytes, "application/pdf", safeName);
    const file = folder.createFile(blob);
    pdfFileId = file.getId();
    pdfUrl = file.getUrl();
  } catch (e) { return { success: false, error: "Drive upload failed: " + (e.message || e) }; }

  return withLock_(() => {
    const sheet = getSubjSubmissionsSheet_();

    if (kind === "qotd") {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][1]).toLowerCase().trim() === username.toLowerCase() &&
            String(data[i][3]) === questionId) {
          try { DriveApp.getFileById(pdfFileId).setTrashed(true); } catch (e2) {}
          return { success: false, alreadySubmitted: true, error: "You've already submitted this question." };
        }
      }
    }

    const id = Utilities.getUuid();
    const now = Date.now();
    sheet.appendRow([
      id, username, kind, questionId, questionText, questionMarks,
      chapterId, solveSec, startedAt, now,
      pdfFileId, pdfUrl, "pending", "", "", "", "",
      "", "", ""
    ]);
    _invalidateSheet_(SUBJ_SUBMISSIONS_SHEET);
    logAction_("system", "Subjective Submission", username, `${kind} · ${questionMarks}M · file ${pdfFileId}`);
    return { success: true, submissionId: id, pdfUrl, message: "Submitted for grading." };
  });
}

function getMySubjectiveSubmissions(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;

  const data = _cachedSheetData_(SUBJ_SUBMISSIONS_SHEET, getSubjSubmissionsSheet_).data;
  const target = auth.username.toLowerCase().trim();
  const mine = [];
  for (let i = 1; i < data.length; i++) {
    const s = rowToSubjSubmission_(data[i]);
    if (s.username.toLowerCase() === target) {
      delete s.pdfFileId;
      mine.push(s);
    }
  }
  return { success: true, submissions: mine };
}

function _pdfPayload_(fileId, fallbackName) {
  if (!fileId) return { success: false, error: "No PDF is stored for this submission." };
  let file;
  try { file = DriveApp.getFileById(fileId); }
  catch (e) { return { success: false, error: "Could not open the PDF. (" + (e.message || e) + ")" }; }
  let blob;
  try { blob = file.getBlob(); }
  catch (e) { return { success: false, error: "Could not read the PDF: " + (e.message || e) }; }
  return {
    success: true,
    base64: Utilities.base64Encode(blob.getBytes()),
    mimeType: "application/pdf",
    filename: file.getName() || fallbackName || "submission.pdf"
  };
}

/* Students read their own (marked) answer PDF through the server — the
   Drive files themselves stay private to the script owner. */
function getMySubmissionPdf(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Submission id required." };
  if (!checkRateLimit_("mypdf_" + auth.username.toLowerCase(), 20, 60000)) {
    return { success: false, error: "Too many requests — please slow down." };
  }
  const found = _findRowFast_(getSubjSubmissionsSheet_(), 1, id);
  if (!found || String(found.row[1]).toLowerCase() !== auth.username.toLowerCase()) {
    return { success: false, error: "Submission not found." };
  }
  return _pdfPayload_(String(found.row[10] || "").trim(), "answer.pdf");
}

/* Lets ANY admin with subjective_view fetch the student's PDF to annotate
   it (previously only the Drive owner could open the raw link). */
function adminDownloadSubmissionPdf(p) {
  const chk = checkAdminCan_(p, "subjective_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Submission id required." };
  const found = _findRowFast_(getSubjSubmissionsSheet_(), 1, id);
  if (!found) return { success: false, error: "Submission not found." };
  return _pdfPayload_(String(found.row[10] || "").trim(), "submission.pdf");
}

/* ═══════════════════════════════════════════════════════════════════════
   PAYMENTS
   ═══════════════════════════════════════════════════════════════════════ */

function detectImageType_(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = i => bytes[i] & 0xff;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return { mime: "image/png", ext: "png" };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return { mime: "image/gif", ext: "gif" };
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
      b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return { mime: "image/webp", ext: "webp" };
  return null;
}

function isPdfBytes_(bytes) {
  return !!bytes && bytes.length > 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/* Returns { bytes } or { error }. Accepts jsPDF-style
   "data:application/pdf;filename=x.pdf;base64," too. */
function parsePdfDataUrl_(dataUrl, maxChars) {
  const s = String(dataUrl || "");
  const m = s.match(/^data:application\/pdf(?:;[^;,]+)*;base64,/);
  if (!m) return { error: "Uploaded file must be a base64 PDF." };
  if (s.length > maxChars) return { error: "PDF too large." };
  let bytes;
  try { bytes = Utilities.base64Decode(s.slice(m[0].length)); }
  catch (e) { return { error: "PDF data is corrupt." }; }
  if (!isPdfBytes_(bytes)) return { error: "That file isn't a valid PDF." };
  return { bytes };
}

function _isFileInFolderNamed_(file, folderName) {
  const parents = file.getParents();
  while (parents.hasNext()) { if (parents.next().getName() === folderName) return true; }
  return false;
}

/* Returns { url } or { error }. Bad/unknown image data is ignored (no
   screenshot) exactly like before; oversize data is rejected. */
function saveScreenshot_(username, data) {
  if (!data) return { url: "" };
  if (data.startsWith("data:image")) {
    if (data.length > MAX_SCREENSHOT_DATA_CHARS) return { error: "Screenshot is too large — max ~6 MB." };
    try {
      const bytes = Utilities.base64Decode(data.slice(data.indexOf(",") + 1));
      const type = detectImageType_(bytes);
      if (!type) { console.log("Screenshot ignored: not a recognised image."); return { url: "" }; }
      const name = _uploadFilename_(username, "payment", type.ext);
      const blob = Utilities.newBlob(bytes, type.mime, name);
      const file = getOrCreateSystemFolder_("PaymentScreenshots").createFile(blob);
      return { url: file.getDownloadUrl() };
    } catch (e) { console.log("Screenshot upload failed: " + e.message); return { url: "" }; }
  }
  /* Only Drive links are accepted as external references. */
  if (data.length <= 500 && /^https:\/\/(drive|docs)\.google\.com\//.test(data)) return { url: sanitizeSheetField_(data) };
  return { url: "" };
}

function submitPayment(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;

  const name = sanitizeSheetField_(String(p.name || "").trim().slice(0, MAX_NAME_LEN));
  const email = sanitizeSheetField_(String(p.email || "").trim().slice(0, MAX_EMAIL_LEN));
  const mobile = String(p.mobile || "").trim().slice(0, 20);
  const txId = sanitizeSheetField_(String(p.txId || "").trim().slice(0, 80));
  const remarks = sanitizeSheetField_(String(p.remarks || "").trim().slice(0, 500));
  const screenshotData = String(p.screenshot || "");

  if (!txId) return { success: false, error: "Transaction ID required." };

  if (!checkRateLimit_("submitpayment_" + username.toLowerCase(), 10, 60 * 60 * 1000)) {
    return { success: false, error: "Too many payment submissions — please wait a few minutes and try again." };
  }

  const okStatus = s => s === "expired" || s === "payment_pending" || s === "trial";
  if (!okStatus(auth.found.row[7])) return { success: false, error: "Payment not required at this time." };

  /* Drive upload happens before taking the lock (it's slow); every sheet
     write — including the user's status change — happens inside it. */
  const shot = saveScreenshot_(username, screenshotData);
  if (shot.error) return { success: false, error: shot.error };
  const screenshotUrl = shot.url || "";

  return withLock_(() => {
    const userSheet = getUsersSheet_();
    const userFound = findUserRow_(userSheet, username);
    if (!userFound) return { success: false, error: "Session expired. Please log in again.", sessionInvalid: true };
    if (!okStatus(userFound.row[7])) return { success: false, error: "Payment not required at this time." };

    /* The same transaction ID cannot back two different accounts. */
    const payRows = getPaymentsSheet_().getDataRange().getValues();
    const txKey = String(txId).toLowerCase().trim();
    for (let i = 1; i < payRows.length; i++) {
      const owner = String(payRows[i][0]).toLowerCase();
      const st = String(payRows[i][6]).toLowerCase();
      if (owner !== username.toLowerCase() && st !== "rejected" &&
          String(payRows[i][4]).toLowerCase().trim() === txKey) {
        return { success: false, error: "This transaction ID has already been used. Check it, or contact support." };
      }
    }
    userSheet.getRange(userFound.rowIndex, 8).setValue("payment_pending");
    userSheet.getRange(userFound.rowIndex, 13).setValue("pending");
    _invalidateSheet_(USERS_SHEET);

    const sheet = getPaymentsSheet_();
    const now = new Date().toISOString();
    const data = sheet.getDataRange().getValues();
    let existingRow = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === username.toLowerCase()) { existingRow = i + 1; break; }
    }
    if (existingRow) {
      const cur = data[existingRow - 1];
      const updates = [
        [2, name || cur[1]],
        [3, email || cur[2]],
        [4, mobile || cur[3]],
        [5, txId],
        [6, remarks || cur[5]],
        [7, "pending"],
        [8, ""],
        [9, screenshotUrl || cur[8]],
        [10, now]
      ];
      updates.forEach(([col, val]) => sheet.getRange(existingRow, col).setValue(val));
    } else {
      sheet.appendRow([username, name, email, mobile, txId, remarks, "pending", "", screenshotUrl, now, ""]);
    }
    _invalidateSheet_(PAYMENTS_SHEET);
    return { success: true, message: "Payment submitted successfully. Waiting for admin verification." };
  });
}

function getPaymentStatus(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;

  const data = _cachedSheetData_(PAYMENTS_SHEET, getPaymentsSheet_).data;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      return {
        success: true,
        payment: {
          username: data[i][0], name: data[i][1], email: data[i][2],
          mobile: String(data[i][3] || ""), txId: data[i][4], remarks: data[i][5],
          status: data[i][6], rejectionReason: data[i][7], screenshotUrl: data[i][8],
          submittedAt: data[i][9], reviewedAt: data[i][10]
        }
      };
    }
  }
  return { success: false, error: "No payment submission found." };
}
/* ═══════════════════════════════════════════════════════════════════════
   CONTENT FILE ACCESS
   ═══════════════════════════════════════════════════════════════════════ */

/* Internal reader. Only JSON-ish files of sane size are ever parsed. */
function readJsonFileById_(fileId) {
  let file;
  try { file = DriveApp.getFileById(fileId); }
  catch (err) {
    return { success: false, error: "Could not open Drive file '" + fileId + "'. Check the fileId and make sure the file hasn't been deleted. (" + (err.message || err) + ")" };
  }
  const mime = String(file.getMimeType() || "");
  if (["application/json", "text/json", "text/plain", "application/octet-stream"].indexOf(mime) === -1) {
    return { success: false, error: "That file is not a JSON data file." };
  }
  if (file.getSize() > MAX_JSON_FILE_BYTES) return { success: false, error: "File is too large." };
  let text;
  try { text = file.getBlob().getDataAsString("UTF-8"); }
  catch (err) { return { success: false, error: "Could not read file contents: " + (err.message || err) }; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { return { success: false, error: "File '" + file.getName() + "' is not valid JSON (" + (err.message || err) + ")." }; }
  return { success: true, result: parsed };
}

/* getFile used to open ANY Drive file the script owner can read. Now only
   registered content is served: the CONTENT_FILE_IDS list, plus files
   inside the WeeklySets / SubjectiveQuestions system folders. Weekly-set
   files are only served to students once that set has been released
   (admins can always preview). Positive results are cached. */
function isContentFileAllowed_(fileId, isAdmin) {
  const ids = (typeof CONTENT_FILE_IDS !== "undefined") ? CONTENT_FILE_IDS : [];
  if (ids.indexOf(fileId) !== -1) return true;

  const cache = CacheService.getScriptCache();
  const ck = "cfa_" + fileId;
  let kind = cache.get(ck);
  if (!kind) {
    let file;
    try { file = DriveApp.getFileById(fileId); } catch (e) { return false; }
    if (_isFileInFolderNamed_(file, "SubjectiveQuestions")) kind = "subj";
    else if (_isFileInFolderNamed_(file, "WeeklySets")) kind = "weekly";
    else return false;
    try { cache.put(ck, kind, 21600); } catch (e) {}
  }
  if (kind === "subj" || isAdmin) return true;

  const data = _cachedSheetData_(WEEKLYSETS_SHEET, getWeeklySetsSheet_).data;
  const now = Date.now();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]) === fileId) {
      const rel = new Date(data[i][7]).getTime();
      if (!isNaN(rel) && now >= rel) return true;
    }
  }
  return false;
}

function handleGetFile(p) {
  const fileId = String(p.fileId || "").trim();
  if (!fileId) return { success: false, error: "Missing fileId parameter." };
  if (fileId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(fileId)) return { success: false, error: "Invalid fileId." };
  if (!checkGetFileRateLimit_()) return { success: false, error: "Server is busy, please try again in a moment.", rateLimited: true };

  let isAdminCaller = false;
  if (GETFILE_REQUIRES_AUTH) {
    const adminActor = p.adminToken ? checkAdmin_({ adminToken: p.adminToken }) : null;
    if (adminActor) {
      isAdminCaller = true;
    } else {
      const auth = authUser_(p);
      if (!auth.ok) return auth.error;
      const gate = requireAccess_(auth);
      if (gate) return gate;
      if (!checkRateLimit_("getfile_" + auth.username.toLowerCase(), GETFILE_RATE_LIMIT_PER_USER_PER_MINUTE, 60000)) {
        return { success: false, error: "Too many file requests — please slow down.", rateLimited: true };
      }
    }
  }
  if (!isContentFileAllowed_(fileId, isAdminCaller)) {
    return { success: false, error: "That file is not available." };
  }
  return readJsonFileById_(fileId);
}

/* The key that opens the ENCRYPTED copies of the question files on the CDN.
   The files on the CDN are { enc:1, kid, iv, ct } (AES-256-GCM); without
   this key they are unreadable. The key is handed out only to a signed-in
   student with paid or trial access (the same check getFile uses) or to
   an admin, and is kept in Script Properties:
     CONTENT_KEY_ID = the current key id (e.g. k1)
     CONTENT_KEY_<id> = the key (base64, 32 bytes). */
function handleGetContentKey(p) {
  const adminActor = p.adminToken ? checkAdmin_({ adminToken: p.adminToken }) : null;
  if (!adminActor) {
    const auth = authUser_(p);
    if (!auth.ok) return auth.error;
    const gate = requireAccess_(auth);
    if (gate) return gate;
    if (!checkRateLimit_("ckey_" + auth.username.toLowerCase(), 20, 60000)) {
      return { success: false, error: "Too many requests. Please wait a moment.", rateLimited: true };
    }
  }
  const props = PropertiesService.getScriptProperties();
  const current = String(props.getProperty("CONTENT_KEY_ID") || "");
  const kid = String(p.kid || current).trim();
  if (!kid) return { success: false, error: "No content key is set up.", noKey: true };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) return { success: false, error: "Invalid key id." };
  const key = props.getProperty("CONTENT_KEY_" + kid);
  if (!key) return { success: false, error: "No content key is set up for this id.", noKey: true };
  return { success: true, kid: kid, current: current, key: String(key) };
}

/* Several question files in one request:
   ?action=getFiles&fileIds=id1,id2,...&username=..&token=..
   Same checks as getFile for every file. Answer:
   { success:true, files:{ <id>: {success:true,result:[...]} | {success:false,error:"..."} },
     deferred:[ids not read because the response was getting large; ask for them again] }. */
function handleGetFiles(p) {
  const ids = [];
  String(p.fileIds || "").split(",").forEach(function (raw) {
    const id = String(raw).trim();
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });
  if (!ids.length) return { success: false, error: "Missing fileIds parameter." };
  if (ids.length > GETFILES_MAX_BATCH) return { success: false, error: "Too many files in one request (most " + GETFILES_MAX_BATCH + ")." };
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].length > 200 || !/^[A-Za-z0-9_-]+$/.test(ids[i])) return { success: false, error: "Invalid fileId." };
  }
  if (!checkGetFileRateLimit_()) return { success: false, error: "Server is busy, please try again in a moment.", rateLimited: true };

  let isAdminCaller = false;
  if (GETFILE_REQUIRES_AUTH) {
    const adminActor = p.adminToken ? checkAdmin_({ adminToken: p.adminToken }) : null;
    if (adminActor) {
      isAdminCaller = true;
    } else {
      const auth = authUser_(p);
      if (!auth.ok) return auth.error;
      const gate = requireAccess_(auth);
      if (gate) return gate;
      const who = auth.username.toLowerCase();
      if (!checkRateLimit_("getfile_" + who, GETFILE_RATE_LIMIT_PER_USER_PER_MINUTE, 60000)) {
        return { success: false, error: "Too many file requests — please slow down.", rateLimited: true };
      }
      if (!checkRateLimit_("getfiles_" + who, GETFILES_PER_USER_FILES_PER_MINUTE, 60000, null, ids.length)) {
        return { success: false, error: "Too many files requested — please slow down.", rateLimited: true };
      }
    }
  }

  const files = {};
  const deferred = [];
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (i > 0 && total > GETFILES_MAX_RESPONSE_CHARS) { deferred.push(id); continue; }
    const entry = isContentFileAllowed_(id, isAdminCaller)
      ? readJsonFileById_(id)
      : { success: false, error: "That file is not available." };
    files[id] = entry;
    try { total += JSON.stringify(entry).length; } catch (e) {}
  }
  return { success: true, files: files, deferred: deferred };
}

function adminDownloadScreenshot(p) {
  const chk = checkAdminCan_(p, "screenshots");
  if (!chk.ok) return { success: false, error: chk.error };

  let fileId = String(p.fileId || "").trim();
  if (!fileId && p.url) {
    const m = String(p.url).match(/[?&]id=([^&]+)/);
    if (m) fileId = decodeURIComponent(m[1]);
  }
  if (!fileId) return { success: false, error: "Missing fileId or url parameter." };

  let file;
  try { file = DriveApp.getFileById(fileId); }
  catch (err) { return { success: false, error: "Could not open screenshot. (" + (err.message || err) + ")" }; }
  if (!_isFileInFolderNamed_(file, "PaymentScreenshots")) {
    return { success: false, error: "That file is not a stored payment screenshot." };
  }
  let blob;
  try { blob = file.getBlob(); }
  catch (err) { return { success: false, error: "Could not read screenshot contents: " + (err.message || err) }; }

  return { success: true, base64: Utilities.base64Encode(blob.getBytes()),
           mimeType: blob.getContentType() || "image/png",
           filename: file.getName() || "payment_screenshot.png" };
}

/* ═══════════════════════════════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════════════════════════════ */

function getSettingsAll_() {
  const data = _cachedSheetData_(SETTINGS_SHEET, getSettingsSheet_).data;
  const settings = {};
  for (let i = 1; i < data.length; i++) if (data[i][0]) settings[String(data[i][0])] = data[i][1];
  return settings;
}

function _isPrivateSettingKey_(key) {
  const k = String(key).toLowerCase();
  return PRIVATE_SETTING_PREFIXES.some(prefix => k.indexOf(prefix) === 0);
}

/* PUBLIC endpoint (no auth): hides keys prefixed "private_" / "secret_".
   Admins read everything through adminGetSettings. Cached for two minutes
   (cleared whenever an admin saves settings). */
function getSettings() {
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get("pub_settings");
    if (hit) return { success: true, settings: JSON.parse(hit) };
  } catch (e) {}
  const res = getSettingsUncached_();
  try { if (res && res.success) cache.put("pub_settings", JSON.stringify(res.settings), 120); } catch (e) {}
  return res;
}
function getSettingsUncached_() {
  const all = getSettingsAll_();
  const settings = {};
  Object.keys(all).forEach(k => { if (!_isPrivateSettingKey_(k)) settings[k] = all[k]; });
  return { success: true, settings };
}

function adminGetSettings(p) {
  const chk = checkAdminCan_(p, "settings_view");
  if (!chk.ok) return { success: false, error: chk.error };
  return { success: true, settings: getSettingsAll_() };
}

function getSettingValue_(key, fallback) {
  const v = getSettingsAll_()[key];
  return (v === undefined || v === null || v === "") ? fallback : v;
}

function setSettingValue_(key, value) {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  let done = false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) { sheet.getRange(i + 1, 2).setValue(value); done = true; break; }
  }
  if (!done) sheet.appendRow([key, value]);
  _invalidateSheet_(SETTINGS_SHEET);
  CacheService.getScriptCache().remove("pub_settings");
}

/* Pure: is this a usable Loksewa mark scheme? Returns "" when fine,
   otherwise what is wrong. An empty value clears it. */
function loksewaSchemeProblem_(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return "";
  if (v.length > 4000) return "The mark scheme is too long.";
  let o; try { o = JSON.parse(v); } catch (e) { return "The mark scheme is not valid."; }
  if (!o || !Array.isArray(o.groups) || !o.groups.length) return "Add at least one group.";
  if (o.groups.length > 20) return "At most 20 groups.";
  let total = 0;
  for (let i = 0; i < o.groups.length; i++) {
    const g = o.groups[i] || {};
    const marks = Number(g.marks);
    if (!String(g.name || "").trim()) return "Every group needs a name.";
    if (!isFinite(marks) || marks < 1 || marks > 100 || Math.floor(marks) !== marks) return "Marks must be whole numbers from 1 to 100 (" + String(g.name || "group") + ").";
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(String(g.level || ""))) return "Choose a level for " + String(g.name) + ".";
    total += marks;
  }
  if (total > 200) return "The groups add up to more than 200 marks.";
  return "";
}

function adminUpdateSettings(p) {
  const chk = checkAdminCan_(p, "settings_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const key = String(p.key || "").trim();
  const value = (p.value !== undefined) ? p.value : "";
  if (!key) return { success: false, error: "Setting key required." };
  if (key.length > 100) return { success: false, error: "Setting key is too long." };
  if (key === "loksewaScheme") { const bad = loksewaSchemeProblem_(value); if (bad) return { success: false, error: bad }; }

  return withLock_(() => {
    const sheet = getSettingsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === key) {
        sheet.getRange(i + 1, 2).setValue(value);
        _invalidateSheet_(SETTINGS_SHEET); CacheService.getScriptCache().remove("pub_settings");
        logAction_(actor, "Update Setting", key, _isPrivateSettingKey_(key) ? "(private value updated)" : "New value: " + value);
        return { success: true, key, value };
      }
    }
    sheet.appendRow([key, value]);
    _invalidateSheet_(SETTINGS_SHEET); CacheService.getScriptCache().remove("pub_settings");
    logAction_(actor, "Update Setting", key, _isPrivateSettingKey_(key) ? "(private value set)" : "New value: " + value);
    return { success: true, key, value };
  });
}

function adminUpdateSettingsBatch(p) {
  const chk = checkAdminCan_(p, "settings_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const incoming = p.settings;
  if (!Array.isArray(incoming) || !incoming.length) return { success: false, error: "settings array required." };
  if (incoming.length > 200) return { success: false, error: "Too many settings in one batch." };

  return withLock_(() => {
    const sheet = getSettingsSheet_();
    const data = sheet.getDataRange().getValues();
    const rowByKey = {};
    for (let i = 1; i < data.length; i++) if (data[i][0]) rowByKey[String(data[i][0])] = i + 1;

    const applied = [];
    const appendRows = [];
    incoming.forEach(s => {
      const key = String((s && s.key) || "").trim();
      if (!key || key.length > 100) return;
      const value = (s.value !== undefined) ? s.value : "";
      if (key === "loksewaScheme" && loksewaSchemeProblem_(value)) return;
      if (rowByKey[key]) sheet.getRange(rowByKey[key], 2).setValue(value);
      else appendRows.push([key, value]);
      applied.push(key);
    });
    if (appendRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, appendRows.length, 2).setValues(appendRows);
    _invalidateSheet_(SETTINGS_SHEET); CacheService.getScriptCache().remove("pub_settings");
    logAction_(actor, "Update Settings (batch)", applied.join(", "), "");
    return { success: true, updated: applied };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   ADMIN — USERS
   ═══════════════════════════════════════════════════════════════════════ */

const ALLOWED_USER_STATUSES = ["trial", "active", "expired", "payment_pending", "rejected"];

function adminListUsers(p) {
  const chk = checkAdminCan_(p, "users_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const totalCount = Math.max(0, data.length - 1);
  const limit = Math.min(totalCount, MAX_LIST_USERS);
  const users = [];
  /* newest-first: the OUTPUT is capped, so on a busy install the newest
     signups stay visible */
  for (let i = data.length - 1; i >= data.length - limit; i--) users.push(rowToUser_(data[i]));
  return { success: true, users, totalCount, truncated: totalCount > MAX_LIST_USERS };
}

function adminUpdateUser(p) {
  const chk = checkAdminCan_(p, "users_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  let verifyTarget = null;
  const result = withLock_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, username);
    if (!found) return { success: false, error: "User not found." };

    const changes = [];
    const writes = [];

    if (p.name !== undefined) {
      const nm = String(p.name).trim();
      if (nm.length > MAX_NAME_LEN) return { success: false, error: "Name is too long." };
      writes.push([3, sanitizeSheetField_(nm)]); changes.push("name");
    }
    if (p.email !== undefined) {
      const email = String(p.email).trim();
      if (email.length > MAX_EMAIL_LEN) return { success: false, error: "Email address is too long." };
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, error: "Invalid email address." };
      const oldEmail = String(found.row[3] || "").replace(/^'/, "");
      writes.push([4, sanitizeSheetField_(email)]); changes.push("email");
      if (email && email.toLowerCase() !== oldEmail.toLowerCase()) {
        writes.push([19, "false"]);
        verifyTarget = { username: String(found.row[0]), email, name: String(found.row[2] || "") };
      }
    }
    if (p.mobile !== undefined) {
      const mobile = String(p.mobile).trim();
      if (mobile && !/^(98|97|96|99)\d{8}$/.test(mobile)) return { success: false, error: "Invalid Nepali mobile number." };
      if (mobile) {
        const other = findUserByField_(sheet, 4, mobile);
        if (other && other.rowIndex !== found.rowIndex) return { success: false, error: "Another account already uses this mobile number." };
      }
      writes.push([5, mobile]); changes.push("mobile");
    }
    if (p.status !== undefined && p.status !== "") {
      if (ALLOWED_USER_STATUSES.indexOf(String(p.status)) === -1) return { success: false, error: "Invalid status." };
      writes.push([8, p.status]); changes.push("status→" + p.status);
    }
    if (p.permanentAccess !== undefined) {
      const val = (p.permanentAccess === true || p.permanentAccess === "true") ? "true" : "false";
      writes.push([14, val]); changes.push("permanentAccess→" + val);
    }
    if (p.password) {
      const pw = String(p.password);
      if (pw.length < MIN_USER_PASSWORD_LENGTH) return { success: false, error: "Password must be at least " + MIN_USER_PASSWORD_LENGTH + " characters." };
      if (pw.length > MAX_PASSWORD_LEN) return { success: false, error: "Password is too long." };
      /* A non-owner must not be able to reset the password of an account
         that also has an admin record. */
      if (chk.role !== ADMIN_ROLE_OWNER && findAdminRow_(getAdminsSheet_(), String(found.row[0]))) {
        return { success: false, error: "Only the main admin can reset the password of an admin account." };
      }
      writes.push([2, makeStoredHash_(pw)]);
      writes.push([17, ""]); writes.push([18, ""]);
      changes.push("password reset");
    }

    writes.forEach(([col, val]) => sheet.getRange(found.rowIndex, col).setValue(val));
    _invalidateSheet_(USERS_SHEET);
    logAction_(actor, "Update User", username, changes.join(", "));
    return { success: true, username };
  });

  if (result.success && verifyTarget) sendVerificationEmail_(verifyTarget.username, verifyTarget.email, verifyTarget.name);
  return result;
}

/* v1.43: fixed the write targets. The old version wrote to columns 8, 9, 10
   in one call: it destroyed createdAt (column 9) with a fresh timestamp and
   put the literal string "verified" into approvedAt (column 10). It also
   never set paymentStatus (column 13). */
function adminGrantAccess(p) {
  const chk = checkAdminCan_(p, "users_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const username = String(p.username || "").trim();
  const duration = String(p.duration || "").trim();
  if (!username) return { success: false, error: "Username required." };
  if (["permanent", "year"].indexOf(duration) === -1) return { success: false, error: "Duration must be 'permanent' or 'year'." };

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, username);
    if (!found) return { success: false, error: "User not found." };

    let expiresAtIso = "";
    if (duration === "year") {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 365);
      expiresAtIso = expiresAt.toISOString();
    }
    const nowIso = new Date().toISOString();
    /* Column 8: status. Column 10: approvedAt. Column 13: paymentStatus.
       Column 14: permanentAccess. Column 15: accessType. Column 16: accessExpiresAt.
       Column 9 (createdAt) is never touched. */
    sheet.getRange(found.rowIndex, 8).setValue("active");
    sheet.getRange(found.rowIndex, 10).setValue(nowIso);
    sheet.getRange(found.rowIndex, 13).setValue("verified");
    sheet.getRange(found.rowIndex, 14).setValue("true");
    sheet.getRange(found.rowIndex, 15).setValue(duration === "year" ? "yearly" : "permanent");
    sheet.getRange(found.rowIndex, 16).setValue(expiresAtIso);
    _invalidateSheet_(USERS_SHEET);
    logAction_(actor, "Grant Access", username, "Duration: " + duration);
    return { success: true, username, duration, accessExpiresAt: expiresAtIso };
  });
}

/* Batch grant: reads and writes ONLY columns 8..16 (status … accessExpiresAt)
   in one round trip. The old version rewrote the whole sheet, which could
   overwrite session tokens (cols 17-18) issued by concurrent logins. */
function adminGrantAccessBatch(p) {
  const chk = checkAdminCan_(p, "users_bulk");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  let usernames;
  try { usernames = Array.isArray(p.usernames) ? p.usernames : JSON.parse(p.usernames || "[]"); }
  catch (e) { return { success: false, error: "usernames must be a JSON array." }; }
  if (!Array.isArray(usernames) || !usernames.length) return { success: false, error: "No usernames provided." };
  if (usernames.length > 1000) return { success: false, error: "Limit is 1000 usernames per batch." };

  const duration = String(p.duration || "").trim();
  if (["permanent", "year"].indexOf(duration) === -1) return { success: false, error: "Duration must be 'permanent' or 'year'." };

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const n = Math.max(0, sheet.getLastRow() - 1);
    const keys = n ? sheet.getRange(2, 1, n, 1).getValues() : [];
    const block = n ? sheet.getRange(2, 8, n, 9).getValues() : [];   // cols 8..16
    const idxByUser = {};
    for (let i = 0; i < n; i++) idxByUser[String(keys[i][0]).toLowerCase().trim()] = i;

    let expiresAtIso = "";
    if (duration === "year") {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 365);
      expiresAtIso = expiresAt.toISOString();
    }
    const nowIso = new Date().toISOString();
    const results = [];
    let anyChanged = false;

    usernames.forEach(raw => {
      const u = String(raw || "").trim();
      const idx = idxByUser[u.toLowerCase()];
      if (idx === undefined) { results.push({ username: u, success: false, error: "User not found." }); return; }
      const r = block[idx];
      r[0] = "active";                 // col 8: status
      r[2] = nowIso;                   // col 10: approvedAt
      r[5] = "verified";               // col 13: paymentStatus
      r[6] = "true";                   // col 14: permanentAccess
      r[7] = duration === "year" ? "yearly" : "permanent";   // col 15
      r[8] = expiresAtIso;             // col 16
      anyChanged = true;
      results.push({ username: u, success: true });
    });

    if (anyChanged) {
      sheet.getRange(2, 8, n, 9).setValues(block);
      _invalidateSheet_(USERS_SHEET);
    }
    logAction_(actor, "Bulk Grant Access", usernames.join(", ").slice(0, 2000),
      "Duration: " + duration + " — " + results.filter(r => r.success).length + "/" + usernames.length + " succeeded");
    return { success: true, duration, accessExpiresAt: expiresAtIso, results };
  });
}

function adminDeleteUser(p) {
  const chk = checkAdminCan_(p, "users_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, username);
    if (!found) return { success: false, error: "User not found." };
    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(USERS_SHEET);
    purgeUserAuxiliaryRows_(username);
    logAction_(actor, "Delete User", username, "Purged Progress/PushTokens/Payments/Backups/WeeklyAttempts/Subjective");
    return { success: true, deleted: username };
  });
}

function adminDeleteUsersBatch(p) {
  const chk = checkAdminCan_(p, "users_bulk");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  let usernames;
  try { usernames = Array.isArray(p.usernames) ? p.usernames : JSON.parse(p.usernames || "[]"); }
  catch (e) { return { success: false, error: "usernames must be a JSON array." }; }
  if (!Array.isArray(usernames) || !usernames.length) return { success: false, error: "No usernames provided." };
  if (usernames.length > 1000) return { success: false, error: "Limit is 1000 usernames per batch." };

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const data = sheet.getDataRange().getValues();
    const rowByUser = {};
    for (let i = 1; i < data.length; i++) rowByUser[String(data[i][0]).toLowerCase().trim()] = i + 1;

    const results = [];
    const toDelete = [];
    usernames.forEach(raw => {
      const u = String(raw || "").trim();
      const rowIndex = rowByUser[u.toLowerCase()];
      if (!rowIndex) { results.push({ username: u, success: false, error: "User not found." }); return; }
      toDelete.push({ username: u, rowIndex });
    });

    toDelete.sort((a, b) => b.rowIndex - a.rowIndex);
    toDelete.forEach(({ username, rowIndex }) => {
      sheet.deleteRow(rowIndex);
      purgeUserAuxiliaryRows_(username, { skipLogScrub: true });
      results.push({ username, success: true });
    });
    _invalidateSheet_(USERS_SHEET);
    logAction_(actor, "Bulk Delete User", usernames.join(", ").slice(0, 2000),
      results.filter(r => r.success).length + "/" + usernames.length + " succeeded (auxiliary rows purged)");
    return { success: true, results };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   SELF-SERVICE DATA CONTROL
   ═══════════════════════════════════════════════════════════════════════ */

const DELETED_USER_LABEL = "[deleted user]";

/* Extracts a Drive file id from a stored URL (".../uc?id=XYZ" or "/d/XYZ/"). */
function driveIdFromUrl_(url) {
  const s = String(url || "");
  const m = s.match(/[?&]id=([A-Za-z0-9_-]{15,})/) || s.match(/\/d\/([A-Za-z0-9_-]{15,})/);
  return m ? m[1] : "";
}

/* Drive file ids that belong to one student: payment screenshots, submitted
   answer PDFs, and the pre-edit backup copy of a marked PDF. */
function collectUserDriveFileIds_(target, opts) {
  const withPayments = !(opts && opts.payments === false);
  const ids = {};
  const scan = (getter, userCol, idCols, urlCols) => {
    try {
      const data = getter().getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][userCol]).toLowerCase().trim() !== target) continue;
        idCols.forEach(c => { const v = String(data[i][c] || "").trim(); if (v) ids[v] = 1; });
        urlCols.forEach(c => { const v = driveIdFromUrl_(data[i][c]); if (v) ids[v] = 1; });
      }
    } catch (e) { console.error("collectUserDriveFileIds_:", e); }
  };
  if (withPayments) scan(getPaymentsSheet_, 0, [], [8]);
  scan(getSubjSubmissionsSheet_, 1, [10, 19], [11]);
  return Object.keys(ids);
}

/* Folders the app itself creates for student uploads. A payment "screenshot
   URL" can also be a Drive link the student pasted, so we ONLY ever trash
   files that sit inside one of these folders. */
const STUDENT_UPLOAD_FOLDERS = ["PaymentScreenshots", "SubjectiveAnswers", "SubjectivePdfBackups"];

function isStudentUploadFile_(file) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (STUDENT_UPLOAD_FOLDERS.indexOf(parents.next().getName()) !== -1) return true;
  }
  return false;
}

/* Moves files to the Drive trash (recoverable by the owner for ~30 days). */
function trashDriveFiles_(ids) {
  let trashed = 0;
  (ids || []).forEach(id => {
    try {
      const file = DriveApp.getFileById(id);
      if (!isStudentUploadFile_(file)) { console.log("trashDriveFiles_: skipped " + id + " (not in an Abhyas upload folder)"); return; }
      file.setTrashed(true);
      trashed++;
    } catch (e) { console.error("trashDriveFiles_: " + id + " - " + (e && e.message ? e.message : e)); }
  });
  return trashed;
}

/* Replaces every cell in one column that equals `target` (case-insensitive). */
function anonymizeColumn_(sheet, colIdx, target, replacement) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const rng = sheet.getRange(2, colIdx + 1, last - 1, 1);
  const vals = rng.getValues();
  let n = 0;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).toLowerCase().trim() === target) { vals[i][0] = replacement; n++; }
  }
  if (n) rng.setValues(vals);
  return n;
}

/* Deletes every row whose column `colIdx` equals `target`. Returns the count. */
function deleteRowsForUser_(sheetName, getter, colIdx, target) {
  let n = 0;
  try {
    const sheet = getter();
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][colIdx]).toLowerCase().trim() === target) { sheet.deleteRow(i + 1); n++; }
    }
    _invalidateSheet_(sheetName);
  } catch (e) { console.error("deleteRowsForUser_: " + sheetName + " failed:", e); }
  return n;
}

/* Full clean-up for one student, used by adminDeleteUser,
   adminDeleteUsersBatch and deleteMyAccount. Call it AFTER the Users row
   is gone. */
function purgeUserAuxiliaryRows_(username, opts) {
  if (!username) return { driveFilesTrashed: 0, referencesAnonymized: 0 };
  const target = String(username).toLowerCase().trim();
  const driveIds = collectUserDriveFileIds_(target);
  purgeUserSheetRows_(username);
  const trashed = trashDriveFiles_(driveIds);
  let scrubbed = 0;
  try {
    scrubbed += anonymizeColumn_(getQReportsSheetSafe_(), 6, target, DELETED_USER_LABEL);
  } catch (e) { console.error("purgeUserAuxiliaryRows_: QuestionReports scrub failed:", e); }
  if (!(opts && opts.skipLogScrub)) {
    try { scrubbed += anonymizeColumn_(getLogsSheet_(), 3, target, DELETED_USER_LABEL); }
    catch (e) { console.error("purgeUserAuxiliaryRows_: log scrub failed:", e); }
  }
  return { driveFilesTrashed: trashed, referencesAnonymized: scrubbed };
}

/* Student deletes their OWN account. Needs: valid session, the password, and
   confirm = "DELETE". Accounts that also carry admin access are refused
   (the main admin has to remove the admin role first). */
function deleteMyAccount(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;

  if (String(p.confirm || "").trim().toUpperCase() !== "DELETE") {
    return { success: false, error: "Type DELETE to confirm." };
  }
  if (!checkRateLimit_("delacct_" + username.toLowerCase(), 5, 10 * 60 * 1000, "Delete Account Rate Limited")) {
    return { success: false, error: "Too many attempts. Please wait a few minutes and try again." };
  }
  const password = String(p.password == null ? "" : p.password);
  if (!password) return { success: false, needsPassword: true, error: "Enter your password to delete your account." };
  if (!verifyPassword_(password, auth.found.row[1]).ok) return { success: false, error: "Password is incorrect." };
  if (userIsAlsoAdmin_(username, auth.found.row[1])) {
    return { success: false, error: "This account also has admin access. Ask the main admin to remove the admin role first." };
  }

  return withLock_(() => {
    const sheet = getUsersSheet_();
    const found = findUserRow_(sheet, username);
    if (!found) return { success: false, error: "Account not found." };
    if (!verifyUserToken_(found, p.token)) return { success: false, error: "Session expired. Please log in again.", sessionInvalid: true };

    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(USERS_SHEET);
    const cleanup = purgeUserAuxiliaryRows_(username);
    logAction_("system", "Self-Delete Account", DELETED_USER_LABEL,
      "Student deleted their own account. Drive files trashed: " + cleanup.driveFilesTrashed);
    return { success: true, deleted: true, message: "Your account and its data have been deleted." };
  });
}

/* Student clears THEIR OWN cloud progress (Progress row + admin-made
   progress snapshots + history). The account, payment record and
   weekly-set / written-answer history stay. */
function resetMyProgress(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;

  if (String(p.confirm || "").trim().toUpperCase() !== "RESET") {
    return { success: false, error: "Type RESET to confirm." };
  }
  if (!checkRateLimit_("resetprog_" + username.toLowerCase(), 5, 10 * 60 * 1000, "Reset Progress Rate Limited")) {
    return { success: false, error: "Too many attempts. Please wait a few minutes and try again." };
  }

  return withLock_(() => {
    const target = String(username).toLowerCase().trim();
    const progress = deleteRowsForUser_(PROGRESS_SHEET, getProgressSheet_, 0, target);
    const backups = deleteRowsForUser_(PROGRESS_BACKUPS_SHEET, getProgressBackupsSheet_, 2, target);
    const history = deleteRowsForUser_(PROGRESS_HISTORY_SHEET, getProgressHistorySheet_, 0, target);
    logAction_("system", "Self-Reset Progress", username, "Cleared cloud progress rows: " + progress + ", snapshots: " + backups + ", history: " + history);
    return { success: true, cleared: { progress, snapshots: backups, history } };
  });
}

function purgeUserSheetRows_(username) {
  if (!username) return;
  const target = String(username).toLowerCase().trim();

  const map = [
    [PROGRESS_SHEET, getProgressSheet_, 0],
    [PUSHTOKENS_SHEET, getPushTokensSheet_, 0],
    [PAYMENTS_SHEET, getPaymentsSheet_, 0],
    [PROGRESS_BACKUPS_SHEET, getProgressBackupsSheet_, 2],
    [PROGRESS_HISTORY_SHEET, getProgressHistorySheet_, 0],
    [WEEKLYATTEMPTS_SHEET, getWeeklyAttemptsSheet_, 0],
    [WEEKLYSTARTS_SHEET, getWeeklyStartsSheet_, 0],
    [SUBJ_SUBMISSIONS_SHEET, getSubjSubmissionsSheet_, 1]
  ];

  map.forEach(([name, getter, colIdx]) => {
    try {
      const sheet = getter();
      const data = sheet.getDataRange().getValues();
      for (let i = data.length - 1; i >= 1; i--) {
        if (String(data[i][colIdx]).toLowerCase().trim() === target) sheet.deleteRow(i + 1);
      }
      _invalidateSheet_(name);
    } catch (e) { console.error("purgeUserSheetRows_: " + name + " failed:", e); }
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   ADMIN — PAYMENTS
   ═══════════════════════════════════════════════════════════════════════ */

function adminListPayments(p) {
  const chk = checkAdminCan_(p, "payments_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(PAYMENTS_SHEET, getPaymentsSheet_).data;
  const totalCount = Math.max(0, data.length - 1);

  const txIdOwners = {};
  for (let i = 1; i < data.length; i++) {
    const txId = String(data[i][4] || "").trim().toLowerCase();
    const username = String(data[i][0] || "");
    if (!txId) continue;
    if (!txIdOwners[txId]) txIdOwners[txId] = new Set();
    txIdOwners[txId].add(username);
  }

  const limit = Math.min(totalCount, MAX_LIST_PAYMENTS);
  const payments = [];
  for (let i = data.length - 1; i >= data.length - limit; i--) {
    const txId = String(data[i][4] || "");
    const username = String(data[i][0] || "");
    const owners = txIdOwners[txId.trim().toLowerCase()];
    const shared = owners ? [...owners].filter(u => u !== username) : [];
    payments.push({
      username, name: data[i][1], email: data[i][2],
      mobile: String(data[i][3] || ""), txId, remarks: data[i][5],
      status: data[i][6], rejectionReason: data[i][7], screenshotUrl: data[i][8],
      submittedAt: data[i][9], reviewedAt: data[i][10],
      duplicateTxId: shared.length > 0, duplicateTxIdUsers: shared
    });
  }
  return { success: true, payments, totalCount, truncated: totalCount > MAX_LIST_PAYMENTS };
}

function adminReviewPayment(p) {
  const chk = checkAdminCan_(p, "payments_review");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const username = String(p.username || "").trim();
  const status = String(p.status || "").trim();
  const reason = sanitizeSheetField_(String(p.rejectionReason || "").trim().slice(0, 500));
  if (!username || !status) return { success: false, error: "Username and status required." };
  if (["verified", "rejected", "pending"].indexOf(status) === -1) return { success: false, error: "Status must be verified, rejected, or pending." };

  return withLock_(() => {
    const paySheet = getPaymentsSheet_();
    const data = paySheet.getDataRange().getValues();
    let paymentRow = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === username.toLowerCase()) { paymentRow = i + 1; break; }
    }
    if (!paymentRow) return { success: false, error: "Payment not found." };

    const nowIso = new Date().toISOString();
    paySheet.getRange(paymentRow, 7).setValue(status);
    if (reason && status === "rejected") paySheet.getRange(paymentRow, 8).setValue(reason);
    paySheet.getRange(paymentRow, 11).setValue(nowIso);
    _invalidateSheet_(PAYMENTS_SHEET);

    const userSheet = getUsersSheet_();
    const userFound = findUserRow_(userSheet, username);
    if (userFound) {
      if (status === "verified") {
        userSheet.getRange(userFound.rowIndex, 8).setValue("active");
        userSheet.getRange(userFound.rowIndex, 13).setValue("verified");
        userSheet.getRange(userFound.rowIndex, 14).setValue("true");
        userSheet.getRange(userFound.rowIndex, 10).setValue(nowIso);
        userSheet.getRange(userFound.rowIndex, 15).setValue("permanent");
        userSheet.getRange(userFound.rowIndex, 16).setValue("");
      } else if (status === "rejected") {
        userSheet.getRange(userFound.rowIndex, 8).setValue("expired");
        userSheet.getRange(userFound.rowIndex, 13).setValue("rejected");
        userSheet.getRange(userFound.rowIndex, 14).setValue("false");
      } else if (status === "pending") {
        userSheet.getRange(userFound.rowIndex, 8).setValue("payment_pending");
        userSheet.getRange(userFound.rowIndex, 13).setValue("pending");
        userSheet.getRange(userFound.rowIndex, 14).setValue("false");
      }
      _invalidateSheet_(USERS_SHEET);
    }

    logAction_(actor, "Review Payment", username, "Status: " + status + (reason ? " (" + reason + ")" : ""));

    if (status === "verified" || status === "rejected") {
      try {
        sendPushNotification_(username,
          status === "verified" ? "Payment verified! 🎉" : "Payment rejected",
          status === "verified"
            ? "Your payment has been verified. You now have full access to Abhyas."
            : "Your payment was rejected" + (reason ? ": " + reason : ". Please check and resubmit."));
      } catch (err) {}
    }
    return { success: true, username, status };
  });
}

/* Batch review: reads/writes only the Payments columns 7..11 and the Users
   columns 8..16 (never the token columns). */
function adminReviewPaymentsBatch(p) {
  const chk = checkAdminCan_(p, "payments_bulk");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  let usernames;
  try { usernames = Array.isArray(p.usernames) ? p.usernames : JSON.parse(p.usernames || "[]"); }
  catch (e) { return { success: false, error: "usernames must be a JSON array." }; }
  if (!Array.isArray(usernames) || !usernames.length) return { success: false, error: "No usernames provided." };
  if (usernames.length > 1000) return { success: false, error: "Limit is 1000 usernames per batch." };

  const status = String(p.status || "").trim();
  const reason = sanitizeSheetField_(String(p.rejectionReason || "").trim().slice(0, 500));
  if (["verified", "rejected", "pending"].indexOf(status) === -1) return { success: false, error: "Status must be verified, rejected, or pending." };

  return withLock_(() => {
    const paySheet = getPaymentsSheet_();
    const payN = Math.max(0, paySheet.getLastRow() - 1);
    const payKeys = payN ? paySheet.getRange(2, 1, payN, 1).getValues() : [];
    const payBlock = payN ? paySheet.getRange(2, 7, payN, 5).getValues() : [];   // cols 7..11
    const payIdxByUser = {};
    for (let i = 0; i < payN; i++) payIdxByUser[String(payKeys[i][0]).toLowerCase().trim()] = i;

    const userSheet = getUsersSheet_();
    const userN = Math.max(0, userSheet.getLastRow() - 1);
    const userKeys = userN ? userSheet.getRange(2, 1, userN, 1).getValues() : [];
    const userBlock = userN ? userSheet.getRange(2, 8, userN, 9).getValues() : [];  // cols 8..16
    const userIdxByUser = {};
    for (let i = 0; i < userN; i++) userIdxByUser[String(userKeys[i][0]).toLowerCase().trim()] = i;

    const nowIso = new Date().toISOString();
    const results = [];
    let paymentsChanged = false, usersChanged = false;

    usernames.forEach(raw => {
      const u = String(raw || "").trim();
      const pIdx = payIdxByUser[u.toLowerCase()];
      if (pIdx === undefined) { results.push({ username: u, success: false, error: "Payment not found." }); return; }

      const pr = payBlock[pIdx];
      pr[0] = status;                                  // col 7
      if (reason && status === "rejected") pr[1] = reason;   // col 8
      pr[4] = nowIso;                                  // col 11
      paymentsChanged = true;

      const uIdx = userIdxByUser[u.toLowerCase()];
      if (uIdx !== undefined) {
        const ur = userBlock[uIdx];
        if (status === "verified") {
          ur[0] = "active"; ur[5] = "verified"; ur[6] = "true";
          ur[2] = nowIso; ur[7] = "permanent"; ur[8] = "";
        } else if (status === "rejected") {
          ur[0] = "expired"; ur[5] = "rejected"; ur[6] = "false";
        } else if (status === "pending") {
          ur[0] = "payment_pending"; ur[5] = "pending"; ur[6] = "false";
        }
        usersChanged = true;
      }
      results.push({ username: u, success: true });
    });

    if (paymentsChanged) {
      paySheet.getRange(2, 7, payN, 5).setValues(payBlock);
      _invalidateSheet_(PAYMENTS_SHEET);
    }
    if (usersChanged) {
      userSheet.getRange(2, 8, userN, 9).setValues(userBlock);
      _invalidateSheet_(USERS_SHEET);
    }

    const okCount = results.filter(r => r.success).length;
    logAction_(actor, "Bulk Review Payment", usernames.join(", ").slice(0, 2000),
      "Status: " + status + (reason ? " (" + reason + ")" : "") + " — " + okCount + "/" + usernames.length + " succeeded");

    if (status === "verified" || status === "rejected") {
      results.filter(r => r.success).forEach(r => {
        try {
          sendPushNotification_(r.username,
            status === "verified" ? "Payment verified! 🎉" : "Payment rejected",
            status === "verified" ? "Your payment has been verified. You now have full access to Abhyas."
                                  : "Your payment was rejected" + (reason ? ": " + reason : ". Please check and resubmit."));
        } catch (err) {}
      });
    }
    return { success: true, status, results };
  });
}

function adminDeletePayment(p) {
  const chk = checkAdminCan_(p, "payments_review");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  return withLock_(() => {
    const sheet = getPaymentsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
        sheet.deleteRow(i + 1);
        _invalidateSheet_(PAYMENTS_SHEET);
        logAction_(actor, "Delete Payment", username, "");
        return { success: true, deleted: username };
      }
    }
    return { success: false, error: "Payment not found." };
  });
}

function adminRevokeScreenshotSharing(p) {
  const chk = checkAdminCan_(p, "maintenance");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const iter = DriveApp.getFoldersByName("PaymentScreenshots");
  if (!iter.hasNext()) return { success: true, processed: 0, revoked: 0, alreadyPrivate: 0, failed: 0, message: "No PaymentScreenshots folder yet." };
  const folder = iter.next();
  const files = folder.getFiles();
  let processed = 0, revoked = 0, alreadyPrivate = 0, failed = 0;
  while (files.hasNext()) {
    processed++;
    const f = files.next();
    try {
      if (f.getSharingAccess() === DriveApp.Access.PRIVATE) { alreadyPrivate++; continue; }
      f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      revoked++;
    } catch (e) { failed++; console.error("revoke sharing failed for " + f.getId(), e); }
  }
  logAction_(actor, "Revoke Screenshot Sharing", "",
    `Processed ${processed}, revoked ${revoked}, already-private ${alreadyPrivate}, failed ${failed}`);
  return { success: true, processed, revoked, alreadyPrivate, failed };
}

function adminExpiringTrials(p) {
  const chk = checkAdminCan_(p, "dashboard");
  if (!chk.ok) return { success: false, error: chk.error };
  const hours = Math.max(1, Math.min(168, Number(p.hours) || 24));
  const data = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const now = Date.now();
  const cutoff = now + hours * 60 * 60 * 1000;
  const users = [];
  for (let i = 1; i < data.length; i++) {
    const u = rowToUser_(data[i]);
    if (u.status !== "trial" || !u.trialExpiresAt) continue;
    const t = new Date(u.trialExpiresAt).getTime();
    if (isNaN(t) || t <= now || t > cutoff) continue;
    users.push(u);
  }
  users.sort((a, b) => new Date(a.trialExpiresAt) - new Date(b.trialExpiresAt));
  return { success: true, hours, count: users.length, users };
}

/* ═══════════════════════════════════════════════════════════════════════
   ADMIN — STATS / LOGS / TRENDS
   ═══════════════════════════════════════════════════════════════════════ */

/* v1.43: switched from a per-execution variable to CacheService. Apps
   Script runs each request in a fresh context, so a module-level `let`
   cache never hits between requests. The dashboard polls this every 60
   seconds; a 30-second cache is short enough that a new signup still
   appears promptly, and long enough that the poll does not re-read every
   row of Users and Payments on every call. */
function adminStats(p) {
  const chk = checkAdminCan_(p, "dashboard");
  if (!chk.ok) return { success: false, error: chk.error };

  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get("admin_stats_v1");
    if (hit) return JSON.parse(hit);
  } catch (e) {}

  const userData = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const payData = _cachedSheetData_(PAYMENTS_SHEET, getPaymentsSheet_).data;

  let total = 0, trial = 0, active = 0, expired = 0, pendingPay = 0;
  for (let i = 1; i < userData.length; i++) {
    total++;
    const s = userData[i][7];
    if (s === "trial") trial++;
    else if (s === "active") active++;
    else if (s === "expired") expired++;
    else if (s === "payment_pending") pendingPay++;
  }
  let totalPay = 0, pending = 0, verified = 0, rejected = 0;
  for (let i = 1; i < payData.length; i++) {
    totalPay++;
    const s = payData[i][6];
    if (s === "pending") pending++;
    else if (s === "verified") verified++;
    else if (s === "rejected") rejected++;
  }
  const payload = {
    success: true,
    stats: {
      users: { total, trial, active, expired, paymentPending: pendingPay },
      payments: { total: totalPay, pending, verified, rejected }
    }
  };
  try { cache.put("admin_stats_v1", JSON.stringify(payload), 30); } catch (e) {}
  return payload;
}

function adminListLogs(p) {
  const chk = checkAdminCan_(p, "logs_view");
  if (!chk.ok) return { success: false, error: chk.error };

  const sheet = getLogsSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true, logs: [] };
  const totalDataRows = lastRow - 1;
  const rowsToRead = Math.min(totalDataRows, LOGS_MAX_ROWS_READ);
  const startRow = lastRow - rowsToRead + 1;
  const data = sheet.getRange(startRow, 1, rowsToRead, LOG_HEADERS.length).getValues();
  const logs = data.map(row => ({ timestamp: row[0], admin: row[1], action: row[2], target: row[3], details: row[4] })).reverse();
  return { success: true, logs, totalCount: totalDataRows, truncated: totalDataRows > LOGS_MAX_ROWS_READ };
}

/* Sign-ups and payments per day (Nepal time) plus the headline numbers. */
function adminTrends(p) {
  const chk = checkAdminCan_(p, "dashboard");
  if (!chk.ok) return { success: false, error: chk.error };
  const days = Math.max(7, Math.min(90, Number(p.days) || 30));
  const data = _cachedSheetData_(USERS_SHEET, getUsersSheet_).data;
  const tz = "Asia/Kathmandu";
  const dayKey = t => Utilities.formatDate(new Date(t), tz, "yyyy-MM-dd");

  const series = [], byKey = {};
  const nowMs = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(nowMs - i * 86400000);
    if (!byKey[k]) { byKey[k] = { date: k, signups: 0, paid: 0 }; series.push(byKey[k]); }
  }

  let total = 0, paid = 0, trial = 0, awaiting = 0, notPaid = 0, periodSignups = 0, periodPaid = 0;
  for (let i = 1; i < data.length; i++) {
    total++;
    const status = String(data[i][7] || "");
    const created = new Date(data[i][8]).getTime();
    const approved = new Date(data[i][9]).getTime();
    if (status === "active") paid++;
    else if (status === "trial") trial++;
    else if (status === "payment_pending") awaiting++;
    else if (status === "expired" || status === "rejected") notPaid++;
    if (!isNaN(created)) { const b = byKey[dayKey(created)]; if (b) { b.signups++; periodSignups++; } }
    if (status === "active" && !isNaN(approved)) { const b = byKey[dayKey(approved)]; if (b) { b.paid++; periodPaid++; } }
  }
  const amount = Number(getSettingValue_("paymentAmount", 100)) || 0;
  return {
    success: true, days, series,
    totals: {
      total, paid, trial, awaiting, notPaid,
      paidRate: total ? Math.round((paid / total) * 100) : 0,
      periodSignups, periodPaid, amount, revenueEstimate: paid * amount
    }
  };
}

function adminMostMissedQuestions(p) {
  const chk = checkAdminCan_(p, "dashboard");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const filters = {
    level: safeImportString_(p.level, 120),
    chapter: safeImportString_(p.chapter, 200),
    book: safeImportString_(p.book, 200),
    subtopic: safeImportString_(p.subtopic, 200),
    dateFrom: safeImportString_(p.dateFrom, 30),
    dateTo: safeImportString_(p.dateTo, 30),
    minAttempts: Math.max(1, Math.min(MAX_REPORT_MIN_ATTEMPTS, Number(p.minAttempts) || 3)),
    limit: Math.max(1, Math.min(MAX_REPORT_LIMIT, Number(p.limit) || 30))
  };

  const fromTime = parseReportDateFrom_(filters.dateFrom);
  const toTime = parseReportDateTo_(filters.dateTo);
  if (filters.dateFrom && fromTime === null) return { success: false, error: "dateFrom must use YYYY-MM-DD format." };
  if (filters.dateTo && toTime === null) return { success: false, error: "dateTo must use YYYY-MM-DD format." };
  if (fromTime !== null && toTime !== null && fromTime > toTime) return { success: false, error: "dateFrom cannot be later than dateTo." };

  const data = _cachedSheetData_(PROGRESS_SHEET, getProgressSheet_).data;
  const totalRows = Math.max(0, data.length - 1);
  const rowsToScan = Math.min(totalRows, MAX_MISSED_SCAN_ROWS);
  const tally = {};

  for (let i = 1; i <= rowsToScan; i++) {
    const username = String(data[i][0] || "").trim();
    const raw = data[i][1];
    if (!username || !raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { continue; }
    const sessions = (parsed && parsed.prog && Array.isArray(parsed.prog.sessions)) ? parsed.prog.sessions : [];
    for (const session of sessions) {
      if (!session || typeof session !== "object") continue;
      const sessionTime = normalizeReportTime_(session.at);
      if (sessionTime !== null && fromTime !== null && sessionTime < fromTime) continue;
      if (sessionTime !== null && toTime !== null && sessionTime > toTime) continue;
      const qres = Array.isArray(session.qres) ? session.qres : [];
      for (const qr of qres) {
        if (!qr || !qr.uid) continue;
        const metadata = reportMetadataForQuestion_(qr, session);
        if (!reportMetadataMatches_(metadata, filters)) continue;
        const uid = String(qr.uid);
        if (!tally[uid]) {
          tally[uid] = {
            uid, fileId: reportFileIdFromUid_(uid), index: reportIndexFromUid_(uid),
            level: metadata.level, chapter: metadata.chapter, book: metadata.book, subtopic: metadata.subtopic,
            wrong: 0, total: 0, students: {}, lastAttemptAt: null
          };
        }
        const record = tally[uid];
        record.total++;
        if (!qr.ok) record.wrong++;
        record.students[username] = true;
        const attemptTime = normalizeReportTime_(qr.at || session.at);
        if (attemptTime !== null && (record.lastAttemptAt === null || attemptTime > record.lastAttemptAt)) record.lastAttemptAt = attemptTime;
        if (!record.level && metadata.level) record.level = metadata.level;
        if (!record.chapter && metadata.chapter) record.chapter = metadata.chapter;
        if (!record.book && metadata.book) record.book = metadata.book;
        if (!record.subtopic && metadata.subtopic) record.subtopic = metadata.subtopic;
      }
    }
  }

  const results = Object.keys(tally).map(uid => {
    const r = tally[uid];
    const studentCount = Object.keys(r.students).length;
    return {
      uid: r.uid, fileId: r.fileId, index: r.index,
      level: r.level || "", chapter: r.chapter || "", book: r.book || "", subtopic: r.subtopic || "",
      wrong: r.wrong, total: r.total,
      wrongRate: r.total ? Math.round((r.wrong / r.total) * 100) : 0,
      accuracy: r.total ? Math.round(((r.total - r.wrong) / r.total) * 100) : 0,
      uniqueStudents: studentCount,
      lastAttemptAt: r.lastAttemptAt ? new Date(r.lastAttemptAt).toISOString() : ""
    };
  })
  .filter(r => r.total >= filters.minAttempts && r.fileId !== "local")
  .sort((a, b) => b.wrongRate - a.wrongRate || b.total - a.total || b.uniqueStudents - a.uniqueStudents)
  .slice(0, filters.limit);

  logAction_(actor, "View Filtered Question Report", "", JSON.stringify(filters).slice(0, 1000));
  return {
    success: true, results, filters, minAttempts: filters.minAttempts, limit: filters.limit,
    generatedAt: new Date().toISOString(),
    truncated: totalRows > MAX_MISSED_SCAN_ROWS,
    totalRowsScanned: rowsToScan, totalRowsAvailable: totalRows
  };
}

function reportMetadataForQuestion_(qr, session) {
  const meta = (qr && qr.meta && typeof qr.meta === "object") ? qr.meta : {};
  return {
    level: String(qr.level || meta.level || qr.lv || session.lv || "").trim(),
    chapter: String(qr.chapterKey || meta.chapterKey || session.chapterKey
      || qr.chapter || meta.chapter || qr.ch || session.ch || session.chapter || "").trim(),
    book: String(qr.book || meta.book || session.book || "").trim(),
    subtopic: String(qr.subtopic || meta.subtopic || qr.sub || session.sub || "").trim()
  };
}
function reportMetadataMatches_(m, f) {
  if (f.level && m.level.toLowerCase() !== f.level.toLowerCase()) return false;
  if (f.chapter && m.chapter.toLowerCase() !== f.chapter.toLowerCase()) return false;
  if (f.book && m.book.toLowerCase() !== f.book.toLowerCase()) return false;
  if (f.subtopic && m.subtopic.toLowerCase() !== f.subtopic.toLowerCase()) return false;
  return true;
}
function parseReportDateFrom_(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d.getTime();
}
function parseReportDateTo_(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T23:59:59.999Z");
  return isNaN(d.getTime()) ? null : d.getTime();
}
function normalizeReportTime_(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return isFinite(value) ? value : null;
  const n = Number(value);
  if (!isNaN(n) && n > 0) return n;
  const p = new Date(String(value));
  return isNaN(p.getTime()) ? null : p.getTime();
}
function reportFileIdFromUid_(uid) {
  const s = String(uid || "");
  const m = s.match(/^(.+)_(\d+)$/);
  return m ? m[1] : s;
}
function reportIndexFromUid_(uid) {
  const s = String(uid || "");
  const m = s.match(/^(.+)_(\d+)$/);
  return m ? Number(m[2]) : null;
}

/* ═══════════════════════════════════════════════════════════════════════
   STUDY PDFs
   ═══════════════════════════════════════════════════════════════════════ */

/* Pure: validate and clean the text fields of an upload or edit. */
function normalizeStudyDocMeta_(p, requireTitle) {
  const title = sanitizeSheetField_(String(p.title == null ? "" : p.title).replace(/\s+/g, " ").trim().slice(0, 120));
  if (requireTitle && !title) return { error: "Give the PDF a title." };
  const category = String(p.category == null ? "model-answer" : p.category).trim().toLowerCase();
  if (STUDYDOC_CATEGORIES.indexOf(category) === -1) return { error: "Unknown category." };
  const chapterId = String(p.chapterId == null ? "" : p.chapterId).trim().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
  const description = sanitizeSheetField_(String(p.description == null ? "" : p.description).replace(/[\r\n]+/g, " ").trim().slice(0, 400));
  const rawSort = (p.sortOrder === undefined || p.sortOrder === null || String(p.sortOrder).trim() === "") ? NaN : Number(p.sortOrder);
  let sortOrder = isFinite(rawSort) ? rawSort : 100;
  sortOrder = Math.max(0, Math.min(9999, Math.round(sortOrder)));
  return { value: { title, category, chapterId, description, sortOrder } };
}

/* Pure: newest-first inside each sort order, so a new upload is easy to spot. */
function sortStudyDocs_(docs) {
  return docs.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || (b.uploadedAt - a.uploadedAt));
}

function listStudyDocs(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const data = _cachedSheetData_(STUDYDOCS_SHEET, getStudyDocsSheet_).data;
  const docs = [];
  for (let i = 1; i < data.length; i++) {
    if (!String(data[i][0] || "").trim()) continue;
    const d = rowToStudyDoc_(data[i], false);
    if (d.status === "published" && String(data[i][5] || "").trim()) docs.push(d);
  }
  return { success: true, docs: sortStudyDocs_(docs) };
}

function getStudyDocPdf(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Document id required." };
  if (!checkRateLimit_("studydoc_" + auth.username.toLowerCase(), 30, 60000)) {
    return { success: false, error: "Too many requests — please slow down." };
  }
  const found = _findRowFast_(getStudyDocsSheet_(), 1, id);
  if (!found || String(found.row[8] || "published") !== "published") return { success: false, error: "That document isn't available." };
  const out = _pdfPayload_(String(found.row[5] || "").trim(), String(found.row[6] || "study.pdf"));
  if (out.success) out.title = String(found.row[1] || "");
  return out;
}

function adminListStudyDocs(p) {
  const chk = checkAdminCan_(p, "studydocs_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = getStudyDocsSheet_().getDataRange().getValues();
  const docs = [];
  for (let i = 1; i < data.length; i++) { if (String(data[i][0] || "").trim()) docs.push(rowToStudyDoc_(data[i], true)); }
  return { success: true, docs: sortStudyDocs_(docs), categories: STUDYDOC_CATEGORIES };
}

function adminAddStudyDoc(p) {
  const chk = checkAdminCan_(p, "studydocs_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const meta = normalizeStudyDocMeta_(p, true);
  if (meta.error) return { success: false, error: meta.error };
  const pdfData = String(p.pdfData || "");
  if (pdfData.indexOf("data:") !== 0) return { success: false, error: "Choose a PDF file to upload." };
  if (pdfData.length > MAX_STUDYDOC_DATA_CHARS) return { success: false, error: "PDF too large — keep it under about 10 MB." };
  if (!checkRateLimit_("studydocadd_" + String(chk.actor).toLowerCase(), 30, 60 * 60 * 1000)) {
    return { success: false, error: "Too many uploads — wait a little and try again." };
  }
  const parsed = parsePdfDataUrl_(pdfData, MAX_STUDYDOC_DATA_CHARS);
  if (parsed.error) return { success: false, error: parsed.error };

  const id = Utilities.getUuid();
  const safeBase = meta.value.title.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "study";
  const fileName = safeBase + ".pdf";
  let fileId = "";
  try {
    const file = getOrCreateSystemFolder_("StudyDocs").createFile(Utilities.newBlob(parsed.bytes, "application/pdf", id.slice(0, 8) + "_" + fileName));
    fileId = file.getId();
  } catch (e) { return { success: false, error: "Drive upload failed: " + (e.message || e) }; }

  return withLock_(() => {
    const now = Date.now();
    getStudyDocsSheet_().appendRow([
      id, meta.value.title, meta.value.category, meta.value.chapterId, meta.value.description,
      fileId, fileName, parsed.bytes.length, (p.publish === false || p.publish === "false") ? "hidden" : "published",
      meta.value.sortOrder, chk.actor, now, now
    ]);
    _invalidateSheet_(STUDYDOCS_SHEET);
    logAction_(chk.actor, "Study PDF Added", meta.value.title, meta.value.category + " · " + parsed.bytes.length + " bytes");
    return { success: true, id };
  });
}

function adminUpdateStudyDoc(p) {
  const chk = checkAdminCan_(p, "studydocs_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Document id required." };
  const meta = normalizeStudyDocMeta_(p, true);
  if (meta.error) return { success: false, error: meta.error };
  const status = String(p.status || "published") === "hidden" ? "hidden" : "published";
  return withLock_(() => {
    const sheet = getStudyDocsSheet_();
    const found = _findRowFast_(sheet, 1, id);
    if (!found) return { success: false, error: "Document not found." };
    sheet.getRange(found.rowIndex, 2, 1, 4).setValues([[meta.value.title, meta.value.category, meta.value.chapterId, meta.value.description]]);
    sheet.getRange(found.rowIndex, 9, 1, 2).setValues([[status, meta.value.sortOrder]]);
    sheet.getRange(found.rowIndex, 13).setValue(Date.now());
    _invalidateSheet_(STUDYDOCS_SHEET);
    logAction_(chk.actor, "Study PDF Edited", meta.value.title, status);
    return { success: true };
  });
}

function adminDeleteStudyDoc(p) {
  const chk = checkAdminCan_(p, "studydocs_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Document id required." };
  return withLock_(() => {
    const sheet = getStudyDocsSheet_();
    const found = _findRowFast_(sheet, 1, id);
    if (!found) return { success: false, error: "Document not found." };
    const fileId = String(found.row[5] || "").trim();
    const title = String(found.row[1] || "");
    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(STUDYDOCS_SHEET);
    if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) {} }
    logAction_(chk.actor, "Study PDF Deleted", title, id);
    return { success: true };
  });
}

function adminDownloadStudyDoc(p) {
  const chk = checkAdminCan_(p, "studydocs_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "Document id required." };
  const found = _findRowFast_(getStudyDocsSheet_(), 1, id);
  if (!found) return { success: false, error: "Document not found." };
  return _pdfPayload_(String(found.row[5] || "").trim(), String(found.row[6] || "study.pdf"));
}

/* ═══════════════════════════════════════════════════════════════════════
   SUBJECTIVE — ADMIN
   ═══════════════════════════════════════════════════════════════════════ */

/* Accepts YYYY-MM-DD, an ISO string, or epoch milliseconds. */
function _submissionDayBound_(value, endOfDay) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + (endOfDay ? "T23:59:59.999" : "T00:00:00.000"));
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const n = Number(raw);
  if (!isNaN(n) && n > 0) return n;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function adminListSubjectiveSubmissions(p) {
  const chk = checkAdminCan_(p, "subjective_view");
  if (!chk.ok) return { success: false, error: chk.error };

  const data = _cachedSheetData_(SUBJ_SUBMISSIONS_SHEET, getSubjSubmissionsSheet_).data;
  const totalCount = Math.max(0, data.length - 1);
  const statusFilter  = String(p.status || "").trim();
  const chapterFilter = String(p.chapterId || "").trim();
  const kindFilter    = String(p.kind || "").trim();
  const from = _submissionDayBound_(p.dateFrom, false);
  const to   = _submissionDayBound_(p.dateTo, true);
  if (p.dateFrom && from === null) return { success: false, error: "dateFrom is not a valid date." };
  if (p.dateTo && to === null)     return { success: false, error: "dateTo is not a valid date." };

  const out = [];
  let matched = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    const s = rowToSubjSubmission_(data[i]);
    if (statusFilter && s.status !== statusFilter) continue;
    if (chapterFilter && s.chapterId !== chapterFilter) continue;
    if (kindFilter && (s.kind || "qotd") !== kindFilter) continue;
    if (from !== null && !(s.submittedAt >= from)) continue;
    if (to !== null && !(s.submittedAt <= to)) continue;
    matched++;
    if (out.length < MAX_SUBJ_SUBMISSIONS) out.push(s);
  }
  return {
    success: true, submissions: out,
    totalCount, matchedCount: matched,
    truncated: matched > out.length
  };
}

function adminGradeSubjectiveSubmission(p) {
  const chk = checkAdminCan_(p, "subjective_grade");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const id = String(p.id || "").trim();
  const score = Number(p.score);
  const feedback = sanitizeSheetField_(String(p.feedback || "").trim().slice(0, 2000));
  if (!id) return { success: false, error: "id required." };
  if (!isFinite(score) || score < 0) return { success: false, error: "Valid score required." };

  return withLock_(() => {
    const sheet = getSubjSubmissionsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === id) {
        const maxMarks = Number(data[i][5]) || 100;
        const clamped = Math.min(score, maxMarks);
        sheet.getRange(i + 1, 13, 1, 5).setValues([["graded", clamped, feedback, actor, new Date().toISOString()]]);
        _invalidateSheet_(SUBJ_SUBMISSIONS_SHEET);
        logAction_(actor, "Grade Subjective", String(data[i][1]), id + " → " + clamped + "/" + maxMarks);
        try {
          sendPushNotification_(String(data[i][1]), "Subjective answer graded",
            "You scored " + clamped + "/" + maxMarks + ". Open the app to see feedback.");
        } catch (e) {}
        return { success: true, id, score: clamped, maxMarks };
      }
    }
    return { success: false, error: "Submission not found." };
  });
}

function adminUploadSubjectiveFile(p) {
  const chk = checkAdminCan_(p, "subjective_import");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const fileData = String(p.fileData || "");
  const filename = String(p.filename || "subjective.json").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "subjective.json";
  if (!fileData) return { success: false, error: "No file data provided." };
  if (fileData.length > 5 * 1024 * 1024) return { success: false, error: "File too large — should be well under 4MB." };

  let jsonText, parsed;
  try {
    jsonText = fileData.indexOf("data:") === 0
      ? Utilities.newBlob(Utilities.base64Decode(fileData.split(",")[1])).getDataAsString("UTF-8")
      : fileData;
    parsed = JSON.parse(jsonText);
  } catch (e) { return { success: false, error: "That file isn't valid JSON — check the format." }; }

  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.questions) ? parsed.questions : null);
  if (!arr || !arr.length) return { success: false, error: "No questions found — file must be an array or {questions:[...]}." };
  const badMarks = arr.filter(q => q && q.q && [5,10].indexOf(Number(q.marks)) === -1).length;

  try {
    const blob = Utilities.newBlob(jsonText, "application/json", filename);
    const folder = getOrCreateFolder_("SubjectiveQuestions");
    const file = folder.createFile(blob);
    logAction_(actor, "Upload Subjective File", filename, "fileId: " + file.getId());
    return {
      success: true, fileId: file.getId(), filename: file.getName(),
      questionCount: arr.length,
      warning: badMarks > 0 ? badMarks + " question(s) don't have marks of 5 or 10 — they'll display as 10 marks." : null
    };
  } catch (e) { return { success: false, error: "Drive upload failed: " + (e.message || e) }; }
}

function adminCommitSubjectiveImport(p) {
  const chk = checkAdminCan_(p, "subjective_import");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const fileId = String(p.fileId || "").trim();
  if (!fileId) return { success: false, error: "fileId required." };

  const sectionName = String(p.section || "").trim();

  let items;
  try { items = (Array.isArray(p.items)) ? p.items : JSON.parse(p.items || "[]"); }
  catch (e) { return { success: false, error: "items must be a JSON array." }; }
  if (!Array.isArray(items) || !items.length) return { success: false, error: "No items to insert." };
  if (items.length > 500) return { success: false, error: "Limit is 500 items per commit." };

  return withLock_(() => {
    let file;
    try { file = DriveApp.getFileById(fileId); }
    catch (e) { return { success: false, error: "Could not open target Drive file: " + (e.message || e) }; }

    let existing;
    try { existing = JSON.parse(file.getBlob().getDataAsString("UTF-8")); }
    catch (e) { return { success: false, error: "Target file isn't valid JSON." }; }

    let baseArr;
    let wrapper = null;
    let targetSectionLabel = "UNCLASSIFIED (Smart Paste)";

    if (Array.isArray(existing)) {
      baseArr = existing.slice();
    } else if (existing && Array.isArray(existing.sections)) {
      const sections = existing.sections.map(s => ({
        section: String(s.section || "General"),
        questions: Array.isArray(s.questions) ? s.questions.slice() : []
      }));
      const wanted = sectionName || "UNCLASSIFIED (Smart Paste)";
      targetSectionLabel = wanted;
      let target = sections.find(s => s.section === wanted);
      if (!target) {
        target = { section: wanted, questions: [] };
        sections.push(target);
      }
      baseArr = target.questions;
      wrapper = Object.assign({}, existing);
      wrapper.sections = sections;
    } else if (existing && Array.isArray(existing.questions)) {
      baseArr = existing.questions.slice();
      wrapper = Object.assign({}, existing);
    } else {
      return { success: false, error: "Unsupported file shape." };
    }

    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
    const seen = new Set();
    baseArr.forEach(q => { if (q && q.q) seen.add(norm(q.q)); });

    let inserted = 0, skipped = 0;
    items.forEach(it => {
      const text = String(it.question || it.q || "").trim();
      if (!text) { skipped++; return; }
      const key = norm(text);
      if (seen.has(key)) { skipped++; return; }
      seen.add(key);

      const marksRaw = Number(it.marks) || 10;
      const marks = (marksRaw === 5 || marksRaw === 10) ? marksRaw : 10;

      baseArr.push({ type: "subjective", chapter: targetSectionLabel, q: text, marks });
      inserted++;
    });

    if (!inserted) {
      return { success: true, fileId, inserted: 0, skipped,
               message: "All items were duplicates." };
    }

    const newContent = wrapper
      ? JSON.stringify(wrapper, null, 2)
      : JSON.stringify(baseArr, null, 2);

    try { file.setContent(newContent); }
    catch (e) { return { success: false, error: "Could not write to file: " + (e.message || e) }; }

    logAction_(actor, "Commit Subjective Import", file.getName(),
      inserted + " into \"" + targetSectionLabel + "\", " + skipped + " skipped");
    return { success: true, fileId, filename: file.getName(), inserted, skipped, section: targetSectionLabel };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   REPLACE SUBMISSION PDF
   ═══════════════════════════════════════════════════════════════════════ */

function adminReplaceSubmissionPdf(p) {
  const chk = checkAdminCan_(p, "subjective_grade");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const id       = String(p.id || "").trim();
  const fileId   = String(p.fileId || "").trim();
  const filename = String(p.filename || "submission.pdf")
    .replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "submission.pdf";
  const dataUrl  = String(p.fileData || "");

  if (!id)      return { success: false, error: "Submission id required." };
  if (!fileId)  return { success: false, error: "Drive fileId required." };
  if (!dataUrl) return { success: false, error: "No file data provided." };
  if (dataUrl.length > 14 * 1024 * 1024) return { success: false, error: "PDF too large — max ~10 MB." };
  const parsed = parsePdfDataUrl_(dataUrl, 14 * 1024 * 1024);
  if (parsed.error) return { success: false, error: parsed.error };

  return withLock_(() => {
    const sheet = getSubjSubmissionsSheet_();
    const data  = sheet.getDataRange().getValues();
    let rowIndex = -1, row = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === id) { rowIndex = i + 1; row = data[i]; break; }
    }
    if (rowIndex === -1) return { success: false, error: "Submission not found." };

    const storedFileId = String(row[10] || "").trim();
    if (!storedFileId || storedFileId !== fileId) {
      return { success: false, error: "Drive fileId doesn't match this submission." };
    }

    let file;
    try { file = DriveApp.getFileById(fileId); }
    catch (e) { return { success: false, error: "Could not open Drive file. (" + (e.message || e) + ")" }; }

    let backupId = String(row[19] || "").trim();
    if (!backupId) {
      try {
        const folder = getOrCreateSystemFolder_("SubjectivePdfBackups");
        const backupName = _uploadFilename_("backup", id.slice(0, 8), "pdf");
        backupId = file.makeCopy(backupName, folder).getId();
      } catch (e) {
        console.error("adminReplaceSubmissionPdf: backup failed:", e);
      }
    }

    try {
      const blob = Utilities.newBlob(parsed.bytes, "application/pdf", filename);
      overwriteDriveFileBinary_(fileId, blob);
    } catch (e) {
      return { success: false, error: "Could not write to Drive file: " + (e.message || e) };
    }

    const now = new Date().toISOString();
    sheet.getRange(rowIndex, 18, 1, 3).setValues([[now, actor, backupId]]);
    _invalidateSheet_(SUBJ_SUBMISSIONS_SHEET);

    logAction_(actor, "Replace Submission PDF", id,
      filename + " · student: " + String(row[1] || "") +
      " · backup: " + (backupId || "none"));

    try {
      sendPushNotification_(String(row[1] || ""), "Your answer paper was updated",
        "Your answer paper has been updated with the marked version. Open it to see the annotations.");
    } catch (e) {}

    return { success: true, id, fileId, backupId, replacedAt: now };
  });
}

/* DriveApp's File.setContent only writes text. Overwriting a binary file in
   place requires the Advanced Drive Service. If it isn't enabled we refuse
   rather than corrupt the PDF. The file keeps its original name. */
function overwriteDriveFileBinary_(fileId, blob) {
  if (typeof Drive === "undefined" || !Drive.Files || !Drive.Files.update) {
    throw new Error("Advanced Drive Service is not enabled. In the Apps Script editor, go to Services → Add a service → Drive API.");
  }
  Drive.Files.update(
    { mimeType: "application/pdf" },
    fileId,
    blob,
    { supportsAllDrives: true }
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   PROGRESS IMPORT
   ═══════════════════════════════════════════════════════════════════════ */

function safeImportString_(value, maxLength) {
  const s = String(value == null ? "" : value).trim();
  return (maxLength && s.length > maxLength) ? s.slice(0, maxLength) : s;
}
function normalizeImportMode_(mode) {
  const v = String(mode || "preview").trim().toLowerCase();
  return ["preview", "merge", "replace"].indexOf(v) !== -1 ? v : "";
}
function normalizeImportRecords_(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.users)) return payload.users;
  if (payload.username && payload.data) return [{ username: payload.username, data: payload.data }];
  return [];
}
function parseImportData_(value) {
  if (value && typeof value === "object") return value;
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Progress data is empty.");
  if (raw.length > MAX_IMPORT_DATA_CHARS_PER_USER) throw new Error("Progress data exceeds the 45,000 character limit.");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error("Progress data is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Progress data must be a JSON object.");
  return parsed;
}
function validateProgressObject_(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { valid: false, error: "Progress data must be an object." };
  const allowed = { prog: 1, bk: 1, fl: 1, wr: 1, stk: 1, chapStats: 1, schemaVersion: 1, updatedAt: 1 };
  for (const key of Object.keys(data)) {
    if (!allowed[key]) return { valid: false, error: "Unsupported progress field: " + key };
  }
  for (const f of ["bk", "fl", "wr"]) {
    if (data[f] !== undefined && !Array.isArray(data[f])) return { valid: false, error: f + " must be an array." };
  }
  if (data.prog !== undefined) {
    if (!data.prog || typeof data.prog !== "object" || Array.isArray(data.prog)) return { valid: false, error: "prog must be an object." };
    if (data.prog.sessions !== undefined && !Array.isArray(data.prog.sessions)) return { valid: false, error: "prog.sessions must be an array." };
    for (const nf of ["total", "correct", "studySec"]) {
      const v = data.prog[nf];
      if (v !== undefined && (typeof v !== "number" || !isFinite(v))) return { valid: false, error: "prog." + nf + " must be numeric." };
    }
  }
  return { valid: true };
}
function serializeProgressObject_(data) {
  const json = JSON.stringify(data);
  if (json.length > MAX_IMPORT_DATA_CHARS_PER_USER) throw new Error("Merged progress exceeds the 45,000 character limit.");
  return json;
}
function cloneJson_(v) { return JSON.parse(JSON.stringify(v)); }
function itemUid_(item) { return (item && typeof item === "object") ? String(item.uid || item.id || "").trim() : ""; }

function mergeUniqueItemsByUid_(first, second) {
  const out = [];
  const seen = {};
  for (const list of [Array.isArray(first) ? first : [], Array.isArray(second) ? second : []]) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const uid = itemUid_(item);
      if (!uid) continue;
      if (!seen[uid]) { seen[uid] = true; out.push(cloneJson_(item)); }
      else {
        const idx = out.findIndex(r => itemUid_(r) === uid);
        if (idx !== -1) out[idx] = Object.assign({}, out[idx], cloneJson_(item));
      }
    }
  }
  return out;
}
function sessionIdentity_(s) {
  if (!s || typeof s !== "object") return "";
  if (s.id) return String(s.id);
  return [String(s.at || s.startedAt || ""), String(s.mode || ""), String(s.chapter || ""), String(s.total || 0)].join("|");
}
function mergeSessions_(first, second) {
  const out = [];
  const index = {};
  for (const list of [Array.isArray(first) ? first : [], Array.isArray(second) ? second : []]) {
    for (const session of list) {
      if (!session || typeof session !== "object") continue;
      const id = sessionIdentity_(session);
      if (!id) continue;
      if (index[id] === undefined) { index[id] = out.length; out.push(cloneJson_(session)); }
      else {
        const i = index[id];
        const existing = out[i];
        out[i] = Object.assign({}, existing, cloneJson_(session));
        if (existing.qres || session.qres) out[i].qres = mergeQuestionResults_(existing.qres, session.qres);
      }
    }
  }
  out.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  return out.slice(-500);
}
function questionResultIdentity_(r) {
  return (r && typeof r === "object") ? [String(r.uid || ""), String(r.at || ""), r.ok ? "1" : "0"].join("|") : "";
}
function mergeQuestionResults_(first, second) {
  const out = [];
  const seen = {};
  for (const list of [Array.isArray(first) ? first : [], Array.isArray(second) ? second : []]) {
    for (const item of list) {
      if (!item || typeof item !== "object" || !item.uid) continue;
      const id = questionResultIdentity_(item);
      if (!seen[id]) { seen[id] = true; out.push(cloneJson_(item)); }
    }
  }
  return out.slice(-10000);
}
function mergeProgressData_(existing, incoming) {
  existing = existing || {};
  incoming = incoming || {};
  const result = Object.assign({}, cloneJson_(existing), cloneJson_(incoming));
  const ep = existing.prog || {}, ip = incoming.prog || {};
  result.prog = Object.assign({}, cloneJson_(ep), cloneJson_(ip));
  result.prog.sessions = mergeSessions_(ep.sessions, ip.sessions);
  result.prog.total = result.prog.sessions.reduce((t, s) => t + Number(s.total || 0), 0);
  result.prog.correct = result.prog.sessions.reduce((t, s) => t + Number(s.correct || 0), 0);
  result.bk = mergeUniqueItemsByUid_(existing.bk, incoming.bk);
  result.fl = mergeUniqueItemsByUid_(existing.fl, incoming.fl);
  result.wr = mergeUniqueItemsByUid_(existing.wr, incoming.wr);
  result.schemaVersion = 2;
  result.updatedAt = new Date().toISOString();
  return result;
}
function getProgressRecordForImport_(sheet, username) {
  const found = findProgressRow_(sheet, username);
  if (!found || !found.row || !found.row[1]) return { found: false, rowIndex: null, data: null };
  try { return { found: true, rowIndex: found.rowIndex, data: parseImportData_(found.row[1]) }; }
  catch (e) { return { found: true, rowIndex: found.rowIndex, data: null, error: "Existing server progress is malformed." }; }
}
function backupProgressRecord_(importId, admin, username, data) {
  const json = serializeProgressObject_(data);
  getProgressBackupsSheet_().appendRow([Utilities.getUuid(), importId, username, json, new Date().toISOString(), admin || "admin"]);
  _invalidateSheet_(PROGRESS_BACKUPS_SHEET);
}
function createProgressImportLog_(admin, mode, recordCount) {
  const importId = Utilities.getUuid();
  getProgressImportsSheet_().appendRow([
    importId, admin || "admin", mode || "preview", "started",
    Number(recordCount) || 0, 0, 0, 0, new Date().toISOString(), "", ""
  ]);
  _invalidateSheet_(PROGRESS_IMPORTS_SHEET);
  return importId;
}
function updateProgressImportLog_(importId, status, accepted, skipped, errorCount, details) {
  const sheet = getProgressImportsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(importId)) {
      sheet.getRange(i + 1, 4, 1, 8).setValues([[
        status || "", data[i][4] || 0, Number(accepted) || 0,
        Number(skipped) || 0, Number(errorCount) || 0,
        data[i][8] || "", new Date().toISOString(),
        String(details || "").slice(0, 30000)
      ]]);
      _invalidateSheet_(PROGRESS_IMPORTS_SHEET);
      return;
    }
  }
}

function adminImportProgress(p) {
  const chk = checkAdminCan_(p, "imports");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const mode = normalizeImportMode_(p.mode);
  if (!mode) return { success: false, error: "mode must be preview, merge, or replace." };

  let rawPayload = (p.payload !== undefined && p.payload !== null) ? p.payload : p.data;
  if (typeof rawPayload === "string") {
    if (rawPayload.length > MAX_IMPORT_BODY_CHARS) return { success: false, error: "Import payload is too large." };
    try { rawPayload = JSON.parse(rawPayload); } catch (e) { return { success: false, error: "Import payload is not valid JSON." }; }
  }
  if (!rawPayload || typeof rawPayload !== "object") return { success: false, error: "Import payload must be a JSON object." };

  const records = normalizeImportRecords_(rawPayload);
  if (!records.length) return { success: false, error: "No import records found." };
  if (records.length > MAX_IMPORT_RECORDS) return { success: false, error: "Import is limited to " + MAX_IMPORT_RECORDS + " records." };

  const importId = createProgressImportLog_(actor, mode, records.length);
  const errors = [];
  const accepted = [];
  let skipped = 0;

  records.forEach((record, i) => {
    record = record || {};
    const username = safeImportString_(record.username, 120);
    if (!username) { skipped++; errors.push({ index: i, error: "username is required." }); return; }
    let data;
    try { data = parseImportData_(record.data !== undefined ? record.data : record.progress); }
    catch (e) { skipped++; errors.push({ index: i, username, error: e.message }); return; }
    const v = validateProgressObject_(data);
    if (!v.valid) { skipped++; errors.push({ index: i, username, error: v.error }); return; }
    accepted.push({ username, data });
  });

  if (mode === "preview") {
    updateProgressImportLog_(importId, "preview", accepted.length, skipped, errors.length, JSON.stringify(errors).slice(0, 30000));
    return { success: true, importId, mode, preview: true, recordsReceived: records.length, recordsAccepted: accepted.length, recordsSkipped: skipped, errors };
  }

  try {
    return withLock_(() => applyProgressImport_(importId, actor, mode, accepted, errors));
  } catch (e) {
    updateProgressImportLog_(importId, "failed", 0, skipped, errors.length + 1, e.message);
    return { success: false, importId, error: "Import failed: " + e.message };
  }
}

function applyProgressImport_(importId, actor, mode, accepted, initialErrors) {
  const progressSheet = getProgressSheet_();
  const userSheet = getUsersSheet_();
  let acceptedCount = 0;
  let skippedCount = initialErrors.length;
  const errors = initialErrors.slice();

  accepted.forEach(item => {
    const username = item.username;
    const incoming = item.data;
    if (!findUserRow_(userSheet, username)) {
      skippedCount++;
      errors.push({ username, error: "User account does not exist." });
      return;
    }
    const current = getProgressRecordForImport_(progressSheet, username);
    if (current.error) { skippedCount++; errors.push({ username, error: current.error }); return; }

    let finalData = incoming;
    if (mode === "merge" && current.found && current.data) finalData = mergeProgressData_(current.data, incoming);
    else if (mode === "replace" && current.found && current.data) backupProgressRecord_(importId, actor, username, current.data);

    try {
      const json = serializeProgressObject_(finalData);
      const now = new Date().toISOString();
      if (current.found) progressSheet.getRange(current.rowIndex, 2, 1, 2).setValues([[json, now]]);
      else progressSheet.appendRow([username, json, now]);
      acceptedCount++;
    } catch (e) { skippedCount++; errors.push({ username, error: e.message }); }
  });
  _invalidateSheet_(PROGRESS_SHEET);

  const status = errors.length ? "completed_with_errors" : "completed";
  updateProgressImportLog_(importId, status, acceptedCount, skippedCount, errors.length, JSON.stringify(errors).slice(0, 30000));
  logAction_(actor, "Import Progress Data", importId, "Mode: " + mode + "; accepted: " + acceptedCount + "; skipped: " + skippedCount);
  return { success: true, importId, mode, preview: false, recordsAccepted: acceptedCount, recordsSkipped: skippedCount, errors };
}

function adminImportStatus(p) {
  const chk = checkAdminCan_(p, "imports");
  if (!chk.ok) return { success: false, error: chk.error };
  const importId = safeImportString_(p.importId, 100);
  if (!importId) return { success: false, error: "importId is required." };

  const data = _cachedSheetData_(PROGRESS_IMPORTS_SHEET, getProgressImportsSheet_).data;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === importId) {
      let errors = [];
      if (data[i][10]) { try { errors = JSON.parse(data[i][10]); } catch (e) { errors = [{ error: String(data[i][10]) }]; } }
      return {
        success: true,
        import: {
          importId: data[i][0], admin: data[i][1], mode: data[i][2], status: data[i][3],
          recordsReceived: Number(data[i][4] || 0), recordsAccepted: Number(data[i][5] || 0),
          recordsSkipped: Number(data[i][6] || 0), errorCount: Number(data[i][7] || 0),
          createdAt: data[i][8], completedAt: data[i][9], errors
        }
      };
    }
  }
  return { success: false, error: "Import not found." };
}

/* ═══════════════════════════════════════════════════════════════════════
   MAINTENANCE
   ═══════════════════════════════════════════════════════════════════════ */

function adminClearProgressBackups(p) {
  const chk = checkAdminCan_(p, "maintenance");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  return withLock_(() => {
    const sheet = getProgressBackupsSheet_();
    const lastRow = sheet.getLastRow();
    const deleted = Math.max(0, lastRow - 1);
    if (deleted > 0) sheet.deleteRows(2, deleted);
    _invalidateSheet_(PROGRESS_BACKUPS_SHEET);
    logAction_(actor, "Clear Progress Backups", "", "Deleted " + deleted + " backup row(s)");
    return { success: true, deleted };
  });
}

function adminPruneOldBackups(p) {
  const chk = checkAdminCan_(p, "maintenance");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const days = Math.max(1, Math.min(3650, Number(p.daysToKeep) || 30));

  return withLock_(() => {
    const sheet = getProgressBackupsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true, deleted: 0, daysToKeep: days };
    const data = sheet.getRange(2, 1, lastRow - 1, PROGRESS_BACKUP_HEADERS.length).getValues();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = [];
    data.forEach((row, i) => {
      const t = new Date(row[4]).getTime();
      if (!isNaN(t) && t < cutoff) rows.push(i + 2);
    });
    rows.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
    _invalidateSheet_(PROGRESS_BACKUPS_SHEET);
    logAction_(actor, "Prune Progress Backups", "", "Kept last " + days + "d, deleted " + rows.length + " row(s)");
    return { success: true, deleted: rows.length, daysToKeep: days };
  });
}

function adminTrimLogs(p) {
  const chk = checkAdminCan_(p, "maintenance");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const keepLast = Math.max(100, Math.min(100000, Number(p.keepLast) || 5000));

  return withLock_(() => {
    const sheet = getLogsSheet_();
    const lastRow = sheet.getLastRow();
    const totalDataRows = Math.max(0, lastRow - 1);
    const toDelete = Math.max(0, totalDataRows - keepLast);
    if (toDelete > 0) sheet.deleteRows(2, toDelete);
    _invalidateSheet_(LOGS_SHEET);
    logAction_(actor, "Trim Logs", "", "Kept " + keepLast + ", deleted " + toDelete + " row(s)");
    return { success: true, deleted: toDelete, kept: keepLast };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC INFO + HARD QUESTIONS
   ═══════════════════════════════════════════════════════════════════════ */

/* Tiny public response for the student app: the announcement banner text
   and a content version that changes whenever a question is edited, so
   phones refresh their downloaded chapters right away. */
function getPublicInfo() {
  const s = getSettings();
  const all = (s && s.settings) || {};
  return {
    success: true,
    announcement: String(all.announcement || ""),
    contentVersion: String(all.contentVersion || ""),
    loksewaScheme: String(all.loksewaScheme || "")
  };
}

/* Public feed consumed by the client-side badge on the flashcard view. */
function getHardQuestionsCache_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("hard_questions");
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const data = _cachedSheetData_(PROGRESS_SHEET, getProgressSheet_).data;
  const tally = {};
  for (let i = 1; i < data.length; i++) {
    let parsed;
    try { parsed = JSON.parse(data[i][1]); } catch (e) { continue; }
    const sessions = parsed && parsed.prog && Array.isArray(parsed.prog.sessions) ? parsed.prog.sessions : [];
    for (const s of sessions) {
      for (const qr of (s.qres || [])) {
        if (!qr || !qr.uid) continue;
        const r = tally[qr.uid] || (tally[qr.uid] = { n: 0, w: 0 });
        r.n++; if (!qr.ok) r.w++;
      }
    }
  }
  const out = {};
  Object.keys(tally).forEach(uid => {
    const r = tally[uid];
    if (r.n >= 20) out[uid] = Math.round((r.w / r.n) * 100);
  });
  try { cache.put("hard_questions", JSON.stringify(out), 6 * 60 * 60); } catch (e) {}
  return out;
}