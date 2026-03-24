/**
 * qrsync.js — QR Air-Gap Sync Engine  (Phase 3)
 *
 * Handles:
 *  - LZ-string compression/decompression
 *  - Chunked animated QR generation (qrcode.js)
 *  - Camera & keyboard-wedge scanning (html5-qrcode + text fallback)
 *  - IndexedDB storage for Mobile Floor Mode
 *  - Action log (delta) tracking on mobile
 *  - Timestamp-based conflict detection with warning modal
 *
 * Wire format per chunk:  MRQR|{sessionId}|{n}/{total}|{base64slice}
 */

'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const QR_MAX_CHUNK  = 1200;   // max chars per QR chunk (safe for mobile cams)
const QR_CYCLE_MS   = 1800;   // ms per frame in animated display
const DB_NAME       = 'MaintenanceRoutinesDB';
const DB_VERSION    = 1;
const IDB_EQUIP     = 'equipment';
const IDB_HISTORY   = 'history';
const IDB_ACTIONLOG = 'action_log';
const IDB_META      = 'metadata';

// ============================================================
// APP MODE  (set from app.js after mode selection)
// ============================================================
// window.APP_MODE = 'pc' | 'mobile'

// ============================================================
// COMPRESSION  (lz-string)
// ============================================================
function qrCompress(obj) {
  const json   = JSON.stringify(obj);
  const comp   = LZString.compressToBase64(json);
  return comp;
}

function qrDecompress(b64) {
  const json = LZString.decompressFromBase64(b64);
  if (!json) throw new Error('Decompression failed — data may be corrupt or incomplete.');
  return JSON.parse(json);
}

// ============================================================
// CHUNKING
// ============================================================
function makeSessionId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function chunkString(str, maxLen) {
  const chunks = [];
  for (let i = 0; i < str.length; i += maxLen)
    chunks.push(str.slice(i, i + maxLen));
  return chunks;
}

function buildChunkFrames(sessionId, dataStr) {
  const slices = chunkString(dataStr, QR_MAX_CHUNK);
  return slices.map((slice, i) =>
    `MRQR|${sessionId}|${i + 1}/${slices.length}|${slice}`
  );
}

function parseChunkFrame(raw) {
  // MRQR|{sessionId}|{n}/{total}|{data}
  const match = raw.match(/^MRQR\|([A-Z0-9]+)\|(\d+)\/(\d+)\|(.+)$/s);
  if (!match) return null;
  return {
    sessionId: match[1],
    index:     parseInt(match[2], 10) - 1,
    total:     parseInt(match[3], 10),
    data:      match[4],
  };
}

function reconstructChunks(frames) {
  // frames: array of chunk objects, possibly out of order
  const arr = new Array(frames[0].total);
  for (const f of frames) arr[f.index] = f.data;
  if (arr.some(v => v === undefined)) throw new Error('Missing chunks — scan all QR frames before continuing.');
  return arr.join('');
}

// ============================================================
// ANIMATED QR DISPLAY
// ============================================================
let _qrAnimTimer = null;

function stopAnimatedQR() {
  if (_qrAnimTimer) { clearInterval(_qrAnimTimer); _qrAnimTimer = null; }
}

async function startAnimatedQR(canvasId, progressId, frames) {
  stopAnimatedQR();
  const canvas   = document.getElementById(canvasId);
  const progress = document.getElementById(progressId);
  let idx = 0;

  async function drawFrame() {
    const frame = frames[idx % frames.length];
    await QRCode.toCanvas(canvas, frame, {
      width: 260,
      margin: 1,
      color: {
        dark:  document.body.classList.contains('light-theme') ? '#1a1d2e' : '#e8eaf2',
        light: document.body.classList.contains('light-theme') ? '#ffffff' : '#0f1117',
      },
      errorCorrectionLevel: 'M',
    });
    if (progress) {
      progress.textContent = frames.length > 1
        ? `Frame ${(idx % frames.length) + 1} of ${frames.length} — hold phone steady`
        : 'Single frame — scan this code';
    }
    idx++;
  }

  await drawFrame();
  if (frames.length > 1) _qrAnimTimer = setInterval(drawFrame, QR_CYCLE_MS);
}

