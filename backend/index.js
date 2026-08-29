const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const { TraceReader, QueryReconstructor, TransactionReconstructor, WaitForGraphReconstructor, RawTraceEvent, QueryTrace } = require('./trace_parser');

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
const CONFIG = {
  TCP_PORT: process.env.QUERY_TRACER_TCP_PORT ? parseInt(process.env.QUERY_TRACER_TCP_PORT) : 19999,
  TCP_HOST: process.env.QUERY_TRACER_TCP_HOST || '127.0.0.1',
  HTTP_PORT: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : 18080,
  MYSQL_HOST: process.env.MYSQL_HOST || '127.0.0.1',
  MYSQL_PORT: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT) : 3307,
  MYSQL_USER: process.env.MYSQL_USER || 'root',
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || null,
  MAX_BUFFER_EVENTS: 1000,
  SESSION_RETENTION_MS: 10 * 60 * 1000 // 10 minutes
};

// Portable layout: backend/index.js is exactly one level below the project root.
// PROJECT_ROOT = StackStepper_Portable/
const PROJECT_ROOT = path.resolve(__dirname, '..');

const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const PRIMARY_TRACE_FILE = path.join(PROJECT_ROOT, 'mysql', 'data_runtime', 'query_trace.jsonl');

function getTraceFilePath() {
  if (process.env.TRACE_FILE) return process.env.TRACE_FILE;
  
  const mysqlDataDir = path.join(PROJECT_ROOT, 'mysql-data');
  const candidates = [
    path.join(PROJECT_ROOT, 'mysql', 'data_runtime', 'query_trace.jsonl'),
    path.join(PROJECT_ROOT, 'mysql', 'data', 'query_trace.jsonl'),
    path.join(mysqlDataDir, 'query_trace.jsonl')
  ];

  if (fs.existsSync(mysqlDataDir)) {
    try {
      const errFiles = fs.readdirSync(mysqlDataDir).filter(f => f.endsWith('.err'));
      for (const ef of errFiles) {
        candidates.unshift(path.join(mysqlDataDir, ef));
      }
    } catch (e) {}
  }

  let bestFile = PRIMARY_TRACE_FILE;
  let maxMtime = 0;

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const stats = fs.statSync(file);
        if (stats.size > 0 && stats.mtimeMs > maxMtime) {
          maxMtime = stats.mtimeMs;
          bestFile = file;
        }
      } catch (e) {}
    }
  }

  return bestFile;
}

const TRACE_FILE = PRIMARY_TRACE_FILE;

// Ensure trace log file directory exists
const traceDir = path.dirname(PRIMARY_TRACE_FILE);
if (!fs.existsSync(traceDir)) {
  fs.mkdirSync(traceDir, { recursive: true });
}
if (!fs.existsSync(PRIMARY_TRACE_FILE)) {
  fs.writeFileSync(PRIMARY_TRACE_FILE, '', 'utf8');
}

// ---------------------------------------------------------
// EXECUTION SESSION CLASS & CORRELATION STATE
// ---------------------------------------------------------

// Maps execution_id -> ExecutionSession
const executionSessions = new Map();
// Maps mysql_thread_id -> execution_id
const threadToExecutionMap = new Map();

class ExecutionSession {
  constructor(executionId, threadId, sql) {
    this.executionId = executionId;
    this.threadId = threadId;
    this.queryId = null;
    this.sql = sql;
    this.status = 'CREATED'; // CREATED, RUNNING, COMPLETED, FAILED
    this.createdAt = Date.now();
    this.eventBuffer = [];
    this.expectedSeq = 0;
    this.subscribers = new Set();
    this.result = null;
    this.error = null;
  }

