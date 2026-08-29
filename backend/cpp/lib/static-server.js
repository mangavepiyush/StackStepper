const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jsx": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function createStaticHandler(frontendDir) {
  return async function staticHandler(req, res) {
    const url = new URL(req.url, "http://localhost");
    let requestPath = url.pathname;

    if (requestPath === "/" || requestPath === "") {
      requestPath = "/shell/index.html";
    }

    let filePath;
    if (requestPath.startsWith("/shell/")) {
      filePath = path.join(frontendDir, "shell", requestPath.substring(7));
    } else if (requestPath.startsWith("/cpp/")) {
      filePath = path.join(frontendDir, "cpp", requestPath.substring(5));
    } else if (requestPath.startsWith("/sql/")) {
      filePath = path.join(frontendDir, "sql", requestPath.substring(5));
    } else if (requestPath === "/cpp") {
      filePath = path.join(frontendDir, "cpp", "index.html");
    } else if (requestPath === "/sql") {
      filePath = path.join(frontendDir, "sql", "index.html");
    } else {
      filePath = path.join(frontendDir, "cpp", requestPath.startsWith("/") ? requestPath.substring(1) : requestPath);
    }

    if (!filePath.startsWith(frontendDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      res.writeHead(404);
      res.end("Not found");
    }
  };
}

module.exports = { createStaticHandler };
