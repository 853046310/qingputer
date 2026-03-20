#!/usr/bin/env node
/**
 * Standalone relay bridge — spawns qingputer-runtime, reads handshake,
 * connects to the relay server, and bridges all messages.
 * Prints the mobile connection info for manual input.
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import { WebSocket } from "ws";
import crypto from "crypto";

const RELAY_URL = process.env.RELAY_URL || "ws://127.0.0.1:8090";
const RUNTIME_BIN = process.env.RUNTIME_BIN || "/Applications/Qingputer.app/Contents/MacOS/qingputer-runtime";
const ROOM_ID = crypto.randomUUID();
const ROOM_TOKEN = crypto.randomUUID();

// ─── 1. Spawn runtime ─────────────────────────────────────────────────────────
console.log("[bridge] Spawning runtime...");
const child = spawn(RUNTIME_BIN, [], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const rl = createInterface({ input: child.stdout });

const handshake = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Runtime handshake timeout")), 15000);
  rl.once("line", (line) => {
    clearTimeout(timer);
    try {
      resolve(JSON.parse(line.trim()));
    } catch (e) {
      reject(new Error(`Invalid handshake: ${line}`));
    }
  });
  child.on("error", reject);
  child.on("exit", (code) => reject(new Error(`Runtime exited with ${code}`)));
});

const { port: runtimePort, token: runtimeToken } = handshake;
console.log(`[bridge] Runtime ready on port ${runtimePort}`);

// Wait for runtime health
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${runtimePort}/health`, {
      headers: { Authorization: `Bearer ${runtimeToken}` },
    });
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// ─── 2. Connect to Relay server ────────────────────────────────────────────────
console.log(`[bridge] Connecting to relay at ${RELAY_URL}...`);

const localSockets = new Map();

function connectRelay() {
  const ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    console.log("[bridge] Connected to relay, registering room...");
    ws.send(JSON.stringify({ type: "register", roomId: ROOM_ID, token: ROOM_TOKEN }));
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "registered":
        console.log(`[bridge] Room registered!`);
        console.log("");
        console.log("══════════════════════════════════════════════════");
        console.log("  手机端 Relay 连接信息:");
        console.log(`  Relay 地址: ${RELAY_URL}`);
        console.log(`  房间 ID:    ${ROOM_ID}`);
        console.log(`  Token:      ${ROOM_TOKEN}`);
        console.log("══════════════════════════════════════════════════");
        console.log("");
        break;

      case "http-request": {
        const url = `http://127.0.0.1:${runtimePort}${msg.path}`;
        try {
          const init = { method: msg.method, headers: msg.headers };
          if (msg.body && msg.method !== "GET" && msg.method !== "HEAD") {
            init.body = msg.body;
          }
          const resp = await fetch(url, init);
          const body = await resp.text();
          const headers = {};
          resp.headers.forEach((v, k) => { headers[k] = v; });
          ws.send(JSON.stringify({
            type: "http-response",
            requestId: msg.requestId,
            status: resp.status,
            headers,
            body,
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: "http-response",
            requestId: msg.requestId,
            status: 502,
            headers: {},
            body: JSON.stringify({ detail: String(err) }),
          }));
        }
        break;
      }

      case "ws-subscribe": {
        const existing = localSockets.get(msg.subscriptionId);
        if (existing) { existing.close(); localSockets.delete(msg.subscriptionId); }

        const wsUrl = `ws://127.0.0.1:${runtimePort}${msg.path}`;
        const local = new WebSocket(wsUrl);
        localSockets.set(msg.subscriptionId, local);

        local.on("message", (data) => {
          ws.send(JSON.stringify({
            type: "ws-event",
            subscriptionId: msg.subscriptionId,
            data: data.toString(),
          }));
        });
        local.on("close", () => localSockets.delete(msg.subscriptionId));
        local.on("error", () => { localSockets.delete(msg.subscriptionId); local.close(); });
        break;
      }

      case "ws-unsubscribe": {
        const sock = localSockets.get(msg.subscriptionId);
        if (sock) { sock.close(); localSockets.delete(msg.subscriptionId); }
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;

      case "pong":
        break;
    }
  });

  ws.on("close", () => {
    console.log("[bridge] Relay disconnected, reconnecting in 3s...");
    setTimeout(connectRelay, 3000);
  });

  ws.on("error", (e) => {
    console.error("[bridge] Relay error:", e.message);
  });

  // Heartbeat
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 25000);
  ws.on("close", () => clearInterval(hb));
}

connectRelay();

// ─── 3. Cleanup ────────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[bridge] Shutting down...");
  child.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  child.kill();
  process.exit(0);
});