  addEvent(event) {
    // Check for sequence ordering anomalies
    if (event.seq !== this.expectedSeq) {
      if (event.seq < this.expectedSeq) {
        console.warn(`[Gateway Warning] Duplicate/out-of-order seq ${event.seq} for execution ${this.executionId} (expected ${this.expectedSeq})`);
      } else {
        console.warn(`[Gateway Warning] Missing seq detected for execution ${this.executionId} (got ${event.seq}, expected ${this.expectedSeq})`);
      }
    }
    this.expectedSeq = event.seq + 1;

    // Buffer event with bounded capacity
    if (this.eventBuffer.length < CONFIG.MAX_BUFFER_EVENTS) {
      this.eventBuffer.push(event);
    }

    // Terminal state handling based on COMMAND_END
    if (event.event_type === 'COMMAND_END') {
      if (event.details && event.details.error !== 0) {
        this.status = 'FAILED';
      } else {
        this.status = 'COMPLETED';
      }
    } else if (this.status === 'CREATED') {
      this.status = 'RUNNING';
    }

    // Real-time broadcast to subscribers
    const payload = JSON.stringify({
      execution_id: this.executionId,
      event: event,
      status: this.status
    });

    for (const ws of this.subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  addSubscriber(ws) {
    this.subscribers.add(ws);
    // Replay already-received events in strictly increasing seq order
    for (const event of this.eventBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          execution_id: this.executionId,
          event: event,
          status: this.status,
          replayed: true
        }));
      }
    }
  }

  removeSubscriber(ws) {
    this.subscribers.delete(ws);
  }
}

// ---------------------------------------------------------
// FILE I/O HELPERS
// ---------------------------------------------------------
function getEventsFromFile() {
  try {
    const tracePath = getTraceFilePath();
    if (!fs.existsSync(tracePath)) return [];
    const content = fs.readFileSync(tracePath, 'utf8');
    const lines = content.split('\n');
    const events = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (!line.startsWith('[QueryTracer]')) continue;
      line = line.substring(13).trim();
      try {
        events.push(JSON.parse(line));
      } catch (e) {}
    }
    return events;
  } catch (err) {
    console.error('[Gateway] Error reading trace file:', err.message);
    return [];
  }
}

function saveEventToFile(jsonString) {
  try {
    const tracePath = getTraceFilePath();
    fs.appendFileSync(tracePath, jsonString + '\n', 'utf8');
  } catch (err) {
    console.error('[Gateway] Error saving event to file:', err.message);
  }
}

// Set of processed (thread_id, query_id, seq) signatures to prevent duplicates
const processedEvents = new Set();

function handleIncomingTelemetryEvent(event, saveToFile = true) {
  const eventSig = `${event.thread_id}_${event.query_id}_${event.seq}`;
  if (processedEvents.has(eventSig)) return;
  processedEvents.add(eventSig);

  // Keep set bounded
  if (processedEvents.size > 10000) {
    const firstKey = processedEvents.keys().next().value;
    processedEvents.delete(firstKey);
  }

  if (saveToFile) {
    saveEventToFile(JSON.stringify(event));
  }

  const tId = event.thread_id !== undefined ? event.thread_id : event.threadId;
  const qId = event.query_id !== undefined ? event.query_id : event.queryId;

  // Correlate to active execution sessions (by thread_id or active RUNNING state)
  for (const session of executionSessions.values()) {
    if (session.status === 'RUNNING' || session.status === 'INITIAL' || Number(session.threadId) === Number(tId)) {
      if (session.queryId === null && qId !== undefined) {
        session.queryId = qId;
        console.log(`[Gateway Correlator] Bound execution ${session.executionId} to thread_id=${tId}, query_id=${qId}`);
      }
      session.addEvent(event);
    }
  }
}

// Tail query_trace.jsonl to process events as they are written by mysqld
let filePosition = 0;
function watchTraceFile() {
  try {
    const tracePath = getTraceFilePath();
    if (!fs.existsSync(tracePath)) return;
    const stats = fs.statSync(tracePath);
    if (filePosition === 0) {
      // Start reading from current end of file for new executions
      filePosition = stats.size;
      return;
    }
    if (stats.size > filePosition) {
      const stream = fs.createReadStream(tracePath, {
        start: filePosition,
        end: stats.size,
        encoding: 'utf8'
      });

      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            try {
              const event = JSON.parse(trimmed);
              handleIncomingTelemetryEvent(event, false);
            } catch (e) {}
          }
        }
      });

      stream.on('end', () => {
        filePosition = stats.size;
      });
    }
  } catch (err) {
    console.error('[Gateway File Watcher Error]', err.message);
  }
}

