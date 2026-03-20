import { useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useExternalMessageConverter,
  type AppendMessage,
} from "@assistant-ui/react";
import {
  CheckCircle2, FileText, Globe, ShieldAlert,
  Terminal, Wrench, XCircle, type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Thread, ComposerExtrasContext } from "@/components/assistant-ui/thread";
import { hapticLight, hapticMedium } from "../lib/mobile-bridge";
import type { ApprovalMode, ApprovalRequest, ChatMessage } from "../types";

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  messages: ChatMessage[];
  approvals: ApprovalRequest[];
  approvalMode: ApprovalMode | null;
  busy: boolean;
  disabled: boolean;
  sessionActive: boolean;
  onSend: (content: string) => Promise<void>;
  onApprove: (approvalId: string) => Promise<void>;
  onDeny: (approvalId: string) => Promise<void>;
  onSetApprovalMode: (mode: ApprovalMode) => void;
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────

export function ChatPanel({
  messages, approvals, approvalMode, busy, disabled, sessionActive,
  onSend, onApprove, onDeny, onSetApprovalMode,
}: ChatPanelProps) {
  const isRunning = busy || sessionActive;

  // ── "智能体思考中" indicator: show after 1s if running but no streaming yet ──
  const [showThinking, setShowThinking] = useState(false);
  const hasStreaming = messages.some((m) => m.metadata?.streaming === true);

  useEffect(() => {
    if (!isRunning || hasStreaming) {
      setShowThinking(false);
      return;
    }
    const timer = window.setTimeout(() => setShowThinking(true), 1000);
    return () => window.clearTimeout(timer);
  }, [isRunning, hasStreaming]);

  const displayMessages: ChatMessage[] = showThinking
    ? [
        ...messages,
        {
          message_id: "__thinking__",
          session_id: "",
          role: "assistant",
          content: "",
          created_at: new Date().toISOString(),
          metadata: { _thinking: true, streaming: true },
        },
      ]
    : messages;

  const convertedMessages = useExternalMessageConverter({
    messages: displayMessages,
    isRunning,
    joinStrategy: "none",
    callback: (msg: ChatMessage) => {
      if (msg.metadata?._thinking) {
        return {
          role: "assistant" as const,
          id: msg.message_id,
          createdAt: new Date(msg.created_at),
          content: "",
          status: { type: "running" as const },
          metadata: { custom: { _thinking: true } },
        };
      }
      if (msg.role === "tool") {
        const summary = parseToolSummary(msg);
        return {
          role: "assistant" as const,
          id: msg.message_id,
          createdAt: new Date(msg.created_at),
          content: summary.summaryText ?? summary.displayLabel,
          convertConfig: { joinStrategy: "none" as const },
          metadata: {
            custom: {
              _isToolStep: true,
              _toolName: summary.toolName,
              _toolLabel: summary.displayLabel,
              _toolSummary: summary.summaryText,
              _toolCategory: summary.category,
              _toolKeyLine: summary.keyLine,
            },
          },
        };
      }
      // 非 assistant 消息直接转换
      if (msg.role !== "assistant") {
        return {
          role: msg.role as "user" | "system",
          id: msg.message_id,
          createdAt: new Date(msg.created_at),
          content: msg.content,
          metadata: { custom: { ...(msg.metadata ?? {}) } },
        };
      }

      const assistantMsg = {
        role: "assistant" as const,
        id: msg.message_id,
        createdAt: new Date(msg.created_at),
        content: msg.content,
        convertConfig: { joinStrategy: "none" as const },
        status: msg.metadata?.streaming
          ? { type: "running" as const }
          : { type: "complete" as const, reason: "stop" as const },
        metadata: { custom: { ...(msg.metadata ?? {}) } },
      };

      return assistantMsg;
    },
  });

  const adapter = useMemo(() => ({
    messages: convertedMessages,
    isRunning,
    isDisabled: disabled,
    onNew: async (msg: AppendMessage) => {
      const text = msg.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
      if (text.trim()) {
        void hapticLight();
        await onSend(text);
      }
    },
  }), [convertedMessages, isRunning, disabled, onSend]);

  const runtime = useExternalStoreRuntime(adapter);

  const pendingApprovals = approvals.filter((a) => a.status === "pending");

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-col h-full min-h-0">

        {/* 执行状态 */}
        {busy && (
          <div
            className="flex items-center gap-2 px-4 py-1.5 shrink-0 text-[11px] border-b border-border/50 anim-slide-top"
            style={{ background: "var(--bg-surface)" }}
          >
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--accent)" }} />
            <span style={{ color: "var(--accent)" }}>执行中…</span>
          </div>
        )}

        {/* assistant-ui Thread：原生 shadcn 样式 */}
        <div className="flex-1 min-h-0">
          <ComposerExtrasContext.Provider value={{ approvalMode, disabled, onSetApprovalMode }}>
            <Thread />
          </ComposerExtrasContext.Provider>
        </div>

        {/* 审批卡片 */}
        {pendingApprovals.map((approval) => (
          <div key={approval.approval_id} className="anim-slide-bottom">
            <ApprovalCard
              approval={approval}
              disabled={disabled || busy}
              onApprove={() => void onApprove(approval.approval_id)}
              onDeny={() => void onDeny(approval.approval_id)}
            />
          </div>
        ))}

      </div>
    </AssistantRuntimeProvider>
  );
}

