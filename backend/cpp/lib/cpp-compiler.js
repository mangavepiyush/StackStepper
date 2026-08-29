const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const CACHE_DIR = path.join(__dirname, "..", "..", "..", ".cache", "binaries");

async function compileProgram({
  sessionDir,
  runtimeDir,
  code,
  timeoutMs = 10000,
}) {
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });

  const sourcePath = path.join(sessionDir, "program.cpp");
  const trackerPath = path.join(runtimeDir, "allocation_tracker.cpp");
  const outputPath = path.join(sessionDir, "program.exe");

  await fs.promises.writeFile(sourcePath, code, "utf8");

  const trackerContent = await fs.promises.readFile(trackerPath, "utf8").catch(() => "");
  const flags = ["-g", "-O0", "-std=c++20", "-Wall", "-Wextra"];
  
  const hash = crypto
    .createHash("sha256")
    .update(code)
    .update(trackerContent)
    .update(flags.join(" "))
    .digest("hex");

  const cachedExePath = path.join(CACHE_DIR, `prog_${hash}.exe`);

  if (fs.existsSync(cachedExePath)) {
    console.log(`[Compilation Cache] Hit! Reusing cached binary for hash: ${hash.substring(0, 8)}`);
    await fs.promises.copyFile(cachedExePath, outputPath);
    return {
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
      error: null,
      sourcePath,
      outputPath,
      cached: true,
    };
  }

  const args = [
    ...flags,
    sourcePath,
    trackerPath,
    "-o",
    outputPath,
  ];

  const bundledGxx = path.join(__dirname, "..", "..", "..", "runtime", "mingw", "bin", "g++.exe");
  const gxxCommand = fs.existsSync(bundledGxx) ? bundledGxx : "g++";

  const result = await runProcess(gxxCommand, args, {
    cwd: sessionDir,
    timeoutMs,
  });

  if (result.ok && fs.existsSync(outputPath)) {
    try {
      await fs.promises.copyFile(outputPath, cachedExePath);
    } catch (e) {}
  }

  return {
    ...result,
    sourcePath,
    outputPath,
    cached: false,
  };
}

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout,
        stderr,
        error: timedOut ? "Compilation timed out." : code === 0 ? null : "Compilation failed.",
      });
    });
  });
}

module.exports = {
  compileProgram,
};