// ---------------------------------------------------------
// QUERY CACHE & RECONSTRUCTION LAYER
// ---------------------------------------------------------
let queryCache = { mtime: 0, queries: null, transactions: null, lockWaitGraph: null };

function getReconstructedData() {
  try {
    const tracePath = getTraceFilePath();
    if (!fs.existsSync(tracePath)) {
      return { queries: [], transactions: [], lockWaitGraph: { edges: [], cycles: [] } };
    }
    const stat = fs.statSync(tracePath);
    if (queryCache.queries && queryCache.mtime === stat.mtimeMs) {
      return queryCache;
    }
    const rawEvents = TraceReader.readFromFile(tracePath);
    const queries = QueryReconstructor.reconstructQueries(rawEvents);
    const transactions = TransactionReconstructor.reconstructTransactions(queries);
    const edges = WaitForGraphReconstructor.extractEdges(queries);
    const cycles = WaitForGraphReconstructor.detectCycles(edges);

    queryCache = {
      mtime: stat.mtimeMs,
      queries,
      transactions,
      lockWaitGraph: { edges, cycles }
    };
    return queryCache;
  } catch (err) {
    console.error('[Gateway] Cache reconstruction error:', err.message);
    return { queries: [], transactions: [], lockWaitGraph: { edges: [], cycles: [] } };
  }
}

function extractTableReferences(sql) {
  if (!sql) return [];
  const regex = /\b(?:FROM|JOIN)\s+`?([a-zA-Z0-9_]+)`?(?:\s+(?:AS\s+)?`?([a-zA-Z0-9_]+)`?)?/gi;
  const reserved = new Set([
    'WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'JOIN',
    'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'SELECT', 'SET', 'AS', 'AND', 'OR', 'UNION', 'ALL'
  ]);

  const refs = [];
  let match;
  while ((match = regex.exec(sql)) !== null) {
    const tblName = match[1];
    let aliasName = match[2];

    if (!tblName || reserved.has(tblName.toUpperCase())) continue;

    if (!aliasName || reserved.has(aliasName.toUpperCase())) {
      aliasName = tblName;
    }

    refs.push({ table: tblName, alias: aliasName });
  }

  return refs;
}

function extractTableNames(sql) {
  const refs = extractTableReferences(sql);
  const set = new Set(refs.map(r => r.table));
  return Array.from(set);
}

async function fetchTableSnapshot(database, table, alias) {
  const sanitizedTable = String(table || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!sanitizedTable) return null;
  const db = database || CONFIG.MYSQL_DATABASE || undefined;

  // Dedicated isolated connection for snapshot
  const connConfig = {
    host: CONFIG.MYSQL_HOST,
    port: CONFIG.MYSQL_PORT,
    user: CONFIG.MYSQL_USER,
    password: CONFIG.MYSQL_PASSWORD,
    multipleStatements: false
  };
  if (db) {
    connConfig.database = db;
  }

  const snapConn = await mysql.createConnection(connConfig);

  try {
    const [rows, fields] = await snapConn.query(`SELECT * FROM \`${sanitizedTable}\` /* TABLE_SNAPSHOT */ LIMIT 100`);
    const columns = fields ? fields.map(f => f.name) : (Array.isArray(rows) && rows.length > 0 ? Object.keys(rows[0]) : ['id', 'name']);
    return {
      schema: db || 'default',
      table: sanitizedTable,
      alias: alias || sanitizedTable,
      columns,
      rows: Array.isArray(rows) ? rows : []
    };
  } finally {
    await snapConn.end().catch(() => {});
  }
}