// ─── 审批卡片 ──────────────────────────────────────────────────────────────────

const RISK_ZH: Record<ApprovalRequest["risk_level"], string> = {
  low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险",
};

function riskColor(level: ApprovalRequest["risk_level"]) {
  if (level === "critical") return { border: "var(--critical)", badge: { bg: "var(--critical-dim)", color: "var(--critical)" } };
  if (level === "high")     return { border: "var(--warning)",  badge: { bg: "var(--warning-dim)",  color: "var(--warning)"  } };
  return                           { border: "var(--accent)",   badge: { bg: "var(--accent-dim)",   color: "var(--accent)"   } };
}

function ApprovalCard({
  approval, disabled, onApprove, onDeny,
}: { approval: ApprovalRequest; disabled: boolean; onApprove: () => void; onDeny: () => void }) {
  const c = riskColor(approval.risk_level);
  return (
    <div
      className="mx-4 mb-2 rounded-xl px-3 py-2.5 flex items-center gap-3 text-[12px] shrink-0"
      style={{ border: `1px solid var(--border)`, borderLeft: `3px solid ${c.border}`, background: "var(--bg-surface)" }}
    >
      <ShieldAlert size={13} style={{ color: c.border, flexShrink: 0 }} />
      <span
        className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide shrink-0"
        style={c.badge}
      >
        {RISK_ZH[approval.risk_level]}
      </span>
      <div className="flex-1 min-w-0">
        <span className="font-mono truncate block" style={{ color: "var(--text-primary)" }}>{approval.preview}</span>
        {approval.reason && (
          <span className="text-[11px] truncate block mt-0.5" style={{ color: "var(--text-secondary)" }}>{approval.reason}</span>
        )}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <Button size="sm" className="h-7 gap-1 text-[12px] [&_svg]:size-auto" disabled={disabled} onClick={() => { void hapticMedium(); onApprove(); }}>
          <CheckCircle2 size={11} /> 批准
        </Button>
        <Button
          variant="outline" size="sm"
          className="h-7 gap-1 text-[12px] [&_svg]:size-auto"
          disabled={disabled} onClick={() => { void hapticMedium(); onDeny(); }}
          style={{ background: "var(--bg-overlay)", color: "var(--text-secondary)", borderColor: "var(--border)" }}
        >
          <XCircle size={11} /> 拒绝
        </Button>
      </div>
    </div>
  );
}

// ─── 工具调用解析（stepTicker 需要） ────────────────────────────────────────────

type ToolCategory = "terminal" | "filesystem" | "browser" | "mcp" | "other";