// ============================================================
// SCANNER  (camera + keyboard-wedge / paste fallback)
// ============================================================
let _html5Scanner = null;
let _currentSession = {};   // { [sessionId]: Set<chunkObj> }
let _onAllChunksReceived = null;
let _wedgeBuffer = '';
let _wedgeTimer  = null;

function stopScanner() {
  if (_html5Scanner) {
    _html5Scanner.stop().catch(() => {});
    _html5Scanner = null;
  }
  document.removeEventListener('keydown', _wedgeHandler);
}

function _processRawScan(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return;

  const chunk = parseChunkFrame(trimmed);
  if (!chunk) {
    // Maybe it's a single-frame non-prefixed QR (older data) — try to parse directly
    try {
      const obj = qrDecompress(trimmed);
      if (_onAllChunksReceived) _onAllChunksReceived(obj);
    } catch {
      showQRToast('Unrecognised QR code format.', 'error');
    }
    return;
  }

  if (!_currentSession[chunk.sessionId]) _currentSession[chunk.sessionId] = [];
  const frames = _currentSession[chunk.sessionId];

  // Deduplicate by index
  if (!frames.find(f => f.index === chunk.index)) frames.push(chunk);

  const pips = document.getElementById('scanProgress');
  if (pips) {
    pips.textContent = `Scanned ${frames.length} / ${chunk.total} frame(s)`;
  }

  if (frames.length >= chunk.total) {
    try {
      const full = reconstructChunks(frames);
      const obj  = qrDecompress(full);
      delete _currentSession[chunk.sessionId];
      if (_onAllChunksReceived) _onAllChunksReceived(obj);
    } catch(err) {
      showQRToast('Reconstruction error: ' + err.message, 'error');
    }
  }
}

function _wedgeHandler(e) {
  // Keyboard wedge types characters rapidly; '\n' or '\r' signals end of scan
  if (e.key === 'Enter') {
    clearTimeout(_wedgeTimer);
    const raw = _wedgeBuffer;
    _wedgeBuffer = '';
    if (raw.startsWith('MRQR') || raw.length > 20) _processRawScan(raw);
    return;
  }
  if (e.key.length === 1) { // printable
    _wedgeBuffer += e.key;
    clearTimeout(_wedgeTimer);
    _wedgeTimer = setTimeout(() => { _wedgeBuffer = ''; }, 300);
  }
}

async function startCameraScanner(divId, onComplete) {
  _onAllChunksReceived = onComplete;
  _currentSession = {};

  if (typeof Html5Qrcode === 'undefined') {
    showQRToast('html5-qrcode library not loaded.', 'error');
    return;
  }

  try {
    _html5Scanner = new Html5Qrcode(divId, { verbose: false });
    await _html5Scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decoded) => _processRawScan(decoded),
      () => {} // silent frame errors
    );
  } catch(err) {
    showQRToast('Camera error: ' + err.message + '. Use text paste fallback instead.', 'warning', 6000);
    _html5Scanner = null;
  }
}

function startWedgeListener(onComplete) {
  _onAllChunksReceived = onComplete;
  _currentSession = {};
  _wedgeBuffer = '';
  document.addEventListener('keydown', _wedgeHandler);
}

function handlePasteInput(text, onComplete) {
  _onAllChunksReceived = onComplete;
  _currentSession = {};
  _processRawScan(text);
}

// ============================================================
// INDEXEDDB  (Mobile Floor Mode storage)
// ============================================================
let _db = null;

function openIDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_EQUIP))
        db.createObjectStore(IDB_EQUIP, { keyPath: 'ID' });
      if (!db.objectStoreNames.contains(IDB_HISTORY))
        db.createObjectStore(IDB_HISTORY, { keyPath: 'ID' });
      if (!db.objectStoreNames.contains(IDB_ACTIONLOG))
        db.createObjectStore(IDB_ACTIONLOG, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(IDB_META))
        db.createObjectStore(IDB_META, { keyPath: 'key' });
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function idbPut(store, record) {
  return openIDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  }));
}

