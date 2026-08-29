const { useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

function buildCurvedPath(x1, y1, x2, y2) {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    return "";
  }
  const dx = Math.max(45, Math.abs(x2 - x1) * 0.4);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

class VisualizerErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Visualizer Error Boundary caught exception:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "24px", background: "#fef2f2", border: "2px solid #ef4444", borderRadius: "12px", margin: "20px", color: "#991b1b" }}>
          <h3 style={{ margin: "0 0 8px" }}>⚠️ Memory Visualizer Render Error</h3>
          <p style={{ margin: "0 0 12px", fontSize: "0.9rem" }}>
            <strong>Error:</strong> {String(this.state.error?.message || this.state.error)}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ background: "#ef4444", color: "#ffffff", border: "none", padding: "6px 14px", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
          >
            Reset Renderer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const DEFAULT_CODE = `#include <iostream>
#include <list>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

struct Node {
    int value;
    Node* next;
};

struct TreeNode {
    int value;
    TreeNode* left;
    TreeNode* right;
};

int main() {
    int arr[4] = {4, 1, 3, 2};
    int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
    std::string text = "hello";
    std::vector<int> vec{7, 8, 9};
    std::list<int> lst{10, 11};
    std::map<int, std::string> mp{{1, "one"}, {2, "two"}};
    std::unordered_map<int, int> um{{3, 30}, {4, 40}};

    Node* head = new Node{1, nullptr};
    head->next = new Node{2, nullptr};

    TreeNode* root = new TreeNode{5, nullptr, nullptr};
    root->left = new TreeNode{3, nullptr, nullptr};
    root->right = new TreeNode{8, nullptr, nullptr};

    std::cout << text << " " << vec[0] << "\\n";

    delete head->next;
    delete head;
    delete root->left;
    delete root->right;
    delete root;
    return arr[0] + grid[1][2] + um[3];
}
`;

const MIN_PLAYBACK_DELAY_MS = 50;
const MAX_PLAYBACK_DELAY_MS = 5000;
const PLAYBACK_DELAY_STEP_MS = 50;
const DEFAULT_PLAYBACK_DELAY_MS = 1400;

const PRESET_EXAMPLES = {
  stackVar: `#include <iostream>
int main() {
    int x = 42;
    double pi = 3.14159;
    int arr[4] = {10, 20, 30, 40};
    std::cout << x << " " << arr[2] << "\\n";
    return 0;
}`,
  heapPointer: `#include <iostream>
int main() {
    int* p = new int(100);
    double* d = new double(2.718);
    std::cout << *p << "\\n";
    delete p;
    delete d;
    return 0;
}`,
  linkedList: `#include <iostream>
struct Node {
    int data;
    Node* next;
};
int main() {
    Node* head = new Node{1, nullptr};
    head->next = new Node{2, nullptr};
    head->next->next = new Node{3, nullptr};
    delete head->next->next;
    delete head->next;
    delete head;
    return 0;
}`,
  tree: `#include <iostream>
struct TreeNode {
    int val;
    TreeNode* left;
    TreeNode* right;
};
int main() {
    TreeNode* root = new TreeNode{5, nullptr, nullptr};
    root->left = new TreeNode{3, nullptr, nullptr};
    root->right = new TreeNode{8, nullptr, nullptr};
    delete root->left;
    delete root->right;
    delete root;
    return 0;
}`,
  multiPointer: `#include <iostream>
struct DNode {
    int val;
    DNode* prev;
    DNode* next;
};
int main() {
    DNode* n1 = new DNode{10, nullptr, nullptr};
    DNode* n2 = new DNode{20, n1, nullptr};
    n1->next = n2;
    delete n2;
    delete n1;
    return 0;
}`
};

