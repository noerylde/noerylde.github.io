/**
 * Maintenance Routines SPA — app.js  (Phase 3)
 *
 * New in Phase 3:
 *  - Mode selection screen (PC vs Mobile)
 *  - Service Worker registration (PWA)
 *  - Light/Dark theme toggle (CSS vars, localStorage, prefers-color-scheme)
 *  - last_modified timestamps on all equipment writes
 *  - Mobile Floor Mode: delegates reads/writes to qrsync.js (IndexedDB)
 *  - pc-only / mobile-only DOM class toggling per mode
 */

'use strict';

// ============================================================
// STATE
// ============================================================
let routinesHandle = null;
window.routinesData = [];    // Explicitly global
let isEditMode     = false;
let users          = [];

let pendingChanges = {};
let loggingEquipId = null;
let trendEquipId   = null;
let editingEquipId = null;
let archiveEquipId = null;
let chartInstance  = null;

let filterText         = '';
let filterOverdue      = false;
let filterShowArchived = false;

// 'pc' | 'mobile' | null (not yet selected)
let APP_MODE = null;

const today = new Date();
today.setHours(0, 0, 0, 0);

// ============================================================
// DOM REFS
// ============================================================
const btnOpenRoutines   = document.getElementById('btnOpenRoutines');
const btnSave           = document.getElementById('btnSave');
const btnRefresh        = document.getElementById('btnRefresh');
const btnUsers          = document.getElementById('btnUsers');
const btnMobileRefresh  = document.getElementById('btnMobileRefresh');
const syncSpinner       = document.getElementById('syncSpinner');
const editModeWrap      = document.getElementById('editModeWrap');
const editModeToggle    = document.getElementById('editModeToggle');
const editModeBadge     = document.getElementById('editModeBadge');
const statusBadge       = document.getElementById('statusBadge');
const changeCountEl     = document.getElementById('changeCount');
const changeNumEl       = document.getElementById('changeNum');
const routinesFileName  = document.getElementById('routinesFileName');
const routinesIndicator = document.getElementById('routinesIndicator');
const themeToggle       = document.getElementById('themeToggle');
const filterBar         = document.getElementById('filterBar');
const searchInput       = document.getElementById('searchInput');
const filterOverdueEl   = document.getElementById('filterOverdue');
const filterArchivedEl  = document.getElementById('filterShowArchived');
const tableContainer    = document.getElementById('tableContainer');
const tableBody         = document.getElementById('tableBody');
const emptyState        = document.getElementById('emptyState');
const loadingOverlay    = document.getElementById('loadingOverlay');
const loadingMsg        = document.getElementById('loadingMessage');
const appFooter         = document.getElementById('appFooter');
const statTotal         = document.getElementById('statTotal');
const statActive        = document.getElementById('statActive');
const statOverdue       = document.getElementById('statOverdue');
const statToday         = document.getElementById('statToday');
const lastSavedEl       = document.getElementById('lastSaved');
const toastEl           = document.getElementById('toast');
const modeFooterBadge   = document.getElementById('modeFooterBadge');
const modeIndicBadge    = document.getElementById('modeIndicatorBadge');

// Log Reading modal
const logModal         = document.getElementById('logModal');
const logModalTitle    = document.getElementById('logModalTitle');
const logModalSubtitle = document.getElementById('logModalSubtitle');
const logModalClose    = document.getElementById('logModalClose');
const logModalCancel   = document.getElementById('logModalCancel');
const logModalSubmit   = document.getElementById('logModalSubmit');
const logSpinner       = document.getElementById('logSpinner');
const lr_user          = document.getElementById('lr_user');
const lr_p1            = document.getElementById('lr_p1');
const lr_p2            = document.getElementById('lr_p2');
const lr_p2_group      = document.getElementById('lr_p2_group');
const lr_flow_in       = document.getElementById('lr_flow_in');
const lr_flow_out      = document.getElementById('lr_flow_out');
const lr_comments      = document.getElementById('lr_comments');

// Trend modal
const trendModal          = document.getElementById('trendModal');
const trendTitle          = document.getElementById('trendTitle');
const trendSubtitle       = document.getElementById('trendSubtitle');
const trendClose          = document.getElementById('trendClose');
const trendClose2         = document.getElementById('trendClose2');
const trendRange          = document.getElementById('trendRange');
const trendNoData         = document.getElementById('trendNoData');
const chartContainer      = document.getElementById('chartContainer');
const readingHistoryTable = document.getElementById('readingHistoryTable');

// Equipment modal
const equipModal       = document.getElementById('equipModal');
const equipModalTitle  = document.getElementById('equipModalTitle');
const equipModalClose  = document.getElementById('equipModalClose');
const equipModalCancel = document.getElementById('equipModalCancel');
const equipModalSave   = document.getElementById('equipModalSave');
const eq_bsi           = document.getElementById('eq_bsi');
const eq_type          = document.getElementById('eq_type');
const eq_serial        = document.getElementById('eq_serial');
const eq_location      = document.getElementById('eq_location');
const eq_due           = document.getElementById('eq_due');
const eq_inservice     = document.getElementById('eq_inservice');
const eq_dual          = document.getElementById('eq_dual');

// Archive dialog
const archiveDialog      = document.getElementById('archiveDialog');
const archiveDialogClose = document.getElementById('archiveDialogClose');
const archiveMessage     = document.getElementById('archiveMessage');
const archiveCancel      = document.getElementById('archiveCancel');
const archiveConfirm     = document.getElementById('archiveConfirm');