function idbGetAll(store) {
  return openIDB().then(db => new Promise((res, rej) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = e  => rej(e.target.error);
  }));
}

function idbClear(store) {
  return openIDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res();
    tx.onerror    = e  => rej(e.target.error);
  }));
}

async function idbGetMeta(key) {
  const all = await idbGetAll(IDB_META);
  const rec = all.find(r => r.key === key);
  return rec ? rec.value : null;
}

async function idbSetMeta(key, value) {
  await idbPut(IDB_META, { key, value });
}

function idbDeleteMeta(key) {
  return openIDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(IDB_META, 'readwrite');
    tx.objectStore(IDB_META).delete(key);
    tx.oncomplete = () => res();
    tx.onerror    = e  => rej(e.target.error);
  }));
}

// ============================================================
// UNSYNCED BADGE  — live count of pending IDB actions
// ============================================================
async function updateUnsyncedBadge() {
  try {
    const actions = await idbGetAll(IDB_ACTIONLOG);
    const badge   = document.getElementById('unsyncedBadge');
    if (!badge) return;
    if (actions.length === 0) {
      badge.classList.add('hidden');
    } else {
      badge.textContent = `${actions.length} unsynced`;
      badge.classList.remove('hidden');
    }
  } catch { /* IDB not open yet */ }
}

// ============================================================
// DRAFT READING  — survive browser force-close mid-form
// ============================================================
const DRAFT_KEY = 'mobile_reading_draft';

async function saveDraftReading(equipId, fields) {
  await idbSetMeta(DRAFT_KEY, { equipId, fields, savedAt: new Date().toISOString() });
}

async function loadDraftReading() {
  return idbGetMeta(DRAFT_KEY);
}

async function clearDraftReading() {
  await idbDeleteMeta(DRAFT_KEY);
}

// ============================================================
// ACTION LOG  (mobile side, tracks changes for Sync QR)
// ============================================================
async function appendActionLog(type, equipmentId, payload) {
  const entry = {
    id:           'ACT-' + Date.now() + '-' + Math.floor(Math.random() * 9999),
    type,
    equipment_id: equipmentId,
    last_modified: new Date().toISOString(),
    payload,
  };
  await idbPut(IDB_ACTIONLOG, entry);
  updateUnsyncedBadge();  // fire-and-forget — update badge immediately
  return entry;
}

async function getActionLog() {
  return idbGetAll(IDB_ACTIONLOG);
}

async function clearActionLog() {
  await idbClear(IDB_ACTIONLOG);
  updateUnsyncedBadge();  // reset badge to zero
}

// ============================================================
// PC → PHONE: Generate Checkout QR
// ============================================================
async function generateCheckoutQR() {
  // routinesData is a global from app.js
  if (!window.routinesData || !window.routinesData.length) {
    showQRToast('Open Routines.json first.', 'warning');
    return;
  }

  const envelope = {
    sync_type:   'checkout',
    checkout_at: new Date().toISOString(),
    routines:    window.routinesData,
  };

  const compressed = qrCompress(envelope);
  const sessionId  = makeSessionId();
  const frames     = buildChunkFrames(sessionId, compressed);

  document.getElementById('qrFrameCount').textContent =
    `${frames.length} frame(s) — ${window.routinesData.length} record(s)`;

  await startAnimatedQR('qrCanvas', 'qrFrameInfo', frames);
  showQRToast(`Checkout QR ready — ${frames.length} frame(s). Hold phone steady.`, 'success');
}

