const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const DETECTOR_EXE = path.join(__dirname, "..", "..", "..", "ml", "bin", "structure_detector.exe");

async function detectDataStructure(sessionDir, code) {
  if (!fs.existsSync(DETECTOR_EXE)) {
    console.log("[ML Detector] Executable not found:", DETECTOR_EXE);
    return { primary: "Unknown", confidence: "low", reasons: ["Detector executable not found"] };
  }

  const rootDir = path.join(__dirname, "..", "..", "..");
  const scratchDir = path.join(rootDir, "scratch");
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  const tempCodePath = path.join(scratchDir, `source_detect_${Date.now()}.cpp`);
  try {
    await fs.promises.writeFile(tempCodePath, code, "utf8");
    const relCodePath = path.relative(rootDir, tempCodePath).replace(/\\/g, "/");
    const cmd = `"${DETECTOR_EXE}" --json "${relCodePath}"`;
    console.log("[ML Detector] Executing:", cmd);

    return await new Promise((resolve) => {
      exec(cmd, { cwd: rootDir, timeout: 25000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const output = stdout && stdout.trim() ? stdout.trim() : (stderr && stderr.trim() ? stderr.trim() : "");
        
        if (output) {
          try {
            const parsed = JSON.parse(output);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const first = parsed[0];
              const result = {
                primary: first.primary || "General",
                confidence: first.confidence || "medium",
                ambiguous: first.ambiguous || false,
                detections: first.detections || [],
                types: first.types || [],
                instances: first.instances || [],
                structure_instances: first.structure_instances || [],
              };
              console.log(`[ML Detector] Prediction: ${result.primary} (${result.confidence})`);
              resolve(result);
              return;
            }
          } catch (e) {
            console.log("[ML Detector] Parse exception:", e.message);
          }
        }

        console.log("[ML Detector] Fallback to General mode.");
        resolve({ primary: "General", confidence: "low" });
      });
    });
  } catch (e) {
    console.log("[ML Detector] Exception:", e.message);
    return { primary: "General", confidence: "low", error: e.message };
  }
}

module.exports = {
  detectDataStructure,
};