// User modal
const userModal     = document.getElementById('userModal');
const userModalClose = document.getElementById('userModalClose');
const userModalDone  = document.getElementById('userModalDone');
const userList       = document.getElementById('userList');
const newUserInput   = document.getElementById('newUserInput');
const addUserBtn     = document.getElementById('addUserBtn');

// Mode selection screen
const modeSelectScreen = document.getElementById('modeSelectScreen');
const btnPCMode        = document.getElementById('btnPCMode');
const btnMobileMode    = document.getElementById('btnMobileMode');

// ============================================================
// UTILITIES
// ============================================================
function generateId(prefix = 'REC') {
  return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
}
function isOverdue(ds) { return ds && new Date(ds + 'T00:00:00') < today; }
function isUpcoming(ds) {
  if (!ds) return false;
  const d = new Date(ds + 'T00:00:00'), lim = new Date(today);
  lim.setDate(today.getDate() + 14);
  return d >= today && d <= lim;
}
function formatDate(ds) {
  if (!ds) return '—';
  return new Date(ds + 'T00:00:00').toLocaleDateString(undefined, { year:'numeric', month:'short', day:'2-digit' });
}
function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function formatNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v); return isNaN(n) ? String(v) : n % 1 === 0 ? n : n.toFixed(1);
}
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function setStatus(t, c) { statusBadge.textContent = t; statusBadge.className = 'status-badge ' + c; }
function updateChangeCount() {
  const n = Object.keys(pendingChanges).length;
  changeNumEl.textContent = n;
  changeCountEl.classList.toggle('hidden', n === 0);
  if (n > 0) { setStatus('Unsaved', 'status-changed'); btnSave.disabled = false; }
  else        { if (routinesHandle) setStatus('Loaded', 'status-loaded'); btnSave.disabled = true; }
}
function showLoading(m) { loadingMsg.textContent = m; loadingOverlay.classList.remove('hidden'); }
function hideLoading()  { loadingOverlay.classList.add('hidden'); }

// ============================================================
// TOAST
// ============================================================
let toastTimer = null;
function showToast(msg, type = 'success', dur = 3500) {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  toastEl.innerHTML = `<span class="toast-icon">${icons[type]||'💬'}</span> ${msg}`;
  toastEl.className = `toast toast-${type}`;
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

// ============================================================
// THEME
// ============================================================
const THEME_KEY = 'routinesSPA_theme';

function applyTheme(dark) {
  document.body.classList.toggle('light-theme', !dark);
  themeToggle.checked = dark;
  localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    applyTheme(saved === 'dark');
  } else {
    applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
}

themeToggle.addEventListener('change', () => applyTheme(themeToggle.checked));

// ============================================================
// MODE SELECTION
// ============================================================
function enterMode(mode) {
  APP_MODE = mode;
  window.APP_MODE = mode;      // expose for qrsync.js

  // Fade out mode selector
  modeSelectScreen.classList.add('fade-out');
  setTimeout(() => modeSelectScreen.classList.add('hidden'), 400);

  // Show main chrome
  document.getElementById('appHeader').classList.remove('hidden');
  document.getElementById('toolbar').classList.remove('hidden');
  filterBar.classList.remove('hidden');
  appFooter.classList.remove('hidden');

  // Mode-specific DOM state
  const pcEls     = document.querySelectorAll('.pc-only');
  const mobileEls = document.querySelectorAll('.mobile-only');

  if (mode === 'pc') {
    pcEls.forEach(el => el.classList.remove('hidden'));
    mobileEls.forEach(el => el.classList.add('hidden'));
    modeIndicBadge.textContent = '🖥️ PC Mode';
    modeFooterBadge.textContent = 'PC Mode';
    modeFooterBadge.className = 'mode-footer-badge mode-pc';
    setStatus('Ready', 'status-idle');

    // Show empty state guidance
    emptyState.classList.remove('hidden');
    document.getElementById('emptyStateTitle').textContent = 'Open Your Data Files';
    document.getElementById('emptyStateMsg').textContent   = 'Click "Open Routines" and "Open History" to load equipment data from the shared drive.';
  } else {
    pcEls.forEach(el => el.classList.add('hidden'));
    mobileEls.forEach(el => el.classList.remove('hidden'));
    modeIndicBadge.textContent = '📱 Mobile Mode';
    modeFooterBadge.textContent = 'Mobile Mode';
    modeFooterBadge.className = 'mode-footer-badge mode-mobile';
    setStatus('Ready', 'status-idle');

    emptyState.classList.remove('hidden');
    document.getElementById('emptyStateTitle').textContent = 'Scan Checkout QR to Begin';
    document.getElementById('emptyStateMsg').textContent   = 'Click "📷 QR Sync" → Scan Checkout tab to load equipment from the shop PC.';

    // Try loading existing IndexedDB data
    if (typeof loadMobileEquipment === 'function') {
      loadMobileEquipment().then(() => {
        if (routinesData.length) {
          renderTable();
          showToast(`Restored ${routinesData.length} records from device storage.`, 'info');
        }
      });
    }
  }
}

btnPCMode.addEventListener('click',     () => enterMode('pc'));
btnMobileMode.addEventListener('click', () => enterMode('mobile'));

// ============================================================
// SERVICE WORKER (PWA)
// ============================================================
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .catch(err => console.warn('SW registration failed:', err));
  }
}

