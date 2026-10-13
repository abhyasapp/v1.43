/* ═══════════════════════════════════════════════════════════════════════
   OBJECTIVE.JS — MCQ quiz engine and everything that trains on it.

   Loaded via <script src="objective.js"> AFTER app.js and BEFORE
   subjective.js in user.html. Classic-script global scope, no modules.

   Depends on globals from app.js:
     S, LS, APP_CONFIG, APPS, _save, _load, toast, toastUndo,
     openMod, closeMod, _anyModalOpen, qs, netFetch, shuf, fmt, fmtHMS,
     isOk, qImgHtml, qSearchHtml, normQ, renderMath, pluralize,
     today, localDateOffset, QDB, PSYNC, WEEKLY, HOME, PROG, CHAPSTATS,
     STREAK, TT, UI, DATA, TUTORIAL, SRCH

   ── v1.43: the report block moved to report/userreport.js ─────────────
   Everything to do with reporting a question and the offline report
   queue now lives in report/userreport.js, which loads after this file
   on user.html. That module installs compatibility shims on QUIZ for
   the old names still called from this file:

     QUIZ._reportCurrent()   → USER_REPORT.current()
     QUIZ._reportExam(qi)    → USER_REPORT.exam(qi)
     QUIZ._reportResult(i)   → USER_REPORT.result(i)

   The call sites in _renderFlashcard, _renderExam and _showResults are
   unchanged. Do not re-add the old definitions here: they would shadow
   the shims and tests/check.js fails if a name is defined twice.

   Exposes on window:
     QUIZ, ON, LOC, PSY, REV, CNT, ONPROG,
     fidFromUid, scopeLeaves, scopedStats, fileStatsMap,
     migrateSessionScopes
   ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════ SCOPE UTILITIES ═══════════════ */

function migrateSessionScopes(){
  if(!Array.isArray(S.prog.sessions)) return;
  let changed = false;
  S.prog.sessions.forEach(s=>{
    if(!s.chapterKey && s.chapter){
      const cleaned = String(s.chapter).split(' — ')[0].trim();
      if(cleaned){ s.chapterKey = cleaned; changed = true; }
    }
  });
  if(changed) _save(LS.PROG, S.prog);
}

function scopeLeaves(lv,ch,book,sub){
  let refs;
  if(!lv){ refs = ChapterData.allFileRefs(); }
  else if(!ch){
    refs = [];
    Object.keys(ChapterData.chapters(lv)).forEach(c=>refs.push(...ChapterData.chapterFileRefs(lv,c)));
  } else {
    refs = ChapterData.chapterFileRefs(lv,ch);
  }
  if(book) refs = refs.filter(r=>r.book===book);
  if(sub)  refs = refs.filter(r=>r.subtopic===sub);
  return refs;
}

function fidFromUid(uid){
  const i = uid.lastIndexOf('_');
  return i > -1 ? uid.slice(0,i) : uid;
}

function fileStatsMap(leaves){
  const map = new Map();
  leaves.forEach(ref=>{
    if(map.has(ref.fid)) return;
    const c = (S.cov && S.cov[ref.fid]) || null;
    const practised = new Set();
    if(c && c.p){ for(let i = 0; i < c.p.length; i++){ if(c.p[i] !== '0') practised.add(ref.fid + '_' + i); } }
    const a = c ? (c.a || 0) : 0, k = c ? (c.c || 0) : 0;
    map.set(ref.fid, {practised, attempted:a, correct:k, wrong:Math.max(0, a - k)});
  });
  return map;
}
function fileMissedNowCount(fid){
  const c = (S.cov && S.cov[fid]) || null;
  if (!c || !c.p) return 0;
  let n = 0;
  for (let i = 0; i < c.p.length; i++) if (c.p[i] === '2') n++;
  return n;
}

function scopedStats(leaves){
  const fileMap = fileStatsMap(leaves);
  const uids = new Set();
  let attempted=0, correct=0, wrong=0;
  fileMap.forEach(rec=>{
    rec.practised.forEach(u=>uids.add(u));
    attempted += rec.attempted; correct += rec.correct; wrong += rec.wrong;
  });
  return {practised:uids.size, attempted, correct, wrong, fileMap};
}

/* ═══════════════ CNT — question-counting helpers ═══════════════ */
const CNT_AUTO_LIMIT = 20;

const CNT = {
  _lastError: null,
  async forFile(ref){
    if(!ref.fid) return null;
    if(S.fcount[ref.fid] != null) return S.fcount[ref.fid];
    try{
      const raw = await QUIZ._fetch(ref.fid, ref.key);
      const n = normQ(raw, ref.fid).length;
      S.fcount[ref.fid] = n;
      _save(LS.FCOUNT, S.fcount);
      return n;
    }catch(e){ CNT._lastError = e && e.message; return null; }
  },
  knownTotal(leaves){
    let sum = 0, unknown = 0;
    leaves.forEach(ref=>{
      const n = S.fcount[ref.fid];
      if(n==null) unknown++; else sum += n;
    });
    return {total:sum, files:leaves.length, unknown};
  },
  async totalFor(lv,ch,book,sub,{force=false, onTick}={}){
    const leaves = scopeLeaves(lv,ch,book,sub);
    const known = CNT.knownTotal(leaves);
    if(known.unknown===0) return known;
    if(!force && leaves.length>CNT_AUTO_LIMIT) return {...known, needsConfirm:true};
    let sum = 0, unknown = 0, done = 0;
    const CONC = 4; let i = 0;
    async function worker(){
      while(i<leaves.length){
        const ref = leaves[i++];
        const n = await CNT.forFile(ref);
        if(n==null) unknown++; else sum += n;
        done++; onTick && onTick(done, leaves.length);
      }
    }
    await Promise.all(Array.from({length:Math.max(1,Math.min(CONC,leaves.length))}, worker));
    return {total:sum, files:leaves.length, unknown};
  }
};

/* ═══════════════ ONPROG — per-scope progress panel ═══════════════ */
const ONPROG = {
  metric: 'practised',
  filewiseOpen: false,
  _seq: 0,
  _lastLeaves: [],

  setMetric(m){
    ONPROG.metric = m;
    document.querySelectorAll('#on-prog-tabs .mtab').forEach(b=>b.classList.toggle('active', b.dataset.m===m));
    ONPROG.render();
  },

  toggleFilewise(){
    ONPROG.filewiseOpen = !ONPROG.filewiseOpen;
    ONPROG.render();
  },

  async resetFile(fid){
    if(!fid) return;
    const ref = ONPROG._lastLeaves.find(l=>l.fid===fid);
    const label = ref ? `${ref.book} — ${ref.subtopic}` : 'this file';
    const ok = await ASK.confirm({
      title: 'Reset practice progress?',
      body:  'Reset progress for <b>' + esc(label) + '</b>? This clears only the Practised / Attempted / Correct / Wrong counts for this one file. Bookmarks, flags and your wrong-answer bank are not touched — the question file itself is never modified.',
      ok:    'Reset',
      danger: true
    });
    if(!ok) return;
    let removedTotal=0, removedCorrectTotal=0;
    S.prog.sessions.forEach(s=>{
      if(!s.qres || !s.qres.length) return;
      const kept = [];
      let removedHere=0, removedCorrectHere=0;
      s.qres.forEach(q=>{
        if(q && q.uid && fidFromUid(q.uid)===fid){
          removedHere++;
          if(q.ok) removedCorrectHere++;
        } else kept.push(q);
      });
      if(removedHere){
        s.qres = kept;
        s.correct = Math.max(0,(s.correct||0) - removedCorrectHere);
        s.wrong   = Math.max(0,(s.wrong||0)   - (removedHere - removedCorrectHere));
        s.total   = Math.max(0,(s.total||0)   - removedHere);
        removedTotal += removedHere;
        removedCorrectTotal += removedCorrectHere;
      }
    });
    S.prog.sessions = S.prog.sessions.filter(s => (s.qres && s.qres.length) || (s.total||0) > 0);
    S.prog.total   = Math.max(0,(S.prog.total||0)   - removedTotal);
    S.prog.correct = Math.max(0,(S.prog.correct||0) - removedCorrectTotal);
    _save(LS.PROG, S.prog);
    if(S.cov && typeof S.cov === 'object'){ delete S.cov[fid]; _save(LS.COV, S.cov); }
    toast(removedTotal ? `✅ Reset "${label}" — ${removedTotal} record(s) cleared` : `Nothing to reset for "${label}"`);
    ONPROG.render();
    if(typeof HOME!=='undefined' && HOME.render) HOME.render();
  },

  _scope(){
    const lv   = document.getElementById('on-lv')?.value   || '';
    const ch   = document.getElementById('on-ch')?.value   || '';
    const book = document.getElementById('on-bk')?.value   || '';
    const ts   = document.getElementById('on-to');
    const opt  = ts && ts.selectedIndex>=0 ? ts.options[ts.selectedIndex] : null;
    const valid = opt && opt.dataset && opt.dataset.sub && !opt.disabled;
    return {lv, ch, book, sub: valid?opt.dataset.sub:'', fid: valid?opt.value:''};
  },

  async render(force=false){
    ONPROG._renderOldPreview();

    const el      = document.getElementById('on-progress-card');
    const titleEl = document.getElementById('on-prog-title');
    const bodyEl  = document.getElementById('on-prog-body');
    if(!el || !titleEl || !bodyEl) return;

    const {lv,ch,book,sub,fid} = ONPROG._scope();
    const mySeq = ++ONPROG._seq;

    if(!lv){
      titleEl.textContent = '📊 Overall Progress';
      const total = S.prog.total, correct = S.prog.correct, wrong = total - correct;
      const pct = total ? Math.round((correct/total)*100) : 0;
      bodyEl.innerHTML = `
        <div class="prog-grid">
          <div class="sc"><div class="sv tcy">${total}</div><div class="stat-lbl">Attempted</div></div>
          <div class="sc"><div class="sv tc2">${correct}</div><div class="stat-lbl">Correct</div></div>
          <div class="sc"><div class="sv tb2">${wrong}</div><div class="stat-lbl">Wrong</div></div>
        </div>
        <div class="pb-w" style="margin-top:.6rem"><div class="pb-l"><span>Accuracy</span><span>${pct}%</span></div><div class="pb"><div class="pb-f" style="width:${pct}%"></div></div></div>
        <div style="font-size:.68rem;color:var(--t3);margin-top:.5rem">Pick a Level, Chapter, Book or Subtopic above to see coverage for that scope.</div>`;
      return;
    }

    const lvLabel = document.getElementById('on-lv').selectedOptions[0]?.textContent.replace(/^📖\s*/,'') || lv;
    const label = fid  ? `${ChapterData.chapterName(lv,ch)} — ${book} — ${sub}`
                : book ? `${ChapterData.chapterName(lv,ch)} — ${book}`
                : ch   ? ChapterData.chapterName(lv,ch)
                : lvLabel;
    titleEl.textContent = `📊 ${label}`;

    const leaves = scopeLeaves(lv,ch,book,sub);
    ONPROG._lastLeaves = leaves;
    const scoped = scopedStats(leaves);
    const known = CNT.knownTotal(leaves);

    const paint = (info)=>{
      if(mySeq !== ONPROG._seq) return;
      const total = info.total;
      const missedNow = leaves.reduce((n, ref) => n + fileMissedNowCount(ref.fid), 0);
      const vals = {practised:scoped.practised, attempted:scoped.attempted, correct:scoped.correct, wrong:scoped.wrong, missedNow: missedNow};
      const metricVal = vals[ONPROG.metric];
      const metricLabel = {practised:'Practised', attempted:'Attempted', correct:'Correct', wrong:'Ever missed', missedNow:'Missed right now'}[ONPROG.metric];
      const barColor = (ONPROG.metric==='wrong' || ONPROG.metric==='missedNow') ? 'var(--ros)'
                     : ONPROG.metric==='correct' ? 'var(--grn)'
                     : 'var(--amb)';
      const pct = total ? Math.min(100, Math.round((metricVal/total)*100)) : 0;
      const unknownNote = info.unknown
        ? `<div style="font-size:.66rem;color:var(--t3);margin-top:.45rem"><i class="ph ph-warning"></i> ${info.unknown} of ${info.files} file${info.files>1?'s':''} not counted yet${CNT._lastError ? ' — ' + esc(CNT._lastError) : ' (offline, or not downloaded)'}</div>`
        : '';
      const confirmBtn = info.needsConfirm
        ? `<button class="btn btn-sm btn-a" style="margin-top:.5rem" data-on-click="ONPROG.render(true)"><i class="ph ph-list-numbers"></i> Count questions (${info.files} files)</button>`
        : '';

      let filewiseHtml = '';
      if(leaves.length>1 && leaves.length<=100){
        const showBook = !book;
        const rows = leaves.map(ref=>{
          const rec = scoped.fileMap.get(ref.fid) || {practised:new Set(), attempted:0, correct:0, wrong:0};
          const fVals = {practised:rec.practised.size, attempted:rec.attempted, correct:rec.correct, wrong:rec.wrong, missedNow: fileMissedNowCount(ref.fid)};
          const fVal = fVals[ONPROG.metric];
          const fTotal = S.fcount[ref.fid];
          const fPct = fTotal ? Math.min(100, Math.round((fVal/fTotal)*100)) : 0;
          const rowLabel = showBook ? `${ref.book} — ${ref.subtopic}` : ref.subtopic;
          return `<div class="pb-w fw-row">
            <div class="pb-l">
              <span>${esc(rowLabel)}</span>
              <span class="fw-row-right">${fVal} / ${fTotal!=null?fTotal:'?'}${fTotal!=null?` (${fPct}%)`:''}
                <button class="fw-reset" title="Reset progress for this file" aria-label="Reset progress for this file" data-fid="${esc(ref.fid)}" data-on-click="event.stopPropagation();ONPROG.resetFile(this.dataset.fid)"><i class="ph ph-trash"></i></button>
              </span>
            </div>
            <div class="pb"><div class="pb-f" style="width:${fTotal!=null?fPct:0}%;background:${barColor}"></div></div>
          </div>`;
        }).join('');
        filewiseHtml = `
          <div class="fw-toggle" data-on-click="ONPROG.toggleFilewise()">
            <span>${ONPROG.filewiseOpen?'▾':'▸'}</span> <i class="ph ph-folder"></i> Filewise breakdown (${leaves.length} files)
          </div>
          <div id="on-fw-list" style="display:${ONPROG.filewiseOpen?'block':'none'}">${rows}</div>`;
      }

      const scopeResetBtn = fid
        ? ` <button class="fw-reset" title="Reset progress for this file" aria-label="Reset progress for this file" data-fid="${esc(fid)}" data-on-click="ONPROG.resetFile(this.dataset.fid)"><i class="ph ph-trash"></i></button>`
        : '';

      bodyEl.innerHTML = `
        <div class="prog-grid">
          <div class="sc"><div class="sv tcy">${scoped.practised}</div><div class="stat-lbl">Practised</div></div>
          <div class="sc"><div class="sv ta2">${scoped.attempted}</div><div class="stat-lbl">Attempted</div></div>
          <div class="sc"><div class="sv tc2">${scoped.correct}</div><div class="stat-lbl">Correct</div></div>
          <div class="sc"><div class="sv tb2">${scoped.wrong}</div><div class="stat-lbl">Wrong</div></div>
        </div>
        ${info.needsConfirm ? confirmBtn : `
          <div class="pb-w" style="margin-top:.65rem">
            <div class="pb-l">
              <span>${metricLabel} coverage (compiled)</span>
              <span>${metricVal} / ${total||'?'} (${pct}%)${scopeResetBtn}</span>
            </div>
            <div class="pb"><div class="pb-f" style="width:${pct}%;background:${barColor}"></div></div>
          </div>`}
        ${unknownNote}
        ${info.needsConfirm ? '' : filewiseHtml}
      `;
    };

    if(known.unknown===0){ paint(known); return; }
    bodyEl.innerHTML = `<div class="empty" style="padding:.8rem 0"><div class="empty-i">⏳</div><p>Counting questions…</p></div>`;
    const info = await CNT.totalFor(lv,ch,book,sub,{
      force,
      onTick:(done,files)=>{
        if(mySeq !== ONPROG._seq) return;
        const p = bodyEl.querySelector('p');
        if(p && files>1) p.textContent = `Counting questions… ${done}/${files} files`;
      }
    });
    paint(info);
  },

  _renderOldPreview(){
    const el = document.getElementById('on-progress-preview');
    if(!el) return;
    const lv   = document.getElementById('on-lv')?.value || '';
    const ch   = document.getElementById('on-ch')?.value || '';
    const book = document.getElementById('on-bk')?.value || '';
    if(!lv || !ch){ el.innerHTML=''; return; }
    const chapterLabel = ChapterData.chapterName(lv,ch) + (book? ' — '+book : '');
    const match = CHAPSTATS.entries().find(c=>c.chapter===chapterLabel);
    if(!match){
      el.innerHTML = `<p style="font-size:.7rem;color:var(--t3);margin-top:.3rem">No attempts yet for this chapter.</p>`;
      return;
    }
    el.innerHTML = `<p style="font-size:.7rem;color:var(--t3);margin-top:.3rem">📊 Your accuracy here so far: <strong style="color:${match.accuracy>=75?'var(--ok)':match.accuracy>=50?'var(--amb)':'var(--bad)'}">${match.accuracy}%</strong> (${match.correct}/${match.attempted})</p>`;
  }
};

