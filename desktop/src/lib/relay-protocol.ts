/** Tunnel message types — mirrored from relay/src/protocol.ts */

export interface RegisterMessage {
  type: "register";
  roomId: string;
  token: string;
}

export interface JoinMessage {
  type: "join";
  roomId: string;
  token: string;
}

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

export interface HttpRequestMessage {
  type: "http-request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface HttpResponseMessage {
  type: "http-response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

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

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

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
