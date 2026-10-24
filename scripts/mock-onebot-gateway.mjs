import http from "node:http";
import { WebSocketServer } from "ws";

// Mock of the OneBot v11 gateway (forward WS + HTTP API), for end-to-end tests only.
// It must never run in production: it has no authentication and accepts anything.

const httpPort = Number(process.env.ONEBOT_MOCK_HTTP_PORT ?? 4031);
const wsPort = Number(process.env.ONEBOT_MOCK_WS_PORT ?? 4030);

const sentMessages = [];
const wsClients = new Set();

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "GET" && path === "/get_status") {
    return json(res, 200, { status: { good: true, app_initialized: true } });
  }

  if (req.method === "POST" && (path === "/send_private_msg" || path === "/send_group_msg")) {
    const body = await readJson(req);
    sentMessages.push({ action: path.slice(1), body, at: new Date().toISOString() });
    return json(res, 200, { status: "ok", retcode: 0, data: { message_id: 100000 + sentMessages.length } });
  }

  if (req.method === "POST" && path === "/__mock/emit") {
    const body = await readJson(req);
    const frame = JSON.stringify(body.event);
    for (const ws of wsClients) {
      if (ws.readyState === 1) ws.send(frame);
    }
    return json(res, 200, { delivered: wsClients.size });
  }

  if (req.method === "GET" && path === "/__mock/messages") {
    return json(res, 200, { messages: sentMessages });
  }

  if (req.method === "POST" && path === "/__mock/reset") {
    sentMessages.length = 0;
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not_found" });
});

const wsServer = new WebSocketServer({ port: wsPort, host: "127.0.0.1" });

wsServer.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("message", () => {
    // OneBot v11 forward WS has no handshake; the client just connects and reads events.
  });
  ws.on("close", () => wsClients.delete(ws));
});

httpServer.listen(httpPort, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "mock-onebot-ready", httpPort, wsPort }) + "\n");
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
