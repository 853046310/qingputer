import type { WebSocket } from "ws";
import type { TunnelMessage } from "./protocol.js";

const GRACE_PERIOD_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface Room {
  roomId: string;
  token: string;
  desktop: WebSocket | null;
  mobile: WebSocket | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();

function send(ws: WebSocket, msg: TunnelMessage) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function handleRegister(
  ws: WebSocket,
  roomId: string,
  token: string,
) {
  let room = rooms.get(roomId);
  if (room) {
    // Reconnect: verify token
    if (room.token !== token) {
      send(ws, { type: "error", message: "Token mismatch" });
      return;
    }
    // Cancel grace timer if any
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    room.desktop = ws;
  } else {
    room = { roomId, token, desktop: ws, mobile: null, graceTimer: null };
    rooms.set(roomId, room);
  }
  send(ws, { type: "registered", roomId });
  console.log(`[room] registered: ${roomId}`);

  ws.on("close", () => onDesktopDisconnect(roomId));
}

export function handleJoin(
  ws: WebSocket,
  roomId: string,
  token: string,
) {
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: "error", message: "Room not found" });
    return;
  }
  if (room.token !== token) {
    send(ws, { type: "error", message: "Token mismatch" });
    return;
  }
  room.mobile = ws;
  send(ws, { type: "joined", roomId });
  console.log(`[room] mobile joined: ${roomId}`);

  ws.on("close", () => {
    if (room.mobile === ws) {
      room.mobile = null;
      console.log(`[room] mobile left: ${roomId}`);
    }
  });
}

/** Forward a message from mobile to desktop. */
export function forwardToDesktop(roomId: string, msg: TunnelMessage): boolean {
  const room = rooms.get(roomId);
  if (!room?.desktop || room.desktop.readyState !== room.desktop.OPEN) {
    return false;
  }
  room.desktop.send(JSON.stringify(msg));
  return true;
}

/** Forward a message from desktop to mobile. */
export function forwardToMobile(roomId: string, msg: TunnelMessage): boolean {
  const room = rooms.get(roomId);
  if (!room?.mobile || room.mobile.readyState !== room.mobile.OPEN) {
    return false;
  }
  room.mobile.send(JSON.stringify(msg));
  return true;
}

function onDesktopDisconnect(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.desktop = null;
  console.log(`[room] desktop disconnected: ${roomId}, grace period ${GRACE_PERIOD_MS}ms`);

  room.graceTimer = setTimeout(() => {
    // Notify mobile and destroy
    if (room.mobile) {
      send(room.mobile, { type: "error", message: "Desktop disconnected" });
      room.mobile.close();
    }
    rooms.delete(roomId);
    console.log(`[room] destroyed: ${roomId}`);
  }, GRACE_PERIOD_MS);
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function getRoomCount(): number {
  return rooms.size;
}

export { REQUEST_TIMEOUT_MS };
