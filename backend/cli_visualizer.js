const fs = require('fs');
const path = require('path');

const TRACE_FILE = path.join(__dirname, '..', '..', 'mysql-data', 'query_trace.jsonl');

// ANSI Color Codes for Rich Terminal Styling
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';
const BG_GREEN = '\x1b[42m\x1b[30m';

const STAGES = [
  { type: 'COMMAND_START', name: '1. Client Inbound', fn: 'dispatch_command()' },
  { type: 'LEX_PARSE', name: '2. Lexer & Parser', fn: 'parse_sql()' },
  { type: 'AST_DISPATCH', name: '3. AST & Dispatcher', fn: 'mysql_execute_command()' },
  { type: 'DML_EXECUTE', name: '4. DML Abstract Layer', fn: 'Sql_cmd_dml::execute()' },
  { type: 'TABLE_OPEN', name: '5. Table Open & MDL', fn: 'open_tables_for_query()' },
  { type: 'OPTIMIZE_STAGE', name: '6. Query Optimizer', fn: 'JOIN::optimize()' },
  { type: 'INDEX_SELECT', name: '7. Index Selection', fn: 'handler::ha_index_init()' },
  { type: 'ROW_FETCH', name: '8. Storage Fetch', fn: 'handler::ha_rnd_next()' },
  { type: 'RESULT_SENT', name: '9. Result Sent', fn: 'Query_result_send::send_data()' },
  { type: 'COMMAND_END', name: '10. Command Finish', fn: 'Execution Complete' }
];

let activeStages = new Set();
let activeQuery = 'Waiting for SQL execution...';
let threadId = '-';
let queryId = '-';
let currentElapsed = 0;
let eventLogs = [];
let lastFileSize = 0;

function renderDashboard() {
  process.stdout.write('\x1Bc');

  console.log(`${BOLD}${CYAN}================================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}            ⚡ REAL-TIME MySQL 9.7 QUERY EXECUTION FLOW VISUALIZER ⚡            ${RESET}`);
  console.log(`${BOLD}${CYAN}================================================================================${RESET}\n`);

  console.log(`${GRAY}+------------------------------------------------------------------------------+${RESET}`);
  console.log(`| ${BOLD}Thread ID:${RESET} ${YELLOW}${threadId.toString().padEnd(10)}${RESET} | ${BOLD}Query ID:${RESET} ${YELLOW}${queryId.toString().padEnd(12)}${RESET} | ${BOLD}Total Duration:${RESET} ${GREEN}${(currentElapsed + ' µs').padEnd(12)}${RESET} |`);
  console.log(`${GRAY}+------------------------------------------------------------------------------+${RESET}`);
  console.log(`| ${BOLD}Active Query:${RESET} ${MAGENTA}${activeQuery.padEnd(60)}${RESET} |`);
  console.log(`${GRAY}+------------------------------------------------------------------------------+${RESET}\n`);

  console.log(`${BOLD}EXECUTION PIPELINE FLOW:${RESET}\n`);

  STAGES.forEach((stage, idx) => {
    const isCompleted = activeStages.has(stage.type);
    let box = '';

    if (isCompleted) {
      box = `${BG_GREEN} [✔] ${stage.name.padEnd(25)} ${stage.fn.padEnd(30)} ${RESET}`;
    } else {
      box = `${GRAY} [ ] ${stage.name.padEnd(25)} ${stage.fn.padEnd(30)} ${RESET}`;
    }

    console.log(`   ${box}`);
    if (idx < STAGES.length - 1) {
      console.log(`   ${GRAY}      ↓${RESET}`);
    }
  });

  console.log(`\n${BOLD}REAL-TIME MICROSECOND EVENT TRACE LOGS:${RESET}`);
  console.log(`${GRAY}--------------------------------------------------------------------------------${RESET}`);

  const recentLogs = eventLogs.slice(-8);
  if (recentLogs.length === 0) {
    console.log(`   ${GRAY}Watching query trace log (${TRACE_FILE})...${RESET}`);
  } else {
    recentLogs.forEach(log => {
      console.log(`   ${GREEN}+${(log.elapsed_us + 'µs').padEnd(10)}${RESET} ${CYAN}[${log.event_type.padEnd(15)}]${RESET} ${GRAY}${log.stage}${RESET} ${log.details ? JSON.stringify(log.details) : ''}`);
    });
  }
  console.log(`${GRAY}--------------------------------------------------------------------------------${RESET}`);
}

function processFile() {
  if (!fs.existsSync(TRACE_FILE)) {
    renderDashboard();
    return;
  }

  const stat = fs.statSync(TRACE_FILE);
  if (stat.size <= lastFileSize) return;

  const content = fs.readFileSync(TRACE_FILE, 'utf8');
  const lines = content.split('\n');
  lastFileSize = stat.size;

  activeStages.clear();
  eventLogs = [];

  for (const line of lines) {
    if (line.trim()) {
      try {
        const event = JSON.parse(line.trim());

        if (event.event_type === 'COMMAND_START' && event.details && event.details.query) {
          activeQuery = event.details.query;
          activeStages.clear();
          eventLogs = [];
        }

        if (event.thread_id !== undefined) threadId = event.thread_id;
        if (event.query_id !== undefined) queryId = event.query_id;
        if (event.elapsed_us !== undefined) currentElapsed = event.elapsed_us;

        activeStages.add(event.event_type);
        eventLogs.push(event);
      } catch (e) {}
    }
  }

  renderDashboard();
}

renderDashboard();
processFile();

// Poll file every 200ms
setInterval(processFile, 200);
