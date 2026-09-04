# StackStepper

A portable educational debugging and visualization platform for understanding program execution, memory, stacks, and SQL query execution.

StackStepper bundles two integrated labs into a single self-contained application:

- **C++ Memory Lab** — write, compile, and step through C++ programs with live heap/stack memory visualization powered by GDB.
- **SQL Engine Lab** — run SQL queries against a real MySQL engine and watch execution unfold step-by-step with JOIN provenance visualization.

---

## Features

### C++ Memory Lab
- Write C++ programs directly in the browser
- Compile with the bundled GCC/G++ toolchain (MinGW)
- Step through execution using GDB-based tracing
- Visualize stack frames, heap allocations, and pointer relationships in real time
- Custom allocation tracker instruments `new`/`delete` to record heap events
- GDB Python scripting extracts memory snapshots at each step

### SQL Engine Lab
- Execute SQL queries against the bundled MySQL server
- Visualize query execution: table scans, index lookups, and JOIN operations
- JOIN provenance visualization — see which rows from each table contributed to each result row
- MySQL QueryTracer plugin emits real-time telemetry events over TCP
- Step-through and forward visualization of query execution

---

## Architecture

StackStepper runs as a set of coordinated local services, all launched and managed by a single entry point.

```
StackStepper.exe  (C# launcher / process manager)
│
├── MySQL QueryTracer Server         → port 3307  (bundled mysqld)
│     └── QueryTracer TCP telemetry → port 19999
│
├── SQL Engine Visualizer Gateway    → port 18080  (Node.js)
│     └── Consumes telemetry from port 19999
│
└── C++ Memory Stepper Backend       → port 3000   (Node.js)
      └── Serves the unified web shell + C++ Lab frontend
```

### Components

| Component | Location | Purpose |
|---|---|---|
| `StackStepper.exe` | Root | C# GUI launcher — starts all services, enforces single instance, manages process lifecycle |
| `backend/cpp/` | Backend | C++ stepper Node.js API — compiles C++ code, drives GDB, extracts snapshots |
| `backend/index.js` | Backend | SQL Engine Gateway — HTTP API + MySQL QueryTracer TCP consumer |
| `frontend/` | Frontend | Unified web shell, C++ Memory Lab UI, SQL Engine Lab UI |
| `runtime/mingw/` | Runtime | Bundled MinGW toolchain — GCC, G++, GDB |
| `runtime/node/` | Runtime | Bundled Node.js runtime |
| `mysql/` | Runtime | Bundled MySQL server binaries |
| `mysql-config/` | Config | MySQL configuration (`my.cnf`) — auto-updated to current install path on startup |
| `launcher/` | Source | C# launcher source code |

---

## Quick Start

### Recommended: Use the GUI Launcher

Double-click **`StackStepper.exe`** in the root folder.

The launcher will:
1. Start the QueryTracer MySQL server on port 3307
2. Start the SQL Engine Visualizer Gateway on port 18080
3. Start the C++ Memory Stepper Backend on port 3000
4. Open the unified StackStepper web interface in your default browser at `http://localhost:3000`

A system tray icon is shown while the application is running.

### Alternative: Batch Script

If you prefer to start without the GUI launcher, double-click **`Start-StackStepper.bat`** in the root folder.

To stop all services: double-click **`Stop-StackStepper.bat`**.

> **First run:** On the very first launch, the startup sequence initializes the MySQL data directory. This may take up to 30–60 seconds. Subsequent launches are faster.

---

## Ports Used

| Port | Service |
|---|---|
| `3000` | C++ Memory Stepper Backend — also serves the unified web shell |
| `18080` | SQL Engine Visualizer Gateway (HTTP API) |
| `3307` | Bundled MySQL server (non-standard port to avoid conflicts with system MySQL) |
| `19999` | QueryTracer TCP telemetry stream (internal, MySQL → SQL Gateway) |

All services bind to `127.0.0.1` (localhost only). No external network access is required or used.

---

## Requirements

### What is Bundled (no installation needed)
- ✅ Node.js runtime (`runtime/node/`)
- ✅ MinGW toolchain — GCC, G++, GDB (`runtime/mingw/`)
- ✅ MySQL server with QueryTracer plugin (`mysql/`)
- ✅ All Node.js backend dependencies (`node_modules/`)
- ✅ All frontend assets

### What You Need
- Windows 10 or Windows 11 (64-bit)
- No internet access required after obtaining the package
- No Visual Studio, Node.js, MySQL, or MinGW installation required

> The application is designed to be fully self-contained. It does not rely on any paths, environment variables, or software from the developer's original machine.

---

## Project Structure