async function fetchTableSnapshots(database, sql) {
  const tableRefs = extractTableReferences(sql);
  console.log(`[N-TABLE DEBUG 1] parsed logical inputs: count = ${tableRefs.length}`, JSON.stringify(tableRefs));
  console.log(`[N-TABLE DEBUG 2] requested snapshots for ${tableRefs.length} table(s)`);

  const snapshots = [];
  for (const ref of tableRefs) {
    try {
      const snap = await fetchTableSnapshot(database, ref.table, ref.alias);
      if (snap) snapshots.push(snap);
    } catch (e) {
      console.warn(`[Gateway Snapshot] Warning: Could not fetch snapshot for table '${ref.table}' (alias '${ref.alias}'):`, e.message);
    }
  }

  console.log(`[N-TABLE DEBUG 3] snapshot results: count = ${snapshots.length}`, snapshots.map(s => `table: ${s.table}, alias: ${s.alias}, cols: [${s.columns.join(',')}], rows: ${s.rows.length}`));
  return snapshots;
}

// ---------------------------------------------------------
// HTTP SERVER & REST API LAYER
// ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoint: Health Check (GET /api/health)
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mysqlPort: CONFIG.MYSQL_PORT, tcpPort: CONFIG.TCP_PORT }));
    return;
  }

  // API Endpoint: Get Real Table Snapshot (GET /api/table-snapshot)
  if (req.method === 'GET' && req.url.startsWith('/api/table-snapshot')) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const table = parsedUrl.searchParams.get('table') || 'student';
    const database = parsedUrl.searchParams.get('database') || CONFIG.MYSQL_DATABASE;
    try {
      const snapshot = await fetchTableSnapshot(database, table);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API Endpoint: Unified Execute SQL Query & Return Telemetry + Snapshot (POST /api/execute or POST /api/query)
  if (req.method === 'POST' && (req.url === '/api/execute' || req.url === '/api/query')) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const sql = payload.sql;
        let database = payload.database || CONFIG.MYSQL_DATABASE || undefined;

        if (!sql || typeof sql !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'SQL string parameter is required' }));
          return;
        }

        console.log(`[Gateway API] [3] Backend received SQL: "${sql}"`);

        const cleanSqlUpper = sql.trim().toUpperCase();
        const isSessionCmd = /^(USE|SET|SHOW|CREATE|DROP|ALTER|INSERT|UPDATE|DELETE)\b/i.test(cleanSqlUpper) || /^SELECT\s+@@/i.test(cleanSqlUpper);

        // Step A: Fetch real table snapshots via dedicated snapshot connection (skip for session commands)
        let tableSnapshots = [];
        let tableSnapshot = null;
        if (!isSessionCmd) {
          try {
            tableSnapshots = await fetchTableSnapshots(database, sql);
            tableSnapshot = tableSnapshots[0] || null;
            const totalRows = tableSnapshots.reduce((sum, s) => sum + s.rows.length, 0);
            console.log(`[Gateway API] [4] Snapshots captured: ${tableSnapshots.length} table(s), ${totalRows} total rows`);
          } catch (snapErr) {
            console.error('[Gateway API] Snapshot fetch error:', snapErr.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              error: `TABLE SNAPSHOT FAILED: ${snapErr.message}`
            }));
            return;
          }
        }

        // Step B: Open User Execution Connection & obtain thread ID
        const userConnConfig = {
          host: CONFIG.MYSQL_HOST,
          port: CONFIG.MYSQL_PORT,
          user: CONFIG.MYSQL_USER,
          password: CONFIG.MYSQL_PASSWORD,
          multipleStatements: false
        };
        if (database) {
          userConnConfig.database = database;
        }

        const userConn = await mysql.createConnection(userConnConfig);

        const threadId = userConn.threadId;
        console.log(`[Gateway API] [5] User MySQL threadId = ${threadId}`);

        // Step C: Record baseline event file count BEFORE execution
        const baselineCount = getEventsFromFile().length;
        console.log(`[Gateway API] [6] Baseline event line count = ${baselineCount} for thread ${threadId}`);

        const executionId = 'exec_' + crypto.randomBytes(8).toString('hex');
        const session = new ExecutionSession(executionId, threadId, sql);
        executionSessions.set(executionId, session);
        threadToExecutionMap.set(threadId, executionId);
        threadToExecutionMap.set(String(threadId), executionId);
        threadToExecutionMap.set(Number(threadId), executionId);

        // Step D: Execute User SQL Query
        let queryErr = null;
        let activeDb = database || null;
        try {
          const [rows, fields] = await userConn.query(sql);
          session.result = {
            columns: fields ? fields.map(f => f.name) : [],
            rows: Array.isArray(rows) ? rows : [],
            affectedRows: rows.affectedRows !== undefined ? rows.affectedRows : null
          };
          session.status = 'COMPLETED';
          console.log(`[Gateway API] [7] SQL execution completed`);

          const useMatch = sql.trim().match(/^USE\s+`?([a-zA-Z0-9_]+)`?/i);
          if (useMatch) {
            activeDb = useMatch[1];
          }
        } catch (err) {
          console.error(`[Gateway Query Execution Error] ${err.message}`);
          session.error = err;
          session.status = 'FAILED';
          queryErr = err;
        } finally {
          await userConn.end().catch(() => {});
          setTimeout(() => {
            threadToExecutionMap.delete(threadId);
            threadToExecutionMap.delete(String(threadId));
            threadToExecutionMap.delete(Number(threadId));
          }, 3000);
        }

        if (queryErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: queryErr.message,
            threadId,
            stage: 'SQL_EXECUTION'
          }));
          return;
        }

        // Fast-path response for session/utility commands (e.g. USE, SET, SHOW)
        if (isSessionCmd) {
          const firstWord = (sql.trim().split(/\s+/)[0] || 'USE').toUpperCase();
          console.log(`[Gateway API] Session command '${firstWord}' executed successfully without telemetry visualization trace.`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            executionId,
            threadId,
            queryId: null,
            commandType: firstWord,
            telemetryAvailable: false,
            visualizationAvailable: false,
            sql,
            database: activeDb,
            currentDatabase: activeDb,
            result: session.result
          }));
          return;
        }

        // Step E: Polling for fresh events appended after baselineCount
        let correlatedQuery = null;
        let observedNewQueryId = -1;
        const startTime = Date.now();
        const timeoutMs = 6000;
        const pollIntervalMs = 30;

        let lastEventCount = 0;
        let stableCountHits = 0;

        while (Date.now() - startTime < timeoutMs) {
          // Check TCP in-memory session buffer first for zero-latency correlation
          let userEvents = session.eventBuffer.filter(e => Number(e.thread_id || e.threadId || e.mysql_thread_id) === Number(threadId));
          
          // Fallback to query_trace.jsonl file events
          const allEvents = getEventsFromFile();
          const newEvents = allEvents.slice(baselineCount);
          if (userEvents.length === 0) {
            userEvents = newEvents.filter(e => Number(e.thread_id || e.threadId || e.mysql_thread_id) === Number(threadId));
          }
          if (userEvents.length === 0 && session.eventBuffer.length > 0) {
            userEvents = session.eventBuffer;
          }
          if (userEvents.length === 0 && newEvents.length > 0) {
            // Fallback to all new events appended during execution window
            userEvents = newEvents;
          }

          if (userEvents.length > 0) {
            let rawEvs = userEvents.map(e => new RawTraceEvent(e)).filter(e => e.isUserData);
            const normSql = (str) => String(str || '').replace(/;\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const targetSqlNorm = normSql(sql);
            const matchingStartIdx = rawEvs.findLastIndex(e => e.eventType === 'COMMAND_START' && e.details && e.details.query && normSql(e.details.query) === targetSqlNorm);
            if (matchingStartIdx !== -1) {
              rawEvs = rawEvs.slice(matchingStartIdx);
            } else {
              const userCmdIdx = rawEvs.findLastIndex(e => e.eventType === 'COMMAND_START' && e.details && e.details.query && !String(e.details.query).includes('/* TABLE_SNAPSHOT */'));
              if (userCmdIdx !== -1) {
                rawEvs = rawEvs.slice(userCmdIdx);
              }
            }
            if (rawEvs.length > 0) {
              const unifiedQuery = new QueryTrace(threadId, rawEvs[0].queryId || 1);
              unifiedQuery.events = rawEvs;
              unifiedQuery.sql = sql;
              correlatedQuery = unifiedQuery;
              observedNewQueryId = rawEvs[0].queryId || 1;
            }

            const hasResultSent = rawEvs.some(e => e.eventType === 'RESULT_SENT');
            const hasJoinMatch = rawEvs.some(e => e.eventType === 'JOIN_MATCH');

            if (userEvents.length === lastEventCount) {
              stableCountHits++;
            } else {
              stableCountHits = 0;
              lastEventCount = userEvents.length;
            }

            if (correlatedQuery && (((hasResultSent || hasJoinMatch) && stableCountHits >= 5) || stableCountHits >= 25)) {
              console.log(`[Gateway API] [9] Correlated query (${threadId}, Q#${correlatedQuery.queryId}) - ${correlatedQuery.events.length} events (total user events: ${userEvents.length}, hasResultSent: ${hasResultSent})`);
              break;
            }
          }

          await new Promise(r => setTimeout(r, pollIntervalMs));
        }

        if (!correlatedQuery) {
          console.error(`[Gateway API] Telemetry correlation timed out after ${Date.now() - startTime}ms`);
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'TRACE CORRELATION FAILED',
            message: `TRACE CORRELATION FAILED: SQL execution SUCCESS. MySQL thread ID: ${threadId}. Telemetry query ID: ${observedNewQueryId !== -1 ? observedNewQueryId : 'unresolved'}. Waited: ${Date.now() - startTime}ms`,
            threadId,
            baselineCount,
            observedQueryId: observedNewQueryId,
            waitedMs: Date.now() - startTime
          }));
          return;
        }

        console.log(`[Gateway API] [6] QueryTracer queryId = ${correlatedQuery.queryId}`);
        console.log(`[Gateway API] [7] Trace found: ${correlatedQuery.events ? correlatedQuery.events.length : 0} events`);

        if (!correlatedQuery.sql) {
          correlatedQuery.sql = sql;
        }
        if (!correlatedQuery.commandType || correlatedQuery.commandType === 'UNKNOWN') {
          const firstWord = (sql.trim().split(/\s+/)[0] || 'SELECT').toUpperCase();
          correlatedQuery.commandType = firstWord;
        }

        // Step F: Return Unified Execution Bundle
        console.log(`[N-TABLE DEBUG 4] POST /api/execute tableSnapshots: count = ${tableSnapshots ? tableSnapshots.length : 0}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          executionId,
          threadId: correlatedQuery.threadId,
          queryId: correlatedQuery.queryId,
          maxGlobalQueryId: correlatedQuery.queryId,
          sql,
          database: activeDb,
          currentDatabase: activeDb,
          tableSnapshot,
          tableSnapshots,
          query: correlatedQuery,
          result: session.result
        }));
      } catch (err) {
        console.error('[Gateway API Error]', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }
    });
    return;
  }

  // API Endpoint: Get Execution Details & Result (GET /api/executions/:id)
  if (req.method === 'GET' && req.url.startsWith('/api/executions/')) {
    const execId = req.url.split('/api/executions/')[1];
    const session = executionSessions.get(execId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Execution session not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      execution_id: session.executionId,
      thread_id: session.threadId,
      query_id: session.queryId,
      sql: session.sql,
      status: session.status,
      event_count: session.eventBuffer.length,
      events: session.eventBuffer,
      result: session.result,
      error: session.error
    }));
    return;
  }

  // API Endpoint: Returns raw trace events from file (GET /api/events)
  if (req.method === 'GET' && req.url === '/api/events') {
    const events = getEventsFromFile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
    return;
  }



  // API Endpoint: Returns query summaries (GET /api/queries or GET /api/reconstructed/queries/summary)
  if (req.method === 'GET' && (req.url.startsWith('/api/queries') || req.url.startsWith('/api/reconstructed/queries/summary'))) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const showInternal = parsedUrl.searchParams.get('showInternal') === 'true';
    const data = getReconstructedData();
    let queriesList = data.queries || [];
    if (!showInternal) {
      queriesList = queriesList.filter(q => {
        const s = (q.sql || '').toUpperCase();
        return !s.includes('TABLE_SNAPSHOT') && !s.includes('CONNECTION_ID()') && !s.includes('INFORMATION_SCHEMA') && !s.includes('SHOW TABLES');
      });
    }
    const summary = queriesList.map(q => ({
      threadId: q.threadId,
      queryId: q.queryId,
      sql: q.sql,
      commandType: q.commandType,
      startTimeUs: q.startTimeUs,
      durationUs: q.durationUs,
      tables: q.tables,
      indexes: q.indexes,
      rowsExamined: q.rowsExamined,
      rowsAffected: q.rowsAffected,
      hasError: q.hasError,
      status: q.hasError ? 'FAILED' : 'SUCCESS',
      eventCount: q.events ? q.events.length : 0,
      userEventsCount: q.userEvents ? q.userEvents.length : 0
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  // API Endpoint: Returns single query detail (GET /api/queries/:threadId/:queryId or /api/reconstructed/queries/single)
  if (req.method === 'GET' && (req.url.startsWith('/api/queries/') || req.url.startsWith('/api/reconstructed/queries/single'))) {
    const data = getReconstructedData();
    let threadId = NaN;
    let queryId = NaN;

    if (req.url.startsWith('/api/queries/')) {
      const parts = req.url.replace('/api/queries/', '').split('/');
      threadId = parseInt(parts[0], 10);
      queryId = parseInt(parts[1], 10);
    } else {
      const parsedUrl = new URL(req.url, 'http://localhost');
      threadId = parseInt(parsedUrl.searchParams.get('threadId'), 10);
      queryId = parseInt(parsedUrl.searchParams.get('queryId'), 10);
    }

    let match = null;
    if (!isNaN(threadId)) {
      if (!isNaN(queryId)) {
        match = (data.queries || []).slice().reverse().find(q => q.threadId === threadId && q.queryId === queryId);
      }
      if (!match) {
        match = (data.queries || []).slice().reverse().find(q => q.threadId === threadId);
      }
    }
    if (!match && data.queries && data.queries.length > 0) {
      match = data.queries[data.queries.length - 1];
    }
    if (match) {
      const tableSnapshots = await fetchTableSnapshots(CONFIG.MYSQL_DATABASE, match.sql);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...match, tableSnapshots, tableSnapshot: tableSnapshots[0] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    }
    return;
  }

  // API Endpoint: Returns reconstructed queries (GET /api/reconstructed/queries)
  if (req.method === 'GET' && req.url === '/api/reconstructed/queries') {
    const data = getReconstructedData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data.queries));
    return;
  }

  // API Endpoint: Returns reconstructed transactions (GET /api/reconstructed/transactions)
  if (req.method === 'GET' && req.url === '/api/reconstructed/transactions') {
    const data = getReconstructedData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data.transactions));
    return;
  }

  // API Endpoint: Returns reconstructed lock wait graph & cycles (GET /api/reconstructed/lock-wait-graph)
  if (req.method === 'GET' && req.url === '/api/reconstructed/lock-wait-graph') {
    const data = getReconstructedData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data.lockWaitGraph));
    return;
  }

  // API Endpoint: Clears trace log file (POST /api/clear)
  if (req.url === '/api/clear') {
    fs.writeFileSync(TRACE_FILE, '', 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cleared' }));
    return;
  }

  // Static File Serving
  let filePath = path.join(FRONTEND_DIR, req.url === '/' ? 'index.html' : req.url);
  const extname = path.extname(filePath);
  let contentType = 'text/html';

  switch (extname) {
    case '.js':
      contentType = 'text/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
    case '.json':
      contentType = 'application/json';
      break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// ---------------------------------------------------------
// WEBSOCKET SERVER
// ---------------------------------------------------------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log(`[Gateway WS] Client connected from ${req.socket.remoteAddress}`);
  let currentExecId = null;

  // Extract execution_id from connection URL if present (e.g. /ws/executions/exec_123)
  const urlParts = req.url.split('/');
  if (urlParts.includes('executions') && urlParts.length > urlParts.indexOf('executions') + 1) {
    currentExecId = urlParts[urlParts.indexOf('executions') + 1];
    const session = executionSessions.get(currentExecId);
    if (session) {
      session.addSubscriber(ws);
    }
  }

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.action === 'subscribe' && msg.execution_id) {
        if (currentExecId && executionSessions.has(currentExecId)) {
          executionSessions.get(currentExecId).removeSubscriber(ws);
        }
        currentExecId = msg.execution_id;
        const session = executionSessions.get(currentExecId);
        if (session) {
          session.addSubscriber(ws);
          ws.send(JSON.stringify({ status: 'subscribed', execution_id: currentExecId }));
        } else {
          ws.send(JSON.stringify({ error: 'Execution session not found', execution_id: currentExecId }));
        }
      }
    } catch (e) {
      console.warn('[Gateway WS] Invalid JSON message from client:', message.toString());
    }
  });

  ws.on('close', () => {
    if (currentExecId) {
      const session = executionSessions.get(currentExecId);
      if (session) {
        session.removeSubscriber(ws);
      }
    }
    console.log('[Gateway WS] Client disconnected');
  });
});

// Start HTTP & WS Server
server.listen(CONFIG.HTTP_PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 QueryTracer Gateway & API: http://127.0.0.1:${CONFIG.HTTP_PORT}`);
  console.log(`📡 WebSocket Stream Endpoint: ws://127.0.0.1:${CONFIG.HTTP_PORT}/ws`);
  console.log(`📁 Log File Storage Path: ${TRACE_FILE}`);
  console.log(`======================================================\n`);
});

