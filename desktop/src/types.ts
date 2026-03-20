export type SessionStatus =
  | "created"
  | "authorized"
  | "active"
  | "paused"
  | "completed"
  | "terminated";

export type EventKind =
  | "message"
  | "command_started"
  | "command_output"
  | "command_finished"
  | "file_read"
  | "file_write"
  | "file_list"
  | "browser_nav"
  | "browser_action"
  | "mcp_call"
  | "approval_requested"
  | "approval_resolved"
  | "policy"
  | "error"
  | "status"
  | "assistant_stream_start"
  | "assistant_chunk"
  | "assistant_stream_end";

export interface RuntimeConnection {
  port: number;
  token: string;
}

export interface CapabilityGrants {
  terminal: boolean;
  filesystem: boolean;
  browser: boolean;
}

export type ApprovalMode = "default" | "maximum" | "session_once_plus_high_risk";

export interface AgentSessionConfig {
  cwd: string;
  grants: CapabilityGrants;
  approval_mode: ApprovalMode;
  idle_timeout_minutes: number;
  absolute_timeout_hours: number;
}

export interface SessionRecord {
  session_id: string;
  title: string;
  config: AgentSessionConfig;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_active_at: string;
  current_cwd: string;
  pending_approval_id: string | null;
  interrupted_reason: string | null;
}

export interface ChatMessage {
  message_id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface AgentAction {
  kind: string;
  summary?: string | null;
  args: Record<string, unknown>;
}

export interface ApprovalRequest {
  approval_id: string;
  session_id: string;
  action: AgentAction;
  reason: string;
  risk_level: "low" | "medium" | "high" | "critical";
  preview: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface EventEnvelope {
  event_id: string;
  session_id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ChatHistoryResponse {
  session: SessionRecord;
  messages: ChatMessage[];
  approvals: ApprovalRequest[];
  events: EventEnvelope[];
}

export interface SettingsPayload {
  model_provider: "openai" | "openrouter";
  openai_base_url: string;
  openai_model: string;
  openai_api_key_set: boolean;
  openrouter_base_url: string;
  openrouter_model: string;
  openrouter_api_key_set: boolean;
  qingflow_web_origin: string;
  qingflow_api_base_url: string;
  qingflow_user_name: string | null;
  qingflow_user_email: string | null;
  qingflow_user_avatar_url: string | null;
  qingflow_selected_ws_id: number | null;
  qingflow_selected_ws_name: string | null;
  mcp_servers: McpServerConfig[];
}

export interface QingflowWorkspaceOption {
  ws_id: number;
  ws_name: string;
  identity: string | null;
  auth: number | null;
  being_disabled: boolean | null;
}

export interface QingflowMcpSyncState {
  builder_status: McpConnectionStatus;
  user_status: McpConnectionStatus;
  last_error: string | null;
}

export interface QingflowAuthStatus {
  web_origin: string;
  api_base_url: string;
  token_set: boolean;
  connected: boolean;
  user_name: string | null;
  user_email: string | null;
  user_avatar_url: string | null;
  selected_ws_id: number | null;
  selected_ws_name: string | null;
  workspaces: QingflowWorkspaceOption[];
  requires_workspace_selection: boolean;
  requires_workspace_creation: boolean;
  mcp_sync: QingflowMcpSyncState;
  last_error: string | null;
}

export interface QingflowAuthProbe {
  window_open: boolean;
  url: string | null;
  token_candidate: string | null;
  ws_id_candidate: number | null;
  observed_keys: string[];
  last_error: string | null;
}

export interface DefaultSessionConfig {
  cwd: string;
  grants: CapabilityGrants;
  approval_mode: ApprovalMode;
  idle_timeout_minutes: number;
  absolute_timeout_hours: number;
}

export interface SessionUpdatePayload {
  title?: string;
  approval_mode?: ApprovalMode;
}

export type McpTransport = "stdio" | "streamable_http";
export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerConfig {
  server_id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  auto_connect: boolean;
  description?: string | null;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  url?: string | null;
  headers: Record<string, string>;
}

export interface McpToolDescriptor {
  server_id: string;
  name: string;
  title?: string | null;
  description?: string | null;
  input_schema?: Record<string, unknown> | null;
}

export interface McpServerRuntimeState {
  config: McpServerConfig;
  status: McpConnectionStatus;
  last_error?: string | null;
  tools: McpToolDescriptor[];
  server_name?: string | null;
  server_version?: string | null;
  instructions?: string | null;
}