// ============================================================
// PHONE → IDB: Receive Checkout QR
// ============================================================
async function onCheckoutScanned(envelope) {
  if (envelope.sync_type !== 'checkout') {
    showQRToast('Wrong QR type — expected a Checkout code.', 'error');
    return;
  }

  showQRToast('Processing checkout data…', 'info', 2000);

  await idbClear(IDB_EQUIP);
  await idbClear(IDB_ACTIONLOG);

  for (const rec of envelope.routines) {
    await idbPut(IDB_EQUIP, rec);
  }
  await idbSetMeta('checkout_at', envelope.checkout_at);

  // Mirror into app globals so the table renders
  window.routinesData = envelope.routines;
  window.histLoaded   = false;

  if (typeof renderTable === 'function') renderTable();
  stopScanner();
  closeQRModal();
  showQRToast(`Checked out — ${envelope.routines.length} equipment records loaded.`, 'success');
}

// ============================================================
// PHONE: Generate Sync QR (action log delta)
// ============================================================
async function generateSyncQR() {
  const actions     = await getActionLog();
  const checkout_at = await idbGetMeta('checkout_at');

  if (!actions.length) {
    showQRToast('No changes to sync — action log is empty.', 'warning');
    return;
  }

  const envelope = {
    sync_type:    'action_log',
    checkout_at:  checkout_at || new Date(0).toISOString(),
    generated_at: new Date().toISOString(),
    actions,
  };

  const compressed = qrCompress(envelope);
  const sessionId  = makeSessionId();
  const frames     = buildChunkFrames(sessionId, compressed);

  document.getElementById('qrFrameCount').textContent =
    `${frames.length} frame(s) — ${actions.length} action(s)`;

  await startAnimatedQR('qrCanvas', 'qrFrameInfo', frames);
  showQRToast(`Sync QR ready — ${frames.length} frame(s), ${actions.length} action(s).`, 'success');
}

// ============================================================
// PC: Receive Sync QR — conflict detection + merge
// ============================================================
async function onSyncScanned(envelope) {
  if (envelope.sync_type !== 'action_log') {
    showQRToast('Wrong QR type — expected a Sync code.', 'error');
    return;
  }

  const actions       = envelope.actions || [];
  const checkout_at   = new Date(envelope.checkout_at || 0);
  const local         = window.routinesData || [];
  const localMap      = new Map(local.map(r => [r.ID, r]));

  // Detect conflicts: any local record modified AFTER the checkout time
  const conflicts = actions
    .filter(a => {
      const rec = localMap.get(a.equipment_id);
      if (!rec || !rec.last_modified) return false;
      return new Date(rec.last_modified) > checkout_at;
    })
    .map(a => {
      const rec = localMap.get(a.equipment_id);
      return {
        action:    a,
        localRec:  rec,
        localTime: rec.last_modified,
        syncTime:  a.last_modified,
      };
    });

  if (conflicts.length) {
    showConflictModal(conflicts, actions, envelope);
  } else {
    applyActionLog(actions, envelope);
  }
}

// ============================================================
// CONFLICT MODAL
// ============================================================
function showConflictModal(conflicts, allActions, envelope) {
  const list = conflicts.map(c => {
    const rec = c.localRec;
    return `<li>
      <strong>${rec.BSI_Number || rec.ID}</strong> — ${rec.Equipment_Type || ''}
      <br><small>Local modified: ${new Date(c.localTime).toLocaleString()}</small>
      <br><small>Incoming: ${new Date(c.syncTime).toLocaleString()}</small>
    </li>`;
  }).join('');

  document.getElementById('conflictList').innerHTML = `<ul>${list}</ul>`;
  document.getElementById('conflictModal').classList.remove('hidden');

  document.getElementById('conflictSkip').onclick = () => {
    document.getElementById('conflictModal').classList.add('hidden');
    const safeActions = allActions.filter(a => !conflicts.find(c => c.action.id === a.id));
    applyActionLog(safeActions, envelope);
  };

  document.getElementById('conflictForce').onclick = () => {
    document.getElementById('conflictModal').classList.add('hidden');
    applyActionLog(allActions, envelope);
  };

  document.getElementById('conflictCancel').onclick = () => {
    document.getElementById('conflictModal').classList.add('hidden');
    showQRToast('Sync cancelled.', 'warning');
  };
}

