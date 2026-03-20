import type {
  QCChatHistoryResponse,
  QCConversationRecord,
  QCSettings,
  QCUpdateSettingsPayload,
} from "../qingcode-types";

export interface IQingCodeApi {
  createConversation(workspacePath: string): Promise<QCConversationRecord>;
  listConversations(): Promise<QCConversationRecord[]>;
  getConversation(conversationId: string): Promise<QCConversationRecord>;
  deleteConversation(conversationId: string): Promise<{ deleted: boolean; conversation_id: string }>;
  postMessage(conversationId: string, content: string): Promise<{ accepted: boolean; conversation: QCConversationRecord }>;
  getHistory(conversationId: string): Promise<QCChatHistoryResponse>;
  getSettings(): Promise<QCSettings>;
  updateSettings(payload: QCUpdateSettingsPayload): Promise<QCSettings>;
  connectEvents(conversationId: string, onMessage: (event: MessageEvent<string>) => void): WebSocket;
}