```
StackStepper_Portable/
│
├── StackStepper.exe          ← Main GUI launcher (recommended entry point)
├── Start-StackStepper.bat    ← Batch script launcher (alternative)
├── Stop-StackStepper.bat     ← Stops all running services
├── setup.bat                 ← First-time setup helper
├── package.json
├── .gitignore
├── .gitattributes            ← Git LFS tracking (mysqld.exe)
│
├── backend/
│   ├── index.js              ← SQL Engine Gateway (port 18080 + TCP 19999 consumer)
│   ├── trace_parser.js       ← QueryTracer NDJSON event reader
│   └── cpp/
│       ├── index.js          ← C++ Stepper backend (port 3000)
│       └── lib/
│           ├── gdb-controller.js   ← GDB CLI automation
│           ├── cpp-compiler.js     ← GCC/G++ compilation with SHA-256 caching
│           ├── session-manager.js  ← Debug session orchestration
│           └── ...
│
├── frontend/
│   ├── shell/                ← Unified web shell (tab switcher, health monitor)
│   ├── cpp/                  ← C++ Memory Lab React frontend
│   └── sql/                  ← SQL Engine Lab frontend + visualization
│
├── launcher/
│   └── Program.cs            ← C# launcher source (single-instance, Job Object lifecycle)
│
├── runtime/
│   ├── node/                 ← Bundled Node.js runtime
│   ├── mingw/                ← Bundled MinGW (GCC, G++, GDB, DLLs)
│   ├── start.js              ← Service orchestration script
│   ├── setup.js              ← First-time initialization script
│   └── stop.js               ← Service shutdown script
│
├── mysql/
│   ├── bin/                  ← MySQL server binaries (mysqld.exe — tracked via Git LFS)
│   ├── lib/                  ← MySQL client library and plugins
│   └── share/                ← MySQL locale and error message files
│
├── mysql-config/
│   └── my.cnf                ← MySQL configuration (path-relative, auto-updated on startup)
│
└── cpp/
    └── runtime/              ← C++ runtime support files (allocation_tracker, viz_gdb.py)
```

> **`mysql-data/`** — The MySQL data directory is created at runtime on first launch and is excluded from version control (`.gitignore`). It contains host-specific binary InnoDB data and should not be confused with the bundled application files.

---

## C++ Memory Lab

The C++ Memory Lab allows you to write, compile, and step through C++ programs with real-time memory visualization.

**How it works:**
1. Write or paste a C++ program into the editor
2. Click **Compile & Debug** — the backend compiles it using the bundled G++ compiler
3. Step through execution — GDB drives the program one step at a time
4. At each step, a GDB Python script (`viz_gdb.py`) extracts a memory snapshot: stack frames, local variables, heap-allocated objects, and pointer relationships
5. A custom allocation tracker (`allocation_tracker.cpp`) instruments `new`/`delete` to record all heap events
6. The frontend renders the snapshot as an interactive memory graph

**Capabilities:**
- Forward step-by-step execution
- Stack frame inspection (function calls, local variables, argument values)
- Heap visualization (allocated objects, their types and sizes)
- Pointer tracking (which pointers reference which objects)
- GDB-based — supports standard C++ programs

**Note:** Programs are compiled fresh for each session. Compiled binaries are cached by SHA-256 of the source to avoid redundant recompilation.

---

## SQL Engine Lab

The SQL Engine Lab lets you run SQL queries against a real MySQL database engine with live execution visualization powered by the QueryTracer plugin.

**How it works:**
1. Type a SQL query into the editor and execute it
2. The SQL Gateway forwards the query to MySQL running on port 3307
3. The custom QueryTracer MySQL plugin emits structured telemetry events over TCP (port 19999) as the query executes
4. The Gateway correlates events by thread ID and builds an execution model
5. The frontend visualizes the execution: table access patterns, JOIN operations, and result construction

**Capabilities:**
- Real SQL execution against a live MySQL engine
- Visualization of table scans and index lookups
- JOIN visualization with provenance — which rows from each table matched and contributed to each result row
- Step-through visualization of query execution
- QueryTracer telemetry integration

**Intentional limitation:** Subquery visualization is not supported. Standard SELECT, JOIN, aggregation, and DML queries are supported.

---

## Data and Runtime State

- **`mysql-data/`** — Created automatically on first launch. Contains the MySQL InnoDB data directory, undo logs, redo logs, and process files. This is runtime-generated data local to your machine and is excluded from version control.
- **`.sessions/`** — Temporary C++ debug session workspace directories. Excluded from version control.
- **`.cache/`** — Compilation cache. Excluded from version control.
- **`*.log`** — Log files generated at runtime. Excluded from version control.

---

## Portability

This distribution is designed to be self-contained and portable on Windows.

On every launch, `runtime/start.js` automatically rewrites `mysql-config/my.cnf` to use the current installation path. This means the application works regardless of where you place the folder — no manual path configuration is required.

The application does not write to the Windows registry, does not modify system environment variables, and does not require administrator privileges for normal operation.

---

## Limitations

- **Windows only** — The bundled runtimes (MinGW, MySQL, Node.js) are Windows 64-bit binaries.
- **Localhost only** — All services bind to `127.0.0.1`. The application is not designed to be exposed to a network.
- **Single instance** — The GUI launcher enforces single-instance operation via a named Windows mutex.
- **Subquery visualization** — Not supported in the SQL Engine Lab.
- **Port conflicts** — If ports 3000, 3307, 18080, or 19999 are already in use on the target machine by another application, startup will fail.

---

## Development Notes

This repository is the **portable distribution** of StackStepper. It contains the compiled launcher, all bundled runtimes, and the complete application source as deployed.

The launcher (`StackStepper.exe`) is a compiled C# Windows Forms application. Its source is included in `launcher/Program.cs`. It uses a Windows Job Object to ensure all child processes (MySQL, Node backends) are terminated when the launcher exits, preventing orphan processes.

`mysql/bin/mysqld.exe` is tracked using **Git Large File Storage (Git LFS)** because it exceeds GitHub's 100 MB file size limit. When cloning this repository, ensure Git LFS is installed (`git lfs install`) before cloning, or run `git lfs pull` after cloning to obtain the MySQL server binary.

---

## License

The `package.json` specifies `"license": "MIT"` for the StackStepper application code.

Bundled third-party components (Node.js, MinGW/GCC/GDB, MySQL) are distributed under their respective licenses. Refer to the documentation of each component for details.

---

*StackStepper — built for learning how programs actually work.*
