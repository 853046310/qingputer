import { useEffect, useRef, useState } from "react";
import { FolderOpen, Send, Square, Terminal, FileCode, AlertCircle } from "lucide-react";
import { isDesktopApp } from "../lib/api-factory";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { IQingCodeApi } from "../lib/qingcode-api-interface";
import type {
  QCChatMessage,
  QCConversationRecord,
  QCChatHistoryResponse,
  QCWSEvent,
} from "../qingcode-types";

interface QingCodePanelProps {
  api: IQingCodeApi | null;
  conversation: QCConversationRecord | null;
  history: QCChatHistoryResponse | null;
  busy: boolean;
  disabled: boolean;
  defaultWorkspace: string;
  onSend: (content: string) => void;
  onSelectWorkspace: (path: string) => void;
  onWsEvent: (event: QCWSEvent) => void;
}

function EventBlock({ event }: { event: QCWSEvent }) {
  if (event.type === "action") {
    const actionType = String(event.payload.action_type ?? "");
    if (actionType === "terminal") {
      return (
        <div className="flex items-start gap-2 px-4 py-2 rounded-lg text-[12px]" style={{ background: "var(--bg-raised)" }}>
          <Terminal size={14} className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
          <code className="whitespace-pre-wrap break-all" style={{ color: "var(--text-secondary)" }}>
            {String(event.payload.command ?? "")}
          </code>
        </div>
      );
    }
    if (actionType === "file_edit") {
      return (
        <div className="flex items-start gap-2 px-4 py-2 rounded-lg text-[12px]" style={{ background: "var(--bg-raised)" }}>
          <FileCode size={14} className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
          <span style={{ color: "var(--text-secondary)" }}>Editing {String(event.payload.path ?? "")}</span>
        </div>
      );
    }
  }
  if (event.type === "terminal_output") {
    return (
      <div className="px-4 py-2 rounded-lg text-[12px] font-mono" style={{ background: "#1a1a2e", color: "#e0e0e0" }}>
        <pre className="whitespace-pre-wrap break-all m-0">{String(event.payload.output ?? "")}</pre>
      </div>
    );
  }
  if (event.type === "error") {
    return (
      <div className="flex items-start gap-2 px-4 py-2 rounded-lg text-[12px]" style={{ background: "var(--danger-dim)", color: "var(--danger)" }}>
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <span>{String(event.payload.message ?? "Unknown error")}</span>
      </div>
    );
  }
  return null;
}

export function QingCodePanel({
  api,
  conversation,
  history,
  busy,
  disabled,
  defaultWorkspace,
  onSend,
  onSelectWorkspace,
  onWsEvent,
}: QingCodePanelProps) {
  const [input, setInput] = useState("");
  const [workspacePath, setWorkspacePath] = useState(defaultWorkspace);
  const [events, setEvents] = useState<QCWSEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const messages = history?.messages ?? [];

  // WebSocket event subscription
  useEffect(() => {
    socketRef.current?.close();
    if (!api || !conversation) return;
    const socket = api.connectEvents(conversation.conversation_id, (msg) => {
      const event = JSON.parse(msg.data) as QCWSEvent;
      setEvents((prev) => [...prev, event]);
      onWsEvent(event);
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [api, conversation?.conversation_id]);

  // Reset events when conversation changes
  useEffect(() => {
    setEvents([]);
  }, [conversation?.conversation_id]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, events]);

  async function handlePickFolder() {
    if (!isDesktopApp()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        const path = typeof selected === "string" ? selected : selected;
        setWorkspacePath(path);
        onSelectWorkspace(path);
      }
    } catch {
      // user cancelled
    }
  }

  function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || disabled || busy) return;
    setInput("");
    onSend(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // Merge messages and events into a timeline
  const timeline: Array<{ type: "message"; data: QCChatMessage } | { type: "event"; data: QCWSEvent }> = [];
  for (const m of messages) {
    timeline.push({ type: "message", data: m });
  }
  for (const ev of events) {
    if (ev.type !== "agent_message" && ev.type !== "agent_message_end" && ev.type !== "agent_message_chunk") {
      timeline.push({ type: "event", data: ev });
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Workspace bar */}
      <div
        className="shrink-0 flex items-center gap-2 px-4"
        style={{ height: 44, borderBottom: "1px solid var(--border-muted)" }}
      >
        <FolderOpen size={16} style={{ color: "var(--text-muted)" }} />
        <span className="text-[13px] truncate flex-1" style={{ color: "var(--text-secondary)" }}>
          {workspacePath || "Select workspace..."}
        </span>
        <Button variant="ghost" size="sm" className="text-[12px] h-7" onClick={handlePickFolder}>
          Browse
        </Button>
      </div>

      {/* Messages area */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {timeline.length === 0 && !conversation ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[18px] font-bold text-white shadow-md">
              QC
            </div>
            <p className="text-sm font-medium text-foreground">QingCode</p>
            <p className="text-[13px] text-center max-w-xs text-muted-foreground">
              AI coding agent powered by OpenHands. Select a workspace and describe your task.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 max-w-3xl mx-auto">
            {timeline.map((item, i) => {
              if (item.type === "message") {
                const m = item.data;
                const isUser = m.role === "user";
                return (
                  <div
                    key={m.message_id}
                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className="px-4 py-2.5 rounded-2xl text-[14px] max-w-[85%] whitespace-pre-wrap break-words"
                      style={{
                        background: isUser ? "var(--accent)" : "var(--bg-raised)",
                        color: isUser ? "#fff" : "var(--text-primary)",
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              }
              return <EventBlock key={`ev-${i}`} event={item.data} />;
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 px-4 pb-4 pt-2" style={{ borderTop: "1px solid var(--border-muted)" }}>
        <div className="flex gap-2 max-w-3xl mx-auto">
          <Textarea
            placeholder="Describe what you want to build or fix..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || busy}
            className="min-h-[44px] max-h-[160px] resize-none text-[14px]"
            rows={1}
          />
          <Button
            size="icon"
            className="h-[44px] w-[44px] shrink-0"
            disabled={!input.trim() || disabled || busy}
            onClick={handleSubmit}
          >
            {busy ? <Square size={18} /> : <Send size={18} />}
          </Button>
        </div>
      </div>
    </div>
  );
}
