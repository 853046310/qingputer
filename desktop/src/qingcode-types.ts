export type QCConversationStatus = "active" | "paused" | "completed" | "error";

export type QCEventType =
  | "agent_message"
  | "agent_message_chunk"
  | "agent_message_end"
  | "action"
  | "observation"
  | "terminal_output"
  | "file_change"
  | "error"
  | "status";

export interface QCRuntimeConnection {
  port: number;
  token: string;
}

export interface QCConversationRecord {
  conversation_id: string;
  title: string;
  workspace_path: string;
  status: QCConversationStatus;
  created_at: string;
  updated_at: string;
}

export interface QCChatMessage {
  message_id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface QCChatHistoryResponse {
  conversation: QCConversationRecord;
  messages: QCChatMessage[];
}

export interface QCWSEvent {
  event_id: string;
  conversation_id: string;
  type: QCEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface QCSettings {
  /** Read-only: active provider from Qingputer (e.g. "openai", "openrouter") */
  provider: string;
  /** Read-only: base URL from Qingputer */
  base_url: string;
  /** Read-only: model name from Qingputer */
  model: string;
  /** Read-only: whether API key is set in Qingputer */
  api_key_set: boolean;
  /** Editable */
  max_iterations: number;
  /** Editable */
  default_workspace: string;
}

export interface QCUpdateSettingsPayload {
  max_iterations?: number;
  default_workspace?: string;
}
