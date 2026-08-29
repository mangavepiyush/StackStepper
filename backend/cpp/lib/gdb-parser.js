function extractSnapshot(output) {
  const startMarker = "__VIZ_SNAPSHOT_BEGIN__";
  const endMarker = "__VIZ_SNAPSHOT_END__";
  const start = output.indexOf(startMarker);
  const end = output.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const payload = output.slice(start + startMarker.length, end).trim();

  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`Failed to parse snapshot JSON: ${error.message}`);
  }
}

function extractProgramOutput(output) {
  const withoutSnapshot = output.replace(/__VIZ_SNAPSHOT_BEGIN__[\s\S]*?__VIZ_SNAPSHOT_END__/g, "");
  const normalized = withoutSnapshot.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const filtered = [];
  let sawNonEmptyOutput = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (sawNonEmptyOutput) {
        filtered.push("");
      }
      continue;
    }

    if (
      /^Breakpoint \d+ at /i.test(trimmed) ||
      /^(Temporary )?Breakpoint \d+[, ]/i.test(trimmed) ||
      /^Thread \d+ hit /i.test(trimmed) ||
      /^\[New Thread /i.test(trimmed) ||
      /^\[Thread /i.test(trimmed) ||
      /^\[Inferior \d+ .* exited .*\]$/i.test(trimmed) ||
      /^Single stepping until exit from function /i.test(trimmed) ||
      /^which has no line number information\.$/i.test(trimmed) ||
      /^Starting program:/i.test(trimmed) ||
      /^warning:/i.test(trimmed)
    ) {
      continue;
    }

    filtered.push(line);
    sawNonEmptyOutput = true;
  }

  while (filtered.length && filtered[filtered.length - 1] === "") {
    filtered.pop();
  }

  return filtered.join("\n");
}

function detectExecutionState(output) {
  const normalized = output.toLowerCase();

  if (normalized.includes("exited normally")) {
    return { state: "exited", reason: "exited normally" };
  }

  if (normalized.includes("received signal")) {
    return { state: "signaled", reason: "program received signal" };
  }

  if (normalized.includes("breakpoint")) {
    return { state: "stopped", reason: "breakpoint" };
  }

  if (normalized.includes("single stepping")) {
    return { state: "stopped", reason: "single stepping" };
  }

  return null;
}

module.exports = {
  extractProgramOutput,
  extractSnapshot,
  detectExecutionState,
};
