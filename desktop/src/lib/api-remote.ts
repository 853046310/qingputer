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

export interface RemoteConfig {
  host: string;
  port: number;
  token: string;
}

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 10_000;
const WS_RECONNECT_INTERVAL = 2_000;

export class RemoteRuntimeApi implements IRuntimeApi {
  private baseUrl: string;
  private token: string;
  private host: string;
  private port: number;

  constructor(config: RemoteConfig) {
    this.host = config.host;
    this.port = config.port;
    this.token = config.token;
    this.baseUrl = `http://${config.host}:${config.port}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        const response = await fetch(url, {
          ...init,
          headers: { ...headers, ...(init?.headers as Record<string, string>) },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text();
          let detail: string | undefined;
          try {
            const parsed = JSON.parse(text) as { detail?: string; message?: string };
            detail = parsed.detail || parsed.message;
          } catch {}
          throw new Error(detail || text || `Request failed with ${response.status}`);
        }
        return (await response.json()) as T;
      } catch (e) {
        lastError = e;
        // Don't retry on non-transient errors (4xx)
        if (e instanceof Error && e.message.includes("Request failed with 4")) throw e;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

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
    let destroyed = false;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (destroyed) return;
      const ws = new WebSocket(
        `ws://${this.host}:${this.port}/api/sessions/${sessionId}/events?token=${encodeURIComponent(this.token)}`,
      );
      ws.onmessage = onMessage;
      ws.onclose = () => {
        if (destroyed) return;
        setTimeout(connect, WS_RECONNECT_INTERVAL);
      };
      ws.onerror = () => {
        // onclose will fire after onerror, triggering reconnect
      };
      socket = ws;
    };

    connect();

    // Return a proxy that controls the destroy flag
    const proxy = {
      close() {
        destroyed = true;
        socket?.close();
      },
      get readyState() {
        return socket?.readyState ?? WebSocket.CLOSED;
      },
    };
    return proxy as unknown as WebSocket;
  }
}
