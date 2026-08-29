const fs = require("fs");
const { DebugSession } = require("./debug-session");

class SessionManager {
  constructor({ workspaceRoot, runtimeRoot }) {
    this.workspaceRoot = workspaceRoot;
    this.runtimeRoot = runtimeRoot;
    this.sessions = new Map();
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  create(socket) {
    const session = new DebugSession({
      socket,
      workspaceRoot: this.workspaceRoot,
      runtimeRoot: this.runtimeRoot,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async destroy(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    this.sessions.delete(id);
    await session.dispose();
  }

  async disposeAll() {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroy(id)));
  }
}

module.exports = {
  SessionManager,
};
