import type {
  TunnelMessage,
  HttpRequestMessage,
  WsSubscribeMessage,
  WsUnsubscribeMessage,
} from "./relay-protocol";

export interface RelayClientConfig {
  relayUrl: string;
  roomId: string;
  runtimePort: number;
  token: string;
}

export interface RelayInfo {
  relay: string;
  room: string;
  token: string;
}

/**
 * Desktop-side Relay client.
 * Connects to the Relay server, registers a room, and proxies
 * HTTP requests + WebSocket subscriptions to the local Runtime.
 */
export class RelayClient {
  private config: RelayClientConfig;
  private ws: WebSocket | null = null;
  private registered = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private localSockets = new Map<string, WebSocket>();

  constructor(config: RelayClientConfig) {
    this.config = config;
  }

  get roomInfo(): RelayInfo | null {
    if (!this.registered) return null;
    return {
      relay: this.config.relayUrl,
      room: this.config.roomId,
      token: this.config.token,
    };
  }

  connect(): void {
    if (this.destroyed) return;
    this.cleanup();

    const ws = new WebSocket(this.config.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      console.log("[relay] connected to relay server");
      this.reconnectAttempt = 0;
      this.send({ type: "register", roomId: this.config.roomId, token: this.config.token });
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      let msg: TunnelMessage;
      try {
        msg = JSON.parse(event.data as string) as TunnelMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      console.log("[relay] disconnected");
      this.registered = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };

    ws.onerror = (e) => {
      console.error("[relay] ws error:", e);
    };
  }

  disconnect(): void {
    this.destroyed = true;
    this.cleanup();
    // Close all local sockets
    for (const [id, sock] of this.localSockets) {
      sock.close();
    }
    this.localSockets.clear();
  }

  private cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.registered = false;
  }

  private handleMessage(msg: TunnelMessage) {
    switch (msg.type) {
      case "registered":
        this.registered = true;
        console.log(`[relay] room registered: ${msg.roomId}`);
        break;

      case "error":
        console.error(`[relay] server error: ${msg.message}`);
        break;

      case "http-request":
        void this.handleHttpRequest(msg);
        break;

      case "ws-subscribe":
        this.handleWsSubscribe(msg);
        break;

      case "ws-unsubscribe":
        this.handleWsUnsubscribe(msg);
        break;

      case "pong":
        break;
    }
  }

  private async handleHttpRequest(msg: HttpRequestMessage) {
    const url = `http://127.0.0.1:${this.config.runtimePort}${msg.path}`;
    try {
      const init: RequestInit = {
        method: msg.method,
        headers: msg.headers,
      };
      if (msg.body && msg.method !== "GET" && msg.method !== "HEAD") {
        init.body = msg.body;
      }
      const resp = await fetch(url, init);
      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      this.send({
        type: "http-response",
        requestId: msg.requestId,
        status: resp.status,
        headers,
        body,
      });
    } catch (err) {
      this.send({
        type: "http-response",
        requestId: msg.requestId,
        status: 502,
        headers: {},
        body: JSON.stringify({ detail: String(err) }),
      });
    }
  }

  private handleWsSubscribe(msg: WsSubscribeMessage) {
    // Close existing subscription if any
    const existing = this.localSockets.get(msg.subscriptionId);
    if (existing) {
      existing.close();
      this.localSockets.delete(msg.subscriptionId);
    }

    const wsUrl = `ws://127.0.0.1:${this.config.runtimePort}${msg.path}`;
    const local = new WebSocket(wsUrl);
    this.localSockets.set(msg.subscriptionId, local);

    local.onmessage = (event) => {
      this.send({
        type: "ws-event",
        subscriptionId: msg.subscriptionId,
        data: event.data as string,
      });
    };

    local.onclose = () => {
      this.localSockets.delete(msg.subscriptionId);
    };

    local.onerror = () => {
      this.localSockets.delete(msg.subscriptionId);
      local.close();
    };
  }

  private handleWsUnsubscribe(msg: WsUnsubscribeMessage) {
    const local = this.localSockets.get(msg.subscriptionId);
    if (local) {
      local.close();
      this.localSockets.delete(msg.subscriptionId);
    }
  }

  private send(msg: TunnelMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping" });
    }, 25_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt++;
    console.log(`[relay] reconnecting in ${backoff}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, backoff);
  }
}
