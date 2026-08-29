const crypto = require("crypto");
const EventEmitter = require("events");

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.emit("close"));
    socket.on("end", () => this.emit("close"));
    socket.on("error", (error) => this.emit("error", error));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        payloadLength = high * 2 ** 32 + low;
        offset = 10;
      }

      const maskOffset = masked ? 4 : 0;
      const frameLength = offset + maskOffset + payloadLength;
      if (this.buffer.length < frameLength) {
        return;
      }

      let payload = this.buffer.slice(offset + maskOffset, frameLength);
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = unmask(payload, mask);
      }

      this.buffer = this.buffer.slice(frameLength);

      if (opcode === 0x8) {
        this.socket.end();
        return;
      }

      if (opcode === 0x9) {
        this.socket.write(createFrame(payload, 0x0a));
        continue;
      }

      if (opcode === 0x1) {
        try {
          this.emit("json", JSON.parse(payload.toString("utf8")));
        } catch (error) {
          this.emit("error", error);
          this.close();
        }
      }
    }
  }

  sendJson(message) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    this.socket.write(createFrame(payload, 0x1));
  }

  onJson(handler) {
    this.on("json", handler);
  }

  onClose(handler) {
    this.on("close", handler);
  }

  close() {
    this.socket.end();
  }
}

class WebSocketServer {
  constructor(server, { path, onConnection }) {
    this.server = server;
    this.path = path;
    this.onConnection = onConnection;

    this.server.on("upgrade", (req, socket) => {
      if (new URL(req.url, "http://localhost").pathname !== this.path) {
        socket.destroy();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n")
      );

      const connection = new WebSocketConnection(socket);
      this.onConnection(connection);
    });
  }

  close() {
    // The HTTP server owns the underlying socket lifecycle.
  }
}

function unmask(payload, mask) {
  const output = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index] ^ mask[index % 4];
  }
  return output;
}

function createFrame(payload, opcode) {
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

module.exports = {
  WebSocketServer,
};
