const { spawn } = require("child_process");

class MemoryMonitor {
  constructor({ limitBytes, pollIntervalMs = 100 }) {
    this.limitBytes = limitBytes;
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
    this.triggered = false;
  }

  start(pid, onLimitExceeded) {
    this.stop();
    this.triggered = false;
    this.timer = setInterval(async () => {
      try {
        const workingSet = await getWorkingSetBytes(pid);
        if (!this.triggered && workingSet !== null && workingSet > this.limitBytes) {
          this.triggered = true;
          onLimitExceeded(workingSet);
        }
      } catch (error) {
        // Ignore short-lived lookup failures while the inferior is starting or stopping.
      }
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.triggered = false;
  }
}

function getWorkingSetBytes(pid) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty WorkingSet64)`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || stderr.trim()) {
        resolve(null);
        return;
      }

      const value = Number(stdout.trim());
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

module.exports = {
  MemoryMonitor,
  killProcessTree,
};
