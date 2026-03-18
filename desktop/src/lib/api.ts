import type {
  AgentSessionConfig,
  ChatHistoryResponse,
  McpServerConfig,
  McpServerRuntimeState,
  RuntimeConnection,
  SessionRecord,
  SessionUpdatePayload,
  SettingsPayload,
} from "../types";
import { invoke } from "@tauri-apps/api/core";

interface RuntimeBridgeResponse {
  status: number;
  body: string;
}

export class RuntimeApi {
  constructor(private connection: RuntimeConnection) {}

  private async refreshConnection(): Promise<RuntimeConnection> {
    const next = await invoke<RuntimeConnection>("runtime_connection");
    this.connection = next;
    return next;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: RuntimeBridgeResponse;
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body != null
          ? String(init.body)
          : null;
    try {
      response = await invoke<RuntimeBridgeResponse>("runtime_request", {
        method,
        path,
        body,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof Error) {
        await this.refreshConnection();
        response = await invoke<RuntimeBridgeResponse>("runtime_request", {
          method,
          path,
          body,
        });
      } else {
        throw error;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const raw = response.body;
      if (raw) {
        let parsed: { detail?: string; message?: string } | null = null;
        try {
          parsed = JSON.parse(raw) as { detail?: string; message?: string };
        } catch {}
        if (parsed?.detail || parsed?.message) {
          throw new Error(parsed.detail || parsed.message);
        }
        throw new Error(raw);
      }
      throw new Error(`Runtime request failed with ${response.status}`);
    }
    return JSON.parse(response.body) as T;
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
    openai_base_url?: string;
    openai_model?: string;
    openai_api_key?: string;
  }): Promise<SettingsPayload> {
    return this.request<SettingsPayload>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  deleteOpenAiKey(): Promise<SettingsPayload> {
    return this.request<SettingsPayload>("/api/settings/openai-key", { method: "DELETE" });
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
    const socket = new WebSocket(
      `ws://127.0.0.1:${this.connection.port}/api/sessions/${sessionId}/events?token=${encodeURIComponent(
        this.connection.token,
      )}`,
    );
    socket.onmessage = onMessage;
    return socket;
  }
}
