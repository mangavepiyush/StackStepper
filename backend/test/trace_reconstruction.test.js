const assert = require('assert');
const {
  RawTraceEvent,
  TraceReader,
  QueryReconstructor,
  TransactionReconstructor,
  WaitForGraphReconstructor
} = require('../trace_parser');

console.log("==========================================================");
console.log("    RUNNING TRACE RECONSTRUCTION UNIT TEST SUITE          ");
console.log("==========================================================");

function runTests() {
  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[PASS] Test ${total}: ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] Test ${total}: ${name}`);
      console.error(err.stack || err.message);
    }
  }

  // ---------------------------------------------------------
  // TEST 1: SELECT using primary-key lookup
  // ---------------------------------------------------------
  test("1. SELECT using primary-key lookup", () => {
    const jsonl = `
    {"thread_id":14,"query_id":10,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT * FROM student WHERE id = 1"}}
    {"thread_id":14,"query_id":10,"seq":2,"elapsed_us":150,"event_type":"INDEX_SELECT","stage":"IndexInit","details":{"index_id":0,"index_name":"PRIMARY","table":"student","access_path":"Primary Key Lookup"}}
    {"thread_id":14,"query_id":10,"seq":3,"elapsed_us":200,"event_type":"ROW_FETCH","stage":"RowFetch","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","values":{"id":"1","name":"Alice"}}}
    {"thread_id":14,"query_id":10,"seq":4,"elapsed_us":250,"event_type":"PROJECTION","stage":"Projection","details":{"result_row_seq":1,"projected_columns":["id","name"],"values":["1","Alice"]}}
    {"thread_id":14,"query_id":10,"seq":5,"elapsed_us":300,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":-1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    assert.strictEqual(events.length, 5);

    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.sql, "SELECT * FROM student WHERE id = 1");
    assert.deepStrictEqual(q.tables, ["student"]);
    assert.deepStrictEqual(q.indexes, ["PRIMARY"]);
    assert.deepStrictEqual(q.accessPaths, ["Primary Key Lookup"]);
    assert.strictEqual(q.rowsExamined, 1);
    assert.strictEqual(q.resultRows.length, 1);
    assert.deepStrictEqual(q.resultRows[0].values, ["1", "Alice"]);
  });

  // ---------------------------------------------------------
  // TEST 2: INSERT
  // ---------------------------------------------------------
  test("2. INSERT", () => {
    const jsonl = `
    {"thread_id":14,"query_id":11,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"INSERT INTO student VALUES (2, 'Bob')"}}
    {"thread_id":14,"query_id":11,"seq":2,"elapsed_us":150,"event_type":"ROW_INSERTED","stage":"RowInserted","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"2"}},"inserted_values":{"id":"2","name":"Bob"}}}
    {"thread_id":14,"query_id":11,"seq":3,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.rowChanges.length, 1);
    assert.strictEqual(q.rowChanges[0].type, 'INSERT');
    assert.strictEqual(q.rowChanges[0].table, 'student');
    assert.deepStrictEqual(q.rowChanges[0].insertedValues, { id: '2', name: 'Bob' });
  });

  // ---------------------------------------------------------
  // TEST 3: UPDATE before -> after pairing
  // ---------------------------------------------------------
  test("3. UPDATE before -> after pairing", () => {
    const jsonl = `
    {"thread_id":14,"query_id":12,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET name = 'Bob Updated' WHERE id = 2"}}
    {"thread_id":14,"query_id":12,"seq":2,"elapsed_us":150,"event_type":"ROW_UPDATE_BEFORE","stage":"RowUpdateBefore","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"2"}},"before_values":{"id":"2","name":"Bob"}}}
    {"thread_id":14,"query_id":12,"seq":3,"elapsed_us":160,"event_type":"ROW_UPDATE_AFTER","stage":"RowUpdateAfter","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"2"}},"after_values":{"id":"2","name":"Bob Updated"}}}
    {"thread_id":14,"query_id":12,"seq":4,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.rowChanges.length, 1);
    assert.strictEqual(q.rowChanges[0].type, 'UPDATE');
    assert.deepStrictEqual(q.rowChanges[0].beforeValues, { id: '2', name: 'Bob' });
    assert.deepStrictEqual(q.rowChanges[0].afterValues, { id: '2', name: 'Bob Updated' });
  });

  // ---------------------------------------------------------
  // TEST 4: DELETE
  // ---------------------------------------------------------
  test("4. DELETE", () => {
    const jsonl = `
    {"thread_id":14,"query_id":13,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"DELETE FROM student WHERE id = 2"}}
    {"thread_id":14,"query_id":13,"seq":2,"elapsed_us":150,"event_type":"ROW_DELETED","stage":"RowDeleted","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"2"}},"deleted_values":{"id":"2","name":"Bob Updated"}}}
    {"thread_id":14,"query_id":13,"seq":3,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.rowChanges.length, 1);
    assert.strictEqual(q.rowChanges[0].type, 'DELETE');
    assert.deepStrictEqual(q.rowChanges[0].deletedValues, { id: '2', name: 'Bob Updated' });
  });

  // ---------------------------------------------------------
  // TEST 5: Multiple updates in one transaction
  // ---------------------------------------------------------
  test("5. Multiple updates in one transaction", () => {
    const jsonl = `
    {"thread_id":14,"query_id":20,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"START TRANSACTION"}}
    {"thread_id":14,"query_id":20,"seq":2,"elapsed_us":110,"event_type":"TRANSACTION_BEGIN","stage":"TransactionBegin","details":{"session_autocommit":true}}
    {"thread_id":14,"query_id":21,"seq":1,"elapsed_us":200,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET name = 'Val1' WHERE id = 1"}}
    {"thread_id":14,"query_id":21,"seq":2,"elapsed_us":210,"event_type":"ROW_UPDATE_BEFORE","stage":"RowUpdateBefore","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"1"}},"before_values":{"id":"1","name":"Alice"}}}
    {"thread_id":14,"query_id":21,"seq":3,"elapsed_us":220,"event_type":"ROW_UPDATE_AFTER","stage":"RowUpdateAfter","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"1"}},"after_values":{"id":"1","name":"Val1"}}}
    {"thread_id":14,"query_id":22,"seq":1,"elapsed_us":300,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET name = 'Val2' WHERE id = 1"}}
    {"thread_id":14,"query_id":22,"seq":2,"elapsed_us":310,"event_type":"ROW_UPDATE_BEFORE","stage":"RowUpdateBefore","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"1"}},"before_values":{"id":"1","name":"Val1"}}}
    {"thread_id":14,"query_id":22,"seq":3,"elapsed_us":320,"event_type":"ROW_UPDATE_AFTER","stage":"RowUpdateAfter","details":{"schema":"student","table":"student","activity_scope":"USER_DATA","row_key":{"type":"PRIMARY","parts":{"id":"1"}},"after_values":{"id":"1","name":"Val2"}}}
    {"thread_id":14,"query_id":23,"seq":1,"elapsed_us":400,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"COMMIT"}}
    {"thread_id":14,"query_id":23,"seq":2,"elapsed_us":410,"event_type":"TRANSACTION_COMMIT","stage":"TransactionCommit","details":{"session_autocommit":true}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 4);

    const txs = TransactionReconstructor.reconstructTransactions(queries);
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].outcome, 'COMMITTED');
    assert.strictEqual(txs[0].statements.length, 4);
    assert.strictEqual(txs[0].totalRowChanges, 2);
  });

  // ---------------------------------------------------------
  // TEST 6: COMMIT transaction
  // ---------------------------------------------------------
  test("6. COMMIT transaction", () => {
    const jsonl = `
    {"thread_id":15,"query_id":30,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"START TRANSACTION"}}
    {"thread_id":15,"query_id":30,"seq":2,"elapsed_us":110,"event_type":"TRANSACTION_BEGIN","stage":"TransactionBegin","details":{}}
    {"thread_id":15,"query_id":31,"seq":1,"elapsed_us":200,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"COMMIT"}}
    {"thread_id":15,"query_id":31,"seq":2,"elapsed_us":210,"event_type":"TRANSACTION_COMMIT","stage":"TransactionCommit","details":{}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    const txs = TransactionReconstructor.reconstructTransactions(queries);
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].outcome, 'COMMITTED');
    assert.strictEqual(txs[0].beginQueryId, 30);
    assert.strictEqual(txs[0].endQueryId, 31);
  });

  // ---------------------------------------------------------
  // TEST 7: ROLLBACK transaction
  // ---------------------------------------------------------
  test("7. ROLLBACK transaction", () => {
    const jsonl = `
    {"thread_id":16,"query_id":40,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"START TRANSACTION"}}
    {"thread_id":16,"query_id":40,"seq":2,"elapsed_us":110,"event_type":"TRANSACTION_BEGIN","stage":"TransactionBegin","details":{}}
    {"thread_id":16,"query_id":41,"seq":1,"elapsed_us":200,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"ROLLBACK"}}
    {"thread_id":16,"query_id":41,"seq":2,"elapsed_us":210,"event_type":"TRANSACTION_ROLLBACK","stage":"TransactionRollback","details":{}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    const txs = TransactionReconstructor.reconstructTransactions(queries);
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].outcome, 'ROLLED_BACK');
    assert.strictEqual(txs[0].beginQueryId, 40);
    assert.strictEqual(txs[0].endQueryId, 41);
  });

  // ---------------------------------------------------------
  // TEST 8: MYSQL_INTERNAL events not becoming user row changes
  // ---------------------------------------------------------
  test("8. MYSQL_INTERNAL events not becoming user row changes", () => {
    const jsonl = `
    {"thread_id":17,"query_id":50,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"CREATE TABLE t1 (id int)"}}
    {"thread_id":17,"query_id":50,"seq":2,"elapsed_us":150,"event_type":"ROW_INSERTED","stage":"RowInserted","details":{"schema":"mysql","table":"tables","activity_scope":"MYSQL_INTERNAL","inserted_values":{"name":"t1"}}}
    {"thread_id":17,"query_id":50,"seq":3,"elapsed_us":200,"event_type":"ROW_INSERTED","stage":"RowInserted","details":{"schema":"student","table":"t1","activity_scope":"USER_DATA","inserted_values":{"id":"1"}}}
    {"thread_id":17,"query_id":50,"seq":4,"elapsed_us":250,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.internalEvents.length, 1);
    assert.strictEqual(q.userEvents.length, 3);
    assert.strictEqual(q.rowChanges.length, 1);
    assert.strictEqual(q.rowChanges[0].table, 't1');
  });

  // ---------------------------------------------------------
  // TEST 9: Malformed JSONL line handling
  // ---------------------------------------------------------
  test("9. Malformed JSONL line handling", () => {
    const jsonl = `
    {"thread_id":18,"query_id":60,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT 1"}}
    {THIS IS A MALFORMED JSON LINE!!!}
    
    {"thread_id":18,"query_id":60,"seq":2,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":-1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    assert.strictEqual(events.length, 2);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(queries[0].sql, "SELECT 1");
  });

  // ---------------------------------------------------------
  // TEST 10: Ordering by seq
  // ---------------------------------------------------------
  test("10. Ordering by seq", () => {
    // Deliberately out-of-order sequence lines
    const jsonl = `
    {"thread_id":19,"query_id":70,"seq":3,"elapsed_us":300,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":-1}}
    {"thread_id":19,"query_id":70,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT * FROM student"}}
    {"thread_id":19,"query_id":70,"seq":2,"elapsed_us":200,"event_type":"ROW_FETCH","stage":"RowFetch","details":{"schema":"student","table":"student","activity_scope":"USER_DATA"}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.events[0].seq, 1);
    assert.strictEqual(q.events[1].seq, 2);
    assert.strictEqual(q.events[2].seq, 3);
    assert.strictEqual(q.events[0].eventType, "COMMAND_START");
    assert.strictEqual(q.events[2].eventType, "COMMAND_END");
  });

  // ---------------------------------------------------------
  // TEST 11: Operator Tree Hierarchy Reconstruction
  // ---------------------------------------------------------
  test("11. Operator Tree Hierarchy Reconstruction", () => {
    const jsonl = `
    {"thread_id":20,"query_id":80,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT * FROM student s JOIN course c ON s.id=c.student_id"}}
    {"thread_id":20,"query_id":80,"seq":2,"elapsed_us":150,"event_type":"OPERATOR_REGISTER","stage":"OperatorRegister","details":{"operator_id":100,"parent_operator_id":0,"iterator":"NestedLoopIterator"}}
    {"thread_id":20,"query_id":80,"seq":3,"elapsed_us":160,"event_type":"OPERATOR_REGISTER","stage":"OperatorRegister","details":{"operator_id":101,"parent_operator_id":100,"iterator":"TableScanIterator","table":"student"}}
    {"thread_id":20,"query_id":80,"seq":4,"elapsed_us":170,"event_type":"OPERATOR_REGISTER","stage":"OperatorRegister","details":{"operator_id":102,"parent_operator_id":100,"iterator":"TableScanIterator","table":"course"}}
    {"thread_id":20,"query_id":80,"seq":5,"elapsed_us":300,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":-1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.executionInfo.operatorTree.length, 1);
    const root = q.executionInfo.operatorTree[0];
    assert.strictEqual(root.operatorId, 100);
    assert.strictEqual(root.iterator, "NestedLoopIterator");
    assert.strictEqual(root.children.length, 2);
    assert.strictEqual(root.children[0].operatorId, 101);
    assert.strictEqual(root.children[0].table, "student");
    assert.strictEqual(root.children[1].operatorId, 102);
    assert.strictEqual(root.children[1].table, "course");
  });

  // ---------------------------------------------------------
  // TEST 12: Physical B+ Tree, Buffer Pool & Lock Events
  // ---------------------------------------------------------
  test("12. Physical B+ Tree, Buffer Pool & Lock Events", () => {
    const jsonl = `
    {"thread_id":21,"query_id":90,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT * FROM student WHERE id = 300"}}
    {"thread_id":21,"query_id":90,"seq":2,"elapsed_us":120,"event_type":"BTREE_PAGE_VISIT","stage":"BtreePageVisit","details":{"space_id":5,"page_no":4,"level":1,"is_leaf":false,"index_name":"PRIMARY"}}
    {"thread_id":21,"query_id":90,"seq":3,"elapsed_us":130,"event_type":"BUFFER_POOL_HIT","stage":"BufferPoolHit","details":{"space_id":5,"page_no":4,"is_hit":true}}
    {"thread_id":21,"query_id":90,"seq":4,"elapsed_us":140,"event_type":"BTREE_PAGE_VISIT","stage":"BtreePageVisit","details":{"space_id":5,"page_no":8,"level":0,"is_leaf":true,"index_name":"PRIMARY"}}
    {"thread_id":21,"query_id":90,"seq":5,"elapsed_us":150,"event_type":"BUFFER_POOL_HIT","stage":"BufferPoolHit","details":{"space_id":5,"page_no":8,"is_hit":true}}
    {"thread_id":21,"query_id":90,"seq":6,"elapsed_us":160,"event_type":"LOCK_GRANTED","stage":"LockGranted","details":{"lock_type":"RECORD","lock_mode":"S","table":"student","page_no":8,"granted":true}}
    {"thread_id":21,"query_id":90,"seq":7,"elapsed_us":300,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":-1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.executionInfo.physicalIndexAccess.length, 2);
    assert.strictEqual(q.executionInfo.physicalIndexAccess[0].pageNo, 4);
    assert.strictEqual(q.executionInfo.physicalIndexAccess[0].isLeaf, false);
    assert.strictEqual(q.executionInfo.physicalIndexAccess[1].pageNo, 8);
    assert.strictEqual(q.executionInfo.physicalIndexAccess[1].isLeaf, true);

    assert.strictEqual(q.executionInfo.pageAccesses.length, 2);
    assert.strictEqual(q.executionInfo.pageAccesses[0].isHit, true);

    assert.strictEqual(q.executionInfo.lockEvents.length, 1);
    assert.strictEqual(q.executionInfo.lockEvents[0].lockMode, "S");
    assert.strictEqual(q.executionInfo.lockEvents[0].granted, true);
  });

  // ---------------------------------------------------------
  // TEST 13: MVCC Version Visibility & Undo Reconstruction
  // ---------------------------------------------------------
  test("13. MVCC Version Visibility & Undo Reconstruction", () => {
    const jsonl = `
    {"thread_id":25,"query_id":100,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT * FROM student WHERE id = 300"}}
    {"thread_id":25,"query_id":100,"seq":2,"elapsed_us":110,"event_type":"MVCC_READ_VIEW","stage":"MvccReadView","details":{"creator_trx_id":105,"low_limit_id":106,"up_limit_id":100}}
    {"thread_id":25,"query_id":100,"seq":3,"elapsed_us":120,"event_type":"MVCC_VERSION_CHECK","stage":"MvccVersionCheck","details":{"reader_trx_id":105,"record_trx_id":104,"visible":false,"table":"student"}}
    {"thread_id":25,"query_id":100,"seq":4,"elapsed_us":130,"event_type":"MVCC_UNDO_FOLLOW","stage":"MvccUndoFollow","details":{"from_trx_id":104,"to_trx_id":98,"page_no":8}}
    {"thread_id":25,"query_id":100,"seq":5,"elapsed_us":140,"event_type":"MVCC_VERSION_CHECK","stage":"MvccVersionCheck","details":{"reader_trx_id":105,"record_trx_id":98,"visible":true,"table":"student"}}
    {"thread_id":25,"query_id":100,"seq":6,"elapsed_us":150,"event_type":"MVCC_VERSION_SELECTED","stage":"MvccVersionSelected","details":{"reader_trx_id":105,"record_trx_id":98,"table":"student"}}
    {"thread_id":25,"query_id":100,"seq":7,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":-1}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.ok(q.executionInfo.mvcc);
    assert.strictEqual(q.executionInfo.mvcc.readViews.length, 1);
    assert.strictEqual(q.executionInfo.mvcc.readViews[0].creatorTrxId, 105);
    assert.strictEqual(q.executionInfo.mvcc.versionChecks.length, 2);
    assert.strictEqual(q.executionInfo.mvcc.versionChecks[0].visible, false);
    assert.strictEqual(q.executionInfo.mvcc.versionChecks[1].visible, true);
    assert.strictEqual(q.executionInfo.mvcc.undoTraversal.length, 1);
    assert.strictEqual(q.executionInfo.mvcc.undoTraversal[0].fromTrxId, 104);
    assert.strictEqual(q.executionInfo.mvcc.undoTraversal[0].toTrxId, 98);
    assert.strictEqual(q.executionInfo.mvcc.selectedVersions.length, 1);
    assert.strictEqual(q.executionInfo.mvcc.selectedVersions[0].recordTrxId, 98);
  });

  // ---------------------------------------------------------
  // TEST 14: Lock Waiter & Blocker Relationship Reconstruction
  // ---------------------------------------------------------
  test("14. Lock Waiter & Blocker Relationship Reconstruction", () => {
    const jsonl = `
    {"thread_id":26,"query_id":101,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET name = 'X' WHERE id = 300"}}
    {"thread_id":26,"query_id":101,"seq":2,"elapsed_us":150,"event_type":"LOCK_WAIT","stage":"LockWait","details":{"lock_type":"RECORD","lock_mode":"X","table":"student","page_no":8,"granted":false,"waiting_trx_id":108,"waiting_thread_id":26,"blocking_trx_id":102,"blocking_thread_id":21}}
    {"thread_id":26,"query_id":101,"seq":3,"elapsed_us":300,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":0}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);

    const q = queries[0];
    assert.strictEqual(q.executionInfo.lockEvents.length, 1);
    const lk = q.executionInfo.lockEvents[0];
    assert.strictEqual(lk.granted, false);
    assert.strictEqual(lk.waitingTrxId, 108);
    assert.strictEqual(lk.waitingThreadId, 26);
    assert.strictEqual(lk.blockingTrxId, 102);
    assert.strictEqual(lk.blockingThreadId, 21);
  });

  // ---------------------------------------------------------
  // TEST 15: Wait-For Graph Reconstruction & Edge Extraction
  // ---------------------------------------------------------
  test("15. Wait-For Graph Edge Extraction", () => {
    const jsonl = `
    {"thread_id":20,"query_id":110,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET name = 'A' WHERE id = 1"}}
    {"thread_id":20,"query_id":110,"seq":2,"elapsed_us":150,"event_type":"LOCK_WAIT","stage":"LockWait","details":{"lock_type":"RECORD","lock_mode":"X","table":"student","page_no":4,"granted":false,"waiting_trx_id":501,"waiting_thread_id":20,"blocking_trx_id":502,"blocking_thread_id":21}}
    {"thread_id":20,"query_id":110,"seq":3,"elapsed_us":300,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0,"affected_rows":0}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    const edges = WaitForGraphReconstructor.extractEdges(queries);

    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].waiterTrxId, 501);
    assert.strictEqual(edges[0].blockerTrxId, 502);
    assert.strictEqual(edges[0].table, "student");
    assert.strictEqual(edges[0].pageNo, 4);
  });

  // ---------------------------------------------------------
  // TEST 16: Wait-For Cycle Detection (T501 -> T502 -> T501)
  // ---------------------------------------------------------
  test("16. Wait-For Cycle Detection", () => {
    const edges = [
      { waiterTrxId: 501, blockerTrxId: 502, waiterThreadId: 20, blockerThreadId: 21, table: "student", pageNo: 4 },
      { waiterTrxId: 502, blockerTrxId: 501, waiterThreadId: 21, blockerThreadId: 20, table: "student", pageNo: 4 }
    ];

    const cycles = WaitForGraphReconstructor.detectCycles(edges);
    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(cycles[0], [501, 502, 501]);
  });

  // ---------------------------------------------------------
  // TEST 17: Transaction Lifecycle & MVCC Association
  // ---------------------------------------------------------
  test("17. Transaction Lifecycle & MVCC Association", () => {
    const jsonl = `
    {"thread_id":30,"query_id":120,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"BEGIN"}}
    {"thread_id":30,"query_id":120,"seq":2,"elapsed_us":110,"event_type":"TRANSACTION_BEGIN","stage":"TransactionBegin","details":{}}
    {"thread_id":30,"query_id":120,"seq":3,"elapsed_us":120,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0}}

    {"thread_id":30,"query_id":121,"seq":1,"elapsed_us":200,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"SELECT * FROM student WHERE id = 19020"}}
    {"thread_id":30,"query_id":121,"seq":2,"elapsed_us":210,"event_type":"MVCC_READ_VIEW","stage":"MvccReadView","details":{"creator_trx_id":600,"low_limit_id":601,"up_limit_id":600}}
    {"thread_id":30,"query_id":121,"seq":3,"elapsed_us":220,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0}}

    {"thread_id":30,"query_id":122,"seq":1,"elapsed_us":300,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"COMMIT"}}
    {"thread_id":30,"query_id":122,"seq":2,"elapsed_us":310,"event_type":"TRANSACTION_COMMIT","stage":"TransactionCommit","details":{}}
    {"thread_id":30,"query_id":122,"seq":3,"elapsed_us":320,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    const transactions = TransactionReconstructor.reconstructTransactions(queries);

    assert.strictEqual(transactions.length, 1);
    const tx = transactions[0];
    assert.strictEqual(tx.outcome, "COMMITTED");
    assert.strictEqual(tx.statements.length, 3);
    assert.ok(tx.statements[1].executionInfo.mvcc);
    assert.strictEqual(tx.statements[1].executionInfo.mvcc.readViews[0].creatorTrxId, 600);
  });

  // ---------------------------------------------------------
  // TEST 18: Redo Record Reconstruction
  // ---------------------------------------------------------
  test("18. Redo Record Reconstruction", () => {
    const jsonl = `
    {"thread_id":40,"query_id":200,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET name = 'Test' WHERE id = 1"}}
    {"thread_id":40,"query_id":200,"seq":2,"elapsed_us":150,"event_type":"REDO_RECORD_GENERATED","stage":"RedoRecordGenerated","details":{"start_lsn":845120,"end_lsn":845184,"bytes":64}}
    {"thread_id":40,"query_id":200,"seq":3,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);
    const q = queries[0];
    assert.ok(q.executionInfo.redo);
    assert.strictEqual(q.executionInfo.redo.records.length, 1);
    assert.strictEqual(q.executionInfo.redo.records[0].startLsn, 845120);
    assert.strictEqual(q.executionInfo.redo.records[0].endLsn, 845184);
    assert.strictEqual(q.executionInfo.redo.records[0].bytes, 64);
  });

  // ---------------------------------------------------------
  // TEST 19: Redo Write / Flush Reconstruction
  // ---------------------------------------------------------
  test("19. Redo Write / Flush Reconstruction", () => {
    const jsonl = `
    {"thread_id":40,"query_id":201,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"COMMIT"}}
    {"thread_id":40,"query_id":201,"seq":2,"elapsed_us":150,"event_type":"REDO_LOG_WRITE","stage":"RedoLogWrite","details":{"write_lsn":845184,"bytes":64}}
    {"thread_id":40,"query_id":201,"seq":3,"elapsed_us":180,"event_type":"REDO_LOG_FLUSH","stage":"RedoLogFlush","details":{"flush_lsn":845184}}
    {"thread_id":40,"query_id":201,"seq":4,"elapsed_us":200,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);
    const q = queries[0];
    assert.ok(q.executionInfo.redo);
    assert.strictEqual(q.executionInfo.redo.logWrites.length, 1);
    assert.strictEqual(q.executionInfo.redo.logWrites[0].writeLsn, 845184);
    assert.strictEqual(q.executionInfo.redo.flushes.length, 1);
    assert.strictEqual(q.executionInfo.redo.flushes[0].flushLsn, 845184);
  });

  // ---------------------------------------------------------
  // TEST 20: Dirty Page Lifecycle Reconstruction
  // ---------------------------------------------------------
  test("20. Dirty Page Lifecycle Reconstruction", () => {
    const jsonl = `
    {"thread_id":40,"query_id":202,"seq":1,"elapsed_us":100,"event_type":"COMMAND_START","stage":"ClientInbound","details":{"query":"UPDATE student SET grade = 'A' WHERE id = 2"}}
    {"thread_id":40,"query_id":202,"seq":2,"elapsed_us":120,"event_type":"DIRTY_PAGE_MARKED","stage":"DirtyPageMarked","details":{"space_id":5,"page_no":4,"oldest_lsn":845120}}
    {"thread_id":40,"query_id":202,"seq":3,"elapsed_us":300,"event_type":"DIRTY_PAGE_FLUSH","stage":"DirtyPageFlush","details":{"space_id":5,"page_no":4,"newest_lsn":845184}}
    {"thread_id":40,"query_id":202,"seq":4,"elapsed_us":320,"event_type":"COMMAND_END","stage":"CommandFinish","details":{"error":0}}
    `;

    const events = TraceReader.parseContent(jsonl);
    const queries = QueryReconstructor.reconstructQueries(events);
    assert.strictEqual(queries.length, 1);
    const q = queries[0];
    assert.ok(q.executionInfo.dirtyPages);
    assert.strictEqual(q.executionInfo.dirtyPages.marked.length, 1);
    assert.strictEqual(q.executionInfo.dirtyPages.marked[0].pageNo, 4);
    assert.strictEqual(q.executionInfo.dirtyPages.marked[0].oldestLsn, 845120);
    assert.strictEqual(q.executionInfo.dirtyPages.flushed.length, 1);
    assert.strictEqual(q.executionInfo.dirtyPages.flushed[0].pageNo, 4);
    assert.strictEqual(q.executionInfo.dirtyPages.flushed[0].newestLsn, 845184);
  });

  console.log("==========================================================");
  console.log(` SUMMARY: ${passed} / ${total} TESTS PASSED CLEANLY`);
  console.log("==========================================================");
  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
