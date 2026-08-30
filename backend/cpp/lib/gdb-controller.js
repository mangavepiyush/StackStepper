const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { killProcessTree } = require("./process-limits");
const { detectExecutionState, extractProgramOutput, extractSnapshot } = require("./gdb-parser");

const PROMPT = "__VIZ_GDB_PROMPT__";

class GdbController {
  constructor({ executablePath, sessionDir, runtimeDir, commandTimeoutMs = 4000 }) {
    this.executablePath = executablePath;
    this.sessionDir = sessionDir;
    this.runtimeDir = runtimeDir;
    this.commandTimeoutMs = commandTimeoutMs;
    this.process = null;
    this.stdoutBuffer = "";
    this.pending = [];
    this.inferiorPid = null;
    this.programOutput = "";
  }

  async start() {
    const bundledGdb = path.join(__dirname, "..", "..", "..", "runtime", "mingw", "bin", "gdb.exe");
    const gdbCommand = fs.existsSync(bundledGdb) ? bundledGdb : "gdb";

    this.process = spawn(gdbCommand, ["--quiet", "--nx"], {
      cwd: this.sessionDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      this.flushIfPrompted();
    });

    this.process.stderr.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      this.flushIfPrompted();
    });

    this.process.on("exit", () => {
      while (this.pending.length) {
        const pending = this.pending.shift();
        pending.reject(new Error("gdb terminated unexpectedly"));
      }
    });

    await this.waitForInitialPrompt();
    await this.execute(`set prompt ${PROMPT}`);
    await this.execute("set pagination off");
    await this.execute("set confirm off");
    await this.execute("set style enabled off");
    await this.execute("set suppress-cli-notifications on");
    await this.execute("set print thread-events off");
    await this.execute("set print pretty on");
    await this.execute("set print array on");
    await this.execute("set max-value-size unlimited");
    await this.execute(`file "${normalizeForGdb(this.executablePath)}"`);
    await this.execute(`python gdb.execute(r"""source ${normalizeForGdb(path.join(this.runtimeDir, "viz_gdb.py"))}""")`);
    await this.execute("skip file allocation_tracker.cpp");
    await this.execute("skip -rfu ^std::.*");
    await this.execute("skip -rfu ^__gnu_cxx::.*");
    await this.execute("skip -rfu ^__gnu_debug::.*");
    const helperCheck = await this.execute("help viz-snapshot");
    if (helperCheck.toLowerCase().includes("undefined command")) {
      throw new Error("Failed to register the GDB snapshot helper.");
    }
    await this.execute("break main");
  }

  async runToMain() {
    const output = await this.execute("run", { timeoutMs: 5000 });
    const outputChunk = this.captureProgramOutput(output);
    const state = detectExecutionState(output);
    if (state && state.state === "exited") {
      return this.decorateSnapshot(
        { state: "exited", finished: true, reason: state.reason },
        outputChunk
      );
    }
    return this.decorateSnapshot(await this.snapshot(), outputChunk);
  }

  async stepOver() {
    const output = await this.execute("next", { timeoutMs: 5000 });
    return this.snapshotAfterExecution(output);
  }

  async stepInto() {
    const output = await this.execute("step", { timeoutMs: 5000 });
    return this.snapshotAfterExecution(output);
  }

  async continueExecution() {
    const output = await this.execute("continue", { timeoutMs: 5000 });
    return this.snapshotAfterExecution(output);
  }

  async snapshotAfterExecution(output) {
    const outputChunk = this.captureProgramOutput(output);
    const state = detectExecutionState(output);
    if (state && state.state === "exited") {
      return this.decorateSnapshot(
        { state: "exited", finished: true, reason: state.reason },
        outputChunk
      );
    }
    return this.decorateSnapshot(await this.snapshot(), outputChunk);
  }

  async snapshot() {
    const output = await this.execute("viz-snapshot");
    const snapshot = extractSnapshot(output);
    if (!snapshot) {
      throw new Error("Debugger did not return a snapshot.");
    }
    this.inferiorPid = snapshot.inferiorPid || this.inferiorPid;
    return snapshot;
  }

  captureProgramOutput(output) {
    const outputChunk = extractProgramOutput(output);
    if (!outputChunk) {
      return "";
    }

    if (this.programOutput && !this.programOutput.endsWith("\n")) {
      this.programOutput += "\n";
    }

    this.programOutput += outputChunk;
    return outputChunk;
  }

  decorateSnapshot(snapshot, outputChunk = "") {
    return {
      ...snapshot,
      outputChunk,
      programOutput: this.programOutput,
    };
  }

  async execute(command, options = {}) {
    const timeoutMs = options.timeoutMs || this.commandTimeoutMs;
    if (!this.process || this.process.killed) {
      throw new Error("gdb is not running");
    }

    return new Promise((resolve, reject) => {
      const pendingCommand = {
        resolve: (output) => {
          clearTimeout(timer);
          resolve(output);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };

      const timer = setTimeout(() => {
        const pendingIndex = this.pending.indexOf(pendingCommand);
        if (pendingIndex !== -1) {
          this.pending.splice(pendingIndex, 1);
        }

        if (this.inferiorPid) {
          killProcessTree(this.inferiorPid).catch(() => {});
        }

        if (this.process) {
          this.process.kill("SIGKILL");
          this.process = null;
        }

        reject(new Error(`gdb command timed out: ${command}`));
      }, timeoutMs);

      this.pending.push(pendingCommand);

      this.process.stdin.write(`${command}\n`);
    });
  }

  waitForInitialPrompt() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("gdb did not present its initial prompt."));
      }, this.commandTimeoutMs);

      const read = () => {
        const promptIndex = this.stdoutBuffer.indexOf("(gdb)");
        if (promptIndex !== -1) {
          clearTimeout(timeout);
          this.stdoutBuffer = this.stdoutBuffer.slice(promptIndex + "(gdb)".length);
          resolve();
          return;
        }
        setTimeout(read, 10);
      };

      read();
    });
  }

  flushIfPrompted() {
    let promptIndex = this.stdoutBuffer.indexOf(PROMPT);
    while (promptIndex !== -1 && this.pending.length) {
      const output = this.stdoutBuffer.slice(0, promptIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(promptIndex + PROMPT.length);
      const pending = this.pending.shift();
      pending.resolve(output);
      promptIndex = this.stdoutBuffer.indexOf(PROMPT);
    }
  }

  async dispose() {
    if (!this.process) {
      return;
    }

    if (this.inferiorPid) {
      await killProcessTree(this.inferiorPid);
    }

    this.process.kill("SIGKILL");
    this.process = null;
    this.programOutput = "";
  }
}

function normalizeForGdb(inputPath) {
  return inputPath.replace(/\\/g, "/");
}

module.exports = {
  GdbController,
};