/* ═══════════════ ON — Online Study picker ═══════════════ */
function prettySub(name){
  return String(name)
    .replace(/^UNCLASSIFIED\s+Unclassified questions/i, 'Mixed questions')
    .replace(/\s*&\s*/g, ' & ');
}

const ON = {
  onLv(){
    const lv=document.getElementById('on-lv').value;
    const cs=document.getElementById('on-ch');
    cs.innerHTML='<option value="">📘 Select Chapter…</option>';cs.disabled=!lv;
    const bs=document.getElementById('on-bk');bs.innerHTML='<option value="">📚 Select Book…</option>';bs.disabled=true;
    const ts=document.getElementById('on-to');ts.innerHTML='<option value="">📑 Select Subtopic…</option>';ts.disabled=true;
    if(lv){
      Object.entries(ChapterData.chapters(lv)).forEach(([k,n])=>{
        const fc=ChapterData.fileCount(lv,k);
        const o=document.createElement('option');o.value=k;o.textContent=`Ch${k}: ${n}${fc?'':' (coming soon)'}`;cs.appendChild(o);
      });
    }
    ONPROG.render();
  },
  onCh(){
    const lv=document.getElementById('on-lv').value,ch=document.getElementById('on-ch').value;
    const bs=document.getElementById('on-bk');
    bs.innerHTML='<option value="">📚 Select Book…</option>';bs.disabled=true;
    const ts=document.getElementById('on-to');ts.innerHTML='<option value="">📑 Select Subtopic…</option>';ts.disabled=true;
    if(lv&&ch){
      const books=ChapterData.books(lv,ch);
      if(!Object.keys(books).length){
        bs.innerHTML='<option value="">No books yet for this chapter</option>';
        toast('ℹ️ This chapter has no question files yet');
      } else {
        Object.keys(books).forEach(book=>{
          const fc=ChapterData.fileCount(lv,ch,book);
          const o=document.createElement('option');o.value=book;o.textContent=`${book}${fc?'':' (coming soon)'}`;bs.appendChild(o);
        });
        bs.disabled=false;
        const _bk = Object.keys(books);
        bs.style.display = _bk.length === 1 ? 'none' : '';
        if(_bk.length === 1){ bs.value = _bk[0]; ON.onBook(); return; }
      }
    }
    ONPROG.render();
  },
  async onBook(){
    const lv=document.getElementById('on-lv').value,ch=document.getElementById('on-ch').value,book=document.getElementById('on-bk').value;
    const ts=document.getElementById('on-to');
    ts.innerHTML='<option value="">📑 Select Subtopic…</option>';ts.disabled=true;
    if(lv&&ch&&book){
      const files=ChapterData.files(lv,ch,book);
      if(!Object.keys(files).length){
        ts.innerHTML='<option value="">No files yet for this book</option>';
        toast('ℹ️ This book has no question files yet');
      } else {
        const isOfflineMode = !S.online || S.forcedOffline;
        const cachedKeys = new Set(await QDB.keys());
        let anyEnabled = false;
        Object.entries(files).forEach(([n,id])=>{
          if(!id)return;
          const cacheKey = `${lv}_${ch}_${book}_${n}`;
          const isCached = cachedKeys.has(cacheKey);
          const o=document.createElement('option');
          o.value=id;
          o.dataset.key=cacheKey;
          o.dataset.sub=n;
          if(isOfflineMode && !isCached){
            o.textContent = `🔒 ${prettySub(n)} (not cached)`;
            o.disabled = true;
            o.style.color = 'var(--t3)';
          } else {
            o.textContent = isCached ? `📦 ${prettySub(n)}` : prettySub(n);
            anyEnabled = true;
          }
          ts.appendChild(o);
        });
        ts.disabled=false;
        if(isOfflineMode && !anyEnabled){
          ts.innerHTML='<option value="">No cached files for this book</option>';
          toast('📡 You\'re offline — no cached files in this book. Cache them first while online.');
        }
      }
    }
    ONPROG.render();
  },
  start(mode){
    const ts=document.getElementById('on-to');
    const fid=ts.value,opt=ts.options[ts.selectedIndex],key=opt?.dataset?.key;
    const ch=document.getElementById('on-ch').value,lv=document.getElementById('on-lv').value,book=document.getElementById('on-bk').value;
    if(!fid||!key){toast('Select a subtopic');return}
    const sub=opt?.dataset?.sub||'';
    const name=`${ChapterData.chapterName(lv,ch)} — ${book}`;
    QUIZ.load(fid,key,mode,name,{lv,ch,book,sub,fid});
  }
};

/* ═══════════════ LOC — Local File ═══════════════ */
const LOC = {
  onFile(){
    const f=document.getElementById('loc-file').files[0];if(!f)return;
    const nameEl=document.getElementById('loc-file-name');
    if(nameEl) nameEl.textContent=f.name;
    const r=new FileReader();
    r.onload=e=>{
      try{
        const qs2=normQ(JSON.parse(e.target.result),'local');
        if(!qs2.length){toast('❌ No valid questions found in file');return}
        S.localQs=qs2;
        const info=document.getElementById('loc-info');
        info.style.display='';info.textContent=`✅ ${pluralize(qs2.length,'question')} loaded from "${f.name}"`;
        document.getElementById('loc-pr').disabled=false;
        document.getElementById('loc-ex').disabled=false;
        toast(`✅ ${pluralize(qs2.length,'question')} ready`);
      }catch{toast('❌ Invalid JSON file')}
    };
    r.onerror=()=>toast('❌ Could not read file');
    r.readAsText(f);
  },
  start(mode){
    if(!S.localQs){toast('Load a JSON file first');return}
    QUIZ.startWith([...S.localQs],mode,'Local File');
  }
};

