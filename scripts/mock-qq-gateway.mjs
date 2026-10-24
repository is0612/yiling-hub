import http from "node:http";
import { WebSocketServer } from "ws";

// Mock of the QQ official bot gateway + REST API, for end-to-end tests only.
// It must never run in production: it has no authentication and accepts anything.

const httpPort = Number(process.env.QQ_MOCK_HTTP_PORT ?? 4021);
const wsPort = Number(process.env.QQ_MOCK_WS_PORT ?? 4020);

const sentMessages = [];
let seq = 1;
const gatewayClients = new Set();

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

  if (req.method === "POST" && path === "/app/getAppAccessToken") {
    return json(res, 200, { access_token: "mock-access-token", expires_in: 7200 });
  }

  if (req.method === "POST" && /^\/v2\/(groups|users)\/[^/]+\/messages$/.test(path)) {
    const body = await readJson(req);
    const authorization = req.headers.authorization || "";
    sentMessages.push({ path, body, authorization, at: new Date().toISOString() });
    return json(res, 200, { id: "mock-sent-" + sentMessages.length, timestamp: String(Date.now()) });
  }

  if (req.method === "POST" && path === "/__mock/emit") {
    const body = await readJson(req);
    const frame = JSON.stringify({ op: 0, s: seq++, t: body.t, d: body.d });
    for (const ws of gatewayClients) {
      if (ws.readyState === 1) ws.send(frame);
    }
    return json(res, 200, { delivered: gatewayClients.size });
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
  gatewayClients.add(ws);
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));

  ws.on("message", (data) => {
    let payload;
    try { payload = JSON.parse(String(data)); } catch { return; }
    if (payload.op === 2) {
      ws.send(JSON.stringify({ op: 0, s: seq++, t: "READY", d: { session_id: "mock-session" } }));
    } else if (payload.op === 6) {
      ws.send(JSON.stringify({ op: 0, s: seq++, t: "READY", d: { session_id: "mock-session" } }));
    } else if (payload.op === 1) {
      ws.send(JSON.stringify({ op: 11 }));
    }
  });

  ws.on("close", () => gatewayClients.delete(ws));
});

httpServer.listen(httpPort, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "mock-qq-ready", httpPort, wsPort }) + "\n");
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