function App() {
  const [socketState, setSocketState] = useState("connecting");
  const [phase, setPhase] = useState("idle");
  const [code, setCode] = useState(DEFAULT_CODE);
  const [detection, setDetection] = useState(null);
  const [message, setMessage] = useState("Connect the backend, compile, then step through the real debugger.");
  const [messageTone, setMessageTone] = useState("neutral");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [playbackSpeed, setPlaybackSpeed] = useState(DEFAULT_PLAYBACK_DELAY_MS);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [executionFinished, setExecutionFinished] = useState(false);
  const [vizMode, setVizMode] = useState("simple"); // "simple" (educational) | "detailed" (gdb memory)
  const socketRef = useRef(null);
  const editorRef = useRef(null);
  const editorBackdropRef = useRef(null);
  const containerRef = useRef(null);
  const sourceAnchorsRef = useRef(new Map());
  const targetAnchorsRef = useRef(new Map());
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const pendingStepRef = useRef(false);
  const autoPlayRef = useRef(false);
  const autoStartOnFirstSnapshotRef = useRef(false);
  const [arrows, setArrows] = useState([]);
  const snapshot = historyIndex >= 0 ? history[historyIndex] : null;

  const memoryModel = useMemo(() => {
    if (!snapshot) {
      return {
        stackFrames: [],
        heapObjects: [],
        pointerEdges: [],
        activeAddresses: new Set(),
      };
    }

    // 1. STACK FRAMES & LOCALS (Only valid active runtime variables from current snapshot)
    const stackFrames = (snapshot.stack || []).map((frame, fIdx) => {
      const rawLocals = frame.locals || [];
      const validLocals = rawLocals.filter((loc) => {
        const disp = String(loc.value !== undefined ? loc.value : (loc.display || ''));
        if (disp.includes("<error") || disp.includes("<unavailable") || loc.kind === "unavailable") return false;
        if (loc.isArgument) return true;
        // Exclude local variables whose declaration line is strictly after the current frame line
        if (loc.declaredLine && frame.line && loc.declaredLine > frame.line) return false;
        return true;
      });

      return {
        ...frame,
        index: fIdx,
        locals: validLocals,
      };
    });

    // 2. HEAP OBJECTS (Only active allocations from current snapshot.heap.allocations)
    const rawAllocations = snapshot.heap?.allocations || [];
    const validAllocations = rawAllocations.filter((alloc) => {
      return alloc && alloc.active && alloc.address && alloc.address !== "0x0";
    });

    // 2b. RAW HEAP OBJECTS FOR DETAILED MODE (All active GDB-tracked allocations from snapshot.heap.allAllocations || snapshot.heap.allocations)
    const allRawAllocations = snapshot.heap?.allAllocations || snapshot.heap?.allocations || [];
    const validRawAllocations = allRawAllocations.filter((alloc) => {
      return alloc && alloc.active && alloc.address && alloc.address !== "0x0";
    });

    const activeAddresses = new Set(
      validAllocations.map((a) => String(a.address).toLowerCase())
    );

    // 3. POINTER EDGES (Only edges where target address exists in current snapshot heap allocations)
    const rawEdges = snapshot.heap?.edges || [];
    const validEdges = rawEdges.filter((edge) => {
      if (!edge || !edge.to) return false;
      const targetAddr = String(edge.to).toLowerCase();
      // HARD BOUNDARY RULE: Target address MUST exist in current snapshot heap allocations
      return activeAddresses.has(targetAddr);
    });

    return {
      stackFrames,
      heapObjects: validAllocations,
      rawHeapObjects: validRawAllocations,
      pointerEdges: validEdges,
      activeAddresses,
    };
  }, [snapshot]);

  const syncHistory = (nextHistory, nextIndex = nextHistory.length - 1) => {
    historyRef.current = nextHistory;
    historyIndexRef.current = nextIndex;
    setHistory(nextHistory);
    setHistoryIndex(nextIndex);
  };

  const appendSnapshot = (nextSnapshot) => {
    const nextHistory = [...historyRef.current, nextSnapshot];
    syncHistory(nextHistory, nextHistory.length - 1);
  };

  const patchLastSnapshot = (patch) => {
    if (!historyRef.current.length) {
      return;
    }

    const nextHistory = historyRef.current.slice();
    nextHistory[nextHistory.length - 1] = {
      ...nextHistory[nextHistory.length - 1],
      ...patch,
    };
    syncHistory(nextHistory, historyIndexRef.current);
  };

  const stopAutoPlay = () => {
    autoPlayRef.current = false;
    setIsAutoPlaying(false);
  };

  const describeLocation = (nextSnapshot) => {
    if (!nextSnapshot) {
      return "unknown location";
    }

    return `${nextSnapshot.file || "unknown file"}:${nextSnapshot.line ?? "?"}`;
  };

  const describeStepCounter = (nextIndex = historyIndexRef.current, total = historyRef.current.length) => {
    if (!total || nextIndex < 0) {
      return "Step 0 / 0";
    }

    return `Step ${nextIndex + 1} / ${total}`;
  };

  const setSnapshotMessage = (prefix, nextSnapshot, tone = "neutral") => {
    if (!nextSnapshot) {
      setMessage(prefix);
      setMessageTone(tone);
      return;
    }

    setMessage(`${prefix} at ${describeLocation(nextSnapshot)} (${describeStepCounter()})`);
    setMessageTone(tone);
  };

  const enterAutoPlayMode = (nextSnapshot) => {
    autoPlayRef.current = true;
    setIsAutoPlaying(true);
    setPhase("running");
    setSnapshotMessage("Running step-by-step", nextSnapshot, "neutral");
  };

  const resetTimeline = () => {
    stopAutoPlay();
    autoStartOnFirstSnapshotRef.current = false;
    pendingStepRef.current = false;
    setExecutionFinished(false);
    sourceAnchorsRef.current.clear();
    targetAnchorsRef.current.clear();
    setArrows([]);
    syncHistory([], -1);
  };

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setSocketState("connected");
      setMessage("WebSocket connected. You can compile and inspect memory snapshots.");
      setMessageTone("success");
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      handleServerMessage(payload);
    });

    socket.addEventListener("close", () => {
      autoStartOnFirstSnapshotRef.current = false;
      pendingStepRef.current = false;
      stopAutoPlay();
      setSocketState("disconnected");
      setPhase("idle");
      setMessage("Connection closed.");
      setMessageTone("error");
    });

    socket.addEventListener("error", () => {
      autoStartOnFirstSnapshotRef.current = false;
      pendingStepRef.current = false;
      stopAutoPlay();
      setMessage("WebSocket error.");
      setMessageTone("error");
    });

    return () => socket.close();
  }, []);

  const handleServerMessage = (payload) => {
    if (payload.type === "status") {
      setPhase(payload.phase);
      if (payload.message) {
        setMessage(payload.message);
        setMessageTone(payload.phase === "running" ? "neutral" : "success");
      }
      return;
    }

    if (payload.type === "detected-structure") {
      setDetection(payload.detection || { primary: payload.structure, confidence: payload.confidence });
      return;
    }

    if (payload.type === "compile-succeeded") {
      setPhase("stopped");
      setExecutionFinished(false);
      if (payload.detection) {
        setDetection(payload.detection);
      }
      const dsText = payload.detection?.primary ? ` [ML Detection: ${payload.detection.primary} (${payload.detection.confidence} confidence)]` : "";
      setMessage(`Compilation succeeded.${dsText} Execution is paused at the first breakpoint.`);
      setMessageTone("success");
      return;
    }

    if (payload.type === "compile-error") {
      resetTimeline();
      setPhase("idle");
      setMessage(payload.error || "Compilation failed.");
      setMessageTone("error");
      return;
    }

    if (payload.type === "snapshot") {
      pendingStepRef.current = false;
      if (payload.snapshot?.detectedStructure) {
        setDetection(payload.snapshot.detectedStructure);
      }
      const isFirstSnapshot = historyRef.current.length === 0;
      appendSnapshot(payload.snapshot);
      if (autoStartOnFirstSnapshotRef.current && isFirstSnapshot) {
        autoStartOnFirstSnapshotRef.current = false;
        enterAutoPlayMode(payload.snapshot);
        return;
      }
      setPhase(autoPlayRef.current ? "running" : "stopped");
      setSnapshotMessage(autoPlayRef.current ? "Running step-by-step" : "Paused", payload.snapshot, autoPlayRef.current ? "neutral" : "success");
      return;
    }

    if (payload.type === "execution-finished") {
      pendingStepRef.current = false;
      autoStartOnFirstSnapshotRef.current = false;
      stopAutoPlay();
      setExecutionFinished(true);
      setPhase("finished");
      if (payload.snapshot && payload.snapshot.stack) {
        appendSnapshot(payload.snapshot);
      } else if (payload.snapshot?.programOutput !== undefined) {
        patchLastSnapshot({
          programOutput: payload.snapshot.programOutput,
          outputChunk: payload.snapshot.outputChunk || "",
          finished: true,
          executionState: payload.snapshot.state || "exited",
          exitReason: payload.snapshot.reason || null,
        });
      }
      setSnapshotMessage("Program execution finished", payload.snapshot || historyRef.current[historyRef.current.length - 1], "success");
      return;
    }

    if (payload.type === "session-error") {
      pendingStepRef.current = false;
      autoStartOnFirstSnapshotRef.current = false;
      stopAutoPlay();
      setPhase(historyRef.current.length ? "stopped" : "idle");
      setMessage(payload.error || "Debugger error.");
      setMessageTone("error");
    }
  };

  const send = (payload) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setMessage("WebSocket is not connected.");
      setMessageTone("error");
      return;
    }

    socketRef.current.send(JSON.stringify(payload));
  };

  const compileAndStart = () => {
    resetTimeline();
    autoStartOnFirstSnapshotRef.current = true;
    setPhase("compiling");
    setMessage("Compiling with g++ and starting gdb...");
    setMessageTone("neutral");
    send({ type: "compile-and-start", code });
  };

  const requestLiveStep = (type) => {
    if (pendingStepRef.current || executionFinished) {
      return;
    }

    pendingStepRef.current = true;
    setPhase("running");
    send({ type });
  };

  const codeLines = useMemo(() => code.split("\n"), [code]);

  useEffect(() => {
    if (!isAutoPlaying) {
      return undefined;
    }

    const timer = setTimeout(() => {
      if (historyIndexRef.current < historyRef.current.length - 1) {
        syncHistory(historyRef.current, historyIndexRef.current + 1);
        return;
      }

      if (!executionFinished && !pendingStepRef.current) {
        requestLiveStep("step-into");
      }
    }, playbackSpeed);

    return () => clearTimeout(timer);
  }, [isAutoPlaying, playbackSpeed, executionFinished, history, historyIndex]);

  useLayoutEffect(() => {
    if (!editorRef.current || !editorBackdropRef.current) {
      return;
    }

    editorBackdropRef.current.scrollTop = editorRef.current.scrollTop;
    editorBackdropRef.current.scrollLeft = editorRef.current.scrollLeft;
  }, [code, snapshot]);

  useLayoutEffect(() => {
    if (!containerRef.current || !snapshot) {
      setArrows([]);
      return undefined;
    }

    const timer = setTimeout(() => {
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;

      const edges = snapshot.heap?.edges || [];
      const nextArrows = edges
        .map((edge) => {
          const lSrcKey = String(edge.sourceKey || "").toLowerCase();
          const lTargetKey = String(edge.to || "").toLowerCase();

          let source = sourceAnchorsRef.current.get(lSrcKey) || sourceAnchorsRef.current.get(edge.sourceKey);
          let target = targetAnchorsRef.current.get(lTargetKey) || targetAnchorsRef.current.get(edge.to);

          if (!source && lSrcKey.startsWith("stack:")) {
            const parts = lSrcKey.split(":");
            const varName = parts[parts.length - 1];
            source = sourceAnchorsRef.current.get(varName) || sourceAnchorsRef.current.get(lTargetKey);
          }

          if (!source && lSrcKey.startsWith("heap:")) {
            const parts = lSrcKey.split(":");
            if (parts.length >= 3) {
              const hexAddr = parts[1];
              const fieldName = parts[parts.length - 1];
              const normKey = `heap:${hexAddr}:${fieldName}`;
              source = sourceAnchorsRef.current.get(normKey) || sourceAnchorsRef.current.get(lTargetKey);
            }
          }

          if (!source && lTargetKey) {
            source = sourceAnchorsRef.current.get(lTargetKey);
          }

          if (source && !document.body.contains(source)) {
            sourceAnchorsRef.current.delete(lSrcKey);
            source = null;
          }

          if (target && !document.body.contains(target)) {
            targetAnchorsRef.current.delete(lTargetKey);
            target = null;
          }

          if (!source || !target) {
            return null;
          }

          const sourceRect = source.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();

          const x1 = sourceRect.right - containerRect.left;
          const y1 = sourceRect.top + sourceRect.height / 2 - containerRect.top;
          const x2 = targetRect.left - containerRect.left;
          const y2 = targetRect.top + targetRect.height / 2 - containerRect.top;

          if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
            return null;
          }

          return {
            id: `${edge.sourceKey}:${edge.to}`,
            x1,
            y1,
            x2,
            y2,
            isPrev: edge.isPrev || lSrcKey.includes('prev'),
            isTree: lSrcKey.includes('left') || lSrcKey.includes('right') || lSrcKey.includes('smaller') || lSrcKey.includes('larger') || lSrcKey.includes('child')
          };
        })
        .filter(Boolean);

      setArrows(nextArrows);
    }, 0);

    return () => clearTimeout(timer);
  }, [snapshot, code, vizMode]);

  const registerSource = (key, node) => {
    if (!key) return;
    const lKey = String(key).toLowerCase();
    if (node) {
      sourceAnchorsRef.current.set(lKey, node);
      if (lKey.includes("heap[") && lKey.includes("].")) {
        const parts = lKey.split("].");
        const addrMatch = lKey.match(/heap:0x[0-9a-f]+/);
        if (addrMatch && parts.length > 1) {
          const normKey = `${addrMatch[0]}:${parts[parts.length - 1]}`;
          sourceAnchorsRef.current.set(normKey, node);
        }
      }
    } else {
      sourceAnchorsRef.current.delete(lKey);
    }
  };

  const registerTarget = (key, node) => {
    if (!key) return;
    const lKey = String(key).toLowerCase();
    if (node) {
      targetAnchorsRef.current.set(lKey, node);
    } else {
      targetAnchorsRef.current.delete(lKey);
    }
  };

  const syncEditorScroll = (event) => {
    if (!editorBackdropRef.current) {
      return;
    }

    editorBackdropRef.current.scrollTop = event.target.scrollTop;
    editorBackdropRef.current.scrollLeft = event.target.scrollLeft;
  };

  const startAutoStep = () => {
    if (!snapshot) {
      return;
    }

    autoStartOnFirstSnapshotRef.current = false;
    enterAutoPlayMode(snapshot);
  };

  const pausePlayback = () => {
    stopAutoPlay();
    setPhase(executionFinished ? "finished" : "stopped");
    setSnapshotMessage("Paused", snapshot, "success");
  };

  const stepBackward = () => {
    stopAutoPlay();
    if (historyIndexRef.current <= 0) {
      return;
    }
    const nextIndex = historyIndexRef.current - 1;
    syncHistory(historyRef.current, nextIndex);
    setPhase("stopped");
    setSnapshotMessage("Viewing recorded step", historyRef.current[nextIndex], "success");
  };

  const stepForward = () => {
    stopAutoPlay();

    if (historyIndexRef.current < historyRef.current.length - 1) {
      const nextIndex = historyIndexRef.current + 1;
      syncHistory(historyRef.current, nextIndex);
      setPhase(nextIndex === historyRef.current.length - 1 && executionFinished ? "finished" : "stopped");
      setSnapshotMessage("Viewing recorded step", historyRef.current[nextIndex], "success");
      return;
    }

    requestLiveStep("step-into");
  };

  const stepOver = () => {
    stopAutoPlay();
    if (historyIndexRef.current !== historyRef.current.length - 1 || executionFinished) {
      return;
    }

    requestLiveStep("step-over");
  };

  const restartExecution = () => {
    resetTimeline();
    autoStartOnFirstSnapshotRef.current = true;
    setPhase("compiling");
    setMessage("Restarting the debugger session...");
    setMessageTone("neutral");
    send({ type: "restart" });
  };

  const transportBusy = socketState !== "connected" || phase === "compiling";
  const hasSnapshot = Boolean(snapshot);
  const atLiveEdge = hasSnapshot && historyIndex === history.length - 1;
  const canStepBack = historyIndex > 0;
  const canStepForward = hasSnapshot && (historyIndex < history.length - 1 || (!executionFinished && atLiveEdge)) && !pendingStepRef.current;
  const canStepOver = hasSnapshot && atLiveEdge && !executionFinished && !pendingStepRef.current;
  const canPlay = hasSnapshot && !isAutoPlaying && (historyIndex < history.length - 1 || (!executionFinished && atLiveEdge));
  const currentProgramOutput = snapshot?.programOutput || "";

  return (
    <div className="app-shell">
      <section className="hero">
        <div className="hero-card">
          <h1>Trace real C++ memory, one debugger stop at a time.</h1>
          <p>
            This visualizer uses a real <code>g++</code> compile and a real <code>gdb</code> session.
            Stack frames, pointer targets, and tracked heap allocations are streamed to the UI over WebSockets.
          </p>
        </div>
      </section>

      <main className="layout">
        <section className="panel editor-panel">
          <div className="panel-header">
            <h2>C++ Editor</h2>
            <span className="status-pill">
              {socketState} / {phase}
            </span>
          </div>

          <div className="editor-meta stack-meta">
            Current location: {snapshot?.file || "No program loaded"}{snapshot?.line ? `:${snapshot.line}` : ""}
          </div>

          <div className="editor-shell">
            <div className="editor-backdrop" ref={editorBackdropRef} aria-hidden="true">
              <div className="editor-code">
                {codeLines.map((line, index) => (
                  <div key={index} className={`editor-line ${snapshot?.line === index + 1 ? "active" : ""}`}>
                    <span className="editor-gutter">{index + 1}</span>
                    <span className="editor-text">{line || " "}</span>
                  </div>
                ))}
              </div>
            </div>

            <textarea
              ref={editorRef}
              className="editor-input"
              spellCheck="false"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onScroll={syncEditorScroll}
            />
          </div>

          <div className="preset-buttons">
            <button className="preset-btn" onClick={() => setCode(PRESET_EXAMPLES.stackVar)}>Stack Vars</button>
            <button className="preset-btn" onClick={() => setCode(PRESET_EXAMPLES.heapPointer)}>Heap Pointer</button>
            <button className="preset-btn" onClick={() => setCode(PRESET_EXAMPLES.linkedList)}>Linked List</button>
            <button className="preset-btn" onClick={() => setCode(PRESET_EXAMPLES.tree)}>Tree</button>
            <button className="preset-btn" onClick={() => setCode(PRESET_EXAMPLES.multiPointer)}>Multi-Pointer (DLL)</button>
          </div>

          <div className="controls">
            <button className="primary" onClick={compileAndStart} disabled={transportBusy}>
              Compile & Start
            </button>
            <button className="secondary" onClick={stepBackward} disabled={transportBusy || !canStepBack}>
              Step Back
            </button>
            <button className="secondary" onClick={stepForward} disabled={transportBusy || !canStepForward || isAutoPlaying}>
              Step Forward
            </button>
            <button className="secondary" onClick={stepOver} disabled={transportBusy || !canStepOver || isAutoPlaying}>
              Step Over
            </button>
            <button className="secondary" onClick={isAutoPlaying ? pausePlayback : startAutoStep} disabled={transportBusy || (!isAutoPlaying && !canPlay)}>
              {isAutoPlaying ? "Pause" : "Play"}
            </button>
            <button className="secondary" onClick={restartExecution} disabled={transportBusy}>
              Restart
            </button>
          </div>

          <div className="playback-bar">
            <label className="speed-control">
              <span>Step Delay</span>
              <input
                className="speed-slider"
                type="range"
                min={MIN_PLAYBACK_DELAY_MS}
                max={MAX_PLAYBACK_DELAY_MS}
                step={PLAYBACK_DELAY_STEP_MS}
                value={playbackSpeed}
                onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
              />
              <span>{formatPlaybackDelay(playbackSpeed)}</span>
            </label>
            <div className="timeline-meta">
              <span>{describeStepCounter(historyIndex, history.length)}</span>
              <span className={`timeline-state ${atLiveEdge ? "live" : "history"}`}>
                {atLiveEdge ? (executionFinished ? "final frame" : "live edge") : "history view"}
              </span>
            </div>
          </div>

          <div className={`message ${messageTone === "error" ? "error" : messageTone === "success" ? "success" : ""}`}>
            {message}
          </div>

          <div className="output-window">
            <div className="panel-header output-header">
              <h2>Program Output</h2>
              <span className="status-pill">stdout / stderr</span>
            </div>
            <pre className="output-console">
              {currentProgramOutput || "Program output will appear here as you run or step through the code."}
            </pre>
          </div>
        </section>

        <section className="panel visualizer-panel" ref={containerRef}>
          <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h2>Memory View</h2>
              <span className="status-pill" style={{ marginTop: "4px" }}>
                {snapshot ? `${snapshot.stack?.length || 0} stack frames` : "waiting for debugger"}
              </span>
            </div>

            <div className="mode-toggle-group">
              <button
                type="button"
                className={`mode-toggle-btn ${vizMode === "simple" ? "active" : ""}`}
                onClick={() => setVizMode("simple")}
              >
                ✨ Simple Mode
              </button>
              <button
                type="button"
                className={`mode-toggle-btn ${vizMode === "detailed" ? "active" : ""}`}
                onClick={() => setVizMode("detailed")}
              >
                🔍 Detailed Mode
              </button>
            </div>
          </div>

          {detection && (
            <div className="ml-badge">
              <span>🤖 <strong>ML Data Structure Guessed:</strong> {detection.primary}</span>
              <span className={`ml-confidence-${detection.confidence}`}>{detection.confidence} confidence</span>
              <span className="layout-mode-tag" style={{ marginLeft: "auto", fontSize: "0.75rem", background: "rgba(255,255,255,0.1)", padding: "2px 8px", borderRadius: "10px" }}>
                Model: <strong>{detection.model || "V1"}</strong>
              </span>
            </div>
          )}

          {vizMode === "simple" ? (
            <React.Fragment>
              <SimpleVisualizationView
                mode={resolveVisualizationMode(detection?.primary)}
                detection={detection}
                memoryModel={memoryModel}
                registerSource={registerSource}
                registerTarget={registerTarget}
              />
              <svg className="arrow-layer">
                <defs>
                  <marker id="arrowhead" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
                    <polygon points="0 0, 14 5, 0 10" fill="#ff6b00" />
                  </marker>
                  <marker id="arrowhead-prev" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
                    <polygon points="0 0, 14 5, 0 10" fill="#00f3ff" />
                  </marker>
                </defs>
                {arrows.map((arrow) => {
                  const path = buildCurvedPath(arrow.x1, arrow.y1, arrow.x2, arrow.y2);
                  return (
                    <path
                      key={arrow.id}
                      d={path}
                      fill="none"
                      stroke={arrow.isTree ? "#10b981" : arrow.isPrev ? "#00f3ff" : "#ff6b00"}
                      strokeWidth="2.5"
                      markerEnd={arrow.isPrev ? "url(#arrowhead-prev)" : "url(#arrowhead)"}
                    />
                  );
                })}
              </svg>
            </React.Fragment>
          ) : (
            <div className="memory-visualization-canvas">
              <StructureVisualizationView
                mode={resolveVisualizationMode(detection?.primary)}
                detection={detection}
                snapshot={snapshot}
                registerTarget={registerTarget}
              />

              <svg className="arrow-layer">
                <defs>
                  <marker id="arrowhead" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
                    <polygon points="0 0, 14 5, 0 10" fill="#ff6b00" />
                  </marker>
                  <marker id="arrowhead-prev" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
                    <polygon points="0 0, 14 5, 0 10" fill="#00f3ff" />
                  </marker>
                  <marker id="arrowhead-tree" markerWidth="14" markerHeight="10" refX="12" refY="5" orient="auto">
                    <polygon points="0 0, 14 5, 0 10" fill="#10b981" />
                  </marker>
                </defs>
                {arrows.map((arrow) => {
                  const dx = Math.max(45, Math.abs(arrow.x2 - arrow.x1) * 0.4);
                  const markerId = arrow.isPrev ? "arrowhead-prev" : arrow.isTree ? "arrowhead-tree" : "arrowhead";
                  const pathClass = arrow.isPrev ? "arrow-path-prev" : arrow.isTree ? "arrow-path-tree" : "arrow-path";
                  return (
                    <path
                      key={arrow.id}
                      className={pathClass}
                      d={`M ${arrow.x1} ${arrow.y1} C ${arrow.x1 + dx} ${arrow.y1}, ${arrow.x2 - dx} ${arrow.y2}, ${arrow.x2} ${arrow.y2}`}
                      markerEnd={`url(#${markerId})`}
                    />
                  );
                })}
              </svg>

              <div className="visualizer-grid">
                <div className="lane">
                  <h3>Call Stack</h3>
                  {!memoryModel?.stackFrames?.length && <div className="section-card">Compile a program to see stack frames.</div>}
                  {(memoryModel?.stackFrames || []).map((frame) => (
                    <div key={frame.index} className="section-card stack-frame">
                      <div className="stack-title">
                        <strong>{frame.function}</strong>
                        <span className="stack-meta">line {frame.line ?? "?"}</span>
                      </div>
                      <div className="stack-meta">{frame.file || "unknown file"}</div>
                      <div className="variable-list" style={{ marginTop: "12px" }}>
                        {(frame.locals || []).map((variable) => (
                          <ValueTree
                            key={`${frame.index}:${variable.name}`}
                            scopeKey={`stack:${frame.index}`}
                            node={variable}
                            label={variable.name}
                            registerSource={registerSource}
                            root
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="lane">
                  <h3>Heap Allocations</h3>
                  {!(memoryModel?.rawHeapObjects || memoryModel?.heapObjects)?.length && <div className="section-card">No tracked heap allocations yet.</div>}
                  {((memoryModel?.rawHeapObjects || memoryModel?.heapObjects) || []).map((allocation) => (
                    <div
                      key={`${allocation.id}:${allocation.address}`}
                      className="section-card heap-block"
                      ref={(node) => registerTarget(allocation.address, node)}
                    >
                      <div className="heap-title">
                        <strong>{allocation.address || "unknown address"}</strong>
                        <span className="heap-meta">{allocation.active ? "active" : "freed"}</span>
                      </div>
                      <div className="heap-meta">
                        {allocation.size} bytes {allocation.isArray ? "array allocation" : "object allocation"}
                      </div>
                      {allocation.preview && (
                        <div className="heap-preview">
                          <ValueTree
                            scopeKey={`heap:${allocation.address}`}
                            node={allocation.preview}
                            label={allocation.previewType || "contents"}
                            registerSource={registerSource}
                            root
                          />
                        </div>
                      )}
                      <div className="heap-bytes">{allocation.bytes || "bytes unavailable"}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function renderValue(variable) {
  if (variable.string) {
    return JSON.stringify(variable.string);
  }
  if (variable.value !== undefined && typeof variable.value !== "object") {
    return String(variable.value);
  }
  return variable.display || variable.kind;
}

function summarizeNode(node) {
  if (node === null || node === undefined) {
    return "";
  }

  if (typeof node !== "object") {
    return String(node);
  }

  if (node.string) {
    return JSON.stringify(node.string);
  }

  if (node.kind === "array" && Array.isArray(node.children)) {
    return `[${node.children.map((child) => summarizeNode(child)).join(", ")}]`;
  }

  if (isMapKind(node.kind) && Array.isArray(node.entries)) {
    return `{${node.entries.map((entry) => `${summarizeNode(entry.key)}: ${summarizeNode(entry.value)}`).join(", ")}}`;
  }

  if (node.kind === "pointer" || node.kind === "reference") {
    return node.targetAddress || node.display || "null";
  }

  if (node.value !== undefined && typeof node.value !== "object") {
    return String(node.value);
  }

  return node.display || node.kind;
}

function unwrapNamedChild(node) {
  if (
    node &&
    typeof node === "object" &&
    Object.prototype.hasOwnProperty.call(node, "name") &&
    Object.prototype.hasOwnProperty.call(node, "value")
  ) {
    return node.value;
  }

  return node;
}

function resolveVisualizationMode(primary) {
  if (!primary) return "Generic";
  const p = primary.toLowerCase();
  if (p.includes("singly linked list") || p.includes("circular singly linked list") || p.includes("linked list") || p.includes("list")) {
    if (p.includes("doubly")) return "DoublyLinkedList";
    return "LinkedList";
  }
  if (p.includes("tree") || p.includes("bst")) return "Tree";
  if (p.includes("stack")) return "Stack";
  if (p.includes("queue")) return "Queue";
  if (p.includes("array") || p.includes("vector")) return "Array";
  if (p.includes("heap")) return "Heap";
  if (p.includes("hash") || p.includes("table")) return "HashTable";
  if (p.includes("graph")) return "Graph";
  return "Generic";
}

function StructureVisualizationView({ mode, detection, snapshot, registerTarget }) {
  // ML detection is strictly informational and has ZERO authority over memory visualization.
  return null;
}

function ValueTree({ scopeKey, node, label, registerSource, root = false }) {
  const isPointer = node.kind === "pointer" || node.kind === "reference";
  const className = root ? `variable-card ${isPointer ? "pointer" : ""}` : "child-row";
  const childEntries = node.pointee
    ? [{ label: "*", value: node.pointee }]
    : (node.children || []).map((child, index) => ({
        label: child.name || `[${index}]`,
        value: unwrapNamedChild(child),
      }));

  return (
    <div className={className}>
      <div
        className="variable-header"
        ref={(element) => {
          if (typeof registerSource === "function" && element) {
            if (isPointer || node.targetAddress || (typeof node.value === "string" && node.value.startsWith("0x"))) {
              const rawPath = String(node.path || label || "").trim();
              registerSource(`${scopeKey}:${rawPath}`, element);
              registerSource(`${scopeKey}:${rawPath}`.toLowerCase(), element);

              let cleanPath = rawPath;
              if (cleanPath.includes(".")) {
                cleanPath = cleanPath.substring(cleanPath.lastIndexOf(".") + 1);
              } else if (cleanPath.includes("->")) {
                cleanPath = cleanPath.substring(cleanPath.lastIndexOf("->") + 2);
              }

              const normKey = `${scopeKey}:${cleanPath}`;
              registerSource(normKey, element);
              registerSource(normKey.toLowerCase(), element);

              const targetAddr = node.targetAddress || (typeof node.value === "string" && node.value.startsWith("0x") ? node.value : null);
              if (targetAddr) {
                registerSource(targetAddr, element);
                registerSource(targetAddr.toLowerCase(), element);
              }
            }
          }
        }}
      >
        <div>
          <div className="variable-name">{label}</div>
          <div className="variable-type">{node.type || node.kind}</div>
        </div>
        <span className={`kind-pill kind-${node.kind || "unknown"}`}>{formatKind(node.kind)}</span>
      </div>
      {renderBody({ node })}

      {childEntries.length > 0 && !isCompactCollectionKind(node.kind) && (
        <div className="children">
          {childEntries.map((child, index) => (
            <ValueTree
              key={`${child.value.path || child.label}:${index}`}
              scopeKey={scopeKey}
              node={child.value}
              label={child.label}
              registerSource={registerSource}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function renderBody({ node }) {
  if (node.kind === "string" || node.kind === "string_pointer") {
    return (
      <div className="datatype-shell">
        <div className="value-row">
          <span className="value-label">string</span>
          <span className="value-strong">{JSON.stringify(node.string || renderValue(node))}</span>
        </div>
        <div className="value-row compact">
          {node.address && <span className="address-chip">{node.address}</span>}
        </div>
      </div>
    );
  }

  if ((node.kind === "array" || isSequenceKind(node.kind)) && Array.isArray(node.children)) {
    if (isMatrixNode(node)) {
      return (
        <div className="datatype-shell">
          <div className="value-row">
            <span className="value-label">{node.kind}</span>
            <span className="address-chip">{node.address || "stack"}</span>
          </div>
          {node.summary && <div className="container-summary">{node.summary}</div>}
          <div className="matrix-grid">
            {node.children.map((row, rowIndex) => (
              <div className="matrix-row" key={`${row.path || rowIndex}`}>
                <div className="matrix-label">[{rowIndex}]</div>
                <div className="matrix-cells">
                  {(row.children || []).map((cell, cellIndex) => (
                    <div className="array-cell matrix-cell" key={`${cell.path || cellIndex}`}>
                      <div className="array-index">[{cellIndex}]</div>
                      <div className="array-value">{summarizeNode(cell)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="datatype-shell">
        <div className="value-row">
          <span className="value-label">{node.kind}</span>
          <span className="address-chip">{node.address || "stack"}</span>
        </div>
        {node.summary && <div className="container-summary">{node.summary}</div>}
        <div className="array-grid">
          {node.children.map((child, index) => {
            const entry = unwrapNamedChild(child);
            const childName = child.name || `[${index}]`;
            const entryPath = String(entry.path || child.path || "").trim();

            let exactEdgeKey = null;

            if (entryPath) {
              if (entryPath.startsWith("heap[")) {
                const match = entryPath.match(/^heap\[(0x[0-9a-fA-F]+)\]\.(.*)$/);
                if (match) {
                  const hexAddr = match[1];
                  const fieldPath = match[2];
                  exactEdgeKey = `heap:${hexAddr}:${fieldPath}`;
                }
              } else if (entryPath.includes("->")) {
                const cleanPath = entryPath.substring(entryPath.lastIndexOf("->") + 2);
                exactEdgeKey = `stack:0:${cleanPath}`;
              }
            }

            const targetAddr = entry.targetAddress || (typeof entry.value === "string" && entry.value.startsWith("0x") ? entry.value : (typeof entry.display === "string" && entry.display.startsWith("0x") ? entry.display : null));

            return (
              <div
                className="array-cell"
                key={`${entry.path || index}`}
                ref={(element) => {
                  if (typeof registerSource === "function" && element) {
                    if (exactEdgeKey) {
                      registerSource(exactEdgeKey, element);
                      registerSource(exactEdgeKey.toLowerCase(), element);
                    }
                    if (targetAddr) {
                      registerSource(targetAddr, element);
                      registerSource(targetAddr.toLowerCase(), element);
                    }
                  }
                }}
              >
                <div className="array-index">{childName}</div>
                <div className="array-value">{summarizeNode(entry)}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (isMapKind(node.kind) && Array.isArray(node.entries)) {
    return (
      <div className="datatype-shell">
        <div className="value-row">
          <span className="value-label">{node.kind}</span>
          <span className="address-chip">{node.address || "stack"}</span>
        </div>
        {node.summary && <div className="container-summary">{node.summary}</div>}
        <div className="map-table">
          {node.entries.map((entry, index) => (
            <div className="map-row" key={`${entry.name || index}`}>
              <div className="map-key">{summarizeNode(entry.key)}</div>
              <div className="map-sep">{'->'}</div>
              <div className="map-value">{summarizeNode(entry.value)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (node.kind === "pointer" || node.kind === "reference") {
    return (
      <div className="datatype-shell pointer-shell">
        <div className="value-row">
          <span className="value-label">{node.kind}</span>
          <span className="value-strong">{node.targetAddress || "null"}</span>
        </div>
        <div className="value-row compact">
          <span className="address-chip">{node.address || "stack"}</span>
          {node.targetType && <span className="address-chip soft">{node.targetType}</span>}
        </div>
      </div>
    );
  }

  if (node.kind === "object" && Array.isArray(node.children)) {
    return (
      <div className="datatype-shell">
        <div className="value-row">
          <span className="value-label">object</span>
          <span className="address-chip">{node.address || "stack"}</span>
        </div>
        <div className="field-table">
          {node.children.map((child, index) => {
            const fieldValue = unwrapNamedChild(child);
            return (
              <div className="field-row" key={`${fieldValue.path || child.name}:${index}`}>
                <div className="field-name">{child.name || `field_${index}`}</div>
                <div className="field-value">{summarizeNode(fieldValue)}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="datatype-shell">
      <div className="value-row">
        <span className="value-label">value</span>
        <span className="value-strong">{renderValue(node)}</span>
      </div>
      <div className="value-row compact">
        {node.address && <span className="address-chip">{node.address}</span>}
      </div>
    </div>
  );
}

function isSequenceKind(kind) {
  return [
    "vector",
    "deque",
    "list",
    "forward_list",
    "set",
    "unordered_set",
    "queue",
    "stack",
    "priority_queue",
    "span",
    "valarray",
    "bitset",
    "container",
  ].includes(kind);
}

function isMapKind(kind) {
  return kind === "map" || kind === "unordered_map";
}

function isCompactCollectionKind(kind) {
  return kind === "array" || isSequenceKind(kind) || isMapKind(kind) || kind === "string";
}

function isMatrixNode(node) {
  return Array.isArray(node.children) && node.children.length > 0 && node.children.every((child) => child.kind === "array");
}

function formatKind(kind) {
  if (!kind) {
    return "value";
  }

  return kind
    .replace(/_/g, " ")
    .replace(/^\w/, (char) => char.toUpperCase());
}

function cleanTypeName(typeStr) {
  if (!typeStr) return "var";
  let s = String(typeStr);
  s = s.replace(/std::__cxx11::basic_string<char,\s*std::char_traits<char>,\s*std::allocator<char>>/g, "string");
  s = s.replace(/std::basic_string<char,\s*std::char_traits<char>,\s*std::allocator<char>>/g, "string");
  s = s.replace(/std::allocator<[^>]+>/g, "");
  s = s.replace(/std::vector<([^,>]+)(?:,.*)?>/g, "vector<$1>");
  s = s.replace(/std::map<([^,>]+),\s*([^,>]+)(?:,.*)?>/g, "map<$1, $2>");
  s = s.replace(/std::unordered_map<([^,>]+),\s*([^,>]+)(?:,.*)?>/g, "unordered_map<$1, $2>");
  s = s.replace(/std::set<([^,>]+)(?:,.*)?>/g, "set<$1>");
  s = s.replace(/std::unordered_set<([^,>]+)(?:,.*)?>/g, "unordered_set<$1>");
  s = s.replace(/std::list<([^,>]+)(?:,.*)?>/g, "list<$1>");
  s = s.replace(/std::stack<([^,>]+)(?:,.*)?>/g, "stack<$1>");
  s = s.replace(/std::queue<([^,>]+)(?:,.*)?>/g, "queue<$1>");
  s = s.replace(/std::string/g, "string");
  s = s.replace(/std::/g, "");
  return s;
}

function extractPrimitiveValue(val) {
  if (val === null || val === undefined) return "nullptr";
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "string") {
    if (val === "[object Object]") return "0";
    return val;
  }
  if (typeof val === "object") {
    if (val.value !== undefined && typeof val.value !== "object") return String(val.value);
    if (val.display !== undefined && typeof val.display === "string" && !val.display.includes("[object Object]")) {
      return val.display;
    }
    if (val.string !== undefined) return String(val.string);
    if (val.targetAddress) return val.targetAddress;
    if (val.summary) return val.summary;
    if (val.val !== undefined && typeof val.val !== "object") return String(val.val);
    if (val.data !== undefined && typeof val.data !== "object") return String(val.data);
    
    // Check nested children for scalar value
    if (Array.isArray(val.children)) {
      const valChild = val.children.find(c => c.name === "val" || c.name === "value" || c.name === "data");
      if (valChild) return extractPrimitiveValue(valChild.value);
    }

    if (val.value && typeof val.value === "object") {
      return extractPrimitiveValue(val.value);
    }
  }
  return "0";
}

function getNodeValue(alloc) {
  if (!alloc || !alloc.preview) return "0";
  const fields = alloc.preview.fields || alloc.preview.children || [];
  if (Array.isArray(fields)) {
    const scalar = fields.find(f => {
      const valStr = extractPrimitiveValue(f.value !== undefined ? f.value : f);
      return typeof valStr === "string" && !valStr.startsWith("0x") && valStr !== "nullptr";
    });
    if (scalar) return extractPrimitiveValue(scalar.value !== undefined ? scalar.value : scalar);
  }
  if (alloc.preview.value !== undefined) return extractPrimitiveValue(alloc.preview.value);
  return "0";
}

function isConstructorOrDestructorFrame(frame) {
  if (!frame || !frame.function) return false;
  const fnName = String(frame.function).trim();

  if (fnName.includes("::~") || fnName.startsWith("~")) return true;

  if (fnName.includes("operator new") || fnName.includes("operator delete") || fnName.includes("__base_ctor") || fnName.includes("__comp_ctor")) {
    return true;
  }

  const doubleColonIdx = fnName.indexOf("::");
  if (doubleColonIdx !== -1) {
    const classNamePart = fnName.substring(0, doubleColonIdx).trim();
    const afterColonPart = fnName.substring(doubleColonIdx + 2).trim();
    const baseClassName = classNamePart.replace(/<.*>/g, "").split("::").pop().trim();
    const methodName = afterColonPart.replace(/\(.*\)/g, "").trim();

    if (baseClassName && methodName === baseClassName) {
      return true;
    }
  }

  return false;
}

function SimpleVisualizationView({ mode, detection, memoryModel, registerSource, registerTarget }) {
  if (!memoryModel || (!memoryModel.stackFrames.length && !memoryModel.heapObjects.length)) {
    return (
      <div className="simple-empty-state" style={{ padding: "30px", textAlign: "center", background: "#ffffff", borderRadius: "18px", border: "1px dashed #cbd5e1", margin: "16px 0" }}>
        <div style={{ fontSize: "2.2rem", marginBottom: "8px" }}>🚀</div>
        <h3 style={{ margin: "0 0 6px", color: "#1e293b", fontSize: "1.1rem" }}>Simple Educational Mode Ready</h3>
        <p style={{ margin: 0, color: "#64748b", fontSize: "0.9rem" }}>Compile your code and step forward to see clean memory animations.</p>
      </div>
    );
  }

  const rawStack = memoryModel.stackFrames || [];
  const filteredStack = rawStack.filter(f => !isConstructorOrDestructorFrame(f));
  const stack = filteredStack.length > 0 ? filteredStack : rawStack;
  const allocations = memoryModel.heapObjects || [];
  const locals = stack[0]?.locals || [];

  const isRecursiveCall = stack.length > 1 && stack.every((f, i, arr) => f.function === arr[0].function);

  return (
    <div className="simple-viz-shell" style={{ margin: "16px 0", background: "#ffffff", borderRadius: "18px", border: "1px solid rgba(23, 32, 42, 0.1)", padding: "20px", boxShadow: "0 10px 30px rgba(0, 0, 0, 0.05)", position: "relative" }}>
      <div className="simple-viz-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "18px", paddingBottom: "12px", borderBottom: "1px solid #f1f5f9" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "1.2rem" }}>✨</span>
          <h3 style={{ margin: 0, fontSize: "1.05rem", color: "#0f172a" }}>
            Real Memory Execution Model ({detection?.primary || mode || "Generic"})
          </h3>
        </div>
        <span style={{ fontSize: "0.78rem", background: "rgba(182, 71, 42, 0.1)", color: "#b6472a", padding: "4px 10px", borderRadius: "999px", fontWeight: "bold" }}>
          Simple Mode Active
        </span>
      </div>

      <div className="simple-memory-grid" style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr", gap: "20px", alignItems: "start" }}>
        
        {/* LEFT: STACK MEMORY REGION */}
        <div className="simple-stack-region" style={{ background: "#f8fafc", border: "2px solid #cbd5e1", borderRadius: "16px", padding: "14px" }}>
          <div style={{ fontSize: "0.82rem", fontWeight: "bold", color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>📌 STACK MEMORY</span>
            <span style={{ background: "rgba(182, 71, 42, 0.12)", color: "#b6472a", padding: "2px 8px", borderRadius: "4px", fontSize: "0.72rem", fontWeight: "bold" }}>STACK</span>
          </div>

          {/* Chronological Stack Frames (Top of stack to Main) */}
          {stack.map((frame, fIdx) => (
            <div key={fIdx} className="simple-stack-frame" style={{ background: "#ffffff", border: fIdx === 0 ? "2px solid #b6472a" : "1px solid #cbd5e1", borderRadius: "12px", padding: "12px", marginBottom: "12px", boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                <strong style={{ fontSize: "0.92rem", color: "#0f172a" }}>{frame.function}()</strong>
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>line {frame.line}</span>
              </div>

              <div className="stack-vars-list" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {(frame.locals || []).map((loc) => {
                  const cleanType = cleanTypeName(loc.type || loc.kind);

                  // Pointer Variable Box
                  if (loc.kind === "pointer" || loc.type?.includes("*")) {
                    const targetAddr = loc.targetAddress || (typeof loc.value === "string" && loc.value.startsWith("0x") ? loc.value : null);
                    return (
                      <div key={loc.name} className="simple-var-box pointer-box" ref={(el) => { if (typeof registerSource === "function") { registerSource(`stack:${fIdx}:${loc.name}`, el); registerSource(loc.name, el); if (targetAddr) registerSource(targetAddr, el); } }} data-pointer-source={targetAddr || loc.name} style={{ background: "rgba(182, 71, 42, 0.08)", border: "1.5px solid rgba(182, 71, 42, 0.3)", borderRadius: "8px", padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <span style={{ fontSize: "0.68rem", color: "#b6472a", fontWeight: "bold", display: "block" }}>{cleanType}</span>
                          <strong style={{ fontSize: "0.88rem", color: "#0f172a" }}>{loc.name}</strong>
                        </div>
                        <div style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "#b6472a", fontWeight: "bold" }}>
                          {targetAddr && targetAddr !== "0x0" ? `${targetAddr.substring(0, 8)}... ──►` : "nullptr"}
                        </div>
                      </div>
                    );
                  }

                  // Compile-time Array or STL Vector/List Box
                  if (loc.kind === "array" || Array.isArray(loc.children) || loc.entries) {
                    const items = loc.children || loc.entries || [];
                    return (
                      <div key={loc.name} className="simple-var-box array-box" style={{ background: "#f0f9ff", border: "1.5px solid #38bdf8", borderRadius: "8px", padding: "8px" }}>
                        <div style={{ fontSize: "0.72rem", color: "#0284c7", fontWeight: "bold", marginBottom: "4px" }}>
                          {cleanType} {loc.name}
                        </div>
                        <div style={{ display: "flex", gap: "4px", overflowX: "auto" }}>
                          {items.map((child, cIdx) => {
                            const childValObj = child.value !== undefined ? child.value : child;
                            const childValStr = extractPrimitiveValue(childValObj);
                            const isPtrItem = typeof childValStr === "string" && childValStr.startsWith("0x");
                            const targetAddr = (childValObj && typeof childValObj === "object" && childValObj.targetAddress) || (isPtrItem ? childValStr : null);
                            const itemLabel = child.name || `[${cIdx}]`;
                            const exactEdgeKey = `stack:${fIdx}:${loc.name}${itemLabel}`;

                            return (
                              <div
                                key={cIdx}
                                ref={(el) => {
                                  if (typeof registerSource === "function" && el) {
                                    registerSource(exactEdgeKey, el);
                                    registerSource(`${exactEdgeKey.toLowerCase()}`, el);
                                    if (targetAddr) {
                                      registerSource(targetAddr, el);
                                      registerSource(targetAddr.toLowerCase(), el);
                                    }
                                  }
                                }}
                                style={{ background: "#ffffff", border: "1px solid #7dd3fc", borderRadius: "6px", padding: "4px 6px", textAlign: "center", minWidth: "36px" }}
                              >
                                <div style={{ fontSize: "0.6rem", color: "#0284c7" }}>{itemLabel}</div>
                                <strong style={{ fontSize: "0.82rem", color: isPtrItem ? "#b6472a" : "#0f172a", fontFamily: isPtrItem ? "monospace" : "inherit" }}>
                                  {childValStr}
                                </strong>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

                  // Local Object Box (Box Inside Box)
                  if (loc.kind === "object" && Array.isArray(loc.children)) {
                    return (
                      <div key={loc.name} className="simple-var-box object-box" style={{ background: "#fdf4ff", border: "1.5px solid #c084fc", borderRadius: "8px", padding: "8px" }}>
                        <div style={{ fontSize: "0.72rem", color: "#9333ea", fontWeight: "bold" }}>
                          {cleanType} {loc.name}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "3px", marginTop: "4px" }}>
                          {loc.children.map((field, fIdx) => (
                            <div key={fIdx} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", background: "#ffffff", padding: "3px 6px", borderRadius: "4px", border: "1px solid #f3e8ff" }}>
                              <span style={{ color: "#64748b" }}>{field.name}:</span>
                              <strong style={{ color: "#0f172a" }}>{extractPrimitiveValue(field.value)}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }

                  // Primitive Variable Box (int, double, char, bool)
                  return (
                    <div key={loc.name} className="simple-var-box primitive-box" style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                      <div>
                        <span style={{ fontSize: "0.68rem", color: "#64748b", display: "block" }}>{cleanType}</span>
                        <strong style={{ fontSize: "0.88rem", color: "#0f172a" }}>{loc.name}</strong>
                      </div>
                      <strong style={{ fontSize: "1rem", color: "#b6472a" }}>
                        {extractPrimitiveValue(loc.value !== undefined ? loc.value : loc.display)}
                      </strong>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT: HEAP MEMORY REGION */}
        <div className="simple-heap-region" style={{ background: "#f0fdf4", border: "2px solid #a7f3d0", borderRadius: "16px", padding: "16px", minHeight: "260px" }}>
          <div style={{ fontSize: "0.82rem", fontWeight: "bold", color: "#047857", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>🌳 HEAP MEMORY & DYNAMIC ALLOCATIONS</span>
            <span style={{ background: "rgba(16, 185, 129, 0.15)", color: "#047857", padding: "2px 8px", borderRadius: "4px", fontSize: "0.72rem", fontWeight: "bold" }}>HEAP</span>
          </div>

          {isRecursiveCall ? (
            <SimpleRecursionView stack={stack} />
          ) : (
            <SimpleGenericView locals={locals} allocations={allocations} registerSource={registerSource} registerTarget={registerTarget} />
          )}
        </div>

      </div>
    </div>
  );
}

function SimpleSinglyLinkedList({ allocations, locals, registerSource, registerTarget }) {
  const nodeAllocs = allocations.filter(a => {
    const t = String(a.type || a.preview?.type || "");
    return (t.includes("Node") && !t.includes("TreeNode")) || (a.preview?.fields && a.preview.fields.next !== undefined && a.preview.fields.left === undefined);
  });

  if (!nodeAllocs.length) {
    return <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic", textAlign: "center" }}>No Linked List Nodes Allocated on Heap Yet</div>;
  }

  return (
    <div className="simple-ll-wrapper" style={{ display: "flex", alignItems: "center", gap: "12px", overflowX: "auto", padding: "12px 4px" }}>

      {nodeAllocs.map((alloc, idx) => {
        const val = getNodeValue(alloc);
        return (
          <React.Fragment key={alloc.address}>
            <div ref={(el) => registerTarget && registerTarget(alloc.address, el)} className="heap-card" data-heap-address={alloc.address} style={{ display: "flex", background: "#ffffff", border: "2px solid #b6472a", borderRadius: "12px", overflow: "hidden", boxShadow: "0 4px 12px rgba(182, 71, 42, 0.12)", minWidth: "120px" }}>
              <div style={{ padding: "10px 14px", background: "rgba(182, 71, 42, 0.06)", borderRight: "1px solid rgba(182, 71, 42, 0.2)", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <span style={{ fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Value</span>
                <strong style={{ fontSize: "1.05rem", color: "#0f172a" }}>{val}</strong>
              </div>
              <div ref={(el) => registerSource && registerSource(`heap:${alloc.address}:next`, el)} style={{ padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: "#fafafa" }}>
                <span style={{ fontSize: "0.68rem", color: "#64748b" }}>next</span>
                <span style={{ color: "#b6472a", fontWeight: "bold" }}>➔</span>
              </div>
            </div>
            {idx < nodeAllocs.length - 1 ? (
              <span style={{ color: "#b6472a", fontWeight: "bold", fontSize: "1.2rem" }}>➔</span>
            ) : (
              <div style={{ padding: "6px 10px", background: "#fee2e2", color: "#991b1b", borderRadius: "8px", fontSize: "0.78rem", fontWeight: "bold" }}>NULL</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function SimpleDoublyLinkedList({ allocations, locals, registerSource, registerTarget }) {
  const dllAllocs = allocations.filter(a => {
    const t = String(a.type || a.preview?.type || "");
    return t.includes("Doubly") || (a.preview?.fields && a.preview.fields.prev !== undefined && a.preview.fields.next !== undefined);
  });

  if (!dllAllocs.length) {
    return <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic", textAlign: "center" }}>No Doubly Linked List Nodes Allocated on Heap Yet</div>;
  }

  return (
    <div className="simple-dll-wrapper" style={{ display: "flex", alignItems: "center", gap: "12px", overflowX: "auto", padding: "12px 4px" }}>
      <div style={{ padding: "6px 10px", background: "#fee2e2", color: "#991b1b", borderRadius: "8px", fontSize: "0.78rem", fontWeight: "bold" }}>NULL</div>
      <span style={{ color: "#0284c7", fontWeight: "bold", fontSize: "1.2rem" }}>⇄</span>

      {dllAllocs.map((alloc, idx) => {
        const val = getNodeValue(alloc);
        return (
          <React.Fragment key={alloc.address}>
            <div ref={(el) => registerTarget && registerTarget(alloc.address, el)} className="heap-card" data-heap-address={alloc.address} style={{ display: "flex", background: "#ffffff", border: "2px solid #0284c7", borderRadius: "12px", overflow: "hidden", boxShadow: "0 4px 12px rgba(2, 132, 199, 0.12)", minWidth: "140px" }}>
              <div ref={(el) => registerSource && registerSource(`heap:${alloc.address}:prev`, el)} style={{ padding: "8px 10px", background: "rgba(2, 132, 199, 0.08)", borderRight: "1px solid rgba(2, 132, 199, 0.2)", fontSize: "0.7rem", color: "#0284c7", fontWeight: "bold", display: "flex", alignItems: "center" }}>
                ◄ prev
              </div>
              <div style={{ padding: "10px 14px", flex: 1, textAlign: "center" }}>
                <span style={{ fontSize: "0.68rem", color: "#64748b", display: "block" }}>Value</span>
                <strong style={{ fontSize: "1.05rem", color: "#0f172a" }}>{val}</strong>
              </div>
              <div ref={(el) => registerSource && registerSource(`heap:${alloc.address}:next`, el)} style={{ padding: "8px 10px", background: "rgba(2, 132, 199, 0.08)", borderLeft: "1px solid rgba(2, 132, 199, 0.2)", fontSize: "0.7rem", color: "#0284c7", fontWeight: "bold", display: "flex", alignItems: "center" }}>
                next ►
              </div>
            </div>
            {idx < dllAllocs.length - 1 ? (
              <span style={{ color: "#0284c7", fontWeight: "bold", fontSize: "1.2rem" }}>⇄</span>
            ) : (
              <div style={{ padding: "6px 10px", background: "#fee2e2", color: "#991b1b", borderRadius: "8px", fontSize: "0.78rem", fontWeight: "bold" }}>NULL</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function SimpleBinaryTree({ allocations, locals, registerSource, registerTarget }) {
  const treeAllocs = allocations.filter(a => {
    const t = String(a.type || a.preview?.type || "");
    return t.includes("TreeNode") || (a.preview?.fields && (a.preview.fields.left !== undefined || a.preview.fields.right !== undefined));
  });

  if (!treeAllocs.length) {
    return <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic", textAlign: "center" }}>No Tree Nodes Allocated on Heap Yet</div>;
  }

  const root = treeAllocs[0];
  const children = treeAllocs.slice(1);

  return (
    <div className="simple-tree-wrapper" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", padding: "16px 0" }}>
      {/* 3-Compartment Tree Node Layout matching reference drawing: [ ◄ L | val | R ► ] */}
      <div className="tree-level-root" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div ref={(el) => registerTarget && registerTarget(root.address, el)} className="heap-card" data-heap-address={root.address} style={{ display: "flex", background: "#ffffff", border: "2.5px solid #10b981", borderRadius: "12px", overflow: "hidden", boxShadow: "0 6px 16px rgba(16, 185, 129, 0.2)", minWidth: "150px" }}>
          <div ref={(el) => registerSource && registerSource(`heap:${root.address}:left`, el)} style={{ padding: "8px 12px", background: "rgba(16, 185, 129, 0.12)", borderRight: "1px solid rgba(16, 185, 129, 0.3)", fontSize: "0.72rem", color: "#047857", fontWeight: "bold", display: "flex", alignItems: "center" }}>
            ◄ L
          </div>
          <div style={{ padding: "10px 16px", textAlign: "center", flex: 1 }}>
            <span style={{ fontSize: "0.65rem", color: "#059669", display: "block", textTransform: "uppercase", fontWeight: "bold" }}>Root</span>
            <strong style={{ fontSize: "1.1rem", color: "#0f172a" }}>{getNodeValue(root)}</strong>
          </div>
          <div ref={(el) => registerSource && registerSource(`heap:${root.address}:right`, el)} style={{ padding: "8px 12px", background: "rgba(16, 185, 129, 0.12)", borderLeft: "1px solid rgba(16, 185, 129, 0.3)", fontSize: "0.72rem", color: "#047857", fontWeight: "bold", display: "flex", alignItems: "center" }}>
            R ►
          </div>
        </div>
      </div>

      {children.length > 0 && (
        <div className="tree-level-children" style={{ display: "flex", gap: "30px", position: "relative" }}>
          {children.map((child, idx) => (
            <div key={child.address} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div ref={(el) => registerTarget && registerTarget(child.address, el)} className="heap-card" data-heap-address={child.address} style={{ display: "flex", background: "#ffffff", border: "2px solid #10b981", borderRadius: "10px", overflow: "hidden", boxShadow: "0 4px 12px rgba(16, 185, 129, 0.15)", minWidth: "120px" }}>
                <div ref={(el) => registerSource && registerSource(`heap:${child.address}:left`, el)} style={{ padding: "6px 8px", background: "rgba(16, 185, 129, 0.08)", borderRight: "1px solid rgba(16, 185, 129, 0.2)", fontSize: "0.68rem", color: "#047857", fontWeight: "bold", display: "flex", alignItems: "center" }}>
                  ◄ L
                </div>
                <div style={{ padding: "8px 12px", textAlign: "center", flex: 1 }}>
                  <span style={{ fontSize: "0.62rem", color: "#64748b", display: "block" }}>{idx === 0 ? "LEFT" : "RIGHT"}</span>
                  <strong style={{ fontSize: "0.95rem", color: "#0f172a" }}>{getNodeValue(child)}</strong>
                </div>
                <div ref={(el) => registerSource && registerSource(`heap:${child.address}:right`, el)} style={{ padding: "6px 8px", background: "rgba(16, 185, 129, 0.08)", borderLeft: "1px solid rgba(16, 185, 129, 0.2)", fontSize: "0.68rem", color: "#047857", fontWeight: "bold", display: "flex", alignItems: "center" }}>
                  R ►
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SimpleStack({ locals, allocations }) {
  let items = [];
  locals.forEach(loc => {
    if (loc.value !== undefined) {
      items.push({ name: loc.name, value: extractPrimitiveValue(loc.value) });
    } else if (loc.children && Array.isArray(loc.children)) {
      loc.children.forEach(c => items.push({ name: c.name, value: extractPrimitiveValue(c.value) }));
    }
  });

  if (!items.length) {
    return <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic", textAlign: "center" }}>Stack is empty.</div>;
  }

  return (
    <div className="simple-stack-wrapper" style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 0" }}>
      <div style={{ fontSize: "0.78rem", fontWeight: "bold", color: "#b6472a", marginBottom: "8px", display: "flex", alignItems: "center", gap: "4px" }}>
        TOP OF STACK ⬇
      </div>
      <div style={{ display: "flex", flexDirection: "column-reverse", gap: "8px", minWidth: "180px", maxWidth: "260px", padding: "12px", background: "rgba(182, 71, 42, 0.04)", borderLeft: "3px solid #b6472a", borderRight: "3px solid #b6472a", borderBottom: "3px solid #b6472a", borderRadius: "0 0 14px 14px" }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ padding: "10px 14px", background: idx === items.length - 1 ? "linear-gradient(135deg, #fff3dc, #ffe0b2)" : "#ffffff", border: idx === items.length - 1 ? "2px solid #b6472a" : "1px solid #e2e8f0", borderRadius: "10px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 6px rgba(0,0,0,0.04)" }}>
            <span style={{ fontSize: "0.78rem", color: "#64748b" }}>{item.name || `[${idx}]`}</span>
            <strong style={{ fontSize: "1rem", color: idx === items.length - 1 ? "#b6472a" : "#0f172a" }}>{item.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimpleQueue({ locals, allocations }) {
  let items = [];
  locals.forEach(loc => {
    if (loc.value !== undefined) {
      items.push({ name: loc.name, value: extractPrimitiveValue(loc.value) });
    } else if (loc.children && Array.isArray(loc.children)) {
      loc.children.forEach(c => items.push({ name: c.name, value: extractPrimitiveValue(c.value) }));
    }
  });

  if (!items.length) {
    return <div style={{ padding: "16px", color: "#64748b", fontStyle: "italic", textAlign: "center" }}>Queue is empty.</div>;
  }

  return (
    <div className="simple-queue-wrapper" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 0", overflowX: "auto" }}>
      <div style={{ fontSize: "0.78rem", fontWeight: "bold", color: "#2563eb", whiteSpace: "nowrap" }}>FRONT ──►</div>
      <div style={{ display: "flex", gap: "8px", padding: "10px 14px", background: "rgba(37, 99, 235, 0.04)", borderTop: "3px solid #2563eb", borderBottom: "3px solid #2563eb", borderRadius: "12px" }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ padding: "10px 14px", background: idx === 0 ? "#dbeafe" : "#ffffff", border: idx === 0 ? "2px solid #2563eb" : "1px solid #cbd5e1", borderRadius: "10px", textAlign: "center", minWidth: "60px", boxShadow: "0 2px 6px rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize: "0.68rem", color: "#64748b" }}>{item.name || `[${idx}]`}</div>
            <strong style={{ fontSize: "1rem", color: idx === 0 ? "#1e40af" : "#0f172a" }}>{item.value}</strong>
          </div>
        ))}
      </div>
      <div style={{ fontSize: "0.78rem", fontWeight: "bold", color: "#2563eb", whiteSpace: "nowrap" }}>◄── REAR</div>
    </div>
  );
}

function SimpleArrayView({ locals }) {
  const arrayVars = locals.filter(l => l.isArray || Array.isArray(l.children) || l.kind === "array" || l.type?.includes("vector"));

  if (!arrayVars.length) {
    return <SimpleGenericView locals={locals} />;
  }

  return (
    <div className="simple-arrays-wrapper" style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "8px 0" }}>
      {arrayVars.map((arr) => {
        const elems = arr.children || [];
        return (
          <div key={arr.name} style={{ background: "#f8fafc", borderRadius: "14px", border: "1px solid #e2e8f0", padding: "14px" }}>
            <div style={{ fontSize: "0.85rem", color: "#0284c7", fontWeight: "bold", marginBottom: "8px" }}>
              Array: <code>{arr.name}</code> ({elems.length} elements)
            </div>
            <div style={{ display: "flex", gap: "6px", overflowX: "auto", paddingBottom: "4px" }}>
              {elems.map((elem, idx) => (
                <div key={idx} style={{ background: "#ffffff", border: "1.5px solid #0284c7", borderRadius: "10px", minWidth: "50px", textAlign: "center", padding: "8px 10px", boxShadow: "0 2px 6px rgba(0,0,0,0.03)" }}>
                  <div style={{ fontSize: "0.68rem", color: "#0284c7", fontWeight: "bold" }}>[{idx}]</div>
                  <strong style={{ fontSize: "0.95rem", color: "#0f172a" }}>{extractPrimitiveValue(elem.value !== undefined ? elem.value : elem)}</strong>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SimpleHeapView({ allocations, locals }) {
  if (!allocations.length) {
    return <SimpleGenericView locals={locals} allocations={allocations} />;
  }

  return (
    <div className="simple-heap-wrapper" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px", padding: "8px 0" }}>
      {allocations.map((alloc, idx) => (
        <div key={alloc.address} style={{ background: "#ffffff", border: "1.5px solid #10b981", borderRadius: "12px", padding: "12px", boxShadow: "0 2px 6px rgba(0,0,0,0.03)" }}>
          <div style={{ fontSize: "0.72rem", color: "#10b981", fontWeight: "bold", textTransform: "uppercase" }}>{cleanTypeName(alloc.previewType || "Heap Object")} #{idx + 1}</div>
          <div style={{ marginTop: "6px", fontSize: "0.9rem", color: "#0f172a" }}>
            Value: <strong>{getNodeValue(alloc)}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

function SimpleHashTableLocals({ locals, allocations }) {
  return <SimpleGenericView locals={locals} allocations={allocations} />;
}

function SimpleGraphView({ locals, allocations }) {
  return <SimpleGenericView locals={locals} allocations={allocations} />;
}

function SimpleRecursionView({ stack }) {
  return (
    <div className="simple-recursion-wrapper" style={{ padding: "12px 0" }}>
      <div style={{ fontSize: "0.82rem", fontWeight: "bold", color: "#8b5cf6", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
        <span>🔄</span> Call-Stack Traversal (Depth: {stack.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {stack.map((frame, idx) => (
          <div key={idx} style={{ background: idx === 0 ? "linear-gradient(135deg, #f3e8ff, #e9d5ff)" : "#ffffff", border: idx === 0 ? "2px solid #8b5cf6" : "1px solid #e2e8f0", borderRadius: "12px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 2px 6px rgba(0,0,0,0.03)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "0.75rem", background: idx === 0 ? "#8b5cf6" : "#cbd5e1", color: "#ffffff", padding: "2px 8px", borderRadius: "999px", fontWeight: "bold" }}>
                {idx === 0 ? "Active Frame" : `#${idx + 1}`}
              </span>
              <strong style={{ fontSize: "0.95rem", color: "#0f172a" }}>{frame.function}()</strong>
              <span style={{ fontSize: "0.78rem", color: "#64748b" }}>line {frame.line}</span>
            </div>
            <div style={{ fontSize: "0.82rem", color: "#475569" }}>
              {(frame.locals || []).map(l => `${l.name} = ${extractPrimitiveValue(l.value)}`).join(", ")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimpleGenericView({ locals, allocations, registerSource, registerTarget }) {
  if (!allocations || !allocations.length) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "#64748b" }}>
        <div style={{ fontSize: "1rem", fontWeight: "bold", color: "#047857", marginBottom: "4px" }}>No Dynamic Heap Allocations Active</div>
        <p style={{ margin: 0, fontSize: "0.85rem" }}>All primitive local variables, arrays, and objects are currently allocated directly inside the <strong>STACK MEMORY</strong> frame on the left.</p>
      </div>
    );
  }

  return (
    <div className="simple-generic-heap-wrapper" style={{ padding: "6px 0" }}>
      <div style={{ fontSize: "0.82rem", fontWeight: "bold", color: "#047857", marginBottom: "10px" }}>
        Active Heap Memory Objects ({allocations.length})
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "12px" }}>
        {allocations.map((alloc) => {
          const typeName = cleanTypeName(alloc.previewType || "Heap Allocation");
          const hexAddr = alloc.address ? String(alloc.address).toLowerCase() : "";
          const fields = alloc.preview?.fields || alloc.preview?.children || [];

          return (
            <div
              key={alloc.address}
              className="heap-card"
              data-heap-address={hexAddr}
              ref={(el) => {
                if (typeof registerTarget === "function" && hexAddr) {
                  registerTarget(hexAddr, el);
                  registerTarget(alloc.address, el);
                }
              }}
              style={{ background: "#ffffff", border: "1.5px solid #10b981", borderRadius: "12px", padding: "12px", boxShadow: "0 2px 6px rgba(0,0,0,0.04)" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <span style={{ fontSize: "0.75rem", color: "#047857", fontWeight: "bold" }}>{typeName}</span>
                <span style={{ fontSize: "0.65rem", background: "rgba(16, 185, 129, 0.12)", color: "#047857", padding: "2px 6px", borderRadius: "4px", fontFamily: "monospace" }}>{hexAddr ? hexAddr.substring(0, 8) : "heap"}</span>
              </div>

              {Array.isArray(fields) && fields.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                  {fields.map((f, fIdx) => {
                    const fname = f.name || `field_${fIdx}`;
                    const fvalObj = f.value !== undefined ? f.value : f;
                    const fvalStr = extractPrimitiveValue(fvalObj);
                    const isPtrField = typeof fvalStr === "string" && fvalStr.startsWith("0x");
                    const targetAddr = (fvalObj && typeof fvalObj === "object" && fvalObj.targetAddress) || (isPtrField ? fvalStr : null);

                    const isContainerField = fvalObj && typeof fvalObj === "object" && (Array.isArray(fvalObj.children) || Array.isArray(fvalObj.entries));
                    const containerItems = isContainerField ? (fvalObj.children || fvalObj.entries || []) : [];

                    if (isContainerField && containerItems.length > 0) {
                      return (
                        <div key={fIdx} style={{ display: "flex", flexDirection: "column", gap: "2px", margin: "2px 0" }}>
                          <div style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: "600" }}>{fname}:</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingLeft: "6px", borderLeft: "2px solid #cbd5e1" }}>
                            {containerItems.map((item, itemIdx) => {
                              const itemObj = item.value !== undefined ? item.value : item;
                              const itemValStr = extractPrimitiveValue(itemObj);
                              const isItemPtr = typeof itemValStr === "string" && itemValStr.startsWith("0x");
                              const itemTargetAddr = (itemObj && typeof itemObj === "object" && itemObj.targetAddress) || (isItemPtr ? itemValStr : null);
                              const itemLabel = item.name || `[${itemIdx}]`;
                              const exactEdgeKey = `heap:${hexAddr}:${fname}${itemLabel}`;

                              return (
                                <div
                                  key={itemIdx}
                                  ref={(el) => {
                                    if (typeof registerSource === "function" && el) {
                                      registerSource(exactEdgeKey, el);
                                      registerSource(`${exactEdgeKey.toLowerCase()}`, el);
                                      if (itemTargetAddr) {
                                        registerSource(itemTargetAddr, el);
                                        registerSource(itemTargetAddr.toLowerCase(), el);
                                      }
                                    }
                                  }}
                                  style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem" }}
                                >
                                  <span style={{ color: "#475569" }}>{itemLabel}:</span>
                                  <strong style={{ color: isItemPtr ? "#b6472a" : "#0f172a", fontFamily: "monospace" }}>
                                    {itemValStr}
                                  </strong>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={fIdx}
                        ref={(el) => {
                          if (typeof registerSource === "function" && el) {
                            const srcKey = `heap:${hexAddr}:${fname}`;
                            registerSource(srcKey, el);
                            if (targetAddr) {
                              registerSource(targetAddr, el);
                            }
                          }
                        }}
                        style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem" }}
                      >
                        <span style={{ color: "#64748b" }}>{fname}:</span>
                        <strong style={{ color: isPtrField ? "#b6472a" : "#0f172a" }}>{fvalStr}</strong>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: "1rem", color: "#0f172a", fontWeight: "bold" }}>
                  {alloc.preview?.value !== undefined ? extractPrimitiveValue(alloc.preview.value) : "active"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatPlaybackDelay(delayMs) {
  if (delayMs >= 1000) {
    return `${(delayMs / 1000).toFixed(delayMs % 1000 === 0 ? 0 : 1)} s/step`;
  }

  return `${delayMs} ms/step`;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <VisualizerErrorBoundary>
    <App />
  </VisualizerErrorBoundary>
);