interface ToolSummary {
  category: ToolCategory;
  toolName: string;
  displayLabel: string;
  summaryText: string | null;
  keyLine: string | null;
  parsed: unknown;
}

function detectCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (n.includes("mcp")) return "mcp";
  if (n.includes("command") || n.includes("shell") || n.includes("exec") || n.includes("run") || n.includes("terminal")) return "terminal";
  if (n.includes("file") || n.includes("read") || n.includes("write") || n.includes("list") || n.includes("dir") || n.includes("path")) return "filesystem";
  if (n.includes("browser") || n.includes("nav") || n.includes("click") || n.includes("web") || n.includes("url")) return "browser";
  return "other";
}

function nestedAction(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!obj) return null;
  for (const key of ["action_error", "action_denied", "approval_denied"]) {
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function extractKeyLine(obj: Record<string, unknown>, category: ToolCategory): string | null {
  const keys = category === "terminal" ? ["command", "cmd", "shell", "script", "args", "summary", "description", "name"]
    : category === "filesystem" ? ["path", "file", "filename", "filepath", "summary", "description", "name"]
    : category === "browser" ? ["url", "href", "link", "selector", "summary", "description"]
    : category === "mcp" ? ["server_id", "tool_name", "summary", "description", "name"]
    : ["summary", "description", "content", "message", "name", "key", "value", "id"];
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      const t = val.trim(); return t.length > 100 ? t.slice(0, 100) + "…" : t;
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.trim() && !["tool_use_id", "session_id", "action_kind"].includes(k)) {
      const t = v.trim(); const line = `${k}: ${t}`;
      return line.length > 100 ? line.slice(0, 100) + "…" : line;
    }
  }
  return null;
}

function parseToolSummary(message: ChatMessage): ToolSummary {
  let parsed: unknown = null;
  try { parsed = JSON.parse(message.content); } catch { parsed = message.content; }
  const obj = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
  const actionObj = nestedAction(obj) ?? obj;
  const args = (actionObj?.args && typeof actionObj.args === "object") ? actionObj.args as Record<string, unknown> : null;
  const metadataToolName = message.metadata?.tool_name as string | undefined;
  const metadataServerId = message.metadata?.server_id as string | undefined;
  const metadataKind = message.metadata?.action_kind as string | undefined;
  const serverId = metadataServerId || (args?.server_id as string) || "";
  const toolName = metadataToolName || (args?.tool_name as string) || metadataKind || (actionObj?.kind as string) || "tool";
  const category = detectCategory(toolName);
  const summaryCandidate =
    (message.metadata?.action_summary as string | undefined) ||
    (typeof actionObj?.summary === "string" ? actionObj.summary : null) ||
    null;
  const summaryText = summaryCandidate && summaryCandidate.trim() ? summaryCandidate.trim() : null;
  let keyLine = actionObj ? extractKeyLine(actionObj, category) : null;
  if (!keyLine && message.metadata) keyLine = extractKeyLine(message.metadata as Record<string, unknown>, category);
  const displayLabel = serverId && metadataKind === "mcp.call"
    ? `${serverId} . ${toolName}`
    : serverId && toolName !== "tool"
      ? `${serverId} . ${toolName}`
      : toolName;
  return { category, toolName, displayLabel, summaryText, keyLine, parsed };
}

const CATEGORY_CONFIG: Record<ToolCategory, { color: string; bg: string; Icon: LucideIcon }> = {
  terminal:   { color: "var(--accent)",     bg: "var(--accent-dim)",  Icon: Terminal },
  filesystem: { color: "var(--file)",       bg: "var(--file-dim)",    Icon: FileText },
  browser:    { color: "var(--warning)",    bg: "var(--warning-dim)", Icon: Globe },
  mcp:        { color: "var(--text-primary)", bg: "var(--bg-overlay)", Icon: Wrench },
  other:      { color: "var(--text-muted)", bg: "var(--bg-overlay)",  Icon: Wrench },
};