/* ═══════════════ PSY — Psycho Mode ═══════════════ */
const PSY = {
  LEVELS:[['level5','Level 5 — Diploma'],['level7','Level 7 — Civil Engineering'],['gk','General Knowledge']],
  init(){
    const box=document.getElementById('psy-levels');
    box.innerHTML = PSY.LEVELS.map(([lv,label])=>{
      const names=ChapterData.chapters(lv);
      const items=Object.entries(names).map(([k,n])=>{
        const fc=ChapterData.fileCount(lv,k);
        return `<div class="ch-item" tabindex="0" role="button" data-on-click="this.querySelector('input').click()" data-on-keydown="ACT.enterOrSpace(event)&&this.querySelector('input').click()">
          <input type="checkbox" value="${k}" data-lv="${lv}" ${fc?'':'disabled'} data-on-click="event.stopPropagation();PSY._info()">
          <div class="ch-num">${k}</div>
          <div class="ch-name">${n}${fc?'':' <span style=\"color:var(--t3)\">(no files)</span>'}</div>
          <div class="ch-cnt">${fc}f</div>
        </div>`;
      }).join('');
      return `<div class="sb-lbl" style="margin-top:.7rem;display:flex;align-items:center;justify-content:space-between;padding-right:.2rem">
          <span>${label}</span>
          <span style="display:flex;gap:.3rem">
            <button class="btn btn-sm btn-c" style="font-size:.56rem;padding:.15rem .4rem" data-on-click="PSY.allLv('${lv}')"><i class="ph ph-check"></i> All</button>
            <button class="btn btn-sm btn-r" style="font-size:.56rem;padding:.15rem .4rem" data-on-click="PSY.noneLv('${lv}')">✕</button>
          </span>
        </div>
        <div class="ch-list" id="psy-lv-${lv}">${items || '<div class="empty"><div class="empty-i"><i class="ph ph-book-open"></i></div><p>No chapters yet</p></div>'}</div>`;
    }).join('');
    PSY._info();
  },
  all(){document.querySelectorAll('#psy-levels input:not(:disabled)').forEach(c=>c.checked=true);PSY._info()},
  none(){document.querySelectorAll('#psy-levels input').forEach(c=>c.checked=false);PSY._info()},
  allLv(lv){document.querySelectorAll(`#psy-lv-${lv} input:not(:disabled)`).forEach(c=>c.checked=true);PSY._info()},
  noneLv(lv){document.querySelectorAll(`#psy-lv-${lv} input`).forEach(c=>c.checked=false);PSY._info()},
  _info(){
    const n=document.querySelectorAll('#psy-levels input:checked').length;
    document.getElementById('psy-info').textContent=n?`${n} chapter${n>1?'s':''} selected — ready to load`:'Select at least 1 chapter to continue';
  },
  async start(type){
    const cbs=[...document.querySelectorAll('#psy-levels input:checked')];
    if(!cbs.length){toast('Select at least one chapter');return}
    const refs = [];
    for(const cb of cbs){
      const lv = cb.dataset.lv;
      const ch = cb.value;
      refs.push(...ChapterData.chapterFileRefs(lv, ch));
    }
    QUIZ._showLoader(`Loading ${pluralize(refs.length,'file')}…`);
    const all=[];
    let done=0, failed=0, i=0;
    const loaderMsg = () => {
      const el = document.getElementById('quiz-loader-msg');
      if(el) el.textContent = `Loading files (${done}/${refs.length})…`;
    };
    async function worker(){
      while(i < refs.length){
        const ref = refs[i++];
        try{
          const raw = await QUIZ._fetch(ref.fid, ref.key);
          all.push(...normQ(raw, ref.fid));
        }catch(e){
          failed++;
        }
        done++;
        loaderMsg();
      }
    }
    await Promise.all(Array.from({length: Math.min(4, refs.length)}, worker));
    QUIZ._hideLoader();
    if(!all.length){toast('❌ No questions loaded. Cache data first if offline.',5000);return}
    if(failed>0) toast(`⚠️ ${failed} file${failed>1?'s':''} failed to load — starting with ${all.length} questions`);
    let qsArr=shuf(all);
    if(type==='exam')qsArr=qsArr.slice(0,100);
    if(type==='weak'){
      const wu=new Set(S.wr.map(w=>w.uid));
      const weak=qsArr.filter(q=>wu.has(q.uid));
      qsArr=weak.length?weak:qsArr.slice(0,50);
      if(!weak.length)toast('ℹ️ No wrong answers yet — showing 50 random instead');
    }
    QUIZ.startWith(qsArr,type==='exam'?'exam':'flashcard','⚡ Psycho Mode');
  }
};
/* ═══════════════ REV — Review lists ═══════════════ */
const REV = {
  _filters: { bk: '', fl: '', wr: '' },

  _FILTERS_KEY: 'abhyas_rev_filters',
  _loadFilters(){
    try {
      const raw = sessionStorage.getItem(this._FILTERS_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return;
      ['bk','fl','wr'].forEach(k => { if (typeof o[k] === 'string') this._filters[k] = o[k]; });
    } catch(e){}
  },
  _saveFilters(){
    try { sessionStorage.setItem(this._FILTERS_KEY, JSON.stringify(this._filters)); } catch(e){}
  },

  filterList(kind, term){
    this._filters[kind] = String(term || '').toLowerCase().trim();
    this._saveFilters();
    if (kind === 'wr' && typeof WRONGBY !== 'undefined' && WRONGBY.render) WRONGBY.render();
    else this.renderList(kind);
  },
  _matches(q, term){
    if (!term) return true;
    return (String(q.q || '').toLowerCase().indexOf(term) !== -1) ||
           (q.options || []).some(o => String(o).toLowerCase().indexOf(term) !== -1) ||
           (String(q.explanation || '').toLowerCase().indexOf(term) !== -1) ||
           (String(q.tag || '').toLowerCase().indexOf(term) !== -1);
  },
  _store(kind){ return kind==='bk'?S.bk : kind==='fl'?S.fl : S.wr; },
  _lsKey(kind){ return kind==='bk'?LS.BK : kind==='fl'?LS.FL : LS.WR; },
  _listEl(kind){ return kind==='bk'?'bk-list' : kind==='fl'?'fl-list' : 'wr-list'; },

  _stripHeavy(q){
    if(!q || !q.img) return q;
    const {img, imgCaption, ...rest} = q;
    return rest;
  },

  toggle(kind, question){
    const arr = REV._store(kind);
    const i = arr.findIndex(x=>x.uid===question.uid);
    if(i>-1){ arr.splice(i,1); toast(kind==='bk'?'⭐ Removed bookmark':'🚩 Removed flag'); }
    else { arr.push(kind==='bk' ? {...REV._stripHeavy(question), tag:''} : REV._stripHeavy(question)); toast(kind==='bk'?'⭐ Bookmarked':'🚩 Flagged'); }
    _save(REV._lsKey(kind), arr);
    HOME.updateBadges();
    return i===-1;
  },
  has(kind, uid){ return REV._store(kind).some(x=>x.uid===uid); },
  getTag(uid){ return S.bk.find(x=>x.uid===uid)?.tag || ''; },
  setTag(uid, tag, questionObj){
    let item = S.bk.find(x=>x.uid===uid);
    if(!item && questionObj){ item = {...REV._stripHeavy(questionObj), tag: ''}; S.bk.push(item); }
    if(!item) return;
    item.tag = tag;
    _save(LS.BK, S.bk);
    REV.renderList('bk');
    HOME.updateBadges?.();
  },

  addWrong(question){
    const existing = S.wr.find(x=>x.uid===question.uid);
    if(existing){ existing._streak = 0; existing._nextDue = Date.now(); _save(LS.WR, S.wr); HOME.updateBadges(); return; }
    S.wr.push({...REV._stripHeavy(question), _streak:0, _nextDue: Date.now(), _addedAt: Date.now()});
    _save(LS.WR, S.wr);
    HOME.updateBadges();
  },
  removeWrong(uid){
    const i=S.wr.findIndex(x=>x.uid===uid);
    if(i>-1){ S.wr.splice(i,1); _save(LS.WR, S.wr); HOME.updateBadges(); if(typeof PROGRESS_RESET!=='undefined') PROGRESS_RESET.noteRemoved(uid); }
  },
  /* v1.37: a question that passes its 14-day review is MOVED to a Mastered archive on this device, never
     silently discarded. If the archive cannot be written (storage full) the question simply stays in the
     wrong bank. An Undo toast and the "Bring back mastered" button put it back. */
  MASTERED_KEY: 'abhyas_wr_mastered',
  _masteredLoad(){
    try { const v = JSON.parse(localStorage.getItem(REV.MASTERED_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch(e){ return []; }
  },
  _masteredSave(list){
    try { localStorage.setItem(REV.MASTERED_KEY, JSON.stringify(list)); return true; } catch(e){ return false; }
  },
  graduate(uid){
    const i = S.wr.findIndex(x => x.uid === uid);
    if(i < 0) return false;
    const item = S.wr[i];
    const list = REV._masteredLoad();
    list.unshift({ ...item, _masteredAt: Date.now() });
    if(!REV._masteredSave(list)){
      toast('Storage is full, so this question stays in your wrong bank. Free up space in Data.');
      return false;
    }
    S.wr.splice(i, 1); _save(LS.WR, S.wr); HOME.updateBadges();
    if(typeof PROGRESS_RESET !== 'undefined') PROGRESS_RESET.noteRemoved(uid);
    REV._updateMasteredBtn();
    if(typeof toastUndo === 'function'){
      toastUndo('Mastered: moved out of your wrong bank', () => REV._restoreOne(uid));
    }
    return true;
  },
  _restoreOne(uid){
    const list = REV._masteredLoad();
    const j = list.findIndex(x => x.uid === uid);
    if(j < 0) return false;
    const item = list[j];
    if(!S.wr.some(x => x.uid === uid)){
      const back = { ...item, _streak: 0, _nextDue: Date.now(), _addedAt: Date.now() };
      delete back._masteredAt;
      S.wr.push(back);
      _save(LS.WR, S.wr);
    }
    list.splice(j, 1); REV._masteredSave(list);
    HOME.updateBadges(); REV._updateMasteredBtn();
    if(typeof REV.renderList === 'function') REV.renderList('wr');
    if(typeof PSYNC !== 'undefined') PSYNC.scheduleSync();
    return true;
  },
  restoreMastered(){
    const uids = REV._masteredLoad().map(x => x.uid);
    if(!uids.length){ toast('No mastered questions yet'); return; }
    let n = 0; uids.forEach(u => { if(REV._restoreOne(u)) n++; });
    toast('Brought back ' + n + ' mastered question' + (n === 1 ? '' : 's') + ' for revision');
  },
  _updateMasteredBtn(){
    const b = document.getElementById('wr-mastered-btn');
    if(!b) return;
    const n = REV._masteredLoad().length;
    b.hidden = n === 0;
    b.textContent = 'Bring back mastered (' + n + ')';
  },
  trackAnswer(question, isCorrect){
    if(isCorrect){
      const item = S.wr.find(x=>x.uid===question.uid);
      if(!item) return;
      if(item._nextDue && item._nextDue > Date.now()) return;   /* not due yet: extra practice doesn't count */
      const prev = item._streak || 0;
      /* Reviews happen after 1, 3, 7 and 14 days. The question graduates only
         once the 14-day review has been answered correctly. */
      if(prev >= SR_INTERVALS.length){ REV.graduate(question.uid); return; }
      item._streak = prev + 1;
      item._nextDue = Date.now() + SR_INTERVALS[prev]*24*60*60*1000;
      _save(LS.WR, S.wr);
      HOME.updateBadges?.();
    } else {
      REV.addWrong(question);
    }
  },
  dueWrong(){ return S.wr.filter(x => !x._withdrawn && ((x._nextDue==null) || x._nextDue <= Date.now())); },
  dueCount(){ return REV.dueWrong().length; },

  renderList(kind){
    let arr = REV._store(kind);
    REV._loadFilters();
    const _inputId = kind === 'bk' ? 'bk-search' : kind === 'fl' ? 'fl-search' : 'wr-search';
    const _input = document.getElementById(_inputId);
    if (_input && _input.value !== REV._filters[kind]) _input.value = REV._filters[kind];
    const filter = this._filters[kind] || '';
    if (filter) arr = arr.filter(q => this._matches(q, filter));
    if(kind === 'wr') REV._updateMasteredBtn();
    const el = document.getElementById(REV._listEl(kind));
    if(!el)return;
    if(!arr.length){
      const copy = kind==='bk'
        ? { i:'<i class="ph ph-star"></i>', t:'No bookmarks yet', s:'Tap the star on any question while studying to save it here.' }
        : kind==='fl'
        ? { i:'<i class="ph ph-flag"></i>', t:'No flagged questions yet', s:'Tap the flag on a question you want to come back to.' }
        : { i:'<i class="ph ph-x-circle"></i>', t:'No wrong answers yet', s:'Questions you miss land here automatically, ready for spaced review.' };
      el.innerHTML = `<div class="empty"><div class="empty-i">${copy.i}</div><p>${copy.t}</p><p style="font-size:.72rem;color:var(--t3);margin-top:.15rem">${copy.s}</p></div>`;
      return;
    }
    if(kind==='wr'){
      arr = [...arr].sort((a,b)=>(a._nextDue??0)-(b._nextDue??0));
    }
    el.innerHTML = arr.map((q,i)=>{
      const opts=(q.options||[]).map((o,j)=>{
        const c=String(j)===String(q.correct)||j===Number(q.correct);
        return `<div class="eo${c?' shc':''}">${String.fromCharCode(65+j)}) ${esc(o)}</div>`;
      }).join('');
      const uidJson = JSON.stringify(String(q.uid||''));
      const kindJson = JSON.stringify(kind);
      const tagPicker = kind==='bk' ? `
        <select class="sel-c" style="margin-top:.4rem;font-size:.7rem;padding:.25rem .4rem;width:auto" data-on-change='REV.setTag(${uidJson}, this.value)'>
          <option value="">🏷 No tag</option>
          ${BK_TAGS.map(t=>`<option value="${t}" ${q.tag===t?'selected':''}>${t}</option>`).join('')}
        </select>` : '';
      const reasonPicker = kind==='wr' ? (() => {
        const r = q._reason || (q._misconception ? 'careless' : '');
        return `<select class="sel-c" style="margin-top:.4rem;font-size:.7rem;padding:.25rem .4rem;width:auto" data-on-change='WRONGBY.setReason(${uidJson}, this.value)'>
          <option value="">Why did I miss this?</option>
          <option value="careless" ${r==='careless'?'selected':''}>Careless</option>
          <option value="concept"  ${r==='concept' ?'selected':''}>Concept gap</option>
        </select>`;
      })() : '';
      const notePicker = kind==='wr' ? (() => {
        const n = (typeof QNOTE !== 'undefined') ? QNOTE.get(q.uid) : String(q._note || '');
        return `<div style="margin-top:.4rem">` +
          `<input class="input" type="text" maxlength="500" ` +
          `placeholder="Your note on this question (optional)" ` +
          `value="${escAttrJs(n)}" ` +
          `data-on-change='WRONGBY.setNote(${uidJson}, this.value)' ` +
          `style="font-size:var(--fs-foot)">` +
        `</div>`;
      })() : '';
      let missBadge = '';
      if(kind==='wr' && typeof WRONGBY !== 'undefined'){
        const mc = WRONGBY.missCount(q.uid);
        if (mc >= 3) missBadge = `<span class="ctag tr" style="margin-left:.3rem" title="You have missed this question ${mc} times"><i class="ph ph-warning"></i> missed ${mc}\u00d7</span>`;
      }
      let srBadge = '';
      if(kind==='wr'){
        const isDue = (q._nextDue==null) || q._nextDue<=Date.now();
        const streak = q._streak||0;
        if(isDue){ srBadge = `<span class="ctag tr" style="margin-left:.3rem"><i class="ph ph-repeat"></i> Due now</span>`; }
        else {
          const daysLeft = Math.ceil((q._nextDue-Date.now())/(24*60*60*1000));
          srBadge = `<span class="ctag ta" style="margin-left:.3rem">⏳ Due in ${daysLeft}d</span>`;
        }
        if(streak>0) srBadge += `<span class="ctag tg" style="margin-left:.3rem"><i class="ph ph-check"></i>×${streak}</span>`;
      }
      return `<div class="qcard" style="margin-bottom:.5rem">
        <div class="qm"><span class="qn mono">#${i+1}</span>
          ${q.tag ? `<span class="ctag ta" style="margin-left:.3rem"><i class="ph ph-tag"></i> ${esc(q.tag)}</span>` : ''}
          ${srBadge}
          ${missBadge}
          ${q._withdrawn ? `<span class="ctag tr" style="margin-left:.3rem" title="This question was removed from the question bank"><i class="ph ph-prohibit"></i> Withdrawn</span>` : ''}
          ${(q._corrected && Date.now() - q._corrected < 14*24*60*60*1000) ? `<span class="ctag tg" style="margin-left:.3rem" title="Your teacher corrected this question"><i class="ph ph-check-circle"></i> Corrected</span>` : ''}
          ${qReportHtml(q, `USER_REPORT.reportList(${kindJson},${uidJson})`)}
          ${qSearchHtml(q)}
          <button class="ib" data-on-click='REV._removeOne(${kindJson},${uidJson})' title="Remove from review" aria-label="Remove from review"><i class="ph ph-trash"></i></button>
        </div>
        <div class="qt" style="font-size:.82rem">${esc(q.q)}</div>
        ${qImgHtml(q)}
        <div style="margin-top:.3rem">${opts}</div>
        ${q.explanation?`<div class="expl show" style="margin-top:.45rem">${esc(q.explanation)}</div>`:''}
        ${tagPicker}
        ${reasonPicker}
        ${notePicker}
      </div>`;
    }).join('');
    renderMath(el);
  },
  _removeOne(kind, uid){
    const arr=REV._store(kind);
    const i=arr.findIndex(x=>x.uid===uid);
    if(i>-1){
      const item = arr[i];
      arr.splice(i,1);_save(REV._lsKey(kind),arr);REV.renderList(kind);HOME.updateBadges();
      if(kind==='wr' && typeof PROGRESS_RESET!=='undefined'){
        PROGRESS_RESET.noteRemoved(uid);
        toastUndo('Removed from wrong bank', ()=>{
          /* put it back as a fresh entry (newer than the removal marker, so sync keeps it) */
          if(S.wr.some(x=>x.uid===uid)) return;
          S.wr.push({...item, _addedAt: Date.now()});
          _save(LS.WR, S.wr); REV.renderList('wr'); HOME.updateBadges();
          if(typeof PSYNC!=='undefined') PSYNC.scheduleSync();
        });
      }
    }
  },
  clearAll(kind){
    const prev = JSON.parse(JSON.stringify(REV._store(kind)));
    if(kind==='bk'){S.bk=[];_save(LS.BK,[]);}
    else if(kind==='fl'){S.fl=[];_save(LS.FL,[]);}
    else {S.wr=[];_save(LS.WR,[]);}
    const clearedAt = (kind==='wr' && typeof PROGRESS_RESET!=='undefined') ? PROGRESS_RESET.noteWrongCleared() : 0;
    REV.renderList(kind); HOME.updateBadges();
    toastUndo('🗑 List cleared', ()=>{
      if(kind==='bk'){S.bk=prev;_save(LS.BK,prev);}
      else if(kind==='fl'){S.fl=prev;_save(LS.FL,prev);}
      else {S.wr=prev;_save(LS.WR,prev); if(clearedAt) PROGRESS_RESET.lift([clearedAt]); if(typeof PSYNC!=='undefined') PSYNC.scheduleSync();}
      REV.renderList(kind); HOME.updateBadges();
      toast('↩️ Restored');
    });
  },
  start(kind, mode, dueOnly){
    let arr = [...REV._store(kind)].filter(x => !x._withdrawn);     /* a withdrawn question stays listed but is never practised */
    if(kind==='wr' && dueOnly) arr = REV.dueWrong();
    if(!arr.length){toast(dueOnly?'Nothing due for review right now 🎉':'Nothing to study here yet');return}
    QUIZ.startWith(shuf(arr), mode, kind==='bk'?'⭐ Bookmarks':kind==='fl'?'🚩 Flagged':(dueOnly?'🔁 Wrong Bank (Due Today)':'❌ Wrong Bank'));
  }
};

/* ═══════════════ QUIZ — MCQ engine ═══════════════ */
const QUIZ = {
  /* Objective chapter MCQ files are published to a GitHub content repo and
     served through jsDelivr after the daily sync. Weekly sets and the
     subjective bank are NOT mirrored, so a 404 here just falls through
     to the Apps Script path below. Replace YOUR-USERNAME with your
     GitHub username (the same one used in chapters-loader.js). */
  /* From config.js. The CDN is tried FIRST for every objective file; Apps Script is the fallback. */
  CDN_BASE: (window.ABHYAS_CONFIG && window.ABHYAS_CONFIG.CONTENT_CDN_BASE) || '',

  async _fetch(fileId, cacheKey, attempt=1, kind='fg'){
    function _validCache(v){
      if(!v) return false;
      if(v && typeof v === 'object' && !Array.isArray(v) && v.success === false) return false;
      return true;
    }
    if(!S.online){
      const cached = await QDB.get(cacheKey);
      if(_validCache(cached)) return cached;
      if(cached && !_validCache(cached)) throw new Error('Cached data is invalid (a previous network error was stored). Go online to refresh it.');
      throw new Error('You are offline and this set is not cached yet. Go to the Offline Cache tab to download it while online.');
    }
    if(attempt === 1 && kind !== 'bg'){
      const hit = await QDB.get(cacheKey);
      if(_validCache(hit)){ QUIZ._maybeRevalidate(fileId, cacheKey); return hit; }
    }
    try{
      /* Try the CDN first for objective chapter files.
         jsDelivr mirrors the GitHub content repo, so a hit returns the
         same JSON Apps Script would, from an edge cache. A 404 means the
         file is not mirrored (weekly set, subjective bank) — fall through. */
      try{
        const cdnData = await QUIZ._fetchFromCDN(fileId, attempt === 1 ? 12000 : 8000);
        if(_validCache(cdnData)) await QDB.set(cacheKey, cdnData);
        return cdnData;
      }catch(cdnErr){ /* 404 / timeout / offline / non-JSON — try Apps Script */ }

      const timeoutMs = attempt === 1 ? 25000 : 15000;
      if(typeof GETFILE_GATE !== 'undefined') await GETFILE_GATE.take(kind);
      const auth = { username: (S.user && S.user.username) || '', token: (S.user && S.user.token) || '' };
      const r = await netFetch(`${APPS}?${qs({action:'getFile', fileId, ...auth})}`, {redirect:'follow'}, timeoutMs);
      const text = await r.text();
      if(text.trim().startsWith('<')){
        throw new Error('Server returned an HTML page instead of JSON — the Apps Script may be down or requires re-authorisation.');
      }
      let data;
      try{ data = JSON.parse(text); }
      catch(pe){ throw new Error('Could not parse server response. The file may be corrupted or the server returned an unexpected format.'); }
      if(data && data.rateLimited && attempt < 4){
        const waitSec = Math.min(20, Math.max(3, Number(data.retryAfterSec) || 6));
        if(typeof GETFILE_GATE !== 'undefined') GETFILE_GATE.backoff(waitSec * 1000 + 500);
        toast('⏳ Server is busy — retrying in ' + waitSec + 's…', 3000);
        await new Promise(res => setTimeout(res, waitSec * 1000));
        return QUIZ._fetch(fileId, cacheKey, attempt + 1, kind);
      }
      if(data && data.sessionInvalid){
        throw new Error('Your session expired. Sign out and sign in again to keep studying.');
      }
      if(data && data.needsPayment){
        throw new Error('Your access has ended. Complete the payment to open new chapters — anything already downloaded still works offline.');
      }
      if(data && typeof data === 'object' && !Array.isArray(data) && data.success === true){
        if(data.result !== undefined) data = data.result;
        else if(data.data !== undefined) data = data.data;
        else if(data.questions !== undefined) data = data.questions;
      }
      if(data && typeof data === 'object' && !Array.isArray(data) && data.success === false){
        throw new Error(data.error || 'Server returned an error for this file.');
      }
      if(_validCache(data)){
        const ok = await QDB.set(cacheKey, data);
        if(!ok && !QUIZ._cacheWarned){
          QUIZ._cacheWarned = true;
          toast('⚠️ Device storage is full — quizzes still work, but new sets won\'t be saved for offline use. Clear some cached sets from the Offline Cache tab to free space.', 6000);
        }
      }
      return data;
    } catch(err){
      const cached = await QDB.get(cacheKey);
      if(_validCache(cached)){ toast('📦 Loaded from cache (network error)'); return cached; }
      if(attempt < 2 && (err.message.includes('timed out') || err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))){
        toast('⚠️ Slow connection — retrying…');
        await new Promise(res => setTimeout(res, 1500));
        return QUIZ._fetch(fileId, cacheKey, attempt + 1, kind);
      }
      throw err;
    }
  },

  /* ── One question file, straight from jsDelivr. ── */
  async _fetchFromCDN(fileId, timeoutMs){
    if(!this.CDN_BASE) throw new Error('CDN 404 (no mirror configured)');
    if(!S.online || S.forcedOffline) throw new Error('OFFLINE');
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
    try{
      const r = await fetch(`${this.CDN_BASE}/content/${fileId}.json`,
                            { signal: ctrl.signal, cache: 'default' });
      clearTimeout(timer);
      if(!r.ok) throw new Error('CDN ' + r.status);
      const data = await r.json();
      /* v1.40: the mirrored file may be encrypted ({enc:1,kid,iv,ct}); the key comes from the backend for paid students only */
      if(typeof CONTENT_CRYPTO !== 'undefined' && CONTENT_CRYPTO.isEnvelope(data)) return await CONTENT_CRYPTO.open(data, fileId);
      if(data && data.enc === 1) throw new Error('Encrypted file but no decryptor loaded');
      return data;
    }catch(e){
      clearTimeout(timer);
      throw e;
    }
  },

  /* v1.34: fetch several question files in ONE request (action getFiles) and save each one. Used by the offline
     download. refs = [{fid, key}]. Returns:
       { unsupported:true }              the server is the older version without getFiles (caller falls back to _fetch)
       { rateLimited:true, waitSec }     server asked us to slow down; nothing was saved, try the same refs again later
       { saved:[ref], failed:[{ref,error}], deferred:[ref] }   deferred = the server left them out to keep the answer small
     Throws for an expired session or ended access (every file would fail the same way) and for network errors. */
    async _fetchBatch(refs){
    if(!S.online || S.forcedOffline) throw new Error('You are offline.');

    /* The CDN carries every chapter MCQ file. Try it first, in
       parallel. Files not on the CDN (weekly sets, subjective bank) come
       back as 404 and are handled by the Apps Script fallback below. */
    if(refs.length >= 1 && QUIZ.CDN_BASE){
      const cdnResults = await Promise.all(refs.map(async ref => {
        try{
          const data = await QUIZ._fetchFromCDN(ref.fid, 12000);
          const ok = await QDB.set(ref.key, data);
          return { ref, ok, cdn: true, error: ok ? '' : 'Device storage is full.' };
        }catch(e){
          return { ref, ok: false, cdn: false, error: e.message };
        }
      }));
      const allOk = cdnResults.every(r => r.ok);
      if(allOk){
        return { saved: refs.slice(), failed: [], deferred: [] };
      }
      /* If some of the batch isn't on the CDN, retry the whole batch through
         Apps Script so weekly sets and subjective files still work. */
      const savedOnCdn = cdnResults.filter(r => r.ok).map(r => r.ref);
      const notOnCdn   = cdnResults.filter(r => !r.ok && !r.cdn).map(r => r.ref);
      const cdnFailed  = cdnResults.filter(r => !r.ok && r.cdn).map(r => ({ ref: r.ref, error: r.error }));
      /* If none failed due to "not on CDN", we've done all we can via CDN —
         report what we got and don't hit Apps Script for files that 404'd. */
      if(notOnCdn.length === 0){
        return { saved: savedOnCdn, failed: cdnFailed, deferred: [] };
      }
      refs = notOnCdn;
      if(refs.length === 0){
        return { saved: savedOnCdn, failed: cdnFailed, deferred: [] };
      }
      /* Fall through and hand the rest to Apps Script. The CDN saved ones
         are already in IndexedDB. */
      var _cdnPrefix = { saved: savedOnCdn, failed: cdnFailed, deferred: [] };
    }

    if(typeof GETFILE_GATE !== 'undefined') await GETFILE_GATE.take('fg');
    const auth = { username: (S.user && S.user.username) || '', token: (S.user && S.user.token) || '' };
    const r = await netFetch(`${APPS}?${qs({action:'getFiles', fileIds: refs.map(x => x.fid).join(','), ...auth})}`, {redirect:'follow'}, 60000);
    const text = await r.text();
    if(text.trim().startsWith('<')){
      throw new Error('Server returned an HTML page instead of JSON — the Apps Script may be down or requires re-authorisation.');
    }
    let data;
    try{ data = JSON.parse(text); }
    catch(pe){ throw new Error('Could not parse server response. The server returned an unexpected format.'); }
    if(!data || typeof data !== 'object') throw new Error('Server returned an unexpected answer.');
    if(data.rateLimited){
      const waitSec = Math.min(20, Math.max(3, Number(data.retryAfterSec) || 6));
      if(typeof GETFILE_GATE !== 'undefined') GETFILE_GATE.backoff(waitSec * 1000 + 500);
      return { rateLimited:true, waitSec };
    }
    if(data.sessionInvalid) throw new Error('Your session expired. Sign out and sign in again to keep studying.');
    if(data.needsPayment) throw new Error('Your access has ended. Complete the payment to open new chapters — anything already downloaded still works offline.');
    if(data.success === false && /^unknown action/i.test(String(data.error || ''))){
      /* Older backend — fall back to per-file fetches through the CDN path. */
      const out = _cdnPrefix || { saved:[], failed:[], deferred:[] };
      out.noBatch = true;      /* tell the download loop to stop asking this server for batches */
      for(const ref of refs){
        try{
          const cdnData = await QUIZ._fetchFromCDN(ref.fid, 12000).catch(() => QUIZ._fetch(ref.fid, ref.key));
          const ok = await QDB.set(ref.key, cdnData);
          if(ok) out.saved.push(ref); else out.failed.push({ ref, error:'Device storage is full.', storageFull:true });
        }catch(e){ out.failed.push({ ref, error: e.message }); }
      }
      return out;
    }
    if(data.success !== true || !data.files || typeof data.files !== 'object'){
      throw new Error(data.error || 'Server returned an error for these files.');
    }
    const out = _cdnPrefix || { saved:[], failed:[], deferred:[] };
    if(!out.deferred) out.deferred = [];
    const later = new Set(Array.isArray(data.deferred) ? data.deferred : []);
    for(const ref of refs){
      if(later.has(ref.fid)){ out.deferred.push(ref); continue; }
      const e = data.files[ref.fid];
      if(!e){ out.failed.push({ ref, error:'The server did not return this file.' }); continue; }
      if(e.success !== true){ out.failed.push({ ref, error: e.error || 'Server returned an error for this file.' }); continue; }
      let v = e.result;
      if(v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v) && v.success === false)){
        out.failed.push({ ref, error:'The file is empty or not valid.' }); continue;
      }
      const ok = await QDB.set(ref.key, v);
      if(!ok && !QUIZ._cacheWarned){
        QUIZ._cacheWarned = true;
        toast('⚠️ Device storage is full — quizzes still work, but new sets won\'t be saved for offline use.', 6000);
      }
      if(ok) out.saved.push(ref);
      else out.failed.push({ ref, error:'Device storage is full.', storageFull:true });
    }
    return out;
  },
  _reval: {},
  _maybeRevalidate(fileId, cacheKey){
    try{
      const TS_KEY = 'abhyas_qts';
      const map = _load(TS_KEY, {});
      if(Date.now() - (map[cacheKey] || 0) < 24*60*60*1000 || QUIZ._reval[cacheKey]) return;
      QUIZ._reval[cacheKey] = true;
      QUIZ._revalidateQuiet(fileId, cacheKey)
        .then(ok => { if(ok){ const m = _load(TS_KEY, {}); m[cacheKey] = Date.now(); _save(TS_KEY, m); } })
        .catch(() => {})
        .finally(() => { delete QUIZ._reval[cacheKey]; });
    }catch(e){}
  },
    async _revalidateQuiet(fileId, cacheKey){
    if(!S.online || S.forcedOffline) return false;
    /* Revalidate against the CDN, not Apps Script. Falls through to
       the old path only if the CDN doesn't have the file. */
    try{
      const data = await QUIZ._fetchFromCDN(fileId, 12000);
      return await QDB.set(cacheKey, data);
    }catch(e){
      if(String(e.message || '').indexOf('CDN 404') === -1) return false;
      /* Not on CDN — fall through to Apps Script as before. */
    }
    if(typeof GETFILE_GATE !== 'undefined') await GETFILE_GATE.take('bg');
    const auth = { username: (S.user && S.user.username) || '', token: (S.user && S.user.token) || '' };
    const r = await netFetch(`${APPS}?${qs({action:'getFile', fileId, ...auth})}`, {redirect:'follow'}, 25000);
    const text = await r.text();
    if(text.trim().startsWith('<')) return false;
    let data;
    try{ data = JSON.parse(text); }catch(e){ return false; }
    if(!data || data.rateLimited || data.sessionInvalid || data.needsPayment) return false;
    if(typeof data === 'object' && !Array.isArray(data) && data.success === true){
      if(data.result !== undefined) data = data.result;
      else if(data.data !== undefined) data = data.data;
      else if(data.questions !== undefined) data = data.questions;
    }
    if(!data || (typeof data === 'object' && !Array.isArray(data) && data.success === false)) return false;
    return await QDB.set(cacheKey, data);
  },
  _cacheWarned: false,

  async load(fileId, cacheKey, mode, chapterName, scope=null){
    if(!S.online || S.forcedOffline){
      const cached = await QDB.get(cacheKey);
      const isValid = cached && !(typeof cached === 'object' && !Array.isArray(cached) && cached.success === false);
      if(!isValid){
        QUIZ._showError('You are offline and this set is not cached yet. Go to the Offline Cache tab while online to download it.', null);
        return;
      }
    }
    QUIZ._showLoader('Connecting to server…');
    const msgTimer = setTimeout(()=>{ QUIZ._showLoader('Still loading… (Apps Script may be warming up)'); }, 5000);
    const msgTimer2 = setTimeout(()=>{ QUIZ._showLoader('Taking longer than usual… please wait or check your connection.'); }, 12000);
    try{
      const raw = await QUIZ._fetch(fileId, cacheKey);
      clearTimeout(msgTimer); clearTimeout(msgTimer2);
      const qsArr = normQ(raw, fileId);
      QUIZ._hideLoader();
      if(!qsArr.length){ toast('❌ No valid questions found in this file. Check the file format.'); return; }
      QUIZ.startWith(qsArr, mode, chapterName, scope);
      setTimeout(()=>{ try{ CACHE.prefetchNext(fileId); }catch(e){} }, 4000);
    } catch(err){
      clearTimeout(msgTimer); clearTimeout(msgTimer2);
      QUIZ._hideLoader();
      const msg = err.message==='OFFLINE'
        ? 'You are offline and this set has not been downloaded yet. Open Downloads while you have a connection to save it.'
        : err.message;
      QUIZ._showError(msg, ()=>QUIZ.load(fileId, cacheKey, mode, chapterName, scope));
    }
  },

  _showError(msg, retryFn){
    let el = document.getElementById('quiz-error-card');
    if(!el){
      el = document.createElement('div');
      el.id = 'quiz-error-card';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1.5rem';
      document.body.appendChild(el);
    }
    el._retry = retryFn || null;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'quiz-err-title');
    el.innerHTML = `<div style="background:var(--c2);border:1px solid var(--bad-bd);border-radius:var(--r3);padding:1.4rem 1.5rem;max-width:380px;width:100%;box-shadow:var(--sh3)">
      <div style="font-size:1.4rem;margin-bottom:.5rem"><i class="ph ph-x-circle"></i></div>
      <div id="quiz-err-title" style="font-family:var(--fd);font-size:.92rem;font-weight:700;color:var(--ros);margin-bottom:.6rem">Failed to Load</div>
      <div style="font-size:.78rem;color:var(--t2);line-height:1.6;margin-bottom:1rem">${esc(msg)}</div>
      <div style="display:flex;gap:.5rem">
        <button id="quiz-err-retry" style="flex:1;padding:.58rem;background:linear-gradient(135deg,var(--amb2),var(--amb));border:none;border-radius:var(--r1);color:var(--on-accent);font-weight:700;font-size:.82rem;cursor:pointer;font-family:var(--ff)"><i class="ph ph-arrow-clockwise"></i> Retry</button>
        <button id="quiz-err-close" style="padding:.58rem .9rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r1);color:var(--t2);font-size:.82rem;cursor:pointer;font-family:var(--ff)"><i class="ph ph-x"></i> Close</button>
      </div>
    </div>`;
    el.style.display = 'flex';
    document.getElementById('quiz-err-retry').onclick = ()=>{ el.remove(); if(el._retry) el._retry(); };
    document.getElementById('quiz-err-close').onclick = ()=> el.remove();
  },

  _showLoader(msg){
    let el = document.getElementById('quiz-loader');
    if(!el){
      el = document.createElement('div');
      el.id = 'quiz-loader';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:1rem;backdrop-filter:blur(4px)';
      el.innerHTML = '<div style="width:44px;height:44px;border:4px solid rgba(255,255,255,.2);border-top-color:var(--neon);border-radius:50%;animation:spin 0.8s linear infinite"></div><div id="quiz-loader-msg" style="color:#fff;font-size:.9rem;font-weight:600;text-align:center;padding:0 1.5rem"></div>';
      document.body.appendChild(el);
      if(!document.getElementById('quiz-loader-style')){
        const st = document.createElement('style');
        st.id = 'quiz-loader-style';
        st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(st);
      }
    }
    document.getElementById('quiz-loader-msg').textContent = msg || 'Loading…';
    el.style.display = 'flex';
  },
  _hideLoader(){
    const el = document.getElementById('quiz-loader');
    if(el) el.remove();
  },

  startWith(qsArr, mode, chapterName, scope=null){
    if(!qsArr || !qsArr.length){ toast('No questions to study'); return; }
    QUIZ._stopTimer();
    if(mode !== 'exam' && !(scope && scope.weeklyId) && S.cov){
      const seenQ = q => {
        const uid = String((q && q.uid) || '');
        const i = uid.lastIndexOf('_');
        if(i < 1) return false;
        const c = S.cov[uid.slice(0, i)];
        if(!c || !c.p) return false;
        const ch = c.p[parseInt(uid.slice(i + 1), 10)];
        return !!ch && ch !== '0';
      };
      const fresh = qsArr.filter(q => !seenQ(q));
      const old = qsArr.filter(seenQ);
      if(fresh.length && old.length) qsArr = fresh.concat(old);
    }
    if(qsArr.length > 20){
      QUIZ._showLimitPicker(qsArr, mode, chapterName, scope);
      return;
    }
    QUIZ._doStart(qsArr, mode, chapterName, true, scope);
  },

  _showLimitPicker(qsArr, mode, chapterName, scope=null){
    if(document.getElementById('quiz-limit-modal')) return;
    const total = qsArr.length;
    const presets = [10,20,30,50].filter(n=>n<total);
    const modal = document.createElement('div');
    modal.id = 'quiz-limit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1.5rem;backdrop-filter:blur(4px)';
    const isWeekly = !!(scope && scope.weeklyId);
    modal.innerHTML = `
      <div style="background:var(--c2);border:1px solid var(--bd);border-radius:var(--r3);padding:1.5rem;max-width:340px;width:100%;box-shadow:var(--sh3)" role="dialog" aria-modal="true" aria-labelledby="qlm-title">
        <div style="font-size:1.2rem;margin-bottom:.35rem">${mode==='exam'?'<i class="ph ph-note-pencil"></i>':'<i class="ph ph-lightning"></i>'}</div>
        <div id="qlm-title" style="font-family:var(--fd);font-size:.92rem;font-weight:700;color:var(--t1);margin-bottom:.2rem">${esc(chapterName||'Quiz')}</div>
        <div style="font-size:.74rem;color:var(--t3);margin-bottom:1rem">${pluralize(total,'question')} available (unseen ones come first). How many do you want to do?</div>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem">
          ${presets.map(n=>`<button data-qn="${n}" class="qlm-preset" style="padding:.35rem .7rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r1);color:var(--t2);font-size:.76rem;cursor:pointer;font-family:var(--ff)">${n}</button>`).join('')}
          <button data-qn="${total}" class="qlm-preset" style="padding:.35rem .7rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r1);color:var(--t2);font-size:.76rem;cursor:pointer;font-family:var(--ff)">All ${total}</button>
        </div>
        <input id="qlm-inp" type="number" min="1" max="${total}" value="${isWeekly ? total : Math.min(20,total)}"
          style="width:100%;background:var(--c1);border:1.5px solid var(--b1);border-radius:var(--r2);padding:.5rem .75rem;color:var(--t1);font-size:.9rem;font-family:var(--ff);outline:none;box-sizing:border-box;margin-bottom:.6rem" ${isWeekly ? 'readonly' : ''}>
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer;font-size:.8rem;color:var(--t2);${isWeekly?'opacity:.55':''}">
          <input id="qlm-shuffle" type="checkbox" ${isWeekly?'disabled':''} style="width:16px;height:16px;accent-color:var(--amb);cursor:pointer">
          <i class="ph ph-shuffle"></i> Shuffle question order
        </label>
        <div style="display:flex;gap:.4rem">
          <button id="qlm-start" style="flex:1;padding:.62rem;background:linear-gradient(135deg,var(--amb2),var(--amb));border:none;border-radius:var(--r2);color:var(--on-accent);font-weight:700;font-size:.85rem;cursor:pointer;font-family:var(--ff)">Start →</button>
          <button id="qlm-cancel" style="padding:.62rem .9rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r2);color:var(--t2);font-size:.83rem;cursor:pointer;font-family:var(--ff)"><i class="ph ph-x"></i></button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });
    document.querySelectorAll('#quiz-limit-modal .qlm-preset').forEach(btn=>{
      btn.onclick = ()=>{ document.getElementById('qlm-inp').value = btn.dataset.qn; };
    });
    document.getElementById('qlm-cancel').onclick = ()=> modal.remove();
    document.getElementById('qlm-start').onclick = ()=>{
      const n = Math.min(total, Math.max(1, parseInt(document.getElementById('qlm-inp').value)||total));
      const doShuffle = document.getElementById('qlm-shuffle').checked;
      modal.remove();
      const picked = doShuffle ? shuf(qsArr).slice(0,n) : qsArr.slice(0,n);
      QUIZ._doStart(picked, mode, chapterName, false, scope);
    };
  },

  _doStart(qsArr, mode, chapterName, doShuffle=true, scope=null){
    const isWeekly = !!(scope && scope.weeklyId);
    const reviewMode = !!(scope && scope.weeklyReviewMode);
    const effectiveShuffle = isWeekly ? false : doShuffle;

    const presetAnswers = reviewMode && scope.weeklyAttempt
      ? (scope.weeklyAttempt.answers || []).slice()
      : null;

    const modeLabel = reviewMode
      ? '👁️ Review'
      : (mode==='exam' ? '📝 Exam' : '⚡ Flashcard');
    toast(`${modeLabel} — ${qsArr.length} question${qsArr.length!==1?'s':''} · ${chapterName||'Study'}`, 2500);

    const examSeconds = (mode==='exam' && !reviewMode) ? qsArr.length*90 : 0;
    S.quiz = {
      qs: effectiveShuffle ? shuf(qsArr) : [...qsArr],
      ans: (presetAnswers && presetAnswers.length === qsArr.length)
        ? presetAnswers.slice()
        : new Array(qsArr.length).fill(null),
      mode: reviewMode ? 'flashcard' : mode,
      idx:0, timer:null, elapsed:0,
      left: examSeconds,
      examEndAt: mode==='exam' ? Date.now() + examSeconds*1000 : 0,
      examTotal: mode==='exam' ? examSeconds : 0, warned: [],
      active:true, ch: chapterName||'Study', scope, skipped:new Set(), shown:new Set(),
      startedAt: Date.now(),
      reviewOnly: reviewMode
    };
    document.getElementById('quiz-wrap').style.display='';
    document.querySelectorAll('.view').forEach(e=>e.classList.remove('on'));
    window.scrollTo(0,0);
    try{
      if(mode==='exam' && !reviewMode){
        document.getElementById('fc-wrap').style.display='none';
        document.getElementById('ex-wrap').style.display='';
        document.getElementById('res-wrap').style.display='none';
        QUIZ._renderExam();
      } else {
        document.getElementById('ex-wrap').style.display='none';
        document.getElementById('fc-wrap').style.display='';
        document.getElementById('res-wrap').style.display='none';
        QUIZ._renderFlashcard();
      }
    } catch(err){
      console.error('[QUIZ._doStart] render failed:', err);
      S.quiz.active = false;
      document.getElementById('quiz-wrap').style.display = 'none';
      toast('❌ Could not display this quiz — one of the questions may be malformed. Try a different set.', 5000);
      return;
    }
    if(!reviewMode) QUIZ._startTimer();
    if(mode==='exam' && !reviewMode) QUIZ._snapshotExam(true);
  },

  daily(){
    const refs = ChapterData.allFileRefs();
    if(!refs.length){ toast('No content configured yet'); return; }
    toast('⏳ Building today\'s challenge…');
    (async()=>{
      const picks = shuf(refs).slice(0, Math.min(10, refs.length));
      const all = [];
      let failed = 0;
      let _di = 0;
      const _dworker = async () => {
        while(_di < picks.length){
          const ref = picks[_di++];
          try{
            const raw = await QUIZ._fetch(ref.fid, ref.key);
            all.push(...normQ(raw, ref.fid));
          }catch(e){
            failed++;
            console.warn('[daily] Failed to load', ref.key, e.message);
          }
        }
      };
      await Promise.all(Array.from({length: Math.min(4, picks.length)}, _dworker));
      if(!all.length){ toast('❌ Could not load daily challenge — try caching data first'); return; }
      if(failed>0) toast(`⚠️ ${failed} file(s) failed — challenge uses ${all.length} questions`);
      const qsArr = shuf(all).slice(0,30);
      QUIZ.startWith(qsArr, 'flashcard', '🌟 Daily Challenge');
    })();
  },

  async adaptive(){
    const TARGET = 25;
    const seen = new Set();
    const pool = [];
    const addAll = list => { for(const q of list){ if(q && q.uid && !seen.has(q.uid)){ seen.add(q.uid); pool.push(q); } } };

    addAll(REV.dueWrong());
    addAll(S.bk.filter(q => q.tag==='Confusing' || q.tag==='Need Check'));

    if(pool.length >= TARGET){
      QUIZ.startWith(shuf(pool).slice(0,TARGET), 'flashcard', '🎯 Adaptive Practice');
      return;
    }

    const refs = ChapterData.allFileRefs();
    if(!refs.length){
      if(pool.length){ QUIZ.startWith(shuf(pool), 'flashcard', '🎯 Adaptive Practice'); return; }
      toast('No content configured yet'); return;
    }
    toast('⏳ Building your adaptive practice set…');
    const need = TARGET - pool.length;
    const _acc = ref => {
      const rec = S.chapStats[`${ChapterData.chapterName(ref.lv, ref.ch)} — ${ref.book}`];
      return (rec && rec.attempted >= 5) ? (rec.correct / rec.attempted) * 100 : null;
    };
    const _weak = refs.filter(r => { const a = _acc(r); return a !== null && a < 60; });
    const _rest = refs.filter(r => !_weak.includes(r));
    if(_weak.length) toast('Focusing on the chapters you find hardest.', 3000);
    const picks = shuf(_weak).slice(0, 5).concat(shuf(_rest)).slice(0, Math.min(8, refs.length));
    let failed = 0;
    const stopAt = pool.length + need*2;
    for(const ref of picks){
      if(pool.length >= stopAt) break;
      try{
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        addAll(normQ(raw, ref.fid));
      }catch(e){
        failed++;
        console.warn('[adaptive] Failed to load', ref.key, e.message);
      }
    }
    if(!pool.length){ toast('❌ Could not build a practice set — try caching data first'); return; }
    if(failed>0) toast(`⚠️ ${failed} file(s) failed — practice set uses what loaded`);
    QUIZ.startWith(shuf(pool).slice(0,TARGET), 'flashcard', '🎯 Adaptive Practice');
  },

  _startTimer(){
    QUIZ._stopTimer();
    S.quiz.timer = setInterval(()=>{
      if(!S.quiz.active)return;
      if(S.quiz.mode==='exam'){
        S.quiz.left = Math.max(0, Math.round((S.quiz.examEndAt - Date.now())/1000));
        const tEl=document.getElementById('ex-tmr'); if(tEl) tEl.textContent=fmt(S.quiz.left);
        if(S.quiz.left<=0){ toast('⏰ Time\'s up!'); QUIZ.submitExam(); return; }
        QUIZ._timerWarn(S.quiz.left);
        if(S.quiz.left % 15 === 0) QUIZ._snapshotExam();
      } else {
        S.quiz.elapsed++;
        const tEl=document.getElementById('fc-tmr'); if(tEl) tEl.textContent=fmt(S.quiz.elapsed);
      }
    },1000);
  },
  _stopTimer(){ if(S.quiz.timer){ clearInterval(S.quiz.timer); S.quiz.timer=null; } },
  /* 10 / 5 / 1 minute warnings: a toast, a screen-reader announcement, and a red timer in the last 5 minutes */
  _timerWarn(left){
    const total = S.quiz.examTotal || 0;
    const r = examWarning(left, total, S.quiz.warned || []);
    S.quiz.warned = r.warned;
    const tEl = document.getElementById('ex-tmr');
    if(tEl) tEl.style.color = left <= 300 ? 'var(--danger)' : '';
    if(!r.fire) return;
    const msg = r.fire >= 60 && r.fire % 60 === 0 ? (r.fire/60) + (r.fire === 60 ? ' minute' : ' minutes') + ' left' : r.fire + ' seconds left';
    toast('⏳ ' + msg);
    QUIZ._announce(msg);
  },
  _announce(msg){
    let el = document.getElementById('sr-live');
    if(!el){ el = document.createElement('div'); el.id = 'sr-live'; el.className = 'sr-only'; el.setAttribute('role','status'); el.setAttribute('aria-live','assertive'); document.body.appendChild(el); }
    el.textContent = ''; setTimeout(()=>{ el.textContent = msg; }, 50);
  },
  /* the question the student is on in the timed exam: the first card whose bottom is below the header */
  _exCurrent(){
    const cards = document.querySelectorAll('#ex-qs .eqc');
    for(let i=0;i<cards.length;i++){ if(cards[i].getBoundingClientRect().bottom > 110) return i; }
    return Math.max(0, cards.length - 1);
  },
  _exGo(qi){
    const c = document.getElementById('eqc-'+qi);
    if(c){ c.scrollIntoView({block:'start', behavior:'smooth'}); const o = c.querySelector('.eo'); if(o) o.focus({preventScroll:true}); }
  },

  toggleMark(qi){
    if(!S.quiz.marked) S.quiz.marked = new Set();
    if(S.quiz.marked.has(qi)) S.quiz.marked.delete(qi); else S.quiz.marked.add(qi);
    const b = document.querySelector(`#eqc-${qi} .ib.mark-btn`);
    if(b) b.classList.toggle('fl-on', S.quiz.marked.has(qi));
    if(document.getElementById('pal-grid')) QUIZ.showPalette(true);
  },
  showPalette(refresh){
    if(!S.quiz || !S.quiz.qs) return;
    const marked = S.quiz.marked || new Set();
    const tiles = S.quiz.qs.map((q, i) => {
      const done = S.quiz.ans[i] !== null && S.quiz.ans[i] !== undefined;
      const m = marked.has(i);
      const bg = m ? 'var(--warning-soft)' : done ? 'var(--accent-soft)' : 'var(--bg-sunken)';
      const bd = m ? 'var(--warning)' : done ? 'var(--accent)' : 'var(--sep-strong)';
      const col = m ? 'var(--warning)' : done ? 'var(--accent)' : 'var(--ink-2)';
      const state = m ? 'marked for review' : done ? 'answered' : 'not answered';
      return `<button type="button" data-on-click="QUIZ.goTo(${i})" aria-label="Question ${i+1}, ${state}" style="min-width:0;height:40px;border-radius:8px;border:1.5px solid ${bd};background:${bg};color:${col};font-weight:700;font-family:var(--mono);font-size:.8rem">${i+1}</button>`;
    }).join('');
    const nAns = S.quiz.ans.filter(a => a !== null && a !== undefined).length;
    const html = `<p class="t-foot mb3">${nAns} answered · ${S.quiz.qs.length - nAns} blank · ${marked.size} marked for review</p><div id="pal-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(44px,1fr));gap:6px">${tiles}</div>`;
    if(refresh){ const b = document.getElementById('mbody'); if(b) b.innerHTML = html; return; }
    openMod('Question grid', html);
  },
  goTo(i){
    closeMod();
    const el = document.getElementById('eqc-' + i);
    if(el) el.scrollIntoView({behavior:'smooth', block:'center'});
  },

  _lastSnapAt: 0,
  _SNAPSHOT_SIZE_CEILING: 2 * 1024 * 1024,
  _snapshotExam(force){
    if(!S.quiz || !S.quiz.active || S.quiz.mode!=='exam' || !S.user) return;
    const now = Date.now();
    if(!force && (now - QUIZ._lastSnapAt) < 3000) return;
    QUIZ._lastSnapAt = now;
    const header = {
      username: S.user.username,
      ch: S.quiz.ch,
      ans: S.quiz.ans,
      left: S.quiz.left,
      scope: S.quiz.scope || null,
      startedAt: S.quiz.startedAt || now,
      savedAt: now
    };
    const fullSnap = { ...header, qs: S.quiz.qs };
    let fullJson = null;
    try{ fullJson = JSON.stringify(fullSnap); }catch(e){}
    if(fullJson && fullJson.length < QUIZ._SNAPSHOT_SIZE_CEILING){
      _save(LS.EXAM_SNAP, fullSnap);
      return;
    }
    const liteQs = S.quiz.qs.map(q => { const { img, imgCaption, ...rest } = q; return rest; });
    _save(LS.EXAM_SNAP, { ...header, qs: liteQs });
  },
  _clearExamSnapshot(){ localStorage.removeItem(LS.EXAM_SNAP); },

  checkResumableExam(){
    const snap = _load(LS.EXAM_SNAP, null);
    if(!snap || !S.user || snap.username !== S.user.username || !snap.qs || !snap.qs.length){
      if(snap) QUIZ._clearExamSnapshot();
      return;
    }
    if(snap.scope && snap.scope.weeklyId){
      const done = (typeof WEEKLY !== 'undefined' && WEEKLY.attempts && WEEKLY.attempts[snap.scope.weeklyId]);
      if(done){ QUIZ._clearExamSnapshot(); return; }
    }
    const elapsedSinceSave = Math.floor((Date.now() - snap.savedAt) / 1000);
    const adjustedLeft = snap.left - elapsedSinceSave;

    if(adjustedLeft <= 0){
      QUIZ._resumeSnapshot(snap, 0);
      toast('⏰ Your exam timer ran out while you were away — showing your results.');
      QUIZ.submitExam();
      return;
    }

    const answered = snap.ans.filter(a=>a!==null).length;
    const modal = document.createElement('div');
    modal.id = 'exam-resume-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1.5rem;backdrop-filter:blur(4px)';
    modal.innerHTML = `
      <div style="background:var(--c2);border:1px solid var(--bd);border-radius:var(--r3);padding:1.5rem;max-width:340px;width:100%;box-shadow:var(--sh3)" role="dialog" aria-modal="true">
        <div style="font-size:1.2rem;margin-bottom:.35rem"><i class="ph ph-note-pencil"></i></div>
        <div style="font-family:var(--fd);font-size:.92rem;font-weight:700;color:var(--t1);margin-bottom:.2rem">Unfinished exam found</div>
        <div style="font-size:.78rem;color:var(--t3);margin-bottom:1rem">${esc(snap.ch)} — ${answered}/${snap.qs.length} answered, ${fmt(adjustedLeft)} left on the clock. This was probably interrupted by a reload or a closed tab.</div>
        <div style="display:flex;gap:.4rem">
          <button id="exam-resume-btn" style="flex:1;padding:.62rem;background:linear-gradient(135deg,var(--amb2),var(--amb));border:none;border-radius:var(--r2);color:var(--on-accent);font-weight:700;font-size:.85rem;cursor:pointer;font-family:var(--ff)">▶️ Resume</button>
          <button id="exam-discard-btn" style="padding:.62rem .9rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r2);color:var(--t2);font-size:.83rem;cursor:pointer;font-family:var(--ff)">Discard</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('exam-resume-btn').onclick = ()=>{
      modal.remove();
      QUIZ._resumeSnapshot(snap, adjustedLeft);
    };
    document.getElementById('exam-discard-btn').onclick = async ()=>{
      const ok = await ASK.confirm({
        title: 'Discard this exam?',
        body:  'You\u2019ll lose ' + answered + '/' + snap.qs.length + ' answered question' + (answered !== 1 ? 's' : '') + '. This cannot be undone.',
        ok:    'Discard',
        danger: true
      });
      if(!ok) return;
      modal.remove();
      QUIZ._clearExamSnapshot();
    };
  },
  _resumeSnapshot(snap, adjustedLeft){
    const originalTotal = (snap.qs.length * 90);
    const spentBeforeSnap = Math.max(0, originalTotal - (snap.left||0));
    const startedAt = snap.startedAt || (snap.savedAt - spentBeforeSnap*1000) || Date.now();
    S.quiz = {
      qs: snap.qs, ans: snap.ans, mode:'exam', idx:0, timer:null, elapsed:0,
      left: adjustedLeft,
      examEndAt: Date.now() + adjustedLeft*1000,
      examTotal: (snap && snap.qs ? snap.qs.length : 0) * 90, warned: [],
      active:true, ch: snap.ch, skipped:new Set(), shown:new Set(),
      scope: snap.scope || null, startedAt,
      reviewOnly: false
    };
    document.getElementById('quiz-wrap').style.display='';
    document.querySelectorAll('.view').forEach(e=>e.classList.remove('on'));
    document.getElementById('fc-wrap').style.display='none';
    document.getElementById('ex-wrap').style.display='';
    document.getElementById('res-wrap').style.display='none';
    QUIZ._renderExam();
    QUIZ._startTimer();
    toast('▶️ Exam resumed');
  },

  quit(){
    QUIZ._exitGuard(()=>{ UI._goRaw('home'); });
  },

  _exitGuard(afterQuit){
    if(document.getElementById('quiz-exit-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'quiz-exit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1.5rem;backdrop-filter:blur(4px)';
    const isExam = S.quiz.mode === 'exam';
    const isReview = !!S.quiz.reviewOnly;
    const answered = S.quiz.ans.filter(a=>a!==null).length;
    const total = S.quiz.qs.length;
    const isWeekly = !!(S.quiz.scope && S.quiz.scope.weeklyId);
    const heading = isReview
      ? 'Exit review?'
      : (isWeekly && isExam ? 'Leave this weekly exam?' : 'Leave this quiz?');
    const body = isReview
      ? `You're viewing your recorded results for ${esc(S.quiz.ch)}.`
      : isWeekly && isExam
        ? `You only get ONE attempt at this weekly set. Leaving now abandons your one shot — the exam window keeps running and you won't be able to start over. ${answered} of ${total} answered so far.`
        : (isExam ? answered+' of '+total+' answered' : 'Question '+(S.quiz.idx+1)+' of '+total);
    modal.innerHTML = `
      <div style="background:var(--c2);border:1px solid var(--bd);border-radius:var(--r3);padding:1.5rem;max-width:340px;width:100%;box-shadow:var(--sh3)" role="dialog" aria-modal="true">
        <div style="font-size:1.3rem;margin-bottom:.4rem"><i class="ph ph-warning"></i></div>
        <div style="font-family:var(--fd);font-size:.95rem;font-weight:700;color:var(--t1);margin-bottom:.3rem">${heading}</div>
        <div style="font-size:.76rem;color:var(--t3);margin-bottom:1.1rem">${body}</div>
        <div style="display:flex;flex-direction:column;gap:.45rem">
          ${isExam && !isReview ? '<button id="qem-finish" style="padding:.62rem;background:var(--ok-bg);border:1px solid var(--ok-bd);border-radius:var(--r2);color:var(--grn);font-weight:700;font-size:.83rem;cursor:pointer;font-family:var(--ff);text-align:left"><i class="ph ph-check-circle"></i> Submit & See Results — grade what I have answered so far</button>' : ''}
          <button id="qem-quit" style="padding:.62rem;background:var(--bad-bg);border:1px solid var(--bad-bd);border-radius:var(--r2);color:var(--ros);font-weight:700;font-size:.83rem;cursor:pointer;font-family:var(--ff);text-align:left"><i class="ph ph-door"></i> ${isReview ? 'Exit review' : 'Quit — discard this session'}</button>
          <button id="qem-cancel" style="padding:.62rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r2);color:var(--t2);font-weight:600;font-size:.83rem;cursor:pointer;font-family:var(--ff);text-align:left">↩ Cancel — keep studying</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = ()=> modal.remove();
    if(isExam && !isReview){
      document.getElementById('qem-finish').onclick = ()=>{ close(); QUIZ.submitExam(); };
    }
    document.getElementById('qem-quit').onclick = ()=>{
      close();
      QUIZ._stopTimer();
      if(isExam && !isReview) QUIZ._clearExamSnapshot();
      S.quiz.active = false;
      document.getElementById('quiz-wrap').style.display = 'none';
      if(afterQuit) afterQuit();
    };
    document.getElementById('qem-cancel').onclick = close;
    modal.addEventListener('click', e=>{ if(e.target===modal) close(); });
  },

  _renderFlashcard(){
    const q = S.quiz.qs[S.quiz.idx];
    if(!q)return;
    try{
      document.getElementById('fc-chip').textContent = '⚡ ' + S.quiz.ch;
      document.getElementById('fc-ctr').textContent = `${S.quiz.idx+1}/${S.quiz.qs.length}`;
      document.getElementById('fc-pf').style.width = `${((S.quiz.idx)/S.quiz.qs.length)*100}%`;
      document.getElementById('fc-qn').textContent = 'Q'+(S.quiz.idx+1);
      document.getElementById('fc-q').textContent = q.q;
      const fcImgWrap = document.getElementById('fc-img-wrap');
      const fcImg = document.getElementById('fc-img');
      if(q.img && fcImgWrap && fcImg){ fcImg.src = q.img; fcImg.alt = q.imgCaption || 'Question figure'; fcImgWrap.style.display = ''; }
      else if(fcImgWrap){ fcImgWrap.style.display = 'none'; }

            const isStarred = REV.has('bk', q.uid);
      const reviewControls = S.quiz.reviewOnly ? '' : `
        <button class="ib ${isStarred?'bk-on':''}" data-on-click="QUIZ._star()" title="Save this question" aria-label="Save this question" aria-pressed="${isStarred?'true':'false'}"><i class="ph ph-star"></i></button>
      `;
      document.getElementById('fc-acts').innerHTML = `
        ${reviewControls}
        <button class="ib" data-on-click="QUIZ._reportCurrent()" title="Report an issue with this question" aria-label="Report an issue with this question"><i class="ph ph-warning-circle"></i></button>
        ${qSearchHtml(q)}
        ${S.quiz.reviewOnly ? '' : `<select class="sel-c" style="font-size:.68rem;padding:.2rem .35rem;width:auto" data-on-change="QUIZ._tagCurrent(this.value)">
          <option value="">🏷 Tag…</option>
          ${BK_TAGS.map(t=>`<option value="${t}" ${REV.getTag(q.uid)===t?'selected':''}>${t}</option>`).join('')}
        </select>`}
      `;

      const ansIdx = S.quiz.ans[S.quiz.idx];
      const answered = ansIdx !== null;
      const optsEl = document.getElementById('fc-opts');
      optsEl.innerHTML = q.options.map((opt,i)=>{
        let cls='eo';
        let isSelected = false;
        if(answered){
          const isCorrect = isOk(i, q.correct);
          isSelected = i===ansIdx;
          if(isCorrect) cls += ' shc';
          else if(isSelected) cls += ' bad2';
        }
        const blocked = answered || S.quiz.reviewOnly;
        return `<div class="${cls}" role="button" tabindex="${blocked?-1:0}" aria-pressed="${isSelected}" aria-label="Option ${String.fromCharCode(65+i)}: ${esc(opt)}${isSelected?', selected':''}" data-on-click="${blocked?'':'QUIZ.fcAnswer('+i+')'}" data-on-keydown="!${blocked}&&ACT.enterOrSpace(event)&&QUIZ.fcAnswer(${i})" style="${blocked?'cursor:default;pointer-events:none':''}">
          <div class="ok">${String.fromCharCode(65+i)}</div><div>${esc(opt)}</div>
        </div>`;
      }).join('');

      const expl = document.getElementById('fc-expl');
      if(answered && q.explanation){ expl.textContent = q.explanation; expl.classList.add('show'); }
      else { expl.classList.remove('show'); expl.textContent=''; }

      document.getElementById('fc-hint').textContent = S.quiz.reviewOnly
        ? 'Review mode — answers locked'
        : (answered ? 'Use Next →' : 'Tap an option to answer');
      document.getElementById('fc-prev').disabled = S.quiz.idx===0;
      document.getElementById('fc-next').textContent = S.quiz.reviewOnly
        ? (S.quiz.idx===S.quiz.qs.length-1 ? 'Exit Review' : 'Next →')
        : (S.quiz.idx===S.quiz.qs.length-1 ? 'Finish ✔' : 'Next →');

      QUIZ._updateFcCounts();

      try {
        const existing = document.getElementById('fc-hard');
        if (existing) existing.remove();
        if (typeof HARDQ !== 'undefined' && q && q.uid) {
          const hard = HARDQ.forUid(q.uid);
          if (hard >= 40) {
            const badge = document.createElement('span');
            badge.id = 'fc-hard';
            badge.className = 'ctag tr';
            badge.style.cssText = 'margin-left:.4rem';
            badge.innerHTML = '<i class="ph ph-warning"></i> ' + hard + '% of students miss this';
            const qn = document.getElementById('fc-qn');
            if (qn && qn.parentElement) qn.parentElement.appendChild(badge);
          }
        }
      } catch(e){}

      renderMath(document.getElementById('fc-wrap'));

      try {
        if (typeof QNOTE !== 'undefined'){
          if (answered) QNOTE.render('fc-note', q.uid);
          else { const b = document.getElementById('fc-note'); if (b) b.innerHTML = ''; }
        }
      } catch(e){}

      try {
        if (typeof QHIST !== 'undefined') QHIST.render('fc-hist', q.uid);
      } catch(e){}

      try {
        const wrap = document.getElementById('fc-similar');
        if (wrap){
          const wrong = S.quiz.ans[S.quiz.idx] !== null &&
                        S.quiz.ans[S.quiz.idx] !== undefined &&
                        !isOk(S.quiz.ans[S.quiz.idx], q.correct);
          if (wrong && !S.quiz.reviewOnly && S.quiz.scope && S.quiz.scope.fid){
            wrap.innerHTML =
              '<button type="button" class="qnote-add" style="border-color:var(--accent-line);color:var(--accent)" ' +
              'data-on-click="WRONGBY.practiceSimilar(\'' + escAttrJs(q.uid) + '\')">' +
              '<i class="ph ph-target"></i> Practice 5 more like this' +
              '</button>';
          } else {
            wrap.innerHTML = '';
          }
        }
      } catch(e){}
    } catch(err){
      console.error('[QUIZ._renderFlashcard] question at idx', S.quiz.idx, 'failed to render:', err, q);
      toast('⚠️ Skipped a malformed question', 2000);
      if(S.quiz.idx < S.quiz.qs.length-1){ S.quiz.idx++; QUIZ._renderFlashcard(); }
      else QUIZ.fcFinish();
    }
  },
  _updateFcCounts(){
    let ok=0,bad=0,skip=0;
    S.quiz.ans.forEach((a,i)=>{
      if(a===null){ if(S.quiz.shown?.has(i)) skip++; return; }
      if(isOk(a, S.quiz.qs[i].correct)) ok++; else bad++;
    });
    document.getElementById('fc-ok').textContent=ok;
    document.getElementById('fc-bad').textContent=bad;
    document.getElementById('fc-skip').textContent=skip;
  },
  fcAnswer(i){
    if(S.quiz.reviewOnly) return;
    if(S.quiz.ans[S.quiz.idx]!==null)return;
    S.quiz.ans[S.quiz.idx]=i;
    const q=S.quiz.qs[S.quiz.idx];
    const correct=isOk(i,q.correct);
    if(correct){ PROG.track(true); REV.trackAnswer(q, true); }
    else { PROG.track(false); REV.trackAnswer(q, false); }
    QUIZ._renderFlashcard();
  },
  fcNav(dir){
    if(!S.quiz.reviewOnly){
      if(!S.quiz.shown) S.quiz.shown=new Set();
      S.quiz.shown.add(S.quiz.idx);
    }
    const next = S.quiz.idx+dir;
    if(next<0)return;
    if(next>=S.quiz.qs.length){ QUIZ.fcFinish(); return; }
    S.quiz.idx=next;
    QUIZ._renderFlashcard();
  },
  _star(){
    if(S.quiz.reviewOnly) return;
    const q=S.quiz.qs[S.quiz.idx];
    const added = REV.toggle('bk', q);
    QUIZ._renderFlashcard();
    if(added && typeof toastUndo === 'function'){
      toastUndo('⭐ Saved', function(){ REV.toggle('bk', q); QUIZ._renderFlashcard(); });
    }
  },

  _tagCurrent(tag){
    if(S.quiz.reviewOnly) return;
    const q=S.quiz.qs[S.quiz.idx];
    if(!q) return;
    REV.setTag(q.uid, tag, q);
    QUIZ._renderFlashcard();
  },
  fcFinish(){
    QUIZ._stopTimer();
    S.quiz.active=false;
    if(S.quiz.reviewOnly){
      document.getElementById('quiz-wrap').style.display = 'none';
      UI._goRaw('home');
      return;
    }
    STREAK.markToday();
    QUIZ._showResults();
  },
  _renderExam(){
    document.getElementById('ex-chip').textContent = '📝 ' + S.quiz.ch;
    document.getElementById('ex-tmr').textContent = fmt(S.quiz.left);
    const el = document.getElementById('ex-qs');
    el.innerHTML = S.quiz.qs.map((q,qi)=>{
      const savedAns = S.quiz.ans[qi];
      return `
      <div class="eqc${savedAns!==null?' answered':''}" id="eqc-${qi}">
        <div class="qm"><span class="qn mono">Q${qi+1}</span><span style="display:inline-flex;gap:.3rem;align-items:center"><button type="button" class="ib mark-btn${S.quiz.marked && S.quiz.marked.has(qi) ? ' fl-on' : ''}" data-on-click="QUIZ.toggleMark(${qi})" title="Mark for review" aria-label="Mark question ${qi+1} for review"><i class="ph ph-flag"></i></button>${qReportHtml(q, `QUIZ._reportExam(${qi})`, `Report an issue with question ${qi+1}`)}${qSearchHtml(q)}</span></div>
        <div class="qt" style="font-size:.85rem">${esc(q.q)}</div>
        ${qImgHtml(q)}
        ${q.options.map((opt,oi)=>{
          const sel = savedAns===oi;
          return `<div class="eo${sel?' sel':''}" role="button" tabindex="0" aria-pressed="${sel}" aria-label="Option ${String.fromCharCode(65+oi)}: ${esc(opt)}" data-on-click="QUIZ.exAnswer(${qi},${oi})" data-on-keydown="ACT.enterOrSpace(event)&&QUIZ.exAnswer(${qi},${oi})" id="eo-${qi}-${oi}">
            <div class="ok">${String.fromCharCode(65+oi)}</div><div>${esc(opt)}</div>
          </div>`;
        }).join('')}
        <button type="button" class="ex-clear" id="ex-clear-${qi}" data-on-click="QUIZ.clearAnswer(${qi})" aria-label="Clear response for question ${qi+1}"${savedAns===null||savedAns===undefined?' hidden':''}><i class="ph ph-eraser"></i> Clear response</button>
      </div>
    `}).join('');
    renderMath(el);
    const answeredCount = S.quiz.ans.filter(a=>a!==null).length;
    document.getElementById('ex-ctr').textContent = `${answeredCount}/${S.quiz.qs.length}`;
    document.getElementById('ex-ans').textContent = answeredCount;
    document.getElementById('ex-pf').style.width = `${(answeredCount/S.quiz.qs.length)*100}%`;
    QUIZ._updateSkippedNav();
  },
  exAnswer(qi, oi){
    if(!S.quiz.active)return;
    /* tapping the option that is already selected unselects it (back to unanswered) */
    const next = (S.quiz.ans[qi] === oi) ? null : oi;
    S.quiz.ans[qi] = next;
    const card = document.getElementById(`eqc-${qi}`);
    if(!card) return;
    /* query inside the one card instead of searching the whole document on every tap */
    card.querySelectorAll('.eo').forEach((e,i)=>{
      const sel = next !== null && i===next;
      e.classList.toggle('sel', sel);
      e.setAttribute('aria-pressed', String(sel));
    });
    card.classList.toggle('answered', next !== null);
    const clr = document.getElementById(`ex-clear-${qi}`);
    if(clr) clr.hidden = (next === null);
    QUIZ._refreshExamCounts();
    QUIZ._snapshotExam();
    QUIZ._updateSkippedNav();
    if(document.getElementById('pal-grid')) QUIZ.showPalette(true);
  },
  /* clear the response for one question without having to pick another option */
  clearAnswer(qi){
    if(!S.quiz || !S.quiz.active || S.quiz.mode !== 'exam') return;
    if(S.quiz.ans[qi] === null || S.quiz.ans[qi] === undefined) return;
    const cur = S.quiz.ans[qi];
    /* exAnswer on the selected option toggles it off; going through it keeps the wrappers in sync */
    QUIZ.exAnswer(qi, cur);
  },
  _refreshExamCounts(){
    const answered = S.quiz.ans.filter(a=>a!==null && a!==undefined).length;
    const ctr = document.getElementById('ex-ctr'); if(ctr) ctr.textContent = `${answered}/${S.quiz.qs.length}`;
    const an = document.getElementById('ex-ans'); if(an) an.textContent = answered;
    const pf = document.getElementById('ex-pf'); if(pf) pf.style.width = `${(answered/S.quiz.qs.length)*100}%`;
  },
  _updateSkippedNav(){
    const btn = document.getElementById('ex-skip-nav');
    if(!btn) return;
    const skippedCount = S.quiz.ans.filter(a=>a===null).length;
    btn.style.display = skippedCount ? '' : 'none';
    const countEl = document.getElementById('ex-skip-count');
    if(countEl) countEl.textContent = skippedCount;
  },
  jumpToUnanswered(){
    if(!S.quiz || !S.quiz.qs) return;
    const total = S.quiz.qs.length;
    const cards = S.quiz.qs.map((_,i)=>document.getElementById('eqc-'+i)).filter(Boolean);
    const viewTop = window.scrollY + 80;
    let startFrom = 0;
    for(let i=0;i<cards.length;i++){ if(cards[i].offsetTop > viewTop){ startFrom = i; break; } }
    for(let step=0; step<total; step++){
      const idx = (startFrom + step) % total;
      if(S.quiz.ans[idx]===null){
        document.getElementById('eqc-'+idx)?.scrollIntoView({behavior:'smooth', block:'center'});
        return;
      }
    }
    toast('🎉 Nothing left unanswered');
  },
  async submitExam(){
    if (!S.quiz.active) return;
    if (S.quiz._submitting) return;
    S.quiz._submitting = true;
    try {
      const unanswered = S.quiz.ans.filter(a => a === null).length;
      const isWeekly = !!(S.quiz.scope && S.quiz.scope.weeklyId);

      if (isWeekly) {
        const ok = await ASK.confirm({
          title: 'Submit your weekly set?',
          body: 'You only get ONE attempt at this weekly set. After you submit you can only review your answers. ' +
                (unanswered > 0 ? unanswered + ' question' + (unanswered === 1 ? '' : 's') + ' still unanswered.' : 'Every question is answered.'),
          ok: 'Submit paper',
          danger: true
        });
        if (!ok) return;
      } else if (unanswered > 0 && S.quiz.left > 0) {
        const ok = await ASK.confirm({
          title: 'Submit with blanks?',
          body: unanswered + ' question' + (unanswered === 1 ? '' : 's') + ' left unanswered. Submit anyway?',
          ok: 'Submit'
        });
        if (!ok) return;
      }

      QUIZ._stopTimer();
      QUIZ._clearExamSnapshot();
      S.quiz.active = false;
      STREAK.markToday();
      S.quiz.qs.forEach((q, qi) => {
        document.querySelectorAll(`#eqc-${qi} .eo`).forEach((e, oi2) => {
          e.style.pointerEvents = 'none';
          const correct = isOk(oi2, q.correct);
          if (correct) e.classList.add('shc');
          else if (oi2 === S.quiz.ans[qi]) e.classList.add('bad2');
        });
        if (S.quiz.ans[qi] === null) return;
        const correctPick = isOk(S.quiz.ans[qi], q.correct);
        PROG.track(correctPick);
        REV.trackAnswer(q, correctPick);
      });
      QUIZ._showResults();
    } finally {
      S.quiz._submitting = false;
    }
  },

  retryWrong(){
    if(S.quiz.scope && S.quiz.scope.weeklyId){ toast('🔒 Weekly sets are one attempt only'); return; }
    const wrongIdx = S.quiz.qs.map((q,i)=>({q,i})).filter(({i})=>!isOk(S.quiz.ans[i], S.quiz.qs[i].correct));
    if(!wrongIdx.length){ toast('🎉 Nothing to retry — all correct!'); UI.go('home'); return; }
    QUIZ.startWith(wrongIdx.map(x=>x.q), 'flashcard', S.quiz.ch + ' (Retry)');
  },

  /* ── RESULTS ── */
  _showResults(){
    document.getElementById('fc-wrap').style.display='none';
    document.getElementById('ex-wrap').style.display='none';
    document.getElementById('res-wrap').style.display='';
    const total = S.quiz.qs.length;
    let correct=0;
    S.quiz.qs.forEach((q,i)=>{ if(isOk(S.quiz.ans[i], q.correct)) correct++; });
    const wrong = S.quiz.ans.filter((a,i)=> a!==null && !isOk(a,S.quiz.qs[i].correct)).length;
    const skipped = S.quiz.ans.filter(a=>a===null).length;

    /* Weekly tests, the daily Loksewa paper and the hourly 50 are marked the Loksewa way (+1 right,
       -0.2 wrong, 0 skipped), and that is the number the headline shows, so it matches
       the score line below it and what the server ranks. Every other quiz type
       (chapter practice, mixed, review) keeps the plain percentage and shows no Loksewa wording. `isWeekly` is
       reused further down when recording the attempt (declaring it twice with
       `const` is a syntax error that stops this whole file from loading). */
    const rawPct = total ? Math.round((correct/total)*100) : 0;
    const isWeekly = !!(S.quiz.scope && S.quiz.scope.weeklyId);
    const isLoksewa = isLoksewaFormat(S.quiz.scope);     /* weekly test, daily 75-mark paper, hourly 50: nothing else */
    const marked = (isLoksewa && total)
      ? Math.round(((correct - wrong * 0.2) / total) * 1000) / 10
      : null;
    const pct = (marked !== null) ? Math.max(0, marked) : rawPct;   /* 0 floor keeps the ring sane; the score line shows the exact marks */

    document.getElementById('res-ring').style.setProperty('--p', pct+'%');
    document.getElementById('res-pct').textContent = pct+'%';
    document.getElementById('res-chap').textContent = S.quiz.ch;
    const grade = pct>=90?'🏆 Outstanding!':pct>=75?'🎯 Great job!':pct>=50?'👍 Keep practicing':'📚 Needs more review';
    document.getElementById('res-grade').textContent = grade;
    let negEl = document.getElementById('res-neg');
    if(!negEl){
      negEl = document.createElement('div');
      negEl.id = 'res-neg';
      negEl.className = 't-foot';
      negEl.style.marginTop = '.3rem';
      document.getElementById('res-grade').after(negEl);
    }
    if (isLoksewa){
      const score = correct - wrong * LOKSEWA_NEGATIVE;
      const pctLok = total ? Math.round((score / total) * 1000) / 10 : 0;
      const verdict = score >= total * 0.4
        ? '<span style="color:var(--success);font-weight:700">above the usual 40% cut-off</span>'
        : '<span style="color:var(--danger);font-weight:700">below the usual 40% cut-off</span>';
      negEl.innerHTML =
        'Loksewa score: <b>' + score.toFixed(1) + ' / ' + total + '</b> (' + pctLok + '%) \u2014 ' + verdict +
        '<br><span class="t-cap">+1 correct \u00b7 \u22120.2 wrong \u00b7 0 skipped</span>';
      negEl.style.fontSize = 'var(--fs-foot)';
      negEl.style.lineHeight = '1.55';
      negEl.style.textAlign = 'center';
    } else {
      negEl.textContent = '';          /* chapter practice, mixed and review show the plain percentage only */
    }

    document.getElementById('res-stats').innerHTML = `
      <div class="sc"><div class="sv tcy">${total}</div><div class="stat-lbl">Total</div></div>
      <div class="sc"><div class="sv tc2">${correct}</div><div class="stat-lbl">Correct</div></div>
      <div class="sc"><div class="sv tb2">${wrong}</div><div class="stat-lbl">Wrong</div></div>
      <div class="sc"><div class="sv ta2">${skipped}</div><div class="stat-lbl">Skipped</div></div>
    `;

    try {
      const oldBlock = document.querySelector('#view-results .chapter-breakdown, .chapter-breakdown');
      if (oldBlock) oldBlock.remove();      /* never leave the previous paper's tables behind */
      if (isLoksewa) {
        const groups = {};
        (S.quiz.qs || []).forEach((q, i) => {
          let label = 'Other';
          try {
            if (typeof fidFromUid === 'function' && typeof ChapterData !== 'undefined') {
              const fid = fidFromUid(String(q.uid || ''));
              const ref = ChapterData.allFileRefs().find(r => r.fid === fid);
              if (ref) label = ChapterData.chapterName(ref.lv, ref.ch) || 'Other';
            }
          } catch(e){}
          const g = groups[label] || (groups[label] = { label, correct: 0, wrong: 0, skipped: 0, total: 0 });
          const a = S.quiz.ans[i];
          g.total++;
          if (a === null || a === undefined) g.skipped++;
          else if (isOk(a, q.correct)) g.correct++;
          else g.wrong++;
        });

        const rows = Object.values(groups).map(g => {
          const score = g.correct - g.wrong * 0.2;
          const pct = g.total ? Math.round((score / g.total) * 100) : 0;
          return Object.assign({}, g, { score, pct });
        }).sort((a, b) => a.pct - b.pct);

        const rowsHtml = rows.map(r => {
          const cls = r.pct >= 60 ? 'color:var(--success)'
                    : r.pct >= 40 ? 'color:var(--accent)'
                    : 'color:var(--danger)';
          return '<tr>' +
            '<td>' + esc(r.label) + '</td>' +
            '<td class="num" style="text-align:center">' + r.total + '</td>' +
            '<td class="num" style="text-align:center;color:var(--success)">' + r.correct + '</td>' +
            '<td class="num" style="text-align:center;color:var(--danger)">' + r.wrong + '</td>' +
            '<td class="num" style="text-align:center">' + r.skipped + '</td>' +
            '<td class="num" style="text-align:right;font-weight:700;' + cls + '">' +
              r.score.toFixed(1) + ' <span class="t-cap">(' + r.pct + '%)</span>' +
            '</td>' +
          '</tr>';
        }).join('');

        const weak = rows.filter(r => r.pct < 40 && r.total >= 2);

        /* Groups come from the scheme the admin set (see shared.js). The daily paper is scored out of each group's
           marks; weekly and hourly sets are not built from the scheme, so they are scored out of their own questions. */
        const scheme = (window.LKS && LKS.scheme()) || defaultLoksewaScheme();
        const items = (S.quiz.qs || []).map((q, i) => {
          let lv = null, ch = null;
          try {
            const fid = (typeof fidFromUid === 'function') ? fidFromUid(String(q.uid || '')) : '';
            const ref = ChapterData.allFileRefs().find(r => r.fid === fid);
            if (ref) { lv = ref.lv; ch = ref.ch; }
          } catch(e){}
          const a = S.quiz.ans[i];
          return { lv, ch, state: (a === null || a === undefined) ? 'skipped' : (isOk(a, q.correct) ? 'correct' : 'wrong') };
        });
        const gRows = loksewaGroupRows(scheme, items, !!(S.quiz.scope && S.quiz.scope.loksewaMock));
        const showGroups = gRows.some(r => r.key !== 'other');       /* a table with only "Other" says nothing */
        const groupRows = gRows.map(g => {
          const cls = g.pct >= 60 ? 'color:var(--success)' : g.pct >= 40 ? 'color:var(--accent)' : 'color:var(--danger)';
          return '<tr>' +
            '<td>' + esc(g.name) + '</td>' +
            '<td class="num" style="text-align:center">' + g.total + '</td>' +
            '<td class="num" style="text-align:center;color:var(--success)">' + g.correct + '</td>' +
            '<td class="num" style="text-align:center;color:var(--danger)">' + g.wrong + '</td>' +
            '<td class="num" style="text-align:center">' + g.skipped + '</td>' +
            '<td class="num" style="text-align:right;font-weight:700;' + cls + '">' +
              g.score.toFixed(1) + ' <span class="t-cap">/ ' + g.outOf + '</span>' +
            '</td>' +
          '</tr>';
        }).join('');

        const block = document.createElement('div');
        block.className = 'chapter-breakdown';
        block.innerHTML = (!showGroups ? '' :
          '<h3 class="t-t3" style="margin:var(--sp-4) 0 var(--sp-2)">' +
            '<i class="ph ph-medal"></i> Marks by group' +
          '</h3>' +
          '<div class="table-wrap" style="margin-bottom:var(--sp-3)">' +
            '<table>' +
              '<thead><tr>' +
                '<th>Group</th>' +
                '<th style="text-align:center">Q</th>' +
                '<th style="text-align:center">Right</th>' +
                '<th style="text-align:center">Wrong</th>' +
                '<th style="text-align:center">Skipped</th>' +
                '<th style="text-align:right">Score</th>' +
              '</tr></thead>' +
              '<tbody>' + groupRows + '</tbody>' +
            '</table>' +
          '</div>') +
          '<h3 class="t-t3" style="margin:var(--sp-4) 0 var(--sp-2)">' +
            '<i class="ph ph-chart-bar"></i> Marks by chapter' +
          '</h3>' +
          '<div class="table-wrap" style="margin-bottom:var(--sp-3)">' +
            '<table>' +
              '<thead><tr>' +
                '<th>Chapter</th>' +
                '<th style="text-align:center">Q</th>' +
                '<th style="text-align:center">Right</th>' +
                '<th style="text-align:center">Wrong</th>' +
                '<th style="text-align:center">Skipped</th>' +
                '<th style="text-align:right">Score</th>' +
              '</tr></thead>' +
              '<tbody>' + rowsHtml + '</tbody>' +
            '</table>' +
          '</div>' +
          (weak.length
            ? '<div class="banner banner-danger" style="align-items:flex-start">' +
                '<i class="ph ph-warning-circle"></i>' +
                '<div><div style="font-weight:700">Needs work</div>' +
                '<div style="margin-top:.2rem;line-height:1.55">' +
                  weak.map(r => esc(r.label) + ' <b>(' + r.pct + '%)</b>').join(' \u00b7 ') +
                '</div>' +
                '<div class="t-cap" style="margin-top:.35rem">Under 40% \u2014 revise these before the next paper.</div>' +
                '</div></div>'
            : '<div class="banner banner-accent" style="align-items:flex-start">' +
                '<i class="ph ph-check-circle"></i>' +
                '<span>No chapter under 40%. Solid, consistent paper.</span></div>');

        const stats = document.getElementById('res-stats');
        if (stats && stats.parentNode) stats.parentNode.insertBefore(block, stats.nextSibling);
      }
    } catch(e){ console.warn('[chapter breakdown] failed:', e); }

    try {
      const changed = S.quiz.changed || {};
      const idxs = Object.keys(changed);
      const existing = document.getElementById('res-changed');
      if (existing) existing.remove();
      if (idxs.length) {
        let toWrong = 0, toRight = 0;
        idxs.forEach(i => {
          const c = changed[i];
          if (c.wasRight && !c.nowRight) toWrong++;
          else if (!c.wasRight && c.nowRight) toRight++;
        });
        const p = document.createElement('p');
        p.id = 'res-changed';
        p.className = 't-foot';
        p.style.cssText = 'text-align:center;margin-top:.4rem';
        p.innerHTML =
          '<i class="ph ph-arrows-clockwise"></i> ' +
          idxs.length + ' answer' + (idxs.length === 1 ? '' : 's') + ' changed' +
          (toWrong ? ' \u00b7 <b style="color:var(--danger)">' + toWrong + ' right \u2192 wrong</b>' : '') +
          (toRight ? ' \u00b7 <b style="color:var(--success)">' + toRight + ' wrong \u2192 right</b>' : '');
        const stats = document.getElementById('res-stats');
        if (stats) stats.parentNode.insertBefore(p, stats.nextSibling);
      }
    } catch (e) {}

    document.getElementById('res-review').innerHTML = S.quiz.qs.map((q,i)=>{
      const a = S.quiz.ans[i];
      const correctPick = isOk(a,q.correct);
      return `<div class="qcard" style="border-left-color:${correctPick?'var(--ok)':'var(--bad)'}">
        <div class="qm"><span class="qn mono">Q${i+1}</span><span class="ctag ${correctPick?'tg':'tr'}">${correctPick?'Correct':a===null?'Skipped':'Wrong'}</span>${qReportHtml(q, `QUIZ._reportResult(${i})`, `Report an issue with question ${i+1}`)}${qSearchHtml(q)}</div>
        <div class="qt" style="font-size:.82rem">${esc(q.q)}</div>
        ${qImgHtml(q)}
        ${q.options.map((opt,oi)=>{
          let cls='eo';
          if(isOk(oi,q.correct)) cls+=' shc';
          else if(oi===a) cls+=' bad2';
          return `<div class="${cls}" style="cursor:default;pointer-events:none"><div class="ok">${String.fromCharCode(65+oi)}</div><div>${esc(opt)}</div></div>`;
        }).join('')}
        ${q.explanation?`<div class="expl show">${esc(q.explanation)}</div>`:''}
        ${(typeof QNOTE !== 'undefined' && QNOTE.get(q.uid)) ? `<div class="qnote-box" style="margin-top:.5rem"><div class="qnote-hd"><i class="ph ph-note"></i> Your note</div><div class="qnote-text">${esc(QNOTE.get(q.uid))}</div></div>` : ''}
      </div>`;
    }).join('');
    renderMath(document.getElementById('res-review'));

    if(pct>=70 && window.confetti){ confetti({particleCount:90,spread:75,origin:{y:0.6}}); }
    const qres = S.quiz.qs
      .map((q,i)=> S.quiz.ans[i]===null ? null : {uid:q.uid, ok:isOk(S.quiz.ans[i], q.correct)})
      .filter(Boolean);
    const scope = S.quiz.scope || {};
    const durationSec = S.quiz.startedAt
      ? Math.min(3*60*60, Math.round((Date.now()-S.quiz.startedAt)/1000))
      : 0;
    const sessionObj = {
      chapter:S.quiz.ch,
      chapterKey: scope.ch ? (ChapterData.chapterName(scope.lv, scope.ch) || '') : '',
      mode:S.quiz.mode,
      total, correct, wrong, skipped, pct, at:Date.now(),
      durationSec,
      lv:scope.lv||'', ch:scope.ch||'', book:scope.book||'', sub:scope.sub||'', fid:scope.fid||'',
      weeklyId: scope.weeklyId || '',
      weeklyTitle: scope.weeklyTitle || '',
      qres
    };
    if(typeof COV !== 'undefined') COV.record(qres);
    PROG.recordSession(sessionObj);
    CHAPSTATS.record(sessionObj);

    /* Weekly set: capture the score. Only the FIRST attempt is synced to
       the server; retakes stay on this device for the "last time you got
       X" prompt. The retry button always offers "Practice again".
       `isWeekly` is already declared above (Loksewa scoring
       section) — reused here. Declaring it a second time with `const`
       is a syntax error that stops the entire file from loading. */
    const isRetake = !!(scope.weeklyRetake);
    if(isWeekly){
      WEEKLY._recordAttempt(S.quiz, { total, correct, wrong, skipped, pct });

      const retryBtn = document.querySelector('#res-wrap .btn-p');
      if(retryBtn){
        retryBtn.disabled = false;
        retryBtn.style.opacity = '';
        retryBtn.style.pointerEvents = '';
        retryBtn.innerHTML = isRetake
          ? '<i class="ph ph-repeat"></i> Retake again'
          : '<i class="ph ph-repeat"></i> Practice again (score won\'t change)';
        retryBtn.onclick = function(){
          UI.go('home');
          setTimeout(function(){ WEEKLY._startRetake(scope.weeklyId); }, 150);
        };
      }

      if(isRetake){
        const grade = document.getElementById('res-grade');
        if(grade && !grade.parentNode.querySelector('.retake-notice')){
          const note = document.createElement('div');
          note.className = 'retake-notice t-foot';
          note.style.cssText = 'text-align:center;margin-top:.5rem;color:var(--warning)';
          note.innerHTML = '<i class="ph ph-info"></i> This was a practice retake. Your <b>official score</b> for this set has not changed.';
          grade.parentNode.insertBefore(note, grade.nextSibling);
        }
      }
    }
  }
};

