import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Moon, MoreHorizontal, Settings, SquarePen, Sun, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { ChatPanel } from "./components/ChatPanel";
import { SettingsPage } from "./components/SettingsPage";
import { StatusBar } from "./components/StatusBar";
import { RuntimeApi } from "./lib/api";
import type {
  ApprovalRequest,
  ChatHistoryResponse,
  ChatMessage,
  DefaultSessionConfig,
  EventEnvelope,
  McpServerConfig,
  McpServerRuntimeState,
  RuntimeConnection,
  SessionRecord,
  SessionUpdatePayload,
  SettingsPayload,
} from "./types";

const STATUS_ZH: Record<string, string> = {
  created: "已创建", authorized: "已授权", active: "运行中",
  paused: "已暂停", completed: "已完成", terminated: "已终止",
};

async function delay(ms: number) {
  await new Promise((r) => window.setTimeout(r, ms));
}

async function withRetry<T>(work: () => Promise<T>, attempts = 8, backoffMs = 200): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await work(); } catch (e) { last = e; await delay(backoffMs); }
  }
  throw last;
}

function appendUniqueEvent(events: EventEnvelope[], e: EventEnvelope): EventEnvelope[] {
  return events.some((x) => x.event_id === e.event_id) ? events : [...events, e];
}

function appendMessageFromEvent(messages: ChatMessage[], event: EventEnvelope): ChatMessage[] {
  if (event.kind === "assistant_stream_start") {
    const id = String(event.payload.message_id ?? "");
    if (!id) return messages;
    const idx = messages.findIndex((m) => m.message_id === id);
    const nextMessage: ChatMessage = {
      message_id: id,
      session_id: event.session_id,
      role: "assistant",
      content: "",
      created_at: event.created_at,
      metadata: { streaming: true },
    };
    if (idx >= 0) {
      const next = [...messages];
      next[idx] = { ...next[idx], metadata: { ...(next[idx].metadata ?? {}), streaming: true } };
      return next;
    }
    return [...messages, nextMessage];
  }
  if (event.kind === "assistant_chunk") {
    const id = String(event.payload.message_id ?? "");
    const chunk = String(event.payload.chunk ?? "");
    if (!id || !chunk) return messages;
    const idx = messages.findIndex((m) => m.message_id === id);
    if (idx >= 0) {
      const next = [...messages];
      next[idx] = { ...next[idx], content: next[idx].content + chunk, metadata: { streaming: true } };
      return next;
    }
    return [...messages, { message_id: id, session_id: event.session_id, role: "assistant" as const, content: chunk, created_at: event.created_at, metadata: { streaming: true } }];
  }
  if (event.kind === "assistant_stream_end") {
    const id = String(event.payload.message_id ?? "");
    if (!id) return messages;
    const idx = messages.findIndex((m) => m.message_id === id);
    if (idx < 0) return messages;
    const next = [...messages];
    next[idx] = {
      ...next[idx],
      metadata: { ...(next[idx].metadata ?? {}), streaming: false },
    };
    return next;
  }
  if (event.kind === "message") {
    const id = String(event.payload.message_id ?? "");
    if (!id) return messages;
    const msg: ChatMessage = {
      message_id: id,
      session_id: event.session_id,
      role: String(event.payload.role ?? "tool") as ChatMessage["role"],
      content: String(event.payload.content ?? ""),
      created_at: event.created_at,
      metadata: (event.payload.metadata as Record<string, unknown>) ?? {},
    };
    const idx = messages.findIndex((m) => m.message_id === id);
    if (idx >= 0) { const next = [...messages]; next[idx] = msg; return next; }
    return [...messages, msg];
  }
  return messages;
}

