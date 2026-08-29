const http = require("http");
const path = require("path");
const { createStaticHandler } = require("./lib/static-server");
const { WebSocketServer } = require("./lib/websocket-server");
const { SessionManager } = require("./lib/session-manager");

const fs = require("fs");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const BUNDLED_MINGW_BIN = path.join(PROJECT_ROOT, "runtime", "mingw", "bin");
const BUNDLED_NODE_DIR = path.join(PROJECT_ROOT, "runtime", "node");

if (fs.existsSync(BUNDLED_MINGW_BIN)) {
  process.env.PATH = `${BUNDLED_MINGW_BIN};${BUNDLED_NODE_DIR};${process.env.PATH}`;
  console.log(`[C++ Backend] Prepended bundled MinGW toolchain to PATH: ${BUNDLED_MINGW_BIN}`);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const webRoot = path.join(PROJECT_ROOT, "frontend");
const staticHandler = createStaticHandler(webRoot);
const sessionManager = new SessionManager({
  workspaceRoot: path.join(PROJECT_ROOT, ".sessions"),
  runtimeRoot: path.join(PROJECT_ROOT, "cpp", "runtime"),
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  staticHandler(req, res);
});

const wsServer = new WebSocketServer(server, {
  path: "/ws",
  onConnection(socket) {
    const session = sessionManager.create(socket);

    socket.sendJson({
      type: "session-ready",
      sessionId: session.id,
      limits: session.getLimits(),
    });

    socket.onJson(async (message) => {
      try {
        switch (message.type) {
          case "compile-and-start":
            await session.compileAndStart(message.code || "");
            break;
          case "step-over":
            await session.stepOver();
            break;
          case "step-into":
            await session.stepInto();
            break;
          case "continue":
            await session.continueExecution();
            break;
          case "restart":
            await session.restart();
            break;
          case "stop":
            await session.dispose();
            break;
          default:
            socket.sendJson({
              type: "session-error",
              error: `Unknown message type: ${message.type}`,
            });
        }
      } catch (error) {
        socket.sendJson({
          type: "session-error",
          error: error && error.message ? error.message : String(error),
        });
      }
    });

    socket.onClose(async () => {
      await sessionManager.destroy(session.id);
    });

    socket.on("error", (error) => {
      socket.sendJson({
        type: "session-error",
        error: error && error.message ? error.message : "WebSocket protocol error.",
      });
    });
  },
});

server.listen(PORT, () => {
  console.log(`C++ execution visualizer listening on http://localhost:${PORT}`);
});

async function shutdown() {
  await sessionManager.disposeAll();
  wsServer.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
