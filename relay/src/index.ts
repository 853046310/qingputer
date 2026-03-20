import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TunnelMessage } from "./protocol.js";
import {
  handleRegister,
  handleJoin,
  forwardToDesktop,
  forwardToMobile,
  getRoom,
  getRoomCount,
  REQUEST_TIMEOUT_MS,
} from "./room.js";

const PORT = parseInt(process.env.PORT ?? "8090", 10);
const HEARTBEAT_INTERVAL_MS = 25_000;

// ─── HTTP server (health check) ─────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: getRoomCount() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ─── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

interface ClientState {
  role: "desktop" | "mobile" | null;
  roomId: string | null;
  alive: boolean;
}

const clientStates = new WeakMap<WebSocket, ClientState>();

wss.on("connection", (ws) => {
  const state: ClientState = { role: null, roomId: null, alive: true };
  clientStates.set(ws, state);

  ws.on("pong", () => {
    state.alive = true;
  });

  ws.on("message", (raw) => {
    let msg: TunnelMessage;
    try {
      msg = JSON.parse(raw.toString()) as TunnelMessage;
    } catch {
      sendMsg(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {
      case "register": {
        state.role = "desktop";
        state.roomId = msg.roomId;
        handleRegister(ws, msg.roomId, msg.token);
        break;
      }

      case "join": {
        state.role = "mobile";
        state.roomId = msg.roomId;
        handleJoin(ws, msg.roomId, msg.token);
        break;
      }

      case "ping": {
        sendMsg(ws, { type: "pong" });
        break;
      }

      case "pong": {
        // Application-level pong, just mark alive
        state.alive = true;
        break;
      }

      // ─── Forward messages between peers ───────────────────────────────
      case "http-request":
      case "ws-subscribe":
      case "ws-unsubscribe": {
        // Mobile → Desktop
        if (!state.roomId) {
          sendMsg(ws, { type: "error", message: "Not in a room" });
          break;
        }
        const sent = forwardToDesktop(state.roomId, msg);
        if (!sent) {
          if (msg.type === "http-request") {
            // Return 502 if desktop unreachable
            sendMsg(ws, {
              type: "http-response",
              requestId: msg.requestId,
              status: 502,
              headers: {},
              body: JSON.stringify({ detail: "Desktop is offline" }),
            });
          }
        }
        break;
      }

      case "http-response":
      case "ws-event": {
        // Desktop → Mobile
        if (!state.roomId) {
          sendMsg(ws, { type: "error", message: "Not in a room" });
          break;
        }
        forwardToMobile(state.roomId, msg);
        break;
      }

      default: {
        sendMsg(ws, { type: "error", message: `Unknown message type` });
      }
    }
  });

  ws.on("error", (err) => {
    console.error("[ws] error:", err.message);
  });
});

// ─── Heartbeat (WebSocket-level ping/pong) ──────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const state = clientStates.get(ws);
    if (state && !state.alive) {
      ws.terminate();
      continue;
    }
    if (state) state.alive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

function sendMsg(ws: WebSocket, msg: TunnelMessage) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Relay listening on :${PORT}`);
});