// ---------------------------------------------------------
// TCP NDJSON TELEMETRY CONSUMER
// ---------------------------------------------------------
function connectToMySQLTelemetry() {
  console.log(`[Gateway TCP] Connecting to QueryTracer TCP at ${CONFIG.TCP_HOST}:${CONFIG.TCP_PORT}...`);
  const client = new net.Socket();
  let buffer = '';

  client.connect(CONFIG.TCP_PORT, CONFIG.TCP_HOST, () => {
    console.log(`[Gateway TCP] Connected to QueryTracer Telemetry Stream on ${CONFIG.TCP_HOST}:${CONFIG.TCP_PORT}`);
  });

  client.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete frame in buffer

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('[QueryTracer]')) {
        line = line.substring(13).trim();
      }
      try {
        const event = JSON.parse(line);
        handleIncomingTelemetryEvent(event);
      } catch (e) {
        console.warn('[Gateway TCP] Malformed NDJSON frame skipped:', line);
      }
    }
  });

  client.on('close', () => {
    console.log('[Gateway TCP] Connection closed. Retrying in 3 seconds...');
    setTimeout(connectToMySQLTelemetry, 3000);
  });

  client.on('error', (err) => {
    console.warn('[Gateway TCP] Waiting for QueryTracer TCP server:', err.message);
  });
}

connectToMySQLTelemetry();

// Bounded session cleanup timer (retires completed executions after 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [execId, session] of executionSessions.entries()) {
    if ((session.status === 'COMPLETED' || session.status === 'FAILED') &&
        (now - session.createdAt > CONFIG.SESSION_RETENTION_MS)) {
      console.log(`[Gateway Cleanup] Retiring execution ${execId}`);
      executionSessions.delete(execId);
    }
  }
}, 60000);
