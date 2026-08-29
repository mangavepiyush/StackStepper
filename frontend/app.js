/**
 * app.js — MySQL Engine Visualizer (Modular Architecture)
 * Central Application Orchestration & Event Delegation
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  console.log('[LIVE FRONTEND BUILD]', 'JOIN-FIX-2026-08-02-FINGERPRINT', location.href);

  const HTTP_API_BASE = 'http://127.0.0.1:18080/api';

  // ---------------------------------------------------------
  // 1. CENTRAL APPLICATION STATE
  // ---------------------------------------------------------
  const state = {
    querySummaries: [],
    selectedQuery: null,
    visualizationModel: null,
    domMap: null,
    currentStep: 0,
    playing: false,
    timer: null,
    playbackDelayMs: 350,
    activeTab: 'tableRows',
    renderedTabs: new Set(),
    limitSummary: 100,
    currentDatabase: null
  };

  // ---------------------------------------------------------
  // 2. DOM ELEMENTS
  // ---------------------------------------------------------
  const appLayout = document.getElementById('appLayout');
  const chkShowInternal = document.getElementById('chkShowInternal');
  const txtSearchHistory = document.getElementById('txtSearchHistory');
  const queryHistoryList = document.getElementById('queryHistoryList');
  const btnLoadMoreQueries = document.getElementById('btnLoadMoreQueries');

  const presetSelect = document.getElementById('presetSelect');
  const sqlInput = document.getElementById('sqlInput');
  const btnExecute = document.getElementById('btnExecute');

  const sqSql = document.getElementById('sqSql');
  const sqBadgeThread = document.getElementById('sqBadgeThread');
  const sqBadgeQuery = document.getElementById('sqBadgeQuery');
  const sqBadgeCmd = document.getElementById('sqBadgeCmd');
  const sqBadgeDuration = document.getElementById('sqBadgeDuration');
  const sqBadgeExamined = document.getElementById('sqBadgeExamined');

  const btnReset = document.getElementById('btnReset');
  const btnPrev = document.getElementById('btnPrev');
  const btnPlay = document.getElementById('btnPlay');
  const btnNext = document.getElementById('btnNext');
  const speedBtns = document.querySelectorAll('.speed-btn');
  const btnToggleInspector = document.getElementById('btnToggleInspector');

  const progressFill = document.getElementById('progressFill');
  const stepInfo = document.getElementById('stepInfo');

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = {
    tableRows: document.getElementById('panelTableRows'),
    overview: document.getElementById('panelOverview'),
    timeline: document.getElementById('panelTimeline'),
    executionPlan: document.getElementById('panelExecutionPlan'),
    storage: document.getElementById('panelStorage'),
    concurrency: document.getElementById('panelConcurrency'),
    durability: document.getElementById('panelDurability'),
    result: document.getElementById('panelResult')
  };

  const inspectorElements = {
    title: document.getElementById('inspTitle'),
    seq: document.getElementById('inspSeq'),
    eventType: document.getElementById('inspEventType'),
    elapsedTime: document.getElementById('inspElapsedTime'),
    studentExplanation: document.getElementById('inspStudentExplanation'),
    rawJson: document.getElementById('inspRawJson'),
    progressFill,
    stepInfo
  };

  // ---------------------------------------------------------
  // 3. INITIALIZATION & DATA FETCHING
  // ---------------------------------------------------------
  async function init() {
    setupEventListeners();
    await loadQuerySummaries();
  }

  async function loadQuerySummaries() {
    try {
      const res = await fetch(`${HTTP_API_BASE}/queries`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) return;

      state.querySummaries = data;
      renderSidebarHistory();

      if (!state.selectedQuery && state.querySummaries.length > 0) {
        const userQuery = state.querySummaries.slice().reverse().find(q => isUserQuery(q));
        const target = userQuery || state.querySummaries[state.querySummaries.length - 1];
        await selectQuery(target.threadId, target.queryId);
      }
    } catch (err) {
      queryHistoryList.innerHTML = `<div class="empty-state" style="color: var(--accent-rose)">Failed to load queries: ${err.message}</div>`;
    }
  }

  function isUserQuery(q) {
    if (!q || !q.sql) return false;
    const s = q.sql.trim();
    if (s.startsWith('mysql.') || s.startsWith('SELECT @@') || s.startsWith('select $$') || s.startsWith('SHOW ') || s.startsWith('SET ')) return false;
    return /^(SELECT|INSERT|UPDATE|DELETE|START|COMMIT|ROLLBACK)/i.test(s);
  }

  function deriveCommandType(sql, defaultType) {
    if (defaultType && defaultType !== 'UNKNOWN') return defaultType;
    const s = (sql || '').trim().toUpperCase();
    if (s.startsWith('SELECT')) return 'SELECT';
    if (s.startsWith('INSERT')) return 'INSERT';
    if (s.startsWith('UPDATE')) return 'UPDATE';
    if (s.startsWith('DELETE')) return 'DELETE';
    return 'DML';
  }

  function getCmdClass(cmd) {
    const c = String(cmd || '').toUpperCase();
    if (c.includes('SELECT')) return 'select';
    if (c.includes('INSERT')) return 'insert';
    if (c.includes('UPDATE')) return 'update';
    if (c.includes('DELETE')) return 'delete';
    return 'select';
  }

  // ---------------------------------------------------------
  // 4. SIDEBAR HISTORY RENDERER
  // ---------------------------------------------------------
  function renderSidebarHistory() {
    const searchText = (txtSearchHistory.value || '').trim().toLowerCase();
    
    let filtered = state.querySummaries.filter(q => {
      if (!chkShowInternal.checked && !isUserQuery(q)) return false;
      if (searchText && q.sql && !q.sql.toLowerCase().includes(searchText)) return false;
      return true;
    });

    const displayCount = Math.min(filtered.length, state.limitSummary);
    const displayList = filtered.slice().reverse().slice(0, displayCount);

    if (displayList.length === 0) {
      queryHistoryList.innerHTML = '<div class="empty-state">No matching queries found.</div>';
      btnLoadMoreQueries.classList.add('hidden');
      return;
    }

    queryHistoryList.innerHTML = '';
    displayList.forEach(q => {
      const item = document.createElement('div');
      const isSelected = state.selectedQuery && state.selectedQuery.threadId === q.threadId && state.selectedQuery.queryId === q.queryId;
      item.className = `history-item ${isSelected ? 'active' : ''}`;
      
      const cmdType = deriveCommandType(q.sql, q.commandType);
      const cmdClass = getCmdClass(cmdType);

      item.innerHTML = `
        <div class="history-item-top">
          <span class="cmd-tag ${cmdClass}">${cmdType}</span>
          <span class="history-time">${q.durationUs || 0} µs</span>
        </div>
        <div class="history-sql">${escapeHtml(q.sql)}</div>
        <div class="history-meta">
          <span>Thread: ${q.threadId}</span>
          <span>Examined: ${q.rowsExamined || 0}</span>
        </div>
      `;

      item.addEventListener('click', () => selectQuery(q.threadId, q.queryId));
      queryHistoryList.appendChild(item);
    });

    if (filtered.length > state.limitSummary) {
      btnLoadMoreQueries.classList.remove('hidden');
    } else {
      btnLoadMoreQueries.classList.add('hidden');
    }
  }

  let visualizationGeneration = 0;

  // ---------------------------------------------------------
  // 5. QUERY SELECTION & VISUALIZATION MODEL BUILD
  // ---------------------------------------------------------
  async function selectQuery(threadId, queryId) {
    pause();
    state.currentStep = 0;
    state.renderedTabs.clear();

    const tId = (threadId !== undefined && threadId !== null && !isNaN(threadId)) ? threadId : 0;
    const qId = (queryId !== undefined && queryId !== null && !isNaN(queryId)) ? queryId : 0;

    try {
      const res = await fetch(`${HTTP_API_BASE}/queries/${tId}/${qId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fullQuery = await res.json();
      if (!fullQuery || fullQuery.threadId === undefined) return;

      const tableSnapshots = fullQuery.tableSnapshots || [];
      const primarySnapshot = fullQuery.tableSnapshot || tableSnapshots[0] || null;

      visualizationGeneration++;
      console.log(`[MODEL CREATED generation=${visualizationGeneration}] via selectQuery(${tId}, ${qId})`);

      state.selectedQuery = fullQuery;
      state.visualizationModel = window.VisualizationModelModule.buildVisualizationModel(fullQuery, primarySnapshot, tableSnapshots);

      console.log('[LIVE MODEL]', {
        generation: visualizationGeneration,
        tableCount: state.visualizationModel?.tables?.length,
        stepCount: state.visualizationModel?.steps?.length,
        finalCounters: state.visualizationModel?.steps?.at(-1)?.counters,
        perTableCounters: state.visualizationModel?.steps?.at(-1)?.perTableCounters
      });

      renderSelectedHeader(fullQuery);
      renderSidebarHistory();

      // Render static DOM for active tab ONCE
      switchTab(state.activeTab || 'tableRows');
    } catch (err) {
      console.error('Failed to select query:', err);
    }
  }

  function renderSelectedHeader(q) {
    sqSql.textContent = q.sql || 'N/A';
    sqBadgeThread.textContent = `Thread: ${q.threadId}`;
    sqBadgeQuery.textContent = `Query: ${q.queryId}`;
    sqBadgeCmd.textContent = deriveCommandType(q.sql, q.commandType);
    sqBadgeDuration.textContent = `${q.durationUs || 0} µs (${((q.durationUs || 0) / 1000).toFixed(2)} ms)`;
    sqBadgeExamined.textContent = `Examined: ${q.rowsExamined || 0}`;
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    tabBtns.forEach(btn => {
      if (btn.dataset.tab === tabName) btn.classList.add('active');
      else btn.classList.remove('active');
    });

    Object.keys(tabPanels).forEach(key => {
      if (tabPanels[key]) {
        if (key === tabName) tabPanels[key].classList.add('active');
        else tabPanels[key].classList.remove('active');
      }
    });

    if (state.visualizationModel) {
      if (!state.renderedTabs.has(tabName)) {
        state.renderedTabs.add(tabName);
        const panelContainer = tabPanels[tabName];
        const vis = window.VisualizationModule;

        if (tabName === 'tableRows') {
          state.domMap = vis.renderTableTab(panelContainer, state.visualizationModel);
        } else if (tabName === 'executionPlan') {
          vis.renderExecutionPlanTab(panelContainer, state.visualizationModel);
        } else if (tabName === 'storage') {
          vis.renderStorageTab(panelContainer, state.visualizationModel);
        } else if (tabName === 'concurrency') {
          vis.renderConcurrencyTab(panelContainer, state.visualizationModel);
        } else if (tabName === 'durability') {
          vis.renderDurabilityTab(panelContainer, state.visualizationModel);
        } else if (tabName === 'result') {
          vis.renderResultTab(panelContainer, state.visualizationModel);
        }
      }

      // Apply current playback step to DOM elements
      window.PlaybackModule.applyStep(state.currentStep, state.visualizationModel, state.domMap, inspectorElements);
    }
  }

  // ---------------------------------------------------------
  // 6. PLAYBACK CONTROLS
  // ---------------------------------------------------------
  function activateStep(idx) {
    if (!state.visualizationModel || !state.visualizationModel.steps) return;
    const maxSteps = state.visualizationModel.steps.length;
    state.currentStep = Math.max(0, Math.min(idx, maxSteps - 1));
    window.PlaybackModule.applyStep(state.currentStep, state.visualizationModel, state.domMap, inspectorElements);
  }

  function playNextStep() {
    if (!state.visualizationModel || !state.visualizationModel.steps) {
      pause();
      return;
    }
    if (state.currentStep >= state.visualizationModel.steps.length - 1) {
      pause();
      return;
    }
    activateStep(state.currentStep + 1);
  }

  function playPrevStep() {
    if (state.currentStep > 0) {
      activateStep(state.currentStep - 1);
    }
  }

  function play() {
    if (state.timer) return;
    state.playing = true;
    btnPlay.textContent = '⏸ Pause';
    if (state.visualizationModel && state.currentStep >= state.visualizationModel.steps.length - 1) {
      state.currentStep = 0;
    }
    playNextStep();
    state.timer = setInterval(playNextStep, state.playbackDelayMs);
  }

  function pause() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.playing = false;
    btnPlay.textContent = '▶ Play';
  }

  function resetPlayback() {
    pause();
    activateStep(0);
  }

  // ---------------------------------------------------------
  // 7. SQL QUERY RUNNER
  // ---------------------------------------------------------
  async function executeSQL() {
    const sql = sqlInput.value.trim();
    if (!sql) return;

    btnExecute.disabled = true;
    btnExecute.textContent = '⏳ Running...';

    // Clear previous state on every Execute click
    pause();
    state.selectedQuery = null;
    state.visualizationModel = null;
    state.domMap = null;
    state.currentStep = 0;
    state.renderedTabs.clear();

    console.log('[VIS] [1] Execute button entered');

    try {
      console.log('[VIS] [2] POST /api/execute sent');
      const reqPayload = { sql };
      if (state.currentDatabase) {
        reqPayload.database = state.currentDatabase;
      }
      const res = await fetch(`${HTTP_API_BASE}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqPayload)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || errJson.error || `HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || data.error || 'Execution failed');
      }

      // Update active database state upon successful query execution
      if (data.currentDatabase || data.database) {
        state.currentDatabase = data.currentDatabase || data.database;
      } else {
        const useMatch = sql.trim().match(/^USE\s+`?([a-zA-Z0-9_]+)`?/i);
        if (useMatch) {
          state.currentDatabase = useMatch[1];
        }
      }

      if (data.visualizationAvailable === false || data.telemetryAvailable === false || !data.query) {
        sqSql.textContent = data.sql || sql;
        sqBadgeThread.textContent = `Thread: ${data.threadId || 'N/A'}`;
        sqBadgeQuery.textContent = `Query: ${data.queryId || 'N/A'}`;
        sqBadgeCmd.textContent = data.commandType || 'USE';
        sqBadgeDuration.textContent = 'Session Command';
        sqBadgeExamined.textContent = 'Examined: 0';

        tabPanels.tableRows.innerHTML = `
          <div class="table-execution-container" style="padding: 1.5rem; text-align: center;">
            <div style="color: var(--accent-cyan); font-size: 1.1rem; font-weight: 700;">Command Executed Successfully ✓</div>
            <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.5rem;">
              Session / Utility command (${escapeHtml(data.commandType || 'USE')}) executed cleanly.
            </div>
          </div>
        `;
        loadQuerySummaries().catch(() => {});
        return;
      }

      console.log('[LIVE EXECUTE RESPONSE]', {
        sql: data.query ? data.query.sql : data.sql,
        threadId: data.threadId,
        queryId: data.queryId,
        eventCount: data.query?.events?.length || 0,
        rowsExamined: data.query?.rowsExamined,
        tableSnapshots: data.tableSnapshots?.map(s => ({
          table: s.table,
          alias: s.alias,
          rows: s.rows?.length
        }))
      });

      visualizationGeneration++;
      console.log(`[MODEL CREATED generation=${visualizationGeneration}] via executeSQL()`);

      state.selectedQuery = data.query;
      state.visualizationModel = window.VisualizationModelModule.buildVisualizationModel(data.query, data.tableSnapshot, data.tableSnapshots);

      console.log('[LIVE MODEL]', {
        generation: visualizationGeneration,
        tableCount: state.visualizationModel?.tables?.length,
        stepCount: state.visualizationModel?.steps?.length,
        finalCounters: state.visualizationModel?.steps?.at(-1)?.counters,
        perTableCounters: state.visualizationModel?.steps?.at(-1)?.perTableCounters
      });

      console.log(`[N-TABLE DEBUG 6] frontend visualization model tables: count = ${state.visualizationModel && state.visualizationModel.tables ? state.visualizationModel.tables.length : 0}`, state.visualizationModel ? state.visualizationModel.tables.map(t => t.key) : []);

      console.log('[TABLE COUNT] bundle snapshot', data.tableSnapshot);
      console.log('[TABLE COUNT] snapshot rows', data.tableSnapshot?.rows?.length);
      console.log('[TABLE COUNT] model tableRows', state.visualizationModel?.tableRows);

      const stepCount = state.visualizationModel ? state.visualizationModel.steps.length : 0;
      console.log(`[VIS] [11] Visualization model built: ${stepCount} steps`);

      renderSelectedHeader(data.query);
      switchTab('tableRows');

      const domRowCount = state.domMap && state.domMap.rowElements ? state.domMap.rowElements.size : 0;
      console.log(`[VIS] [12] Table DOM populated: ${domRowCount} rows`);

      const fetchStepCount = state.visualizationModel && state.visualizationModel.steps ? state.visualizationModel.steps.filter(s => s.type === 'ROW_CURRENT').length : 0;
      console.log(`[VIS] [13] ROW_FETCH playback steps: ${fetchStepCount}`);

      // Refresh sidebar history in background without affecting selection
      loadQuerySummaries().catch(() => {});

    } catch (err) {
      console.error('[VIS] Execution Error:', err);
      sqSql.innerHTML = `
        <div style="color: var(--accent-rose); font-weight: 700;">VISUALIZATION ERROR</div>
        <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0.25rem;">${escapeHtml(err.message)}</div>
      `;
    } finally {
      btnExecute.disabled = false;
      btnExecute.textContent = '⚡ Execute Query';
    }
  }

  // ---------------------------------------------------------
  // 8. EVENT LISTENERS
  // ---------------------------------------------------------
  function setupEventListeners() {
    chkShowInternal.addEventListener('change', () => {
      renderSidebarHistory();
      if (state.selectedQuery) {
        selectQuery(state.selectedQuery.threadId, state.selectedQuery.queryId);
      }
    });

    txtSearchHistory.addEventListener('input', () => renderSidebarHistory());

    btnLoadMoreQueries.addEventListener('click', () => {
      state.limitSummary += 100;
      renderSidebarHistory();
    });

    presetSelect.addEventListener('change', () => {
      if (presetSelect.value) sqlInput.value = presetSelect.value;
    });

    btnExecute.addEventListener('click', executeSQL);

    sqlInput.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        executeSQL();
      }
    });

    btnPlay.addEventListener('click', () => {
      if (state.playing) pause();
      else play();
    });

    btnPrev.addEventListener('click', () => {
      pause();
      playPrevStep();
    });

    btnNext.addEventListener('click', () => {
      pause();
      playNextStep();
    });

    btnReset.addEventListener('click', resetPlayback);

    speedBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        speedBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.playbackDelayMs = parseInt(btn.dataset.speed, 10);
        if (state.playing && state.timer) {
          clearInterval(state.timer);
          state.timer = setInterval(playNextStep, state.playbackDelayMs);
        }
      });
    });

    btnToggleInspector.addEventListener('click', () => {
      appLayout.classList.toggle('collapsed-inspector');
    });

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Start Engine Visualizer
  init();
});