// ============================================================
// APPLY ACTION LOG  (PC side — calls existing app.js functions)
// ============================================================
async function applyActionLog(actions, envelope) {
  let readingCount = 0;
  let equipCount   = 0;

  for (const action of actions) {
    if (action.type === 'log_reading') {
      // Append to histData + update last_reading via existing logReading() flow
      if (window.histHandle) {
        await logReading(action.equipment_id, {
          user:     action.payload.User     || '',
          p1:       action.payload.Pressure_1 ?? '',
          p2:       action.payload.Pressure_2 ?? '',
          flowIn:   action.payload.Flow_In  ?? '',
          flowOut:  action.payload.Flow_Out ?? '',
          comments: action.payload.Comments || '',
        });
      } else {
        // No histHandle open — add to in-memory histData so it shows in trends
        if (window.histData) {
          const exists = window.histData.find(r => r.ID === action.payload.ID);
          if (!exists) window.histData.push(action.payload);
        }
      }
      readingCount++;
    } else if (action.type === 'update_equipment') {
      // Track in pendingChanges — will be committed on Save & Sync
      if (typeof pendingChanges !== 'undefined') {
        if (!pendingChanges[action.equipment_id]) pendingChanges[action.equipment_id] = {};
        Object.assign(pendingChanges[action.equipment_id], action.payload);
      }
      equipCount++;
    }
  }

  if (typeof updateChangeCount === 'function') updateChangeCount();
  if (typeof renderTable === 'function') renderTable();

  stopScanner();
  closeQRModal();

  const msgs = [];
  if (readingCount) msgs.push(`${readingCount} reading(s) logged`);
  if (equipCount) msgs.push(`${equipCount} equipment update(s) — Save & Sync to persist`);
  showQRToast('Sync applied: ' + msgs.join(', ') + '.', 'success', 5000);
}

// ============================================================
// UI: QR SYNC MODAL  (open / close)
// ============================================================
function openQRModal(tab) {
  const modal = document.getElementById('qrSyncModal');
  modal.classList.remove('hidden');
  switchQRTab(tab || 'generate');
  stopAnimatedQR();
  _currentSession = {};
}

function closeQRModal() {
  document.getElementById('qrSyncModal').classList.add('hidden');
  stopAnimatedQR();
  stopScanner();
  _currentSession = {};

  // reset scan progress
  const p = document.getElementById('scanProgress');
  if (p) p.textContent = '';
}

function switchQRTab(tab) {
  document.querySelectorAll('.qr-tab-btn').forEach(b =>
    b.classList.toggle('qr-tab-active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.qr-tab-pane').forEach(p =>
    p.classList.toggle('hidden', p.dataset.tab !== tab)
  );
  stopAnimatedQR();
  stopScanner();
}

// ============================================================
// UI: auxiliary toast (separate from main app toast)
// ============================================================
let _qrToastTimer = null;
function showQRToast(msg, type = 'success', dur = 3500) {
  if (typeof showToast === 'function') { showToast(msg, type, dur); return; }
  console.log('[QR]', type, msg);
}

// ============================================================
// INIT  (called from DOMContentLoaded in app.js)
// ============================================================
function initQRSync() {
  // Toolbar button
  document.getElementById('btnQRSync')?.addEventListener('click', () => openQRModal());

  // Close modal
  document.getElementById('qrSyncClose')?.addEventListener('click', closeQRModal);
  document.getElementById('qrSyncModal')?.addEventListener('click', e => {
    if (e.target.id === 'qrSyncModal') closeQRModal();
  });

  // Tab switchers
  document.querySelectorAll('.qr-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchQRTab(btn.dataset.tab));
  });

  // PC: Generate Checkout QR
  document.getElementById('btnGenerateCheckout')?.addEventListener('click', generateCheckoutQR);

  // Phone: Scan Checkout QR
  document.getElementById('btnScanCheckout')?.addEventListener('click', () => {
    startCameraScanner('qrScannerDiv', onCheckoutScanned);
    startWedgeListener(onCheckoutScanned);
  });

  // Phone: Paste fallback for Scan Checkout
  document.getElementById('btnPasteCheckout')?.addEventListener('click', () => {
    const text = document.getElementById('pasteInput')?.value || '';
    handlePasteInput(text, onCheckoutScanned);
  });

  // Phone: Generate Sync QR
  document.getElementById('btnGenerateSync')?.addEventListener('click', generateSyncQR);

  // PC: Scan Daily Sync
  document.getElementById('btnScanSync')?.addEventListener('click', () => {
    startCameraScanner('qrScannerDiv', onSyncScanned);
    startWedgeListener(onSyncScanned);
  });

  // PC: Paste fallback for Scan Sync
  document.getElementById('btnPasteSync')?.addEventListener('click', () => {
    const text = document.getElementById('pasteInput')?.value || '';
    handlePasteInput(text, onSyncScanned);
  });

  // Keyboard: Escape closes QR modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('qrSyncModal')?.classList.contains('hidden')) {
      closeQRModal();
    }
  });
}