/* ═══════════════ KEYBOARD — quiz controls ═══════════════ */
document.addEventListener('keydown', e=>{
  if(!S.quiz.active) return;
  if(document.getElementById('quiz-wrap').style.display==='none') return;
  if(_anyModalOpen()) return;
  const tag = (e.target && e.target.tagName) || '';
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if(e.key==='Escape'){ if(S.quiz.active) QUIZ.quit(); return; }
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(S.quiz.reviewOnly) return;
  if(S.quiz.mode==='exam'){
    /* timed exam: 1-5 pick (again to unselect), C clear, M mark, N next, P previous */
    const cur = QUIZ._exCurrent(), n = S.quiz.qs.length, k = e.key.toLowerCase();
    if(['1','2','3','4','5'].includes(k)){ const i = Number(k)-1; if(S.quiz.qs[cur]?.options[i]!==undefined){ e.preventDefault(); QUIZ.exAnswer(cur, i); } }
    else if(k==='c'){ QUIZ.clearAnswer(cur); }
    else if(k==='m'){ QUIZ.toggleMark(cur); }
    else if(k==='n'){ if(cur < n-1) QUIZ._exGo(cur+1); }
    else if(k==='p'){ if(cur > 0) QUIZ._exGo(cur-1); }
    return;
  }
  if(S.quiz.mode!=='exam'){
    if(e.key==='ArrowRight') QUIZ.fcNav(1);
    if(e.key==='ArrowLeft') QUIZ.fcNav(-1);
    if(['1','2','3','4','5'].includes(e.key)){
      const i=Number(e.key)-1;
      if(S.quiz.qs[S.quiz.idx]?.options[i]!==undefined) QUIZ.fcAnswer(i);
    }
    const letterIdx = 'abcdeABCDE'.indexOf(e.key);
    if(letterIdx > -1){
      const i = letterIdx % 5;
      if(S.quiz.qs[S.quiz.idx]?.options[i]!==undefined) QUIZ.fcAnswer(i);
    }
  }
});

/* ═══════════════ GLOBAL EXPOSURE ═══════════════ */
window.QUIZ = QUIZ;
window.ON = ON;
window.LOC = LOC;
window.PSY = PSY;
window.REV = REV;
window.CNT = CNT;
window.ONPROG = ONPROG;
window.fidFromUid = fidFromUid;
window.scopeLeaves = scopeLeaves;
window.scopedStats = scopedStats;
window.fileStatsMap = fileStatsMap;
window.migrateSessionScopes = migrateSessionScopes;