function upsertApproval(approvals: ApprovalRequest[], event: EventEnvelope): ApprovalRequest[] {
  if (event.kind !== "approval_requested" && event.kind !== "approval_resolved") return approvals;
  const p = event.payload as unknown as ApprovalRequest;
  return [...approvals.filter((a) => a.approval_id !== p.approval_id), p]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function upsertSessionRecord(records: SessionRecord[], record: SessionRecord): SessionRecord[] {
  return [...records.filter((r) => r.session_id !== record.session_id), record]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function exportJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function formatTs(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch { return value; }
}

// ─── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [connection, setConnection] = useState<RuntimeConnection | null>(null);
  const [api, setApi] = useState<RuntimeApi | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [history, setHistory] = useState<ChatHistoryResponse | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerRuntimeState[]>([]);
  const [sessionDefaults, setSessionDefaults] = useState<DefaultSessionConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("qp-theme") as "light" | "dark") ?? "light",
  );

  // 视图状态
  const [activeView, setActiveView] = useState<"chat" | "settings">("chat");
  const [deleteConfirmSession, setDeleteConfirmSession] = useState<SessionRecord | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  // 跨会话切换时保存流式消息，切回时恢复
  const streamingCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("qp-theme", theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const conn = await invoke<RuntimeConnection>("runtime_connection");
        if (cancelled) return;
        const rapi = new RuntimeApi(conn);
        const [nextSettings, nextMcpServers, nextDefaults, nextSessions] = await Promise.all([
          withRetry(() => rapi.getSettings()),
          withRetry(() => rapi.listMcpServers()),
          invoke<DefaultSessionConfig>("default_session_config"),
          withRetry(() => rapi.listSessions()),
        ]);
        if (cancelled) return;
        setConnection(conn); setApi(rapi); setSettings(nextSettings);
        setMcpServers(nextMcpServers);
        setSessionDefaults(nextDefaults); setSessions(nextSessions);
        if (nextSessions.length > 0) {
          const h = await rapi.getHistory(nextSessions[0].session_id);
          if (cancelled) return;
          setSession(h.session); setHistory(h);
        }
      } catch (reason) { setError(String(reason)); }
    }
    void bootstrap();
    return () => { cancelled = true; socketRef.current?.close(); };
  }, []);

  useEffect(() => {
    socketRef.current?.close();
    if (!api || !session) return;
    const socket = api.connectEvents(session.session_id, (msg) => {
      const event = JSON.parse(msg.data) as EventEnvelope;
      setHistory((cur) => {
        if (!cur) return cur;
        const nextSession = event.kind === "status"
          ? { ...cur.session, status: String(event.payload.status ?? cur.session.status) as SessionRecord["status"], updated_at: event.created_at }
          : cur.session;
        return {
          ...cur,
          session: nextSession,
          events: appendUniqueEvent(cur.events, event),
          messages: appendMessageFromEvent(cur.messages, event),
          approvals: upsertApproval(cur.approvals, event),
        };
      });
      if (event.kind === "status") {
        const st = String(event.payload.status ?? session.status) as SessionRecord["status"];
        setSession((cur) => cur ? { ...cur, status: st, updated_at: event.created_at } : cur);
        setSessions((cur) => upsertSessionRecord(cur, { ...session, status: st, updated_at: event.created_at }));
      }
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [api, session]);

  useEffect(() => {
    if (!api || !session) return;
    if (session.status !== "active") return;

    let cancelled = false;
    let timer: number | null = null;

    const pollHistory = async () => {
      try {
        const next = await api.getHistory(session.session_id);
        if (cancelled) return;
        setHistory((cur) => {
          if (!cur || cur.session.session_id !== session.session_id) return next;
          const knownIds = new Set(next.messages.map((m) => m.message_id));
          const inProgress = cur.messages.filter((m) => m.metadata?.streaming === true && !knownIds.has(m.message_id));
          return inProgress.length > 0 ? { ...next, messages: [...next.messages, ...inProgress] } : next;
        });
        setSession(next.session);
        setSessions((cur) => upsertSessionRecord(cur, next.session));
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(pollHistory, 1200);
        }
      }
    };

    void pollHistory();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [api, session?.session_id, session?.status]);

  useEffect(() => {
    if (!api) return;
    const shouldPoll =
      activeView === "settings" || mcpServers.some((server) => server.status === "connecting");
    if (!shouldPoll) return;

    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      try {
        const next = await api.listMcpServers();
        if (!cancelled) {
          setMcpServers(next);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, 1500);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [api, activeView, mcpServers]);

  const messages = history?.messages ?? [];
  const approvals = useMemo(() => history?.approvals ?? [], [history]);

  async function refreshSessionList(nextSelectedId?: string) {
    if (!api) return [] as SessionRecord[];
    const list = await api.listSessions();
    setSessions(list);
    if (nextSelectedId) setSession(list.find((s) => s.session_id === nextSelectedId) ?? null);
    return list;
  }

  async function refreshHistory(target: SessionRecord) {
    if (!api) return;
    // 切换会话前，把当前流式消息存入缓存
    if (session && session.session_id !== target.session_id) {
      const inProgress = messages.filter((m) => m.metadata?.streaming === true);
      if (inProgress.length > 0) streamingCacheRef.current.set(session.session_id, inProgress);
    }
    const h = await api.getHistory(target.session_id);
    setSession(h.session);
    setHistory((cur) => {
      const dbIds = new Set(h.messages.map((m) => m.message_id));
      // 同一会话刷新（如 handleSend / handleApproval）：保留尚未落库的流式消息
      if (cur && cur.session.session_id === target.session_id) {
        const inProgress = cur.messages.filter((m) => m.metadata?.streaming === true && !dbIds.has(m.message_id));
        if (inProgress.length > 0) return { ...h, messages: [...h.messages, ...inProgress] };
      }
      // 切回之前的会话：从缓存中恢复流式消息
      const cached = streamingCacheRef.current.get(target.session_id) ?? [];
      if (cached.length > 0) {
        streamingCacheRef.current.delete(target.session_id);
        const inProgress = cached.filter((m) => !dbIds.has(m.message_id));
        if (inProgress.length > 0) return { ...h, messages: [...h.messages, ...inProgress] };
      }
      return h;
    });
    setSessions((cur) => upsertSessionRecord(cur, h.session));
  }

  function handleCreateSession() {
    if (!connection) return;
    // 不立即创建会话——进入草稿状态，发送第一条消息后再真正创建
    setSession(null);
    setHistory(null);
    setActiveView("chat");
  }

  async function handleSelectSession(s: SessionRecord) {
    if (busy || s.session_id === session?.session_id) return;
    setBusy(true); setError(null);
    setActiveView("chat");
    try { await refreshHistory(s); } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleSend(content: string) {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      // 草稿模式：第一条消息触发真正的会话创建
      let target = session;
      if (!target) {
        if (!sessionDefaults) return;
        target = await api.createSession(sessionDefaults);
        setSession(target);
        setSessions((cur) => upsertSessionRecord(cur, target!));
      }
      // 首条消息自动命名会话
      if (messages.length === 0) {
        const trimmed = content.trim();
        const autoTitle = trimmed.length > 30 ? trimmed.slice(0, 30) + "…" : trimmed;
        try { await api.updateSession(target.session_id, { title: autoTitle }); } catch { /* ignore */ }
      }
      await api.postMessage(target.session_id, content);
      await refreshHistory(target);
      await refreshSessionList(target.session_id);
    } catch (r) {
      const message = r instanceof Error ? r.message : String(r);
      if (message.includes("API key")) setActiveView("settings");
      setError(message);
    } finally { setBusy(false); }
  }

  async function handleApproval(approvalId: string, approved: boolean) {
    if (!api || !session) return;
    setBusy(true); setError(null);
    try {
      if (approved) await api.approve(session.session_id, approvalId);
      else await api.deny(session.session_id, approvalId);
      await refreshHistory(session);
      await refreshSessionList(session.session_id);
    } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleUpdateSession(payload: SessionUpdatePayload) {
    if (!api || !session) return;
    setBusy(true); setError(null);
    try {
      const s = await api.updateSession(session.session_id, payload);
      // 只更新 session 元数据，不刷新 history，避免擦掉进行中的流式消息
      setSession(s);
      setSessions((cur) => upsertSessionRecord(cur, s));
    } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleDeleteSession(target: SessionRecord) {
    if (!api) return;
    setDeleteConfirmSession(null);
    setBusy(true); setError(null);
    try {
      await api.deleteSession(target.session_id);
      const list = await refreshSessionList();
      const fallback = list.find((s) => s.session_id !== target.session_id) ?? null;
      if (fallback) await refreshHistory(fallback);
      else { setSession(null); setHistory(null); }
    } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleSaveSettings(payload: { openai_base_url?: string; openai_model?: string; openai_api_key?: string }) {
    if (!api) return;
    setBusy(true);
    try { setSettings(await api.updateSettings(payload)); }
    catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleDeleteKey() {
    if (!api) return;
    setBusy(true);
    try { setSettings(await api.deleteOpenAiKey()); }
    catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleResetBrowserProfile() {
    if (!api) return;
    setBusy(true);
    try { await api.resetBrowserProfile(); }
    catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function refreshMcpServers() {
    if (!api) return [] as McpServerRuntimeState[];
    const list = await api.listMcpServers();
    setMcpServers(list);
    return list;
  }

  async function handleUpsertMcpServer(config: McpServerConfig, isNew: boolean) {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      if (isNew) await api.createMcpServer(config);
      else await api.updateMcpServer(config);
      await refreshMcpServers();
    } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleDeleteMcpServer(serverId: string) {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      await api.deleteMcpServer(serverId);
      await refreshMcpServers();
    } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleRefreshMcpServer(serverId: string) {
    if (!api) return;
    setBusy(true); setError(null);
    try {
      await api.refreshMcpServer(serverId);
      await refreshMcpServers();
    } catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}>
      <div className="flex flex-1 min-h-0">

        {/* ── 左侧栏 ── */}
        <aside className="flex flex-col w-[260px] shrink-0" style={{ background: "var(--bg-surface)", borderRight: "1px solid var(--border)" }}>

          {/* 头部 */}
          <div
            className="shrink-0 px-4 pt-4 pb-3"
            data-tauri-drag-region="true"
            style={{ borderBottom: "1px solid var(--border-muted)" }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2" style={{ pointerEvents: "none" }}>
                <div className="relative w-9 h-9 rounded-xl flex items-center justify-center text-[18px] font-bold" style={{ background: "#080e0b", color: "var(--accent)" }}>
                  Q
                  <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full border-2" style={{ background: connection ? "var(--accent)" : "var(--text-muted)", borderColor: "var(--bg-surface)" }} />
                </div>
                <span className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>qingputer</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 [&_svg]:size-auto"
                onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
                style={{ pointerEvents: "auto", color: "var(--text-muted)" }}
                title={theme === "light" ? "切换深色" : "切换浅色"}
              >
                {theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
              </Button>
            </div>
          </div>

          <div className="px-3 py-2 shrink-0">
            <div className="flex flex-col gap-1">
              <Button
                variant="ghost"
                className="h-11 justify-start gap-3 rounded-xl px-3 text-[14px] font-medium"
                disabled={!connection}
                onClick={() => handleCreateSession()}
              >
                <SquarePen size={18} style={{ color: "var(--text-secondary)" }} />
                新建会话
              </Button>
              <Button
                variant="ghost"
                className={`h-11 justify-start gap-3 rounded-xl px-3 text-[14px] font-medium${activeView === "settings" ? " bg-[var(--bg-raised)]" : ""}`}
                disabled={!connection}
                onClick={() => setActiveView((v) => v === "settings" ? "chat" : "settings")}
              >
                <Settings size={18} style={{ color: activeView === "settings" ? "var(--accent)" : "var(--text-secondary)" }} />
                <span style={{ color: activeView === "settings" ? "var(--text-primary)" : undefined }}>设置</span>
              </Button>
            </div>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
            {sessions.length === 0 ? (
              <p className="px-3 py-3 text-center text-[12px]" style={{ color: "var(--text-muted)" }}>暂无会话</p>
            ) : (
              <div className="flex flex-col gap-0">
                {sessions.map((item) => {
                  const active = item.session_id === session?.session_id;
                  return (
                    <div key={item.session_id} className="group relative">
                      <Button
                        variant="ghost"
                        className={`w-full justify-start px-3 py-2 h-auto rounded-xl text-[13px] font-normal${active ? " bg-[var(--bg-raised)]" : ""}`}
                        onClick={() => void handleSelectSession(item)}
                      >
                        <p className="text-[13px] truncate pr-5" style={{
                          color: active ? "var(--text-primary)" : "var(--text-secondary)",
                          fontWeight: active ? 500 : 400,
                        }}>
                          {item.title}
                        </p>
                      </Button>

                      {/* 三点菜单 */}
                      <div
                        className="absolute top-1/2 right-2 -translate-y-1/2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 opacity-0 group-hover:opacity-100 [&_svg]:size-auto"
                              style={{ color: "var(--text-muted)" }}
                          >
                            <MoreHorizontal size={12} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                            <DropdownMenuItem
                              className="text-[12px] gap-2 text-destructive focus:text-destructive"
                              onClick={() => setDeleteConfirmSession(item)}
                            >
                              <Trash2 size={12} />
                              删除会话
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* ── 主区域 ── */}
        <main className="flex-1 min-w-0 flex flex-col">
          {activeView === "settings" ? (
            <SettingsPage
              settings={settings}
              mcpServers={mcpServers}
              disabled={!connection || busy}
              onSave={handleSaveSettings}
              onDeleteKey={handleDeleteKey}
              onResetBrowserProfile={handleResetBrowserProfile}
              onExportHistory={() => history && exportJson(history, `qingputer-session-${history.session.session_id}.json`)}
              onUpsertMcpServer={handleUpsertMcpServer}
              onDeleteMcpServer={handleDeleteMcpServer}
              onRefreshMcpServer={handleRefreshMcpServer}
            />
          ) : (
            <ChatPanel
              messages={messages}
              approvals={approvals}
              approvalMode={session?.config.approval_mode ?? null}
              busy={busy}
              disabled={!connection}
              sessionActive={session?.status === "active"}
              onSend={handleSend}
              onApprove={(id) => handleApproval(id, true)}
              onDeny={(id) => handleApproval(id, false)}
              onSetApprovalMode={(mode) => void handleUpdateSession({ approval_mode: mode })}
            />
          )}
        </main>
      </div>

      {error && (
        <div className="px-4 py-2 text-[13px] anim-slide-bottom" style={{ background: "var(--danger-dim)", color: "var(--danger)", borderTop: "1px solid var(--danger)" }}>
          {error}
        </div>
      )}

      {/* ── 删除确认弹窗 ── */}
      <AlertDialog
        open={!!deleteConfirmSession}
        onOpenChange={(open) => { if (!open) setDeleteConfirmSession(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除会话{" "}
              <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
                "{deleteConfirmSession?.title}"
              </span>{" "}
              吗？
              <br />聊天记录、审批和审计将一并移除，且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteConfirmSession && void handleDeleteSession(deleteConfirmSession)}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
