import { invoke } from "@tauri-apps/api/core";
import type {
  QCChatHistoryResponse,
  QCConversationRecord,
  QCRuntimeConnection,
  QCSettings,
  QCUpdateSettingsPayload,
} from "../qingcode-types";
import type { IQingCodeApi } from "./qingcode-api-interface";

interface RuntimeBridgeResponse {
  status: number;
  body: string;
}

export class QingCodeApi implements IQingCodeApi {
  constructor(private connection: QCRuntimeConnection) {}

  private async refreshConnection(): Promise<QCRuntimeConnection> {
    const next = await invoke<QCRuntimeConnection>("qingcode_connection");
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
      response = await invoke<RuntimeBridgeResponse>("qingcode_request", {
        method,
        path,
        body,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof Error) {
        await this.refreshConnection();
        response = await invoke<RuntimeBridgeResponse>("qingcode_request", {
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
      throw new Error(`QingCode request failed with ${response.status}`);
    }
    return JSON.parse(response.body) as T;
  }

  createConversation(workspacePath: string): Promise<QCConversationRecord> {
    return this.request<QCConversationRecord>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ workspace_path: workspacePath }),
    });
  }

  listConversations(): Promise<QCConversationRecord[]> {
    return this.request<QCConversationRecord[]>("/api/conversations");
  }

  getConversation(conversationId: string): Promise<QCConversationRecord> {
    return this.request<QCConversationRecord>(`/api/conversations/${conversationId}`);
  }

  deleteConversation(conversationId: string): Promise<{ deleted: boolean; conversation_id: string }> {
    return this.request<{ deleted: boolean; conversation_id: string }>(`/api/conversations/${conversationId}`, {
      method: "DELETE",
    });
  }

  postMessage(conversationId: string, content: string): Promise<{ accepted: boolean; conversation: QCConversationRecord }> {
    return this.request(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  getHistory(conversationId: string): Promise<QCChatHistoryResponse> {
    return this.request<QCChatHistoryResponse>(`/api/conversations/${conversationId}/history`);
  }

  getSettings(): Promise<QCSettings> {
    return this.request<QCSettings>("/api/settings");
  }

  updateSettings(payload: QCUpdateSettingsPayload): Promise<QCSettings> {
    return this.request<QCSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  connectEvents(conversationId: string, onMessage: (event: MessageEvent<string>) => void): WebSocket {
    const socket = new WebSocket(
      `ws://127.0.0.1:${this.connection.port}/api/conversations/${conversationId}/events?token=${encodeURIComponent(
        this.connection.token,
      )}`,
    );
    socket.onmessage = onMessage;
    return socket;
  }
}