// ============================================================
// MOBILE: track changes to action log
// Called by app.js when in Mobile Floor Mode
// ============================================================
async function mobileLogReading(equipId, readingData) {
  const reading = {
    ID:           'READ-' + Date.now() + '-' + Math.floor(Math.random() * 9999),
    Equipment_ID: equipId,
    Timestamp:    new Date().toISOString(),
    User:         readingData.user,
    Pressure_1:   readingData.p1 !== '' ? Number(readingData.p1) : null,
    Pressure_2:   readingData.p2 !== '' ? Number(readingData.p2) : null,
    Flow_In:      readingData.flowIn  !== '' ? Number(readingData.flowIn)  : null,
    Flow_Out:     readingData.flowOut !== '' ? Number(readingData.flowOut) : null,
    Comments:     readingData.comments,
  };
  await idbPut(IDB_HISTORY, reading);
  await appendActionLog('log_reading', equipId, reading);  // also triggers badge update
  await clearDraftReading();  // discard in-progress form draft

  // Update last_reading snapshot on local equipment record
  const eq = (window.routinesData || []).find(r => r.ID === equipId);
  if (eq) {
    eq.last_reading = {
      Timestamp:  reading.Timestamp,
      User:       reading.User,
      Pressure_1: reading.Pressure_1,
      Pressure_2: reading.Pressure_2,
      Flow_In:    reading.Flow_In,
      Flow_Out:   reading.Flow_Out,
    };
    eq.last_modified = reading.Timestamp;
    await idbPut(IDB_EQUIP, eq);  // persist snapshot to IDB immediately
  }

  if (typeof renderTable === 'function') renderTable();
  return reading;
}

async function mobileUpdateEquipment(equipId, fields) {
  const now = new Date().toISOString();
  await appendActionLog('update_equipment', equipId, { ...fields, last_modified: now });
  const eq = (window.routinesData || []).find(r => r.ID === equipId);
  if (eq) {
    Object.assign(eq, fields, { last_modified: now });
    await idbPut(IDB_EQUIP, eq);  // persist to IDB immediately — survives force-close
  }
  if (typeof renderTable === 'function') renderTable();
}

// ============================================================
// STATE RECOVERY  — called on Mobile Mode init
// ============================================================
async function loadMobileEquipment() {
  const records = await idbGetAll(IDB_EQUIP);
  window.routinesData = records;
  window.histLoaded   = false;

  const hist = await idbGetAll(IDB_HISTORY);
  window.histData = hist;
  if (hist.length) window.histLoaded = true;

  // Check for pending unsynced actions — alert user their work is safe
  const pending = await idbGetAll(IDB_ACTIONLOG);
  updateUnsyncedBadge();

  if (pending.length > 0) {
    // Slight delay so the table renders first, then the toast is visible
    setTimeout(() => {
      if (typeof showToast === 'function') {
        showToast(
          `🔄 Recovered: <strong>${pending.length}</strong> unsynced action(s) from last session — your work was not lost.`,
          'warning',
          7000
        );
      }
    }, 800);
  }
}
