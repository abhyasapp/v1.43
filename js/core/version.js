/* ═══════════════════════════════════════════════════════════════════════
   VERSION.JS — single source of truth for the client app version.

   Loaded via <script src="version.js"> on every page (before
   shared.js/app.js) AND via importScripts() in sw.js. Bumping this
   value alone is what forces every open browser tab to drop its old
   cached shell and start a fresh session — the SW derives its
   CACHE_NAME from this number.

   Keep in sync with CODE.gs's own APP_VERSION constant (the backend
   runs in a different runtime and can't import this file directly).

   ── Version history (newest last) ──
   1.00 — initial release
   1.01 — login enumeration fix, admin cleanup actions
   1.02 — sliding admin tokens, private screenshots, Google rate limit
   1.03 — formatting / layout only
   1.04 — security + correctness + Weekly Set attempt capture
   1.05 — config consolidation, admin password enforcement
   1.06 — Subjective module, admin roles, dual-role switch
   1.07 — modular split (app.js + objective.js + subjective.js),
          cloud-sync.js Personal Drive backup, manifest.json PWA
          metadata, firebase-config.js, aligned SW shell list,
          admin permissions UI, Smart Paste upload/commit
   1.08 — client realigned with backend v1.11: getFile now sends the
          session (GETFILE_REQUIRES_AUTH) and is paced under the
          per-account rate limit; students read their own marked PDF
          through getMySubmissionPdf; admins read and annotate answer
          papers through adminDownloadSubmissionPdf; annotations are
          stamped onto the original PDF instead of flattening it;
          fixed the ReferenceError that aborted SUBJ.init(); shared
          pdf-viewer.js precached; iOS focus-zoom and 100dvh fixes.
   1.09 — one shared PDF surface (pdf-viewer.js) for students and admins:
          reader mode plus an annotation mode that stores ink in PDF
          points and stamps it onto the original pages. The console's
          duplicate viewer is gone. Mobile quiz gained a fixed
          Back / Next / Finish bar above the tab bar, a density pass so a
          question and its options fit one screen, and guards against a
          double tap skipping a question or submitting twice.
   1.13 — self-service data control: resetMyProgress + deleteMyAccount
          (Backup page -> "Your data on the server"); account deletion now
          also trashes Drive files and anonymises log/report references;
          per-file reset button fixed; Firebase SDK only loads when push is
          configured; sw precaches icon-512/favicon; manifest tidy-up;
          privacy page.
   1.14 — launch hardening: opt-in auto-download, cache-first question sets,
          per-file coverage store, sync payload that always fits, quiz
          keyboard fix, photo-to-PDF written answers, trial pill in the top
          bar, quiz-safe session expiry, tolerant service worker with offline
          fonts/KaTeX/pdf.js, privacy + terms pages, honest copy.
   1.15 — phase 2: unseen-first practice, real weak-topic mode, question grid
          and mark-for-review, exam countdown, weekly test start/resume/rank
          recorded on the server, safer uploads, cached settings, nightly
          spreadsheet backup, client error log, self-hosted assets.
   1.16 — phase 3: question editor + growth panel + announcements in the admin
          console, text-size button, study-plan calendar export, styled confirm
          dialogs, landing-page sample question, automatic checks (tests/).
   1.17 — phase 4: chapter cards + Continue, sign in with email or mobile,
          payment screenshot shrunk on the phone, approval-time note,
          question-count index, Content-Security-Policy, batched progress saves.
   1.18 — solo-student 10/10: personalized Today plan, exam readiness on Home,
          chapter strength verdicts, "Just 5" quick session, resume chip,
          pace feedback, streak forgiveness, image fullscreen, copy-explanation
          button, fast-guess flag on results.
   1.19 — confidence rating (Sure / Not sure / Guessed), misconceptions card,
          recovery mode after 3+ days away, read-aloud button.
   1.20 — chapters refresh when you're online; weekly leaderboard; badges;
          wrong-first results; streak insurance; sidebar search; push nudge.
   1.21 — weekly test retakes: the first attempt is the official record;
          later attempts are local-only practice, and the retake modal
          shows the last score with Review / Retake options. Every system
          Drive folder now lives under "Abhyas System Data", and uploaded
          files are renamed to a standard YYYY-MM-DD_HHMMSS_user_type.ext
          pattern.
   1.22 — polish: rate-limit retry-after shown to the student, exam
          copy protection, live Loksewa negative-marking score in the
          exam bar, boot error boundary, search inside Saved/Flagged/
          Missed lists, faster progress flush, weekly admin summary.
   1.32 — weekly test hardening. Fixed the entire weekly feature:
            • objective.js — removed a duplicate `const isWeekly`
              declaration in _showResults that was a parse-time syntax
              error. The whole file was being rejected by the browser,
              so QUIZ/REV/ON/LOC/PSY/CNT/ONPROG were all undefined and
              every quiz-related feature silently failed.
            • app.js — Review button on the retake modal no longer
              throws ReferenceError (uses escAttrJs(s.id) instead of a
              bare `id`).
            • app.js — _startRetake no longer requires s.fileId before
              attempting a fresh chapter-pool build.
            • app.js — _buildLoksewaPaperRetake falls back to the
              weekly set's own file when the pools are empty, so the
              retake always opens.
            • app.js — _buildLoksewaPaper is now awaited with a
              try/catch, so a rejected build surfaces a toast instead
              of leaving the student on the home screen.
            • app.js — _startReview is async and refuses a Loksewa-
              format attempt whose saved paper is missing, showing a
              clear message rather than every question blank.
            • app.js — Loksewa chapter matching now falls back to
              keyword fragments against chapter names, so the "Could
              not build the full Loksewa paper" toast stops firing
              when chapter IDs don't match the expected scheme.
            • app.js — every weekly score shown to the student now
              uses Loksewa negative marking (+1 correct, −0.2 wrong,
              0 skipped). Applies to the home card, retake modal, and
              the results ring. Non-weekly quizzes keep the plain
              percentage.
            • app.js — added WEEKLY._savePaper/_loadPaper: the paper
              the student actually sat is now saved on the device, so
              Review and Retake always have questions to work with
              even when the chapter pools and the weekly set's Drive
              file are both unreachable.
   1.33 — exam and study tools. Unselect an answer and Clear response in
          timed exams; 10/5/1-minute warnings; exam keyboard shortcuts
          (1-5, C, M, N, P). Scoped "Reset progress" with backup offer,
          typed confirmation and 24-hour undo; resets and wrong-bank
          removals now survive sync. Storage meter with 80% warning, backup
          reminder, versioned Google Drive backups with checksum. 85% mastery
          gate for chapter completion, sprint limited to Level 7 + GK,
          "Daily target met" badge. Six report categories and an offline
          report queue. Text size, high contrast and AMOLED black. Needs
          gas/code.gs v1.33 deployed.
   1.34 — faster offline download. The Offline Cache download asks for 6
          files per request (new getFiles action in gas/code.gs) and keeps
          3 requests going, skips files already on the device, and stops at
          once when the session has expired or access has ended. Works with
          the older server too (falls back to one file per request). One safe
          escAttrJs in shared.js instead of three different copies. Needs
          gas/code.gs v1.34 deployed to get the speed-up.
   1.35 — the daily 75-mark paper now defaults to the syllabus topic table:
          25 GK + the 50 Level 7 marks split as Engineering Survey 7,
          Construction Materials 6, Geotechnical 6, Construction Management 6,
          Structural Analysis 5, Concrete Technology 5, Estimating and
          Costing 5, Engineering Drawing 4, Engineering Economics 3,
          Professional Practices 3. Chapters are matched to topics by name;
          a scheme saved by an admin still wins.
   1.36 — the cloud copy sent to the server is a small fixed-size summary;
          the wrong bank, bookmarks and notes stay on the device and in
          the student's own Google Drive backup.
   1.37 — full review fixes: gas/code.gs de-duplicated; nothing is deleted
          by the app on its own (graduated questions go to a Mastered
          archive with undo, the reset undo copy never expires, offline
          study PDFs are never auto-evicted); download batch constants
          match the server (6 per request, 3 at once); one HTML escaper;
          jsDelivr removed from script-src; debug.gs moved to tools/.
   1.38 — no inline JavaScript anywhere (handlers are data-on-* run by actions.js,
          inline scripts are files), so script-src no longer allows 'unsafe-inline';
          the chapter list ships with the app; question CDN off by default (private
          content repo works); passwords are PBKDF2 and upgrade on login; app.js and
          admin.js split into parts; the dead "Share my progress" button works.
   1.39 — objective question files come from the CDN first everywhere (also a
          batch of one file); Apps Script is the fallback. Tests cover CDN-first,
          partly mirrored, and CDN down.
   1.40 — optional encrypted CDN files: as fast as the CDN, readable only with a
          key the backend gives to signed-in paid students (content-crypto.js,
          getContentKey, content-repo/ templates). Plain files still work.
   1.41 — student page with less on screen: short header with one More menu, a
          Home that shows one decision and at most one notice, backup in one
          place, duplicate cards and a ticking home clock removed.
   1.42 — student portal restructure: 4 navigation groups, Progress in 3 tabs,
          Simple/Detailed Home choice, focus management, and the four Weak spots
          views that never worked (WRONGBY.tab did not exist).
   1.43 — the reporting system moves to its own report/ folder
          (report-shared.js, report-matching.js, userreport.js,
          adminreport.js, and gas/report.gs). Fixes found in review:
          adminGrantAccess wrote createdAt and approvedAt into the wrong
          columns and never set paymentStatus; the 30-second stats cache
          was a per-execution variable and never hit; admin password
          change and admin creation skipped the weak-password check; the
          admin theme toggle left the browser status-bar colour stale.
          The reporting backend is now optional: report.gs can be linked
          in without editing code.gs, and unlinked installs keep working
          against the code.gs endpoints.
   ═══════════════════════════════════════════════════════════════════════ */
const APP_VERSION = '1.43';
