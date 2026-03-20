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

export interface IRuntimeApi {
  createSession(config: AgentSessionConfig): Promise<SessionRecord>;
  listSessions(): Promise<SessionRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord>;
  updateSession(sessionId: string, payload: SessionUpdatePayload): Promise<SessionRecord>;
  deleteSession(sessionId: string): Promise<{ deleted: boolean; session_id: string }>;
  postMessage(sessionId: string, content: string): Promise<{ accepted: boolean; session: SessionRecord }>;
  approve(sessionId: string, approvalId: string): Promise<unknown>;
  deny(sessionId: string, approvalId: string): Promise<unknown>;
  getHistory(sessionId: string): Promise<ChatHistoryResponse>;
  getSettings(): Promise<SettingsPayload>;
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
  }): Promise<SettingsPayload>;
  deleteModelKey(provider: "openai" | "openrouter"): Promise<SettingsPayload>;
  getQingflowStatus(): Promise<QingflowAuthStatus>;
  loginQingflow(payload: { email: string; password: string }): Promise<QingflowAuthStatus>;
  connectQingflow(payload: { token: string; detected_ws_id?: number | null }): Promise<QingflowAuthStatus>;
  selectQingflowWorkspace(wsId: number): Promise<QingflowAuthStatus>;
  logoutQingflow(): Promise<QingflowAuthStatus>;
  syncQingflowMcp(): Promise<QingflowAuthStatus>;
  resetBrowserProfile(): Promise<{ reset: boolean }>;
  listMcpServers(): Promise<McpServerRuntimeState[]>;
  createMcpServer(config: McpServerConfig): Promise<McpServerRuntimeState>;
  updateMcpServer(config: McpServerConfig): Promise<McpServerRuntimeState>;
  deleteMcpServer(serverId: string): Promise<{ deleted: boolean; server_id: string }>;
  refreshMcpServer(serverId: string): Promise<McpServerRuntimeState>;
  connectEvents(sessionId: string, onMessage: (event: MessageEvent<string>) => void): WebSocket;
}
