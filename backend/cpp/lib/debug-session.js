const fs = require("fs");
const path = require("path");
const { compileProgram } = require("./cpp-compiler");
const { GdbController } = require("./gdb-controller");
const { MemoryMonitor, killProcessTree } = require("./process-limits");
const { createId, delay } = require("./utils");
const { detectDataStructure } = require("./ml-detector");

class DebugSession {
  constructor({ socket, workspaceRoot, runtimeRoot }) {
    this.id = createId();
    this.socket = socket;
    this.workspaceRoot = workspaceRoot;
    this.runtimeRoot = runtimeRoot;
    this.sessionDir = path.join(workspaceRoot, this.id);
    this.gdb = null;
    this.lastCode = "";
    this.memoryMonitor = new MemoryMonitor({
      limitBytes: 256 * 1024 * 1024,
    });
    this.operationChain = Promise.resolve();
    this.limits = {
      compileTimeoutMs: 10000,
      commandTimeoutMs: 5000,
      memoryLimitMb: 256,
      autoStepDelayMs: 300,
      autoStepMaxSteps: 400,
    };
  }

  getLimits() {
    return this.limits;
  }

  async compileAndStart(code) {
    return this.runExclusive(async () => {
      await this.compileAndStartInternal(code);
    });
  }

  async compileAndStartInternal(code) {
      if (!code.trim()) {
        throw new Error("Please enter some C++ code.");
      }

      this.lastCode = code;
      await this.resetDebugger();
      this.socket.sendJson({ type: "status", phase: "compiling" });

      const compilePromise = compileProgram({
        sessionDir: this.sessionDir,
        runtimeDir: this.runtimeRoot,
        code,
        timeoutMs: this.limits.compileTimeoutMs,
      });

      const detectionPromise = detectDataStructure(this.sessionDir, code).catch((err) => {
        console.log("[ML Detector] Detection error:", err ? err.message : err);
        return { primary: "General", confidence: "low" };
      });

      const compileResult = await compilePromise;

      if (!compileResult.ok) {
        this.socket.sendJson({
          type: "compile-error",
          error: compileResult.stderr || compileResult.stdout || compileResult.error,
        });
        return;
      }

      detectionPromise.then((detection) => {
        this.lastDetection = detection;
        this.socket.sendJson({
          type: "detected-structure",
          structure: detection.primary,
          confidence: detection.confidence,
          detection,
          source: "ast-detector",
        });
      });

      this.socket.sendJson({
        type: "compile-succeeded",
        executablePath: compileResult.outputPath,
        cached: compileResult.cached,
      });

      this.gdb = new GdbController({
        executablePath: compileResult.outputPath,
        sessionDir: this.sessionDir,
        runtimeDir: this.runtimeRoot,
        commandTimeoutMs: this.limits.commandTimeoutMs,
      });

      await this.gdb.start();
      const snapshot = await this.gdb.runToMain();
      await this.handleSnapshot(snapshot);
  }

  async stepOver() {
    return this.runExclusive(async () => {
      this.ensureStarted();
      const snapshot = await this.withMemoryGuard(() => this.gdb.stepOver());
      await this.handleSnapshot(snapshot);
    });
  }

  async stepInto() {
    return this.runExclusive(async () => {
      this.ensureStarted();
      const snapshot = await this.withMemoryGuard(() => this.gdb.stepInto());
      await this.handleSnapshot(snapshot);
    });
  }

  async continueExecution() {
    return this.runExclusive(async () => {
      this.ensureStarted();
      await this.runAutoStepPlayback();
    });
  }

  async restart() {
    return this.runExclusive(async () => {
      if (!this.lastCode) {
        return;
      }
      await this.compileAndStartInternal(this.lastCode);
    });
  }

  async withMemoryGuard(runCommand) {
    const pid = this.gdb && this.gdb.inferiorPid;

    if (pid) {
      this.memoryMonitor.start(pid, async (workingSet) => {
        await killProcessTree(pid);
        this.socket.sendJson({
          type: "session-error",
          error: `Program exceeded memory limit (${Math.round(workingSet / (1024 * 1024))} MB).`,
        });
      });
    }

    try {
      return await runCommand();
    } finally {
      this.memoryMonitor.stop();
    }
  }

  async runAutoStepPlayback() {
    this.socket.sendJson({
      type: "status",
      phase: "running",
    });

    for (let stepCount = 0; stepCount < this.limits.autoStepMaxSteps; stepCount += 1) {
      const snapshot = await this.withMemoryGuard(() => this.gdb.stepInto());
      const finished = await this.handleSnapshot(snapshot, { playbackActive: !snapshot.finished && snapshot.state !== "exited" });

      if (finished) {
        return;
      }

      await delay(this.limits.autoStepDelayMs);
    }

    this.socket.sendJson({
      type: "status",
      phase: "stopped",
      message: `Auto-step paused after ${this.limits.autoStepMaxSteps} steps to avoid an endless run.`,
    });
  }

  async handleSnapshot(snapshot, metadata = {}) {
    if (!snapshot) {
      return false;
    }

    snapshot.detectedStructure = this.lastDetection || null;

    if (snapshot.finished || snapshot.state === "exited") {
      this.socket.sendJson({
        type: "execution-finished",
        snapshot,
      });
      return true;
    }

    this.socket.sendJson({
      type: "snapshot",
      snapshot,
      ...metadata,
    });

    return false;
  }

  ensureStarted() {
    if (!this.gdb) {
      throw new Error("Compile and start a program first.");
    }
  }

  async resetDebugger() {
    this.memoryMonitor.stop();
    if (this.gdb) {
      await this.gdb.dispose();
      this.gdb = null;
    }
  }

  async dispose() {
    await this.resetDebugger();
    try {
      await fs.promises.rm(this.sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {}
  }

  runExclusive(task) {
    const nextOperation = this.operationChain.then(task, task);
    this.operationChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}

module.exports = {
  DebugSession,
};
