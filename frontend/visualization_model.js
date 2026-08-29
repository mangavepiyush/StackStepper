/**
 * visualization_model.js — MySQL Engine Visualizer
 * Converts raw reconstructed query telemetry into a clean VisualizationModel.
 * Canonical telemetry-driven normalization ONCE per query selection.
 * STRICT EVENT AUTHORITY MODEL — ZERO FAKE OR HARDCODED ROWS.
 */

(function(exports) {
  'use strict';

  function deriveCommandType(sql, defaultType) {
    if (defaultType && defaultType !== 'UNKNOWN') return defaultType;
    const s = (sql || '').trim().toUpperCase();
    if (s.startsWith('SELECT')) return 'SELECT';
    if (s.startsWith('INSERT')) return 'INSERT';
    if (s.startsWith('UPDATE')) return 'UPDATE';
    if (s.startsWith('DELETE')) return 'DELETE';
    if (s.startsWith('START') || s.startsWith('BEGIN')) return 'BEGIN';
    if (s.startsWith('COMMIT')) return 'COMMIT';
    if (s.startsWith('ROLLBACK')) return 'ROLLBACK';
    return 'DML';
  }

  function extractRowKey(evt, matchedSnap, allSnapshots) {
    if (!evt) return null;
    const details = evt.details || {};

    if (details.primary_key_value !== undefined && details.primary_key_value !== null) {
      return String(details.primary_key_value);
    }

    const keyObj = details.row_key || evt.row_key;
    if (keyObj) {
      if (typeof keyObj === 'object') {
        if (keyObj.parts && typeof keyObj.parts === 'object') {
          if (keyObj.parts.id !== undefined) return String(keyObj.parts.id);
          const vals = Object.values(keyObj.parts);
          if (vals.length > 0) return String(vals[0]);
        }
        if (keyObj.id !== undefined) return String(keyObj.id);
        const vals = Object.values(keyObj);
        if (vals.length > 0 && typeof vals[0] !== 'object') return String(vals[0]);
      } else {
        return String(keyObj);
      }
    }
    if (details.row_key && typeof details.row_key === 'object' && details.row_key.parts) {
      const parts = details.row_key.parts;
      if (parts.id !== undefined) return String(parts.id);
      const firstPart = Object.values(parts)[0];
      if (firstPart !== undefined && firstPart !== null) return String(firstPart);
    }

    if (details.values && typeof details.values === 'object') {
      if (Array.isArray(details.values)) {
        if (details.values.length > 0) {
          const candidateSnaps = [];
          if (matchedSnap) candidateSnaps.push(matchedSnap);
          if (Array.isArray(allSnapshots)) {
            allSnapshots.forEach(s => {
              if (!candidateSnaps.includes(s)) candidateSnaps.push(s);
            });
          }
          for (const snap of candidateSnaps) {
            if (snap && Array.isArray(snap.rows)) {
              const match = snap.rows.find(r => {
                const rVals = Object.values(r).map(v => String(v).trim());
                return details.values.every(v => rVals.includes(String(v).trim()));
              });
              if (match) {
                if (match.id !== undefined) return String(match.id);
                const firstVal = Object.values(match)[0];
                if (firstVal !== undefined && firstVal !== null) return String(firstVal);
              }
            }
          }
          return String(details.values[0]);
        }
      } else {
        if (details.values.id !== undefined) return String(details.values.id);
        const candidateSnaps = [];
        if (matchedSnap) candidateSnaps.push(matchedSnap);
        if (Array.isArray(allSnapshots)) {
          allSnapshots.forEach(s => {
            if (!candidateSnaps.includes(s)) candidateSnaps.push(s);
          });
        }
        for (const snap of candidateSnaps) {
          if (snap && Array.isArray(snap.rows)) {
            const matches = snap.rows.filter(r => {
              return Object.keys(details.values).every(k => r[k] !== undefined && String(r[k]) === String(details.values[k]));
            });
            if (matches.length === 1) {
              if (matches[0].id !== undefined) return String(matches[0].id);
              const firstVal = Object.values(matches[0])[0];
              if (firstVal !== undefined && firstVal !== null) return String(firstVal);
            }
          }
        }
      }
    }

    if (details.row_number !== undefined && details.row_number !== null) {
      return String(details.row_number);
    }

    return null;
  }

  function isUserDataEvent(evt, validTableNamesSet) {
    if (!evt) return false;
    const details = evt.details || {};
    const scope = evt.activity_scope || details.activity_scope || '';
    const schema = (evt.schema || details.schema || '').toLowerCase();

    if (scope === 'MYSQL_INTERNAL' || schema === 'information_schema' || schema === 'mysql') {
      return false;
    }

    if (validTableNamesSet && validTableNamesSet.size > 0) {
      const evtTbl = (details.table || evt.table || '').toLowerCase();
      const evtAls = (details.alias || evt.alias || '').toLowerCase();
      if (evtTbl && evtAls) {
        if (!validTableNamesSet.has(evtTbl) && !validTableNamesSet.has(evtAls)) return false;
      } else if (evtTbl) {
        if (!validTableNamesSet.has(evtTbl)) return false;
      } else if (evtAls) {
        if (!validTableNamesSet.has(evtAls)) return false;
      }
    }

    return true;
  }

  function determineExecutedAccessMethod(events, accessPaths) {
    let method = 'UNKNOWN';
    let displayMethod = 'Unknown / Not Proven';
    let indexName = '';

    const allEvents = events || [];
    let foundConst = false;
    let foundRange = false;
    let foundScan = false;

    for (const evt of allEvents) {
      const details = evt.details || {};
      const iter = details.iterator || evt.iterator || '';
      const pathStr = details.access_path || evt.access_path || '';
      const idxStr = details.index_name || evt.index_name || '';

      if (idxStr && idxStr !== 'NONE') indexName = idxStr;

      if (iter === 'IndexRangeScanIterator' || pathStr === 'Index Range Scan' || evt.eventType === 'INDEX_RANGE_SCAN_START') {
        foundRange = true;
      } else if (iter === 'ConstTableLookup' || pathStr === 'Primary Key Lookup' || (evt.eventType === 'INDEX_LOOKUP' && idxStr === 'PRIMARY')) {
        foundConst = true;
      } else if (iter === 'TableScanIterator' || pathStr === 'Full Table Scan' || evt.eventType === 'TABLE_SCAN_START') {
        foundScan = true;
      }
    }

    if (foundRange) {
      method = 'PRIMARY_INDEX_RANGE_SCAN';
      displayMethod = 'Index Range Scan';
      if (!indexName) indexName = 'PRIMARY';
    } else if (foundConst) {
      method = 'PRIMARY_KEY_LOOKUP';
      displayMethod = 'Primary Key Lookup';
    } else if (accessPaths && accessPaths.length > 0) {
      const p = accessPaths[0];
      method = p.type || 'UNKNOWN';
      displayMethod = p.access_path || p.type || 'Unknown';
      indexName = p.index_name || '';
    }

    return { executedMethod: method, displayMethod, indexName };
  }

  function getEffectiveEventType(evt) {
    if (!evt) return 'EVENT';
    const rawType = evt.eventType || evt.event_type || 'EVENT';
    const stage = evt.stage || '';

    if (rawType === 'FILTER_RESULT' || stage === 'FILTER_RESULT' || stage === 'FilterPassed') return 'FILTER_RESULT';
    if (rawType === 'ROW_SELECTED' || stage === 'ROW_SELECTED') return 'ROW_SELECTED';
    if (rawType === 'ROW_DISCARDED' || stage === 'ROW_DISCARDED') return 'ROW_DISCARDED';
    if (rawType === 'PROJECTION' || stage === 'Projection') return 'PROJECTION';
    if (rawType === 'RESULT_SENT' || stage === 'ResultRowSent') return 'RESULT_SENT';
    if (rawType === 'TABLE_SCAN_START' || stage === 'TABLE_SCAN_START') return 'TABLE_SCAN_START';
    if (rawType === 'TABLE_SCAN_END' || stage === 'TABLE_SCAN_END') return 'TABLE_SCAN_END';
    if (rawType === 'ROW_FETCH' || stage === 'RowFetch') return 'ROW_FETCH';
    if (rawType === 'COMMAND_START' || stage === 'ClientInbound') return 'COMMAND_START';
    if (rawType === 'COMMAND_END' || stage === 'CommandFinish') return 'COMMAND_END';
    if (rawType === 'LEX_PARSE' || stage === 'LexerAndParser' || stage === 'ASTCreated') return 'LEX_PARSE';
    if (rawType === 'AST_DISPATCH' || stage === 'CommandDispatcher') return 'AST_DISPATCH';
    if (rawType === 'AST_CREATED' || stage === 'ASTCreated') return 'AST_CREATED';

    return rawType;
  }

  function buildVisualizationModel(queryTrace, tableSnapshot, tableSnapshots) {
    if (!queryTrace) return null;

    const sql = queryTrace.sql || '';
    const cmdType = deriveCommandType(sql, queryTrace.commandType);
    const allSnapshots = Array.isArray(tableSnapshots) && tableSnapshots.length > 0 ? tableSnapshots : (tableSnapshot ? [tableSnapshot] : []);
    const primarySnapshot = allSnapshots[0] || tableSnapshot || null;
    const tableName = (primarySnapshot && primarySnapshot.table) ? primarySnapshot.table.toLowerCase() : ((queryTrace.tables && queryTrace.tables.length > 0) ? queryTrace.tables[0].toLowerCase() : 'student');
    const validTableNamesSet = new Set(allSnapshots.flatMap(s => [s.table.toLowerCase(), (s.alias || s.table).toLowerCase()]));
    const rawEvents = queryTrace.events || queryTrace.userEvents || [];

    const targetSqlNorm = (sql || '').trim().toLowerCase();
    let targetStartIdx = -1;
    if (targetSqlNorm.length > 0) {
      rawEvents.forEach((ev, idx) => {
        const rawType = ev.eventType || ev.event_type || ev.stage;
        if (rawType === 'COMMAND_START' && ev.details && ev.details.query) {
          const q = ev.details.query.trim().toLowerCase();
          if (!q.includes('table_snapshot') && (q === targetSqlNorm || targetSqlNorm.includes(q) || q.includes(targetSqlNorm.slice(0, 15)))) {
            targetStartIdx = idx;
          }
        }
      });
    }

    const allEvents = targetStartIdx >= 0 ? rawEvents.slice(targetStartIdx) : rawEvents;
    const accessInfo = determineExecutedAccessMethod(allEvents, queryTrace.accessPaths);

    // Diagnostic log 1, 2, 3
    console.log(`[JOIN-VIZ 1] participating tables discovered: ${allSnapshots.length}`);
    const aliasMapStr = allSnapshots.map(s => `${s.alias || s.table} -> ${s.table}`).join(', ');
    console.log(`[JOIN-VIZ 2] alias mappings: ${aliasMapStr || 'default'}`);
    const snapsStr = allSnapshots.map(s => `${s.alias || s.table} (table: ${s.table}, rows=${s.rows ? s.rows.length : 0})`).join(', ');
    console.log(`[JOIN-VIZ 3] snapshots captured: ${snapsStr}`);

    const tablesList = [];
    const observedRowsMap = new Map();
    const lastFetchedByAliasMap = new Map();
    const isMultiTable = allSnapshots.length > 1;

    // Per-table statistics tracking
    const tableStatsMap = new Map();

    allSnapshots.forEach(snap => {
      const sSchema = (snap.schema || 'student').toLowerCase();
      const sTable = (snap.table || 'student').toLowerCase();
      const sAlias = (snap.alias || sTable).toLowerCase();
      const fullTblKey = `${sSchema}.${sTable}[${sAlias}]`;
      const rows = Array.isArray(snap.rows) ? snap.rows : [];

      const tblObj = {
        key: fullTblKey,
        schema: sSchema,
        name: sTable,
        alias: snap.alias || sTable,
        columns: snap.columns || ['id', 'name'],
        rows,
        accessMethod: 'Full Table Scan',
        indexName: ''
      };
      tablesList.push(tblObj);

      tableStatsMap.set(fullTblKey, {
        examinedSet: new Set(),
        selectedSet: new Set(),
        discardedSet: new Set()
      });

      rows.forEach(r => {
        let rId = String(r.id !== undefined ? r.id : (r.primaryKey !== undefined ? r.primaryKey : ''));
        if (!rId) {
          const firstVal = Object.values(r)[0];
          if (firstVal !== undefined && firstVal !== null) rId = String(firstVal);
        }
        if (rId) {
          const compKey = `${sAlias}:${rId}`;
          const mapKey = isMultiTable ? compKey : rId;
          const rVals = Object.values(r);
          const secondVal = rVals.length > 1 ? rVals[1] : undefined;
          const displayName = r.name || r.first_name || r.course_name || r.dept_name || r.instructor_name || (secondVal !== undefined ? String(secondVal) : `Row_${rId}`);
          const rowObj = {
            id: rId,
            compositeKey: compKey,
            tableKey: fullTblKey,
            schema: sSchema,
            table: sTable,
            alias: snap.alias || sTable,
            name: displayName,
            status: 'NOT VISITED',
            resolvedStatus: 'NOT VISITED',
            values: r
          };
          observedRowsMap.set(mapKey, rowObj);
          if (compKey !== mapKey) {
            observedRowsMap.set(compKey, rowObj);
          }
        }
      });
    });

    const rowNumToKeyMap = new Map();
    let lastFetchedRowKey = null;

    const globalExaminedSet = new Set();
    const globalSelectedSet = new Set();
    const globalDiscardedSet = new Set();
    const resultSeqSeen = new Set();
    const resultStream = [];

    // Result column names
    const resultColumns = queryTrace.result?.columns || ['id', 'name'];

    // Track join operators
    let isJoinQuery = isMultiTable || allEvents.some(e => e.eventType === 'JOIN_MATCH' || e.eventType === 'JOIN_NO_MATCH');
    let joinType = 'INNER';
    let joinIterator = 'NestedLoopIterator';
    const joinOpsList = [];

    const ops = queryTrace.operators || [];
    console.log(`[JOIN-VIZ 4] operators discovered: ${ops.length}`);

    ops.forEach(op => {
      const iter = op.iterator || op.accessPath || '';
      if (iter.includes('Join') || iter.includes('NestedLoop')) {
        isJoinQuery = true;
        if (op.joinType) joinType = op.joinType;
        if (iter) joinIterator = iter;
        joinOpsList.push(op);
      }
    });

    console.log(`[JOIN-VIZ 5] join operators discovered: ${joinOpsList.length}`);
    console.log(`[JOIN-VIZ 6] per-table access paths resolved`);

    const steps = [];

    // Helper to produce deep copy of observed rows state with single active ROW_CURRENT
    function getObservedStatesCopy(activeKey) {
      const copy = {};
      observedRowsMap.forEach((v, k) => {
        if (k === v.compositeKey || (!isMultiTable && k === v.id)) {
          const isCurrent = activeKey && (k === activeKey || v.compositeKey === activeKey || v.id === activeKey);
          const currentStat = isCurrent ? 'CURRENT' : v.resolvedStatus;
          const obj = { id: v.id, compositeKey: v.compositeKey || k, tableKey: v.tableKey, schema: v.schema, table: v.table, alias: v.alias, name: v.name, status: currentStat, resolvedStatus: v.resolvedStatus };
          copy[k] = obj;
        }
      });
      return copy;
    }

    function getPerTableCounters() {
      const counts = {};
      tableStatsMap.forEach((v, k) => {
        counts[k] = {
          examined: v.examinedSet.size,
          selected: v.selectedSet.size,
          discarded: v.discardedSet.size
        };
      });
      return counts;
    }

    // Process telemetry events
    allEvents.forEach((evt, idx) => {
      const type = getEffectiveEventType(evt);
      const seq = evt.seq || (idx + 1);
      const isUserEv = isUserDataEvent(evt, validTableNamesSet);
      const details = evt.details || {};

      const evtDisp = (details.display_name || details.table || tableName).toLowerCase();

      // Find matching snapshot by alias or table
      const matchedSnap = allSnapshots.find(s => (s.alias && s.alias.toLowerCase() === evtDisp) || (s.table && s.table.toLowerCase() === evtDisp));
      const evtSchema = (matchedSnap && matchedSnap.schema) ? matchedSnap.schema.toLowerCase() : 'student';
      const evtTable = (matchedSnap && matchedSnap.table) ? matchedSnap.table.toLowerCase() : evtDisp;
      const evtAlias = (matchedSnap && matchedSnap.alias) ? matchedSnap.alias.toLowerCase() : evtDisp;
      const fullTblKey = `${evtSchema}.${evtTable}[${evtAlias}]`;

      // Update per-table access method if present
      if (details.iterator || details.access_path) {
        const targetTbl = tablesList.find(t => t.key === fullTblKey || t.name === evtTable || (t.alias && t.alias.toLowerCase() === evtDisp));
        if (targetTbl) {
          if (details.access_path) targetTbl.accessMethod = details.access_path;
          if (details.index_name) targetTbl.indexName = details.index_name;
        }
      }

      if (type === 'COMMAND_START') {
        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'SQL_RECEIVED',
          title: 'SQL Statement Received',
          explanation: `MySQL protocol layer received query: "${sql}". Thread allocated.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'LEX_PARSE' || type === 'AST_CREATED') {
        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'LEX_PARSE',
          title: 'Lexer & AST Parser',
          explanation: 'MySQL parsed query into Abstract Syntax Tree (AST).',
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'OPTIMIZER_START' || type === 'OPTIMIZE_STAGE' || type === 'INDEX_SELECT') {
        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'OPTIMIZER',
          title: 'Cost-Based Optimizer (CBO)',
          explanation: `Optimizer selected access strategy: ${accessInfo.displayMethod}${accessInfo.indexName ? ' (Index: ' + accessInfo.indexName + ')' : ''}.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'TABLE_SCAN_START' || type === 'TABLE_OPEN') {
        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'TABLE_ACCESS_START',
          title: 'Storage Engine Iterator Open',
          explanation: `MySQL initialized storage engine iterator on '${evtAlias}'.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'ROW_FETCH' && isUserEv) {
        const rKey = extractRowKey(evt, matchedSnap, allSnapshots);
        const rNum = details.row_number;
        const compKey = `${evtAlias}:${rKey}`;
        const mapKey = isMultiTable ? compKey : rKey;

        if (rKey) {
          lastFetchedRowKey = mapKey;
          lastFetchedByAliasMap.set(evtAlias, mapKey);
          if (rNum !== undefined) rowNumToKeyMap.set(rNum, mapKey);
          globalExaminedSet.add(mapKey);

          if (tableStatsMap.has(fullTblKey)) {
            tableStatsMap.get(fullTblKey).examinedSet.add(rKey);
          }

          const nameVal = details.values?.name || details.values?.course_name || details.values?.dept_name || details.values?.instructor_name || (Array.isArray(details.values) ? details.values[1] : `Row_${rKey}`);

          const keysToUpdate = isMultiTable ? [compKey, mapKey] : [compKey, mapKey, rKey];
          keysToUpdate.forEach(k => {
            if (observedRowsMap.has(k)) {
              const existing = observedRowsMap.get(k);
              if (nameVal && typeof nameVal === 'string') existing.name = nameVal;
              if (existing.resolvedStatus === 'NOT VISITED') {
                existing.resolvedStatus = 'EXAMINED';
              }
            }
          });

          if (!observedRowsMap.has(mapKey)) {
            observedRowsMap.set(mapKey, { id: rKey, compositeKey: compKey, tableKey: fullTblKey, schema: evtSchema, table: evtTable, alias: evtAlias, name: nameVal, status: 'NOT VISITED', resolvedStatus: 'EXAMINED' });
          }

          steps.push({
            stepIndex: steps.length,
            seq,
            type: 'ROW_CURRENT',
            rowKey: rKey,
            compositeKey: compKey,
            activeRowKey: mapKey,
            schema: evtSchema,
            table: evtTable,
            alias: evtAlias,
            tableKey: fullTblKey,
            rowNumber: rNum,
            title: `Fetching ${evtAlias} Row #${rKey}`,
            explanation: `Storage engine fetched tuple #${rKey} from table '${evtAlias}' for evaluation.`,
            event: evt,
            rowStates: getObservedStatesCopy(mapKey),
            counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
            perTableCounters: getPerTableCounters(),
            resultStream: [...resultStream]
          });
        }
      } else if (type === 'FILTER_RESULT' && isUserEv) {
        const rNum = details.row_number;
        const mapKey = (rNum !== undefined && rowNumToKeyMap.has(rNum)) ? rowNumToKeyMap.get(rNum) : lastFetchedRowKey;
        const passed = details.passed === true;

        if (mapKey && observedRowsMap.has(mapKey)) {
          const rowObj = observedRowsMap.get(mapKey);
          if (rowObj.resolvedStatus !== 'SELECTED') {
            if (passed) {
              rowObj.resolvedStatus = 'FILTER_PASSED';
            } else {
              rowObj.resolvedStatus = 'DISCARDED';
              globalDiscardedSet.add(mapKey);
              if (tableStatsMap.has(rowObj.tableKey)) {
                tableStatsMap.get(rowObj.tableKey).discardedSet.add(rowObj.id);
              }
            }
          }
        }

        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'FILTER_EVALUATED',
          compositeKey: mapKey,
          activeRowKey: null,
          passed,
          condition: details.condition || '',
          title: `Predicate Filter (${passed ? 'PASS ✓' : 'FAIL ✕'})`,
          explanation: `Filter condition ${details.condition || ''} evaluated ${passed ? 'TRUE' : 'FALSE'}.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'ROW_SELECTED' && isUserEv) {
        const rNum = details.row_number;
        const mapKey = (rNum !== undefined && rowNumToKeyMap.has(rNum)) ? rowNumToKeyMap.get(rNum) : lastFetchedRowKey;

        if (!isJoinQuery && mapKey && observedRowsMap.has(mapKey)) {
          const rowObj = observedRowsMap.get(mapKey);
          rowObj.resolvedStatus = 'SELECTED';
          globalSelectedSet.add(mapKey);
          globalDiscardedSet.delete(mapKey);
          if (tableStatsMap.has(rowObj.tableKey)) {
            tableStatsMap.get(rowObj.tableKey).selectedSet.add(rowObj.id);
            tableStatsMap.get(rowObj.tableKey).discardedSet.delete(rowObj.id);
          }
        }

        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'ROW_SELECTED',
          compositeKey: mapKey,
          activeRowKey: null,
          title: `Row Selected ✓`,
          explanation: `Row accepted by execution pipeline for output projection.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'JOIN_MATCH' || type === 'JOIN_NO_MATCH') {
        const matched = details.matched !== false;
        const joinTuples = details.join_tuples;

        const markRowSelected = (mKey) => {
          if (!mKey) return;
          let rowObj = observedRowsMap.get(mKey);
          if (!rowObj) {
            const parts = String(mKey).split(':');
            const alias = parts.length > 1 ? parts[0] : '';
            const rowId = parts.length > 1 ? parts[1] : parts[0];
            const snap = allSnapshots.find(s => (s.alias && s.alias.toLowerCase() === alias.toLowerCase()) || (s.table && s.table.toLowerCase() === alias.toLowerCase()));
            if (snap) {
              const sSchema = (snap.schema || 'default').toLowerCase();
              const sTable = (snap.table || '').toLowerCase();
              const sAlias = (snap.alias || sTable).toLowerCase();
              const tableKey = `${sSchema}.${sTable}[${sAlias}]`;
              rowObj = {
                id: String(rowId),
                compositeKey: mKey,
                tableKey,
                resolvedStatus: 'SELECTED'
              };
              observedRowsMap.set(mKey, rowObj);
            }
          }
          if (rowObj) {
            rowObj.resolvedStatus = 'SELECTED';
            globalSelectedSet.add(mKey);
            globalDiscardedSet.delete(mKey);
            if (tableStatsMap.has(rowObj.tableKey)) {
              tableStatsMap.get(rowObj.tableKey).selectedSet.add(rowObj.id);
              tableStatsMap.get(rowObj.tableKey).discardedSet.delete(rowObj.id);
            }
          }
        };

        if (joinTuples && typeof joinTuples === 'object') {
          Object.entries(joinTuples).forEach(([alias, pk]) => {
            if (pk !== null && pk !== undefined && pk !== 'null') {
              const mapKey = isMultiTable ? `${alias}:${pk}` : String(pk);
              markRowSelected(mapKey);
            }
          });
        } else if (matched) {
          lastFetchedByAliasMap.forEach(mKey => markRowSelected(mKey));
        }

        steps.push({
          stepIndex: steps.length,
          seq,
          type: type,
          activeRowKey: null,
          matched,
          joinType: details.join_type || 'INNER',
          title: `Join Predicate ${matched ? 'MATCH ✓' : 'NO MATCH ✕'}`,
          explanation: `Join iterator evaluated join condition: ${matched ? 'Outer row matched inner row.' : 'No join match found.'}`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'RESULT_SENT' && isUserEv) {
        const resValues = Array.isArray(details.values) ? details.values : Object.values(details.values || {});
        const isMetadata = resValues.some(v => String(v).includes('Source distribution') || String(v).startsWith('@@'));

        if (!isMetadata) {
          const resSeq = details.result_row_seq || (globalSelectedSet.size + 1);
          if (!resultSeqSeen.has(resSeq)) {
            resultSeqSeen.add(resSeq);

            let rKey = extractRowKey(evt, null, allSnapshots);
            let mapKey = rKey ? (isMultiTable ? `${evtAlias}:${rKey}` : rKey) : lastFetchedRowKey;

            const markRowSelected = (mKey) => {
              if (mKey && observedRowsMap.has(mKey)) {
                const rowObj = observedRowsMap.get(mKey);
                rowObj.resolvedStatus = 'SELECTED';
                globalSelectedSet.add(mKey);
                globalDiscardedSet.delete(mKey);
                if (tableStatsMap.has(rowObj.tableKey)) {
                  tableStatsMap.get(rowObj.tableKey).selectedSet.add(rowObj.id);
                  tableStatsMap.get(rowObj.tableKey).discardedSet.delete(rowObj.id);
                }
              }
            };

            if (!isJoinQuery && (!isMultiTable || globalSelectedSet.size === 0)) {
              const targetKeys = new Set();
              if (mapKey) targetKeys.add(mapKey);
              lastFetchedByAliasMap.forEach(k => targetKeys.add(k));
              targetKeys.forEach(mKey => markRowSelected(mKey));
            }

            const actualResultRows = queryTrace.result?.rows || [];
            let rowValues = resValues;
            if (actualResultRows.length >= resSeq) {
              const rObj = actualResultRows[resSeq - 1];
              if (rObj && typeof rObj === 'object') {
                rowValues = Object.values(rObj);
              }
            }

            resultStream.push({
              resultRowSeq: resSeq,
              id: String(resSeq),
              name: rowValues[1] || rowValues[0] || 'Record',
              values: rowValues
            });

            steps.push({
              stepIndex: steps.length,
              seq,
              type: 'RESULT_SENT',
              compositeKey: mapKey,
              activeRowKey: null,
              title: `Client Result Streamed (#${resSeq})`,
              explanation: `Result tuple transmitted in MySQL client protocol packet.`,
              event: evt,
              rowStates: getObservedStatesCopy(null),
              counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
              perTableCounters: getPerTableCounters(),
              resultStream: [...resultStream]
            });
          }
        }
      } else if (type === 'TABLE_SCAN_END') {
        if (evtAlias) lastFetchedByAliasMap.delete(evtAlias);
        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'TABLE_SCAN_END',
          activeRowKey: null,
          title: `Table Processing Complete (${evtAlias})`,
          explanation: `Engine finished table operation on '${evtAlias}'.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      } else if (type === 'COMMAND_END') {
        steps.push({
          stepIndex: steps.length,
          seq,
          type: 'COMMAND_END',
          activeRowKey: null,
          title: 'Query Execution Complete',
          explanation: `Query processing completed in ${queryTrace.durationUs || 0} µs.`,
          event: evt,
          rowStates: getObservedStatesCopy(null),
          counters: { examined: globalExaminedSet.size, selected: globalSelectedSet.size, discarded: globalDiscardedSet.size },
          perTableCounters: getPerTableCounters(),
          resultStream: [...resultStream]
        });
      }
    });

    if (steps.length === 0) {
      steps.push({
        stepIndex: 0,
        seq: 1,
        type: 'COMMAND_END',
        activeRowKey: null,
        title: 'Query Execution Summary',
        explanation: `Query completed with ${queryTrace.rowsExamined || 0} rows examined`,
        event: {},
        rowStates: getObservedStatesCopy(null),
        counters: { examined: 0, selected: 0, discarded: 0 },
        perTableCounters: getPerTableCounters(),
        resultStream: []
      });
    }

    console.log(`[JOIN-VIZ 7] row telemetry correlated by table`);
    console.log(`[JOIN-VIZ 8] visualization model built`);

    const primaryRows = (primarySnapshot && Array.isArray(primarySnapshot.rows)) ? primarySnapshot.rows : Array.from(observedRowsMap.values());

    return {
      executionIdentity: {
        threadId: queryTrace.threadId,
        queryId: queryTrace.queryId,
        sql,
        commandType: cmdType,
        durationUs: queryTrace.durationUs || 0,
        rowsExamined: queryTrace.rowsExamined || 0
      },
      tables: tablesList,
      table: {
        name: tableName,
        columns: (primarySnapshot && primarySnapshot.columns) ? primarySnapshot.columns : ['id', 'name'],
        rows: primaryRows
      },
      tableRows: primaryRows.length,
      tableSnapshot: primarySnapshot,
      tableSnapshots: allSnapshots,
      resultColumns,
      access: {
        method: accessInfo.displayMethod,
        executedMethod: accessInfo.executedMethod,
        displayMethod: accessInfo.displayMethod,
        indexName: accessInfo.indexName,
        table: tableName
      },
      operators: queryTrace.operators || [],
      joins: {
        isJoin: isJoinQuery || tablesList.length > 1,
        joinType,
        joinIterator,
        joinOperators: joinOpsList
      },
      btreePages: queryTrace.btreePages || [],
      bufferPoolHits: queryTrace.bufferPoolHits || 0,
      locks: queryTrace.locks || [],
      redoLogs: queryTrace.redoLogs || [],
      steps
    };
  }

  exports.buildVisualizationModel = buildVisualizationModel;
})(typeof exports !== 'undefined' ? exports : (window.VisualizationModelModule = {}));
