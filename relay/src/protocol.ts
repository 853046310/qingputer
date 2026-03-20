/** Tunnel message types shared between Relay server, Desktop client, and Mobile client. */

// ─── Desktop → Relay ────────────────────────────────────────────────────────────
export interface RegisterMessage {
  type: "register";
  roomId: string;
  token: string;
}

// ─── Mobile → Relay ─────────────────────────────────────────────────────────────
export interface JoinMessage {
  type: "join";
  roomId: string;
  token: string;
}

// ─── Relay → Client ─────────────────────────────────────────────────────────────
export interface RegisteredMessage {
  type: "registered";
  roomId: string;
}

export interface JoinedMessage {
  type: "joined";
  roomId: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

// ─── Mobile → Desktop (via Relay) ───────────────────────────────────────────────
export interface HttpRequestMessage {
  type: "http-request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

// ─── Desktop → Mobile (via Relay) ───────────────────────────────────────────────
export interface HttpResponseMessage {
  type: "http-response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ─── WebSocket subscription (event streaming) ───────────────────────────────────
export interface WsSubscribeMessage {
  type: "ws-subscribe";
  subscriptionId: string;
  path: string;
}

export interface WsEventMessage {
  type: "ws-event";
  subscriptionId: string;
  data: string;
}

export interface WsUnsubscribeMessage {
  type: "ws-unsubscribe";
  subscriptionId: string;
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────────
export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

// ─── Union type ─────────────────────────────────────────────────────────────────
export type TunnelMessage =
  | RegisterMessage
  | JoinMessage
  | RegisteredMessage
  | JoinedMessage
  | ErrorMessage
  | HttpRequestMessage
  | HttpResponseMessage
  | WsSubscribeMessage
  | WsEventMessage
  | WsUnsubscribeMessage
  | PingMessage
  | PongMessage;
