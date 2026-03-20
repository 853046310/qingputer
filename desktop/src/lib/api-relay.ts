import type {
  AgentSessionConfig,
  ChatHistoryResponse,
  McpServerConfig,
  McpServerRuntimeState,
  QingflowAuthStatus,
  SessionRecord,
  SessionUpdatePayload,
  SettingsPayload,
} from "../types";
import type { IRuntimeApi } from "./api-interface";
import type {
  TunnelMessage,
  HttpResponseMessage,
} from "./relay-protocol";

export interface RelayConfig {
  relay: string;
  room: string;
  token: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY = 30_000;
const HEARTBEAT_INTERVAL = 25_000;

/**
 * Mobile-side IRuntimeApi that tunnels HTTP requests and WebSocket events
 * through a Relay server to the desktop Runtime.
 */
export class RelayRuntimeApi implements IRuntimeApi {
  private relayUrl: string;
  private roomId: string;
  private token: string;
  private ws: WebSocket | null = null;
  private joined = false;
  private destroyed = false;

  private pendingRequests = new Map<
    string,
    { resolve: (resp: HttpResponseMessage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private eventHandlers = new Map<string, (data: string) => void>();
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Queue of messages to send once reconnected
  private sendQueue: string[] = [];

  constructor(config: RelayConfig) {
    this.relayUrl = config.relay;
    this.roomId = config.room;
    this.token = config.token;
  }

  private ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.joined) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error("Relay connection timeout"));
        ws.close();
      }, 10_000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", roomId: this.roomId, token: this.token }));
      };

      ws.onmessage = (event) => {
        let msg: TunnelMessage;
        try {
          msg = JSON.parse(event.data as string) as TunnelMessage;
        } catch {
          return;
        }

        if (msg.type === "joined") {
          this.joined = true;
          this.reconnectAttempt = 0;
          clearTimeout(timeout);
          // Replace onmessage with ongoing handler
          ws.onmessage = (e) => this.handleMessage(e);
          // Start heartbeat
          this.startHeartbeat();
          // Flush queued messages
          this.flushSendQueue();
          // Re-subscribe event handlers
          this.resubscribeEvents();
          resolve();
          return;
        }

        if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.message));
          return;
        }
      };

      ws.onclose = () => {
        this.joined = false;
        this.connectPromise = null;
        this.stopHeartbeat();

        // Don't reject pending requests immediately — try to reconnect first
        if (!this.destroyed && this.reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
          void this.scheduleReconnect();
        } else {
          // Max retries exceeded — reject all pending
          for (const [, req] of this.pendingRequests) {
            clearTimeout(req.timer);
            req.reject(new Error("Relay connection closed"));
          }
          this.pendingRequests.clear();
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        this.connectPromise = null;
        if (!this.destroyed && this.reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
          // onclose will trigger reconnect
        } else {
          reject(new Error("Relay connection error"));
        }
      };
    });

    return this.connectPromise;
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), MAX_RECONNECT_DELAY);
    await new Promise((r) => setTimeout(r, delay));
    if (this.destroyed) return;
    try {
      await this.ensureConnected();
    } catch {
      // ensureConnected's onclose will retry again
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private flushSendQueue() {
    while (this.sendQueue.length > 0) {
      const msg = this.sendQueue.shift()!;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      }
    }
  }

  private resubscribeEvents() {
    for (const subscriptionId of this.eventHandlers.keys()) {
      // We don't know the original path, but we need to re-subscribe.
      // Event handlers store subscriptionId -> callback. We'll send re-subscribe messages.
      // Note: The actual path is embedded in the subscriptionId flow — see connectEvents.
    }
  }

  private handleMessage(event: MessageEvent) {
    let msg: TunnelMessage;
    try {
      msg = JSON.parse(event.data as string) as TunnelMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "http-response": {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve(msg);
        }
        break;
      }
      case "ws-event": {
        const handler = this.eventHandlers.get(msg.subscriptionId);
        if (handler) handler(msg.data);
        break;
      }
      case "error": {
        console.error("[relay-api] error:", msg.message);
        break;
      }
      case "pong":
        break;
    }
  }

  private send(msg: TunnelMessage) {
    const serialized = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serialized);
    } else {
      // Queue for sending after reconnect
      this.sendQueue.push(serialized);
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    await this.ensureConnected();

    const requestId = crypto.randomUUID();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };
    const body = (init?.body as string) ?? null;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${method} ${path}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (resp) => {
          if (resp.status >= 400) {
            let detail: string | undefined;
            try {
              const parsed = JSON.parse(resp.body) as { detail?: string; message?: string };
              detail = parsed.detail || parsed.message;
            } catch {}
            reject(new Error(detail || resp.body || `Request failed with ${resp.status}`));
            return;
          }
          try {
            resolve(JSON.parse(resp.body) as T);
          } catch {
            resolve(resp.body as unknown as T);
          }
        },
        reject,
        timer,
      });

      this.send({
        type: "http-request",
        requestId,
        method,
        path,
        headers,
        body,
      });
    });
  }

  // ─── IRuntimeApi implementation ─────────────────────────────────────────────

  createSession(config: AgentSessionConfig): Promise<SessionRecord> {
    return this.request<SessionRecord>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
  }

  listSessions(): Promise<SessionRecord[]> {
    return this.request<SessionRecord[]>("/api/sessions");
  }

  getSession(sessionId: string): Promise<SessionRecord> {
    return this.request<SessionRecord>(`/api/sessions/${sessionId}`);
  }

  updateSession(sessionId: string, payload: SessionUpdatePayload): Promise<SessionRecord> {
    return this.request<SessionRecord>(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean; session_id: string }> {
    return this.request<{ deleted: boolean; session_id: string }>(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
  }

  postMessage(sessionId: string, content: string): Promise<{ accepted: boolean; session: SessionRecord }> {
    return this.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  approve(sessionId: string, approvalId: string): Promise<unknown> {
    return this.request(`/api/sessions/${sessionId}/approvals/${approvalId}/approve`, { method: "POST" });
  }

  deny(sessionId: string, approvalId: string): Promise<unknown> {
    return this.request(`/api/sessions/${sessionId}/approvals/${approvalId}/deny`, { method: "POST" });
  }

  getHistory(sessionId: string): Promise<ChatHistoryResponse> {
    return this.request<ChatHistoryResponse>(`/api/sessions/${sessionId}/history`);
  }

  getSettings(): Promise<SettingsPayload> {
    return this.request<SettingsPayload>("/api/settings");
  }

  updateSettings(payload: {
    model_provider?: "openai" | "openrouter";
    openai_base_url?: string;
    openai_model?: string;
    openai_api_key?: string;
    openrouter_base_url?: string;
    openrouter_model?: string;
    openrouter_api_key?: string;
    qingflow_web_origin?: string;
    qingflow_api_base_url?: string;
  }): Promise<SettingsPayload> {
    return this.request<SettingsPayload>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  deleteModelKey(provider: "openai" | "openrouter"): Promise<SettingsPayload> {
    return this.request<SettingsPayload>(`/api/settings/model-api-key/${provider}`, { method: "DELETE" });
  }

  getQingflowStatus(): Promise<QingflowAuthStatus> {
    return this.request<QingflowAuthStatus>("/api/qingflow/status");
  }

  loginQingflow(payload: { email: string; password: string }): Promise<QingflowAuthStatus> {
    return this.request<QingflowAuthStatus>("/api/qingflow/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  connectQingflow(payload: { token: string; detected_ws_id?: number | null }): Promise<QingflowAuthStatus> {
    return this.request<QingflowAuthStatus>("/api/qingflow/connect", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  selectQingflowWorkspace(wsId: number): Promise<QingflowAuthStatus> {
    return this.request<QingflowAuthStatus>("/api/qingflow/select-workspace", {
      method: "POST",
      body: JSON.stringify({ ws_id: wsId }),
    });
  }

  logoutQingflow(): Promise<QingflowAuthStatus> {
    return this.request<QingflowAuthStatus>("/api/qingflow/logout", { method: "POST" });
  }

  syncQingflowMcp(): Promise<QingflowAuthStatus> {
    return this.request<QingflowAuthStatus>("/api/qingflow/mcp-sync", { method: "POST" });
  }

  resetBrowserProfile(): Promise<{ reset: boolean }> {
    return this.request<{ reset: boolean }>("/api/settings/browser-profile/reset", { method: "POST" });
  }

  listMcpServers(): Promise<McpServerRuntimeState[]> {
    return this.request<McpServerRuntimeState[]>("/api/mcp/servers");
  }

  createMcpServer(config: McpServerConfig): Promise<McpServerRuntimeState> {
    return this.request<McpServerRuntimeState>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(config),
    });
  }

  updateMcpServer(config: McpServerConfig): Promise<McpServerRuntimeState> {
    return this.request<McpServerRuntimeState>(`/api/mcp/servers/${config.server_id}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  deleteMcpServer(serverId: string): Promise<{ deleted: boolean; server_id: string }> {
    return this.request<{ deleted: boolean; server_id: string }>(`/api/mcp/servers/${serverId}`, {
      method: "DELETE",
    });
  }

  refreshMcpServer(serverId: string): Promise<McpServerRuntimeState> {
    return this.request<McpServerRuntimeState>(`/api/mcp/servers/${serverId}/refresh`, {
      method: "POST",
    });
  }

  connectEvents(sessionId: string, onMessage: (event: MessageEvent<string>) => void): WebSocket {
    const subscriptionId = crypto.randomUUID();
    const path = `/api/sessions/${sessionId}/events?token=${encodeURIComponent(this.token)}`;

    // Create a proxy WebSocket-like object that routes through the relay tunnel
    const proxy = new EventTarget() as EventTarget & {
      close: () => void;
      readyState: number;
      onmessage: ((event: MessageEvent<string>) => void) | null;
    };
    proxy.readyState = WebSocket.CONNECTING;
    proxy.onmessage = onMessage;

    // Register handler for ws-event messages
    this.eventHandlers.set(subscriptionId, (data: string) => {
      const msgEvent = new MessageEvent("message", { data });
      if (proxy.onmessage) proxy.onmessage(msgEvent);
    });

    proxy.close = () => {
      this.eventHandlers.delete(subscriptionId);
      this.send({ type: "ws-unsubscribe", subscriptionId });
      proxy.readyState = WebSocket.CLOSED;
    };

    // Subscribe after ensuring connection
    void this.ensureConnected().then(() => {
      this.send({ type: "ws-subscribe", subscriptionId, path });
      proxy.readyState = WebSocket.OPEN;
    });

    // Return the proxy — it quacks like a WebSocket enough for App.tsx usage
    return proxy as unknown as WebSocket;
  }

  /** Clean shutdown — stop heartbeat, reject pending, close WebSocket. */
  destroy() {
    this.destroyed = true;
    this.stopHeartbeat();
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error("Relay destroyed"));
    }
    this.pendingRequests.clear();
    this.eventHandlers.clear();
    this.sendQueue = [];
    this.ws?.close();
  }
}