// ============================================================
// FILE SYSTEM API HELPERS  (PC mode only)
// ============================================================
async function readFileToJson(h) {
  const file = await h.getFile(); return JSON.parse(await file.text());
}
async function writeJsonToFile(h, data) {
  const w = await h.createWritable();
  await w.write(JSON.stringify(data, null, 2)); await w.close();
}
async function ensureWritePermission(h) {
  const p = await h.queryPermission({ mode: 'readwrite' });
  if (p === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// ============================================================
// OPEN FILES  (PC mode)
// ============================================================
btnOpenRoutines?.addEventListener('click', async () => {
  if (!window.showOpenFilePicker)
    return showToast('File System Access API requires Chrome or Edge.', 'error', 6000);
  try {
    const [h] = await window.showOpenFilePicker({
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    });
    showLoading('Reading Routines…');
    const data = await readFileToJson(h);
    if (!Array.isArray(data)) throw new Error('Expected a JSON array.');
    // Schema migration: ensure 'readings' array exists
    data.forEach(r => { if (!r.readings) r.readings = []; });
    routinesHandle = h; window.routinesData = data; pendingChanges = {};
    routinesFileName.textContent = 'Routines: ' + h.name;
    routinesIndicator.classList.add('has-file');
    editModeWrap.style.display = '';
    btnUsers.style.display = '';
    btnRefresh.style.display = '';
    setStatus('Loaded', 'status-loaded'); updateChangeCount(); renderTable();
    hideLoading(); showToast(`Loaded <strong>${h.name}</strong> — ${data.length} record(s).`);
  } catch (err) { hideLoading(); if (err.name !== 'AbortError') showToast('Open failed: ' + err.message, 'error'); }
});

btnRefresh?.addEventListener('click', async () => {
  showLoading('Refreshing…');
  try {
    if (routinesHandle) window.routinesData = await readFileToJson(routinesHandle);
    renderTable(); showToast('Refreshed.', 'info');
  } catch (e) { showToast('Refresh failed: ' + e.message, 'error'); }
  hideLoading();
});

// Mobile refresh (re-read from IndexedDB)
btnMobileRefresh?.addEventListener('click', async () => {
  if (typeof loadMobileEquipment === 'function') {
    await loadMobileEquipment(); renderTable(); showToast('Reloaded from device.', 'info');
  }
});

// ============================================================
// SAVE & SYNC  (PC mode — equipment metadata)
// ============================================================
btnSave?.addEventListener('click', saveEquipmentSync);

async function saveEquipmentSync() {
  if (!routinesHandle || !Object.keys(pendingChanges).length) return;
  if (!await ensureWritePermission(routinesHandle))
    return showToast('Write permission denied.', 'error');

  btnSave.disabled = true;
  syncSpinner?.classList.remove('hidden');
  setStatus('Syncing…', 'status-saving');
  showLoading('Read-Before-Write — Routines…');

  try {
    const fresh    = await readFileToJson(routinesHandle);
    const freshMap = new Map(fresh.map(r => [r.ID, r]));
    const now      = new Date().toISOString();

    for (const [id, changes] of Object.entries(pendingChanges)) {
      if (changes.__fullRecord) {
        const { __fullRecord, ...rec } = changes;
        rec.last_modified = now;
        freshMap.set(id, rec);
      } else if (freshMap.has(id)) {
        Object.assign(freshMap.get(id), changes, { last_modified: now });
      }
    }

    const merged = [...freshMap.values()];
    await writeJsonToFile(routinesHandle, merged);
    window.routinesData = merged; pendingChanges = {};

    lastSavedEl.textContent = 'Last saved: ' + new Date().toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
    updateChangeCount(); renderTable(); hideLoading();
    showToast('Saved &amp; Synced ✔', 'success');
  } catch (err) {
    hideLoading(); showToast('Save failed: ' + err.message, 'error', 6000);
    setStatus('Unsaved', 'status-changed'); btnSave.disabled = false;
  } finally { syncSpinner?.classList.add('hidden'); }
}

// ============================================================
// LOG READING  — PC: immediate RBW on both files
//               Mobile: delegates to qrsync.mobileLogReading
// ============================================================
async function logReading(equipId, readingData) {
  if (APP_MODE === 'mobile') {
    if (typeof mobileLogReading !== 'function')
      return showToast('qrsync.js not loaded.', 'error');
    logSpinner?.classList.remove('hidden');
    logModalSubmit.disabled = true;
    try {
      await mobileLogReading(equipId, readingData);
      closeLogModal();
      showToast('Reading saved to device ✔', 'success');
    } catch(e) { showToast('Log failed: ' + e.message, 'error'); }
    finally { logSpinner?.classList.add('hidden'); logModalSubmit.disabled = false; }
    return;
  }

  if (!routinesHandle)
    return showToast('Open Routines file first.', 'warning', 5000);
  if (!await ensureWritePermission(routinesHandle))
    return showToast('Write permission denied.', 'error');

  const reading = {
    ID:           generateId('READ'),
    Equipment_ID: equipId,
    Timestamp:    new Date().toISOString(),
    User:         readingData.user,
    Pressure_1:   readingData.p1  !== '' ? Number(readingData.p1)  : null,
    Pressure_2:   readingData.p2  !== '' ? Number(readingData.p2)  : null,
    Flow_In:      readingData.flowIn  !== '' ? Number(readingData.flowIn)  : null,
    Flow_Out:     readingData.flowOut !== '' ? Number(readingData.flowOut) : null,
    Comments:     readingData.comments,
  };

  logSpinner?.classList.remove('hidden');
  logModalSubmit.disabled = true;
  showLoading('Appending to Routines…');

  try {
    const freshRoutines = await readFileToJson(routinesHandle);
    const eq = freshRoutines.find(r => r.ID === equipId);
    if (eq) {
      if (!eq.readings) eq.readings = [];
      if (!eq.readings.find(r => r.ID === reading.ID)) {
        eq.readings.push(reading);
      }
      eq.last_reading = {
        Timestamp: reading.Timestamp, User: reading.User,
        Pressure_1: reading.Pressure_1, Pressure_2: reading.Pressure_2,
        Flow_In: reading.Flow_In, Flow_Out: reading.Flow_Out,
      };
      eq.last_modified = new Date().toISOString();
    }
    await writeJsonToFile(routinesHandle, freshRoutines);
    window.routinesData = freshRoutines;

    renderTable(); hideLoading(); closeLogModal();
    showToast('Reading logged ✔', 'success');
  } catch (err) { hideLoading(); showToast('Log failed: ' + err.message, 'error', 6000); }
  finally { logSpinner?.classList.add('hidden'); logModalSubmit.disabled = false; }
}

// ============================================================
// ARCHIVE  — immediate RBW on Routines.json (PC only)
// ============================================================
async function archiveEquipment(equipId) {
  if (APP_MODE === 'mobile') {
    // Mobile: just mark locally (action logged, will sync to PC)
    if (typeof mobileUpdateEquipment === 'function')
      await mobileUpdateEquipment(equipId, { is_active: false });
    return;
  }
  if (!routinesHandle) return;
  if (!await ensureWritePermission(routinesHandle))
    return showToast('Write permission denied.', 'error');

  showLoading('Archiving…');
  try {
    const fresh = await readFileToJson(routinesHandle);
    const eq    = fresh.find(r => r.ID === equipId);
    if (eq) { eq.is_active = false; eq.last_modified = new Date().toISOString(); }
    await writeJsonToFile(routinesHandle, fresh);
    routinesData = fresh;
    delete pendingChanges[equipId];
    updateChangeCount(); renderTable(); hideLoading();
    showToast('Archived.', 'warning');
  } catch (err) { hideLoading(); showToast('Archive failed: ' + err.message, 'error'); }
}

// ============================================================
// EFFECTIVE RECORDS
// ============================================================
function getEffectiveRecords() {
  const map = new Map(routinesData.map(r => [r.ID, { ...r }]));
  for (const [id, ch] of Object.entries(pendingChanges)) {
    if (ch.__fullRecord) { const { __fullRecord, ...rec } = ch; map.set(id, rec); }
    else if (map.has(id)) Object.assign(map.get(id), ch);
  }
  return [...map.values()];
}

function applyFilters(records) {
  return records.filter(r => {
    if (!filterShowArchived && !r.is_active) return false;
    if (filterOverdue && !isOverdue(r.Due_Date)) return false;
    if (filterText) {
      const q   = filterText.toLowerCase();
      const hay = [r.BSI_Number, r.Equipment_Type, r.Serial_Number, r.Location].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ============================================================
// RENDER TABLE
// ============================================================
function renderTable() {
  const all = getEffectiveRecords(), filtered = applyFilters(all);
  const active  = all.filter(r => r.is_active).length;
  const overdue = all.filter(r => r.is_active && isOverdue(r.Due_Date)).length;
  const todayStr = new Date().toISOString().slice(0, 10);
  let todayLogs = 0;
  all.forEach(r => {
    if (r.readings) todayLogs += r.readings.filter(rd => rd.Timestamp?.startsWith(todayStr)).length;
  });

  statTotal.textContent  = `${all.length} total`;
  statActive.textContent = `${active} active`;
  statOverdue.textContent= `${overdue} overdue`;
  statToday.textContent  = `${todayLogs} logged today`;

  tableBody.innerHTML = '';
  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">No records match filters.</td></tr>`;
  } else {
    filtered.forEach(rec => tableBody.appendChild(buildRow(rec)));
  }

  emptyState.classList.add('hidden');
  tableContainer.classList.remove('hidden');
}

function buildRow(rec) {
  const od = isOverdue(rec.Due_Date), up = isUpcoming(rec.Due_Date);
  const isModified = !!pendingChanges[rec.ID];
  const lr = rec.last_reading;
  const tr = document.createElement('tr');
  if (!rec.is_active) tr.classList.add('row-archived');
  if (od)             tr.classList.add('row-overdue');
  if (isModified)     tr.classList.add('row-modified');

  let dueCls = 'ok', duePrefix = '';
  if (od)      { dueCls = 'overdue';  duePrefix = '⚠ '; }
  else if (up) { dueCls = 'upcoming'; duePrefix = '🔔 '; }

  let readingHtml = '<span class="reading-none">No readings yet</span>';
  if (lr) {
    if (rec.has_gas === false) {
      readingHtml = `<div class="reading-cell">
        <div class="reading-meta">Last Checked ${rec.In_Service ? 'In Service' : 'Out of Service'}, ${formatDateTime(lr.Timestamp)}</div>
      </div>`;
    } else {
      const b = [];
      if (lr.Pressure_1 !== null && lr.Pressure_1 !== undefined && lr.Pressure_1 !== '')
        b.push(`<span class="reading-badge badge-p1">P1: ${formatNum(lr.Pressure_1)} psi</span>`);
      if (rec.has_two_pressures && lr.Pressure_2 !== null && lr.Pressure_2 !== undefined && lr.Pressure_2 !== '')
        b.push(`<span class="reading-badge badge-p2">P2: ${formatNum(lr.Pressure_2)} psi</span>`);
      if (lr.Flow_In  !== null && lr.Flow_In  !== '') b.push(`<span class="reading-badge badge-flow-in">↓ ${formatNum(lr.Flow_In)} L/m</span>`);
      if (lr.Flow_Out !== null && lr.Flow_Out !== '') b.push(`<span class="reading-badge badge-flow-out">↑ ${formatNum(lr.Flow_Out)} L/m</span>`);
      readingHtml = `<div class="reading-cell">
        <div class="reading-values">${b.join('')}</div>
        <div class="reading-meta">${formatDateTime(lr.Timestamp)} · ${esc(lr.User||'')}</div>
      </div>`;
    }
  }

  tr.innerHTML = `
    <td><span class="bsi-pill">${esc(rec.BSI_Number||'—')}</span></td>
    <td>${esc(rec.Equipment_Type||'—')}</td>
    <td style="color:var(--text-sub);font-size:0.82rem">${esc(rec.Serial_Number||'—')}</td>
    <td style="color:var(--text-sub);font-size:0.82rem">${esc(rec.Location||'—')}</td>
    <td><span class="due-badge ${dueCls}">${duePrefix}${formatDate(rec.Due_Date)}</span></td>
    <td class="col-svc" style="text-align:center">
      <span class="view-only" style="font-size:1.15rem; cursor:help" title="${rec.In_Service?'In Service':'Out of Service'}">${rec.In_Service ? '✅' : '❌'}</span>
      <div class="edit-only"><input type="checkbox" class="service-toggle" data-id="${esc(rec.ID)}" ${rec.In_Service?'checked':''} /></div>
    </td>
    <td>${readingHtml}</td>
    <td>
      <div class="action-group">
        <button class="btn btn-sm btn-log btn-icon-only" data-log="${esc(rec.ID)}" title="Log reading" ${!histLoaded&&APP_MODE==='pc'?'disabled':''}>📝</button>
        <button class="btn btn-sm btn-trend btn-icon-only" data-trend="${esc(rec.ID)}" title="View trend" ${!histLoaded?'disabled':''}>📈</button>
        <button class="btn btn-sm btn-edit btn-icon-only edit-only" data-edit="${esc(rec.ID)}" title="Edit">✏️</button>
        <button class="btn btn-sm btn-archive btn-icon-only edit-only" data-archive="${esc(rec.ID)}" title="Archive" ${!rec.is_active?'disabled':''}>📦</button>
      </div>
    </td>
  `;

  tr.querySelector('.service-toggle').addEventListener('change', e => {
    if (APP_MODE === 'mobile') {
      mobileUpdateEquipment?.(rec.ID, { In_Service: e.target.checked });
    } else {
      recordChange(rec.ID, 'In_Service', e.target.checked);
    }
  });
  tr.querySelector('[data-log]').addEventListener('click',     () => openLogModal(rec.ID));
  tr.querySelector('[data-trend]').addEventListener('click',   () => openTrendModal(rec.ID));
  tr.querySelector('[data-edit]').addEventListener('click',    () => openEquipModal(rec.ID));
  tr.querySelector('[data-archive]').addEventListener('click', () => openArchiveDialog(rec.ID));

  return tr;
}

// ============================================================
// CHANGE TRACKING  (PC mode — batched)
// ============================================================
function recordChange(id, field, value) {
  if (!pendingChanges[id]) pendingChanges[id] = {};
  pendingChanges[id][field] = value;
  updateChangeCount();
  tableBody.querySelector(`[data-id="${id}"]`)?.closest('tr')?.classList.add('row-modified');
}

// ============================================================
// EDIT MODE
// ============================================================
editModeToggle.addEventListener('change', () => {
  isEditMode = editModeToggle.checked;
  document.body.classList.toggle('edit-mode', isEditMode);
  editModeBadge.classList.toggle('hidden', !isEditMode);
  addEquipBtn?.style && (addEquipBtn.style.display = isEditMode ? '' : 'none');
});

// ============================================================
// MODAL: LOG READING
// ============================================================
function openLogModal(equipId) {
  if (APP_MODE === 'pc' && !histLoaded)
    return showToast('Open History.json first to enable reading logs.', 'warning', 5000);
  if (users.length === 0)
    return showToast('Add at least one technician via 👥 Users.', 'warning', 5000);

  loggingEquipId = equipId;
  const rec = getEffectiveRecords().find(r => r.ID === equipId);
  if (!rec) return;

  logModalTitle.textContent    = '📝 Log Reading';
  logModalSubtitle.textContent = `${rec.BSI_Number||''} — ${rec.Equipment_Type||''}`;
  
  const hasGas = rec.has_gas !== false; // defaults true
  lr_p1_group.style.display       = hasGas ? '' : 'none';
  lr_flow_in_group.style.display  = hasGas ? '' : 'none';
  lr_flow_out_group.style.display = hasGas ? '' : 'none';
  lr_p2_group.style.display       = (hasGas && rec.has_two_pressures) ? '' : 'none';

  lr_inservice.checked = !!rec.In_Service;

  populateUserDropdown();
  lr_p1.value = lr_p2.value = lr_flow_in.value = lr_flow_out.value = '';
  lr_comments.value = '';

  // ── Mobile: restore in-progress draft from last session ──
  if (APP_MODE === 'mobile' && typeof loadDraftReading === 'function') {
    loadDraftReading().then(entry => {
      if (entry?.equipId === equipId && entry?.fields) {
        const f = entry.fields;
        if (f.user && users.includes(f.user)) lr_user.value = f.user;
        if (f.p1)       lr_p1.value       = f.p1;
        if (f.p2)       lr_p2.value       = f.p2;
        if (f.flowIn)   lr_flow_in.value  = f.flowIn;
        if (f.flowOut)  lr_flow_out.value = f.flowOut;
        if (f.comments) lr_comments.value = f.comments;
        const age = entry.savedAt ? new Date(entry.savedAt).toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' }) : '?';
        showToast(`📋 Draft restored from ${age} — continue where you left off.`, 'info', 5000);
      }
    }).catch(() => {});
  }

  logModal.classList.remove('hidden');
  lr_p1.focus();
}
function closeLogModal() {
  // On deliberate cancel, clear the draft (user chose to discard)
  if (APP_MODE === 'mobile' && typeof clearDraftReading === 'function') {
    clearDraftReading().catch(() => {});
  }
  logModal.classList.add('hidden');
  loggingEquipId = null;
}
logModalClose.addEventListener('click', closeLogModal);
logModalCancel.addEventListener('click', closeLogModal);
logModal.addEventListener('click', e => { if (e.target === logModal) closeLogModal(); });
logModalSubmit.addEventListener('click', () => {
  if (!lr_user.value) return showToast('Select a technician.', 'warning');

  // Update In Service status directly
  const rec = getEffectiveRecords().find(r => r.ID === loggingEquipId);
  if (rec && !!rec.In_Service !== lr_inservice.checked) {
    if (!pendingChanges[loggingEquipId]) pendingChanges[loggingEquipId] = {};
    pendingChanges[loggingEquipId].In_Service = lr_inservice.checked;
  }

  logReading(loggingEquipId, {
    user: lr_user.value, p1: lr_p1.value, p2: lr_p2.value,
    flowIn: lr_flow_in.value, flowOut: lr_flow_out.value, comments: lr_comments.value.trim(),
  });
});

// ── Mobile: save in-progress form data on every blur/change ──
function saveMobileDraft() {
  if (APP_MODE !== 'mobile' || !loggingEquipId) return;
  if (typeof saveDraftReading !== 'function') return;
  saveDraftReading(loggingEquipId, {
    user:     lr_user.value,
    p1:       lr_p1.value,
    p2:       lr_p2.value,
    flowIn:   lr_flow_in.value,
    flowOut:  lr_flow_out.value,
    comments: lr_comments.value,
  }).catch(() => {});   // fire-and-forget, never blocks UI
}
// Blur on every number/text input, change on select
[lr_p1, lr_p2, lr_flow_in, lr_flow_out, lr_comments].forEach(el =>
  el.addEventListener('blur', saveMobileDraft)
);
lr_user.addEventListener('change', saveMobileDraft);  // technician select

// ============================================================
// MODAL: TREND VIEW
// ============================================================
function openTrendModal(equipId) {
  trendEquipId = equipId;
  const rec = getEffectiveRecords().find(r => r.ID === equipId);
  if (!rec) return;
  trendTitle.textContent    = '📈 Trend View';
  trendSubtitle.textContent = `${rec.BSI_Number||''} — ${rec.Equipment_Type||''}`;
  trendModal.classList.remove('hidden');
  buildTrendChart(rec);
}
function closeTrendModal() {
  trendModal.classList.add('hidden'); trendEquipId = null;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
}
trendClose.addEventListener('click', closeTrendModal);
trendClose2.addEventListener('click', closeTrendModal);
trendModal.addEventListener('click', e => { if (e.target === trendModal) closeTrendModal(); });
trendRange.addEventListener('change', () => {
  const rec = getEffectiveRecords().find(r => r.ID === trendEquipId);
  if (rec) buildTrendChart(rec);
});

function buildTrendChart(rec) {
  const days   = parseInt(trendRange.value, 10);
  const cutoff = days > 0 ? new Date(Date.now() - days * 86400e3) : null;
  const readings = (rec.readings || [])
    .filter(r => !cutoff || new Date(r.Timestamp) >= cutoff)
    .sort((a,b) => new Date(a.Timestamp) - new Date(b.Timestamp));

  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  if (!readings.length) {
    chartContainer.classList.add('hidden'); trendNoData.classList.remove('hidden');
    readingHistoryTable.innerHTML = ''; return;
  }
  chartContainer.classList.remove('hidden'); trendNoData.classList.add('hidden');

  const labels = readings.map(r => formatDateTime(r.Timestamp));
  const datasets = [{
    label: 'Pressure 1 (psi)', data: readings.map(r => r.Pressure_1 ?? null),
    borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,0.08)', tension: 0.3,
    yAxisID: 'yP', pointRadius: 4, fill: true,
  }];
  if (rec.has_two_pressures && readings.some(r => r.Pressure_2 !== null)) {
    datasets.push({ label: 'Pressure 2 (psi)', data: readings.map(r => r.Pressure_2 ?? null),
      borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,0.06)', tension: 0.3, yAxisID: 'yP', pointRadius: 4 });
  }
  if (readings.some(r => r.Flow_In !== null)) {
    datasets.push({ label: 'Flow In (L/min)', data: readings.map(r => r.Flow_In ?? null),
      borderColor: '#2ec77a', backgroundColor: 'rgba(46,199,122,0.06)', tension: 0.3, yAxisID: 'yF', pointRadius: 4 });
  }
  if (readings.some(r => r.Flow_Out !== null)) {
    datasets.push({ label: 'Flow Out (L/min)', data: readings.map(r => r.Flow_Out ?? null),
      borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.06)', tension: 0.3, yAxisID: 'yF', pointRadius: 4 });
  }

  const isDark = !document.body.classList.contains('light-theme');
  const gridCol = isDark ? 'rgba(46,51,84,0.5)' : 'rgba(200,204,220,0.5)';
  const txtCol  = isDark ? '#545c80' : '#7880a0';

  const ctx = document.getElementById('trendChart').getContext('2d');
  chartInstance = new Chart(ctx, { type: 'line', data: { labels, datasets },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: isDark ? '#8890b0' : '#4a5078', font: { family: 'Inter', size: 12 }, boxWidth: 14 } },
        tooltip: { backgroundColor: isDark ? '#1a1d27' : '#fff', borderColor: isDark ? '#2e3354' : '#d0d4e8', borderWidth: 1, titleColor: isDark ? '#e8eaf2' : '#1a1d2e', bodyColor: isDark ? '#8890b0' : '#4a5078' },
      },
      scales: {
        x: { ticks: { color: txtCol, font: { size: 11 }, maxTicksLimit: 10 }, grid: { color: gridCol } },
        yP: { type: 'linear', position: 'left', ticks: { color: '#4f8ef7', font: { size: 11 } }, grid: { color: gridCol }, title: { display: true, text: 'Pressure (psi)', color: '#4f8ef7', font: { size: 11 } } },
        yF: { type: 'linear', position: 'right', ticks: { color: '#2ec77a', font: { size: 11 } }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Flow (L/min)', color: '#2ec77a', font: { size: 11 } } },
      },
    },
  });

  const p2Col = rec.has_two_pressures ? '<th>P2 (psi)</th>' : '';
  const rows  = [...readings].reverse().map(r => `<tr>
    <td>${formatDateTime(r.Timestamp)}</td><td>${esc(r.User||'—')}</td>
    <td>${formatNum(r.Pressure_1)}</td>${rec.has_two_pressures?`<td>${formatNum(r.Pressure_2)}</td>`:''}
    <td>${formatNum(r.Flow_In)}</td><td>${formatNum(r.Flow_Out)}</td>
    <td>${esc(r.Comments||'')}</td></tr>`).join('');

  readingHistoryTable.innerHTML = `<table class="reading-history-table"><thead><tr>
    <th>Timestamp</th><th>Technician</th><th>P1 (psi)</th>${p2Col}<th>Flow In</th><th>Flow Out</th><th>Comments</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

// ============================================================
// MODAL: EQUIPMENT ADD / EDIT
// ============================================================
let addEquipBtn = null;
function openEquipModal(id = null) {
  editingEquipId = id;
  if (!id) {
    equipModalTitle.textContent = '➕ Add Equipment';
    eq_bsi.value = eq_type.value = eq_serial.value = eq_location.value = eq_due.value = '';
    eq_inservice.checked = true; eq_dual.checked = false;
  } else {
    const rec = getEffectiveRecords().find(r => r.ID === id);
    if (!rec) return;
    equipModalTitle.textContent = `✏️ Edit — ${rec.BSI_Number||id}`;
    eq_bsi.value = rec.BSI_Number||''; eq_type.value = rec.Equipment_Type||'';
    eq_serial.value = rec.Serial_Number||''; eq_location.value = rec.Location||'';
    eq_due.value = rec.Due_Date||''; eq_inservice.checked = !!rec.In_Service; eq_dual.checked = !!rec.has_two_pressures;
    eq_has_gas.checked = rec.has_gas !== false; // defaults true
  }
  equipModal.classList.remove('hidden'); eq_bsi.focus();
}
function closeEquipModal() { equipModal.classList.add('hidden'); editingEquipId = null; }
equipModalClose.addEventListener('click', closeEquipModal);
equipModalCancel.addEventListener('click', closeEquipModal);
equipModal.addEventListener('click', e => { if (e.target === equipModal) closeEquipModal(); });
equipModalSave.addEventListener('click', () => {
  const bsi = eq_bsi.value.trim(), type = eq_type.value.trim();
  if (!bsi || !type) return showToast('BSI and Type are required.', 'warning');

  if (!editingEquipId) {
    const rec = { ID: generateId('REC'), BSI_Number: bsi, Equipment_Type: type,
      Serial_Number: eq_serial.value.trim(), Location: eq_location.value.trim(),
      Due_Date: eq_due.value||'', is_active: true, In_Service: eq_inservice.checked,
      has_two_pressures: eq_dual.checked, has_gas: eq_has_gas.checked, 
      last_reading: null, last_modified: new Date().toISOString() };
    pendingChanges[rec.ID] = { ...rec, __fullRecord: true };
  } else {
    if (!pendingChanges[editingEquipId]) pendingChanges[editingEquipId] = {};
    Object.assign(pendingChanges[editingEquipId], {
      BSI_Number: bsi, Equipment_Type: type, Serial_Number: eq_serial.value.trim(),
      Location: eq_location.value.trim(), Due_Date: eq_due.value||'',
      In_Service: eq_inservice.checked, has_two_pressures: eq_dual.checked,
      has_gas: eq_has_gas.checked,
    });
  }
  updateChangeCount(); renderTable(); closeEquipModal();
  showToast(editingEquipId ? 'Updated — Save & Sync to persist.' : 'Added — Save & Sync to persist.', 'success', 3000);
});

// Inject "Add Equipment" button into toolbar
(function() {
  addEquipBtn = document.createElement('button');
  addEquipBtn.id = 'btnAddEquip';
  addEquipBtn.className = 'btn btn-secondary edit-only';
  addEquipBtn.innerHTML = '<span class="btn-icon">➕</span> Add Equipment';
  addEquipBtn.style.display = 'none';
  addEquipBtn.addEventListener('click', () => openEquipModal(null));
  document.querySelector('.toolbar-left')?.appendChild(addEquipBtn);
  editModeToggle.addEventListener('change', () => {
    addEquipBtn.style.display = isEditMode ? '' : 'none';
  });
})();

// ============================================================
// ARCHIVE DIALOG
// ============================================================
function openArchiveDialog(id) {
  archiveEquipId = id;
  const rec = getEffectiveRecords().find(r => r.ID === id);
  archiveMessage.textContent = `Archive "${(rec?.BSI_Number||'') + ' — ' + (rec?.Equipment_Type||id)}"?`;
  archiveDialog.classList.remove('hidden');
}
function closeArchiveDialog() { archiveDialog.classList.add('hidden'); archiveEquipId = null; }
archiveDialogClose.addEventListener('click', closeArchiveDialog);
archiveCancel.addEventListener('click', closeArchiveDialog);
archiveDialog.addEventListener('click', e => { if (e.target === archiveDialog) closeArchiveDialog(); });
archiveConfirm.addEventListener('click', () => { const id = archiveEquipId; closeArchiveDialog(); archiveEquipment(id); });

// ============================================================
// FILTERS
// ============================================================
searchInput.addEventListener('input', e => { filterText = e.target.value; renderTable(); });
filterOverdueEl.addEventListener('change', e => { filterOverdue = e.target.checked; renderTable(); });
filterArchivedEl?.addEventListener('change', e => { filterShowArchived = e.target.checked; renderTable(); });

// ============================================================
// USER MANAGEMENT
// ============================================================
const USERS_KEY = 'routinesSPA_users';
function loadUsers() { try { users = JSON.parse(localStorage.getItem(USERS_KEY)||'[]'); } catch { users=[]; } }
function saveUsers() { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }
function populateUserDropdown() {
  const prev = lr_user.value;
  lr_user.innerHTML = '<option value="">— Select —</option>';
  users.forEach(u => { const o = document.createElement('option'); o.value = o.textContent = u; lr_user.appendChild(o); });
  if (prev && users.includes(prev)) lr_user.value = prev;
}
function renderUserList() {
  userList.innerHTML = '';
  if (!users.length) { userList.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted)">No technicians added.</p>'; return; }
  users.forEach(name => {
    const tag = document.createElement('div'); tag.className = 'user-tag';
    tag.innerHTML = `${esc(name)} <button data-name="${esc(name)}" title="Remove">✕</button>`;
    tag.querySelector('button').addEventListener('click', () => { users = users.filter(u => u !== name); saveUsers(); renderUserList(); populateUserDropdown(); });
    userList.appendChild(tag);
  });
}
function addUser() {
  const name = newUserInput.value.trim(); if (!name) return;
  if (users.includes(name)) { showToast('Already in list.', 'warning'); return; }
  users.push(name); saveUsers(); newUserInput.value = ''; renderUserList(); populateUserDropdown();
}
function openUserModal() { renderUserList(); userModal.classList.remove('hidden'); newUserInput.focus(); }
const closeUserModal = () => userModal.classList.add('hidden');
btnUsers?.addEventListener('click', openUserModal);
userModalClose.addEventListener('click', closeUserModal);
userModalDone.addEventListener('click', closeUserModal);
userModal.addEventListener('click', e => { if (e.target === userModal) closeUserModal(); });
addUserBtn.addEventListener('click', addUser);
newUserInput.addEventListener('keydown', e => { if (e.key === 'Enter') addUser(); });

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!logModal.classList.contains('hidden'))           closeLogModal();
    else if (!trendModal.classList.contains('hidden'))    closeTrendModal();
    else if (!equipModal.classList.contains('hidden'))    closeEquipModal();
    else if (!archiveDialog.classList.contains('hidden')) closeArchiveDialog();
    else if (!userModal.classList.contains('hidden'))     closeUserModal();
  }
  if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); if (!btnSave?.disabled) btnSave?.click(); }
});

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadUsers();
  populateUserDropdown();
  registerSW();
  if (typeof initQRSync === 'function') initQRSync();

  if (!window.showOpenFilePicker) {
    console.info('File System Access API not available (may be file:// or Firefox). Mobile mode only.');
  }
});
