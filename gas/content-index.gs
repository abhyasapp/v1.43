/* content-index.gs (v1.19) — batched version */
function buildContentIndex(startFrom) {
  if (typeof CONTENT_FILE_IDS === "undefined") {
    throw new Error("Add private-files.gs to this Apps Script project first.");
  }
  startFrom = Number(startFrom) || 0;
  const map = {};
  let failed = 0, skipped = 0;
  const started = Date.now();
  const perRun = 45;
  let processed = 0;

  for (let i = startFrom; i < CONTENT_FILE_IDS.length; i++) {
    if (Date.now() - started > 5 * 60 * 1000) { skipped = CONTENT_FILE_IDS.length - i; break; }
    if (processed >= perRun) { skipped = CONTENT_FILE_IDS.length - i; break; }
    const id = CONTENT_FILE_IDS[i];
    const res = readJsonFileById_(id);
    if (!res.success) { failed++; continue; }
    const arr = _questionArray_(res.result);
    if (arr) { map[id] = arr.length; processed++; }
    else failed++;
  }

  const keys = Object.keys(map);
  const body = keys.map(k => '  "' + k + '": ' + map[k]).join(",\n");
  const text = "/* CONTENT-INDEX.JS: question count per file. Generated " +
    new Date().toISOString() + " by buildContentIndex(" + startFrom + "). */\n" +
    "window.CONTENT_INDEX = {\n" + body + "\n};\n";
  Logger.log("----- copy from here -----\n" + text + "----- to here -----");
  Logger.log("Counted " + keys.length + " files (from index " + startFrom + "). Failed: " +
    failed + ". " + (skipped ? skipped + " remain — run buildContentIndex" +
    (startFrom + processed) + "() next." : "Done."));
  return { counted: keys.length, failed: failed, remaining: skipped, nextFrom: startFrom + processed };
}

function buildContentIndex0()   { return buildContentIndex(0); }
function buildContentIndex45()  { return buildContentIndex(45); }
function buildContentIndex90()  { return buildContentIndex(90); }
function buildContentIndex135() { return buildContentIndex(135); }
function buildContentIndex180() { return buildContentIndex(180); }
function buildContentIndex225() { return buildContentIndex(225); }
function buildContentIndex270() { return buildContentIndex(270); }
function buildContentIndex315() { return buildContentIndex(315); }