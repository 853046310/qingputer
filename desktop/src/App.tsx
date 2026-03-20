import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Blocks, ChevronsUpDown, Cpu, LogOut, Menu, Moon, MoreHorizontal, Settings, SquarePen, Sun, Trash2, UserRound, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { ChatPanel } from "./components/ChatPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { MobileConnectDialog } from "./components/MobileConnectDialog";
import { PairingScreen, type PairingConfig } from "./components/PairingScreen";
import { ProductTabs, type ProductId } from "./components/ProductTabs";
import { QingCodePanel } from "./components/QingCodePanel";
import { QingflowAuthGate } from "./components/QingflowAuthGate";
import { QingCodeSettingsPage } from "./components/QingCodeSettingsPage";
import { SettingsPage } from "./components/SettingsPage";
import { StatusBar } from "./components/StatusBar";
import { isDesktopApp } from "./lib/api-factory";
import type { IRuntimeApi } from "./lib/api-interface";
import type { IQingCodeApi } from "./lib/qingcode-api-interface";
import { QingCodeApi } from "./lib/qingcode-api";
import { RemoteRuntimeApi, type RemoteConfig } from "./lib/api-remote";
import { RelayRuntimeApi, type RelayConfig } from "./lib/api-relay";
import { RelayClient, type RelayInfo } from "./lib/relay-client";
import { RuntimeApi } from "./lib/api";
import { ConnectionMonitor, type ConnectionState } from "./lib/connection-monitor";
import {
  getPreference, setPreference, removePreference,
  addNetworkListener, addAppStateListener,
  initKeyboard, initStatusBar, hideSplash,
  hapticSuccess,
} from "./lib/mobile-bridge";
import type {
  ApprovalRequest,
  ChatHistoryResponse,
  ChatMessage,
  DefaultSessionConfig,
  EventEnvelope,
  McpServerConfig,
  McpServerRuntimeState,
  QingflowAuthProbe,
  QingflowAuthStatus,
  RuntimeConnection,
  SessionRecord,
  SessionUpdatePayload,
  SettingsPayload,
} from "./types";
import type {
  QCChatHistoryResponse,
  QCConversationRecord,
  QCRuntimeConnection,
  QCSettings,
  QCUpdateSettingsPayload,
  QCWSEvent,
} from "./qingcode-types";

const STATUS_ZH: Record<string, string> = {
  created: "已创建", authorized: "已授权", active: "运行中",
  paused: "已暂停", completed: "已完成", terminated: "已终止",
};

const IS_DESKTOP = isDesktopApp();

const MOBILE_SESSION_DEFAULTS: DefaultSessionConfig = {
  cwd: "~",
  grants: { terminal: true, filesystem: true, browser: true },
  approval_mode: "default",
  idle_timeout_minutes: 60,
  absolute_timeout_hours: 8,
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

function qingflowDisplayName(status: QingflowAuthStatus | null) {
  return status?.user_name?.trim() || status?.user_email?.trim() || "轻流账号";
}

function qingflowInitial(status: QingflowAuthStatus | null) {
  return qingflowDisplayName(status).charAt(0).toUpperCase();
}

// ─── Persistence keys ───────────────────────────────────────────────────────
const PREF_CONNECTION_MODE = "qp-connection-mode";
const PREF_REMOTE_CONFIG = "qp-remote-config";
const PREF_RELAY_CONFIG = "qp-relay-config";

// ─── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [connection, setConnection] = useState<RuntimeConnection | null>(null);
  const [api, setApi] = useState<IRuntimeApi | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [history, setHistory] = useState<ChatHistoryResponse | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [qingflowStatus, setQingflowStatus] = useState<QingflowAuthStatus | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerRuntimeState[]>([]);
  const [sessionDefaults, setSessionDefaults] = useState<DefaultSessionConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [qingflowBusy, setQingflowBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("qp-theme") as "light" | "dark") ?? "light",
  );

  // 视图状态
  const [activeProduct, setActiveProduct] = useState<ProductId>("qingputer");
  const [activeView, setActiveView] = useState<"chat" | "account" | "model" | "mcp">("chat");
  const [deleteConfirmSession, setDeleteConfirmSession] = useState<SessionRecord | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  // QingCode state
  const [qcApi, setQcApi] = useState<IQingCodeApi | null>(null);
  const [qcConnection, setQcConnection] = useState<QCRuntimeConnection | null>(null);
  const [qcConversations, setQcConversations] = useState<QCConversationRecord[]>([]);
  const [qcConversation, setQcConversation] = useState<QCConversationRecord | null>(null);
  const [qcHistory, setQcHistory] = useState<QCChatHistoryResponse | null>(null);
  const [qcSettings, setQcSettings] = useState<QCSettings | null>(null);
  const [qcBusy, setQcBusy] = useState(false);
  const [qcActiveView, setQcActiveView] = useState<"chat" | "settings">("chat");
  const [qcWorkspace, setQcWorkspace] = useState("");
  const [qcInitialized, setQcInitialized] = useState(false);
  // 移动端：配对状态 & 抽屉
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [relayInfo, setRelayInfo] = useState<RelayInfo | null>(null);
  // 移动端持久化配置加载状态
  const [configLoaded, setConfigLoaded] = useState(IS_DESKTOP);
  // 连接监控
  const [connState, setConnState] = useState<ConnectionState>("connected");

  const socketRef = useRef<WebSocket | null>(null);
  const relayClientRef = useRef<RelayClient | null>(null);
  const monitorRef = useRef<ConnectionMonitor | null>(null);
  // 跨会话切换时保存流式消息，切回时恢复
  const streamingCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const qingflowPollTimerRef = useRef<number | null>(null);
  const qingflowConnectInFlightRef = useRef(false);
  const qingflowLastAttemptRef = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  const qingflowUnlockHandledRef = useRef<string | null>(null);

  const isMobile = !IS_DESKTOP;
  const paired = isMobile ? !!api : true;
  const qingflowRequired = IS_DESKTOP && activeProduct === "qingputer";
  const qingflowBlocked = qingflowRequired && qingflowStatus !== null && !qingflowStatus.connected;
  const qingflowName = qingflowDisplayName(qingflowStatus);
  const qingflowAvatarUrl = qingflowStatus?.user_avatar_url ?? settings?.qingflow_user_avatar_url ?? null;
  const qingflowSubline = qingflowStatus?.selected_ws_name ?? qingflowStatus?.user_email ?? "已连接轻流";

  const hydrateQingputerAfterAuth = useCallback(async (targetApi: IRuntimeApi) => {
    const nextSessions = await targetApi.listSessions();
    setSessions(nextSessions);
    setActiveProduct("qingputer");
    setActiveView("chat");
    if (nextSessions.length > 0) {
      const nextHistory = await targetApi.getHistory(nextSessions[0].session_id);
      setSession(nextHistory.session);
      setHistory(nextHistory);
    } else {
      setSession(null);
      setHistory(null);
    }
  }, []);

  const stopQingflowAuthPolling = useCallback(() => {
    if (qingflowPollTimerRef.current !== null) {
      window.clearInterval(qingflowPollTimerRef.current);
      qingflowPollTimerRef.current = null;
    }
    qingflowConnectInFlightRef.current = false;
  }, []);

  const refreshQingflowContext = useCallback(async (targetApi: IRuntimeApi) => {
    const [nextSettings, nextStatus, nextMcpServers] = await Promise.all([
      withRetry(() => targetApi.getSettings()),
      withRetry(() => targetApi.getQingflowStatus()),
      withRetry(() => targetApi.listMcpServers()),
    ]);
    setSettings(nextSettings);
    setQingflowStatus(nextStatus);
    setMcpServers(nextMcpServers);
    return nextStatus;
  }, []);

  const startQingflowAuthPolling = useCallback((targetApi: IRuntimeApi) => {
    stopQingflowAuthPolling();
    const finalizeQingflowAuth = async (statusOverride?: QingflowAuthStatus) => {
      const nextStatus = statusOverride ?? await refreshQingflowContext(targetApi);
      setQingflowStatus(nextStatus);
      if (nextStatus.connected) {
        await hydrateQingputerAfterAuth(targetApi);
      }
    };
    const connectFromProbe = async (probe: QingflowAuthProbe) => {
      const token = probe.token_candidate?.trim();
      if (!token || qingflowConnectInFlightRef.current) {
        return;
      }
      const attemptKey = `${token}:${probe.ws_id_candidate ?? ""}`;
      const now = Date.now();
      if (
        qingflowLastAttemptRef.current.key === attemptKey &&
        now - qingflowLastAttemptRef.current.at < 3000
      ) {
        return;
      }
      qingflowConnectInFlightRef.current = true;
      qingflowLastAttemptRef.current = { key: attemptKey, at: now };
      try {
        const nextStatus = await targetApi.connectQingflow({
          token,
          detected_ws_id: probe.ws_id_candidate ?? undefined,
        });
        setQingflowStatus(nextStatus);
        if (nextStatus.connected || nextStatus.requires_workspace_selection) {
          await invoke("qingflow_auth_stop").catch(() => undefined);
          await finalizeQingflowAuth(nextStatus);
          stopQingflowAuthPolling();
        }
      } catch (reason) {
        setError(String(reason));
      } finally {
        qingflowConnectInFlightRef.current = false;
      }
    };
    const poll = async () => {
      try {
        const latestStatus = await targetApi.getQingflowStatus();
        if (latestStatus.connected || latestStatus.requires_workspace_selection) {
          await invoke("qingflow_auth_stop");
          await finalizeQingflowAuth(latestStatus);
          stopQingflowAuthPolling();
          return;
        }
        const probe = await invoke<QingflowAuthProbe>("qingflow_auth_snapshot");
        if (probe.last_error) {
          setError(probe.last_error);
        }
        if (probe.token_candidate) {
          await connectFromProbe(probe);
          if (qingflowPollTimerRef.current === null) {
            return;
          }
        }
        if (!probe.window_open) {
          await finalizeQingflowAuth();
          stopQingflowAuthPolling();
          return;
        }
      } catch (reason) {
        setError(String(reason));
        stopQingflowAuthPolling();
      }
    };
    void poll();
    qingflowPollTimerRef.current = window.setInterval(() => {
      void poll();
    }, 1200);
  }, [hydrateQingputerAfterAuth, refreshQingflowContext, stopQingflowAuthPolling]);

  useEffect(() => {
    if (!IS_DESKTOP || !api || !qingflowStatus || qingflowStatus.connected || !qingflowStatus.token_set) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const syncIfConnected = async () => {
      try {
        const latestStatus = await api.getQingflowStatus();
        if (cancelled) return;
        if (latestStatus.connected) {
          await invoke("qingflow_auth_stop").catch(() => undefined);
          const refreshed = await refreshQingflowContext(api);
          if (cancelled) return;
          if (refreshed.connected) {
            await hydrateQingputerAfterAuth(api);
          }
          return;
        }
        timer = window.setTimeout(syncIfConnected, 1000);
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
        }
      }
    };

    void syncIfConnected();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [api, hydrateQingputerAfterAuth, qingflowStatus, refreshQingflowContext]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("qp-theme", theme);
    void initStatusBar(theme === "dark");
  }, [theme]);

  useEffect(() => () => {
    stopQingflowAuthPolling();
  }, [stopQingflowAuthPolling]);

  useEffect(() => {
    if (!IS_DESKTOP || !api || !qingflowStatus) {
      return;
    }
    if (!qingflowStatus.connected && !qingflowStatus.requires_workspace_selection) {
      qingflowUnlockHandledRef.current = null;
      return;
    }

    const signature = [
      qingflowStatus.connected ? "connected" : "workspace-selection",
      qingflowStatus.selected_ws_id ?? "none",
    ].join(":");
    if (qingflowUnlockHandledRef.current === signature) {
      return;
    }
    qingflowUnlockHandledRef.current = signature;

    void (async () => {
      await invoke("qingflow_auth_stop").catch(() => undefined);
      if (qingflowStatus.connected) {
        await hydrateQingputerAfterAuth(api);
      }
    })();
  }, [api, hydrateQingputerAfterAuth, qingflowStatus]);

  // Mobile: load persisted config from Capacitor Preferences
  useEffect(() => {
    if (IS_DESKTOP) return;
    let cancelled = false;
    async function loadPersistedConfig() {
      try {
        const [mode, remoteRaw, relayRaw] = await Promise.all([
          getPreference(PREF_CONNECTION_MODE),
          getPreference(PREF_REMOTE_CONFIG),
          getPreference(PREF_RELAY_CONFIG),
        ]);
        if (cancelled) return;
        if (mode === "lan" && remoteRaw) {
          setRemoteConfig(JSON.parse(remoteRaw) as RemoteConfig);
        } else if (mode === "relay" && relayRaw) {
          setRelayConfig(JSON.parse(relayRaw) as RelayConfig);
        }
      } catch {
        // No persisted config — show pairing screen
      } finally {
        if (!cancelled) {
          setConfigLoaded(true);
          void hideSplash();
        }
      }
    }
    void loadPersistedConfig();
    return () => { cancelled = true; };
  }, []);

  // Mobile: init keyboard and splash screen
  useEffect(() => {
    if (IS_DESKTOP) return;
    void initKeyboard();
  }, []);

  // Desktop bootstrap
  useEffect(() => {
    if (!IS_DESKTOP) return;
    let cancelled = false;
    async function bootstrap() {
      try {
        const conn = await invoke<RuntimeConnection>("runtime_connection");
        if (cancelled) return;
        const rapi = new RuntimeApi(conn);
        const [nextSettings, nextQingflowStatus, nextMcpServers, nextDefaults, nextSessions] = await Promise.all([
          withRetry(() => rapi.getSettings()),
          withRetry(() => rapi.getQingflowStatus()),
          withRetry(() => rapi.listMcpServers()),
          invoke<DefaultSessionConfig>("default_session_config"),
          withRetry(() => rapi.listSessions()),
        ]);
        if (cancelled) return;
        setConnection(conn); setApi(rapi); setSettings(nextSettings);
        setQingflowStatus(nextQingflowStatus);
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
    return () => { cancelled = true; socketRef.current?.close(); stopQingflowAuthPolling(); };
  }, [stopQingflowAuthPolling]);

  // Desktop: connect Relay client if VITE_RELAY_URL is set
  useEffect(() => {
    if (!IS_DESKTOP || !connection) return;
    const relayUrl = import.meta.env.VITE_RELAY_URL as string | undefined;
    if (!relayUrl) return;

    const roomId = crypto.randomUUID();
    const client = new RelayClient({
      relayUrl,
      roomId,
      runtimePort: connection.port,
      token: connection.token,
    });
    relayClientRef.current = client;
    client.connect();

    // Poll for registration to set relayInfo
    const check = setInterval(() => {
      const info = client.roomInfo;
      if (info) {
        setRelayInfo(info);
        clearInterval(check);
      }
    }, 500);

    return () => {
      clearInterval(check);
      client.disconnect();
      relayClientRef.current = null;
      setRelayInfo(null);
    };
  }, [connection]);

  // Mobile bootstrap after pairing (LAN mode)
  useEffect(() => {
    if (IS_DESKTOP || !remoteConfig) return;
    let cancelled = false;
    async function mobileBootstrap() {
      try {
        const rapi = new RemoteRuntimeApi(remoteConfig!);
        // Test connectivity
        const [nextSettings, nextMcpServers, nextSessions] = await Promise.all([
          withRetry(() => rapi.getSettings()),
          withRetry(() => rapi.listMcpServers()),
          withRetry(() => rapi.listSessions()),
        ]);
        if (cancelled) return;
        setConnection({ port: remoteConfig!.port, token: remoteConfig!.token });
        setApi(rapi);
        setSettings(nextSettings);
        setMcpServers(nextMcpServers);
        setSessionDefaults(MOBILE_SESSION_DEFAULTS);
        setSessions(nextSessions);
        if (nextSessions.length > 0) {
          const h = await rapi.getHistory(nextSessions[0].session_id);
          if (cancelled) return;
          setSession(h.session); setHistory(h);
        }
      } catch (reason) {
        setError("连接失败：" + String(reason));
        setRemoteConfig(null);
        void removePreference(PREF_CONNECTION_MODE);
        void removePreference(PREF_REMOTE_CONFIG);
      }
    }
    void mobileBootstrap();
    return () => { cancelled = true; socketRef.current?.close(); };
  }, [remoteConfig]);

  // Mobile bootstrap after pairing (Relay mode)
  const [relayConfig, setRelayConfig] = useState<RelayConfig | null>(null);
  useEffect(() => {
    if (IS_DESKTOP || !relayConfig) return;
    let cancelled = false;
    async function relayBootstrap() {
      try {
        const rapi = new RelayRuntimeApi(relayConfig!);
        const [nextSettings, nextMcpServers, nextSessions] = await Promise.all([
          withRetry(() => rapi.getSettings()),
          withRetry(() => rapi.listMcpServers()),
          withRetry(() => rapi.listSessions()),
        ]);
        if (cancelled) return;
        setConnection({ port: 0, token: relayConfig!.token });
        setApi(rapi);
        setSettings(nextSettings);
        setMcpServers(nextMcpServers);
        setSessionDefaults(MOBILE_SESSION_DEFAULTS);
        setSessions(nextSessions);
        if (nextSessions.length > 0) {
          const h = await rapi.getHistory(nextSessions[0].session_id);
          if (cancelled) return;
          setSession(h.session); setHistory(h);
        }
      } catch (reason) {
        setError("连接失败：" + String(reason));
        setRelayConfig(null);
        void removePreference(PREF_CONNECTION_MODE);
        void removePreference(PREF_RELAY_CONFIG);
      }
    }
    void relayBootstrap();
    return () => { cancelled = true; socketRef.current?.close(); };
  }, [relayConfig]);

  function handleMobileConnect(pairing: PairingConfig) {
    setError(null);
    if (pairing.mode === "relay") {
      setRelayConfig(pairing.config);
      // Persist relay config
      void setPreference(PREF_CONNECTION_MODE, "relay");
      void setPreference(PREF_RELAY_CONFIG, JSON.stringify(pairing.config));
      void hapticSuccess();
    } else {
      setRemoteConfig(pairing.config);
      // Persist LAN config
      void setPreference(PREF_CONNECTION_MODE, "lan");
      void setPreference(PREF_REMOTE_CONFIG, JSON.stringify(pairing.config));
      void hapticSuccess();
    }
  }

  const handleDisconnect = useCallback(() => {
    // Stop monitor
    monitorRef.current?.stop();
    monitorRef.current = null;
    stopQingflowAuthPolling();
    // Close socket
    socketRef.current?.close();
    socketRef.current = null;
    // Clear state
    setApi(null);
    setConnection(null);
    setRemoteConfig(null);
    setRelayConfig(null);
    setSessions([]);
    setSession(null);
    setHistory(null);
    setSettings(null);
    setQingflowStatus(null);
    setMcpServers([]);
    setConnState("connected");
    setError(null);
    // Clear persisted config
    void removePreference(PREF_CONNECTION_MODE);
    void removePreference(PREF_REMOTE_CONFIG);
    void removePreference(PREF_RELAY_CONFIG);
  }, [stopQingflowAuthPolling]);

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
      activeView === "mcp" || mcpServers.some((server) => server.status === "connecting");
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

  // Mobile: connection monitor + lifecycle
  useEffect(() => {
    if (IS_DESKTOP || !api) return;
    const mode: "lan" | "relay" = relayConfig ? "relay" : "lan";
    const monitor = new ConnectionMonitor({
      api,
      mode,
      onStateChange: (state) => setConnState(state),
      onReconnected: () => {
        // Refresh sessions and current history after reconnect
        void api.listSessions().then(setSessions).catch(() => {});
        if (session) {
          void api.getHistory(session.session_id).then((h) => {
            setSession(h.session);
            setHistory(h);
          }).catch(() => {});
        }
        // Rebuild event WebSocket
        if (session) {
          socketRef.current?.close();
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
          });
          socketRef.current = socket;
        }
      },
    });
    monitor.start();
    monitorRef.current = monitor;

    // Network change listener
    let removeNetworkListener: (() => void) | null = null;
    void addNetworkListener((connected) => {
      monitor.handleNetworkChange(connected);
    }).then((remove) => { removeNetworkListener = remove; });

    // App state listener (foreground/background)
    let removeAppListener: (() => void) | null = null;
    void addAppStateListener((isActive) => {
      if (isActive) monitor.handleForeground();
    }).then((remove) => { removeAppListener = remove; });

    // Hide splash screen now that we're connected
    void hideSplash();

    return () => {
      monitor.stop();
      monitorRef.current = null;
      removeNetworkListener?.();
      removeAppListener?.();
    };
  }, [api, session?.session_id]);

  // QingCode lazy bootstrap — only when user first switches to QingCode tab
  useEffect(() => {
    if (!IS_DESKTOP || activeProduct !== "qingcode" || qcInitialized) return;
    let cancelled = false;
    async function bootstrapQingCode() {
      try {
        const conn = await invoke<QCRuntimeConnection>("qingcode_connection");
        if (cancelled) return;
        const api = new QingCodeApi(conn);
        const [nextSettings, nextConversations] = await Promise.all([
          withRetry(() => api.getSettings()),
          withRetry(() => api.listConversations()),
        ]);
        if (cancelled) return;
        setQcConnection(conn);
        setQcApi(api);
        setQcSettings(nextSettings);
        setQcConversations(nextConversations);
        setQcWorkspace(nextSettings.default_workspace || "");
        setQcInitialized(true);
        if (nextConversations.length > 0) {
          const h = await api.getHistory(nextConversations[0].conversation_id);
          if (cancelled) return;
          setQcConversation(h.conversation);
          setQcHistory(h);
        }
      } catch (reason) {
        setError("QingCode: " + String(reason));
      }
    }
    void bootstrapQingCode();
    return () => { cancelled = true; };
  }, [activeProduct, qcInitialized]);

  // ── QingCode handlers ──

  async function qcRefreshConversations(nextSelectedId?: string) {
    if (!qcApi) return;
    const list = await qcApi.listConversations();
    setQcConversations(list);
    if (nextSelectedId) setQcConversation(list.find((c) => c.conversation_id === nextSelectedId) ?? null);
  }

  async function qcRefreshHistory(target: QCConversationRecord) {
    if (!qcApi) return;
    const h = await qcApi.getHistory(target.conversation_id);
    setQcConversation(h.conversation);
    setQcHistory(h);
    setQcConversations((cur) => {
      const filtered = cur.filter((c) => c.conversation_id !== h.conversation.conversation_id);
      return [h.conversation, ...filtered].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }

  function handleQcCreateConversation() {
    setQcConversation(null);
    setQcHistory(null);
    setQcActiveView("chat");
  }

  async function handleQcSelectConversation(c: QCConversationRecord) {
    if (qcBusy || c.conversation_id === qcConversation?.conversation_id) return;
    setQcBusy(true); setError(null);
    setQcActiveView("chat");
    try { await qcRefreshHistory(c); } catch (r) { setError(String(r)); } finally { setQcBusy(false); }
  }

  async function handleQcSend(content: string) {
    if (!qcApi) return;
    setQcBusy(true); setError(null);
    try {
      let target = qcConversation;
      if (!target) {
        target = await qcApi.createConversation(qcWorkspace);
        setQcConversation(target);
        setQcConversations((cur) => [target!, ...cur]);
      }
      await qcApi.postMessage(target.conversation_id, content);
      await qcRefreshHistory(target);
    } catch (r) {
      const message = r instanceof Error ? r.message : String(r);
      if (message.includes("API key")) setQcActiveView("settings");
      setError(message);
    } finally { setQcBusy(false); }
  }

  async function handleQcDeleteConversation(target: QCConversationRecord) {
    if (!qcApi) return;
    setQcBusy(true); setError(null);
    try {
      await qcApi.deleteConversation(target.conversation_id);
      await qcRefreshConversations();
      if (target.conversation_id === qcConversation?.conversation_id) {
        setQcConversation(null);
        setQcHistory(null);
      }
    } catch (r) { setError(String(r)); } finally { setQcBusy(false); }
  }

  async function handleQcSaveSettings(payload: QCUpdateSettingsPayload) {
    if (!qcApi) return;
    setQcBusy(true);
    try {
      const next = await qcApi.updateSettings(payload);
      setQcSettings(next);
      setQcWorkspace(next.default_workspace || qcWorkspace);
    } catch (r) { setError(String(r)); } finally { setQcBusy(false); }
  }


  function handleQcWsEvent(event: QCWSEvent) {
    if (event.type === "status") {
      const status = String(event.payload.status ?? "active") as QCConversationRecord["status"];
      setQcConversation((cur) => cur ? { ...cur, status } : cur);
    }
  }

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
    if (!connection && !isMobile) return;
    if (isMobile && !api) return;
    // 不立即创建会话——进入草稿状态，发送第一条消息后再真正创建
    setSession(null);
    setHistory(null);
    setActiveView("chat");
    if (isMobile) setDrawerOpen(false);
  }

  async function handleSelectSession(s: SessionRecord) {
    if (busy || s.session_id === session?.session_id) return;
    setBusy(true); setError(null);
    setActiveView("chat");
    if (isMobile) setDrawerOpen(false);
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
      // 首条消息自动命名会话（fire-and-forget，不阻塞发送）
      if (messages.length === 0) {
        const trimmed = content.trim();
        const autoTitle = trimmed.length > 30 ? trimmed.slice(0, 30) + "…" : trimmed;
        void api.updateSession(target.session_id, { title: autoTitle }).catch(() => {});
      }
      // 发送消息，后端接收后立即返回，agent loop 异步执行
      await api.postMessage(target.session_id, content);
      // 用户消息和状态更新通过 WebSocket 事件实时推送，无需阻塞等待
      void refreshSessionList(target.session_id).catch(() => {});
    } catch (r) {
      const message = r instanceof Error ? r.message : String(r);
      if (message.includes("API key")) setActiveView("model");
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

  async function handleSaveSettings(payload: {
    model_provider?: "openai" | "openrouter";
    openai_base_url?: string;
    openai_model?: string;
    openai_api_key?: string;
    openrouter_base_url?: string;
    openrouter_model?: string;
    openrouter_api_key?: string;
    qingflow_web_origin?: string;
    qingflow_api_base_url?: string;
  }) {
    if (!api) return;
    setBusy(true);
    try { setSettings(await api.updateSettings(payload)); }
    catch (r) { setError(String(r)); } finally { setBusy(false); }
  }

  async function handleStartQingflowAuth(payload: { webOrigin: string; apiBaseUrl: string }) {
    if (!api || !IS_DESKTOP) return;
    setQingflowBusy(true);
    setError(null);
    try {
      const nextSettings = await api.updateSettings({
        qingflow_web_origin: payload.webOrigin,
        qingflow_api_base_url: payload.apiBaseUrl,
      });
      setSettings(nextSettings);
      qingflowUnlockHandledRef.current = null;
      qingflowLastAttemptRef.current = { key: null, at: 0 };
      await invoke("qingflow_auth_start", { webOrigin: payload.webOrigin });
      startQingflowAuthPolling(api);
    } catch (r) {
      setError(String(r));
    } finally {
      setQingflowBusy(false);
    }
  }

  async function handleQingflowLogin(payload: {
    email: string;
    password: string;
    webOrigin: string;
    apiBaseUrl: string;
  }) {
    if (!api) return;
    setQingflowBusy(true);
    setError(null);
    try {
      const nextSettings = await api.updateSettings({
        qingflow_web_origin: payload.webOrigin,
        qingflow_api_base_url: payload.apiBaseUrl,
      });
      setSettings(nextSettings);
      const nextStatus = await api.loginQingflow({
        email: payload.email,
        password: payload.password,
      });
      setQingflowStatus(nextStatus);
      await refreshQingflowContext(api);
      if (nextStatus.connected) {
        await hydrateQingputerAfterAuth(api);
      }
    } catch (r) {
      setError(String(r));
    } finally {
      setQingflowBusy(false);
    }
  }

  async function handleOpenQingflowRegistration(payload: { webOrigin: string }) {
    const target = `${payload.webOrigin.replace(/\/$/, "")}/passport/login`;
    if (IS_DESKTOP) {
      await invoke("open_external_url", { url: target });
      return;
    }
    window.open(target, "_blank", "noopener,noreferrer");
  }

  async function handleQingflowSelectWorkspace(wsId: number) {
    if (!api) return;
    setQingflowBusy(true);
    setError(null);
    try {
      const nextStatus = await api.selectQingflowWorkspace(wsId);
      setQingflowStatus(nextStatus);
      await refreshQingflowContext(api);
      if (nextStatus.connected) {
        await hydrateQingputerAfterAuth(api);
      }
    } catch (r) {
      setError(String(r));
    } finally {
      setQingflowBusy(false);
    }
  }

  async function handleQingflowLogout() {
    if (!api) return;
    setQingflowBusy(true);
    setError(null);
    try {
      const nextStatus = await api.logoutQingflow();
      setQingflowStatus(nextStatus);
      await refreshQingflowContext(api);
      qingflowUnlockHandledRef.current = null;
      setSessions([]);
      setSession(null);
      setHistory(null);
      if (IS_DESKTOP) {
        stopQingflowAuthPolling();
        await invoke("qingflow_auth_stop");
      }
    } catch (r) {
      setError(String(r));
    } finally {
      setQingflowBusy(false);
    }
  }

  function requestQingflowLogout() {
    setLogoutConfirmOpen(true);
  }

  async function handleQingflowSyncMcp() {
    if (!api) return;
    setQingflowBusy(true);
    setError(null);
    try {
      const nextStatus = await api.syncQingflowMcp();
      setQingflowStatus(nextStatus);
      await refreshQingflowContext(api);
    } catch (r) {
      setError(String(r));
    } finally {
      setQingflowBusy(false);
    }
  }

  async function handleDeleteKey(provider: "openai" | "openrouter") {
    if (!api) return;
    setBusy(true);
    try { setSettings(await api.deleteModelKey(provider)); }
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

  // ─── Mobile: loading persisted config ───
  if (isMobile && !configLoaded) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: "var(--bg-base)" }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[28px] font-bold text-white shadow-lg">Q</div>
          <span className="text-sm text-muted-foreground">正在加载…</span>
        </div>
      </div>
    );
  }

  // ─── Mobile: show pairing screen when not connected ───
  if (isMobile && !paired) {
    return <PairingScreen onConnect={handleMobileConnect} />;
  }

  if (qingflowBlocked) {
    return (
      <QingflowAuthGate
        settings={settings}
        qingflowStatus={qingflowStatus}
        error={error}
        disabled={!connection || qingflowBusy}
        onLoginQingflow={handleQingflowLogin}
        onOpenQingflowRegistration={handleOpenQingflowRegistration}
        onSelectQingflowWorkspace={handleQingflowSelectWorkspace}
        onSyncQingflowMcp={handleQingflowSyncMcp}
        onLogoutQingflow={async () => { requestQingflowLogout(); }}
      />
    );
  }

  // ─── Sidebar content (shared between desktop fixed & mobile drawer) ───
  const sidebarContent = (
    <>
      {/* 头部 */}
      <div
        className="shrink-0 px-4 pt-4 pb-3"
        {...(IS_DESKTOP ? { "data-tauri-drag-region": "true" } : {})}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5" style={{ pointerEvents: "none" }}>
            <div className="relative h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[17px] font-bold text-white shadow-sm">
              Q
              <span
                className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2"
                style={{ background: (connection || api) ? "var(--accent)" : "var(--text-muted)", borderColor: "var(--bg-surface)" }}
              />
            </div>
            <span className="text-[15px] font-semibold tracking-tight text-foreground">qingputer</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-auto"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              style={{ pointerEvents: "auto" }}
              title={theme === "light" ? "切换深色" : "切换浅色"}
            >
              {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
            </Button>
            {isMobile && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-auto"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={16} />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="px-3 py-2 shrink-0">
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className="h-10 w-full justify-center gap-2 rounded-xl border-dashed border-border text-[15px] font-medium text-foreground hover:border-solid hover:border-primary/50 hover:bg-accent/10 hover:text-accent-foreground"
            disabled={!connection && !api}
            onClick={() => handleCreateSession()}
          >
            <SquarePen size={15} />
            新建会话
          </Button>
        </div>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无会话</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((item) => {
              const active = item.session_id === session?.session_id;
              return (
                <div key={item.session_id} className="group relative">
                  <Button
                    variant="ghost"
                    className={`w-full justify-start px-3 py-2 h-auto rounded-xl text-[13px] font-normal transition-colors ${active ? "bg-accent/10 text-foreground font-medium" : "text-secondary-foreground/70 hover:bg-muted"}`}
                    onClick={() => void handleSelectSession(item)}
                  >
                    <p className="text-[13px] truncate pr-5">
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
                          className="h-6 w-6 rounded-lg opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground [&_svg]:size-auto"
                      >
                        <MoreHorizontal size={13} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem
                          className="cursor-pointer gap-2 text-destructive focus:text-destructive"
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

      <div className="shrink-0 px-3 pb-3 pt-2 flex flex-col gap-1.5">
        {IS_DESKTOP && (
          <MobileConnectDialog connection={connection} relayInfo={relayInfo} />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/8 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              disabled={!qingflowStatus?.connected || qingflowBusy}
            >
              <Avatar className="h-8 w-8 shrink-0 ring-1 ring-border">
                {qingflowAvatarUrl && (
                  <AvatarImage src={qingflowAvatarUrl} alt={qingflowName} />
                )}
                <AvatarFallback className="bg-gradient-to-br from-emerald-500 to-teal-600 text-[11px] font-semibold text-white">
                  {qingflowInitial(qingflowStatus)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-tight text-foreground">
                  {qingflowName}
                </p>
                <p className="truncate text-[11px] leading-tight text-muted-foreground">
                  {qingflowSubline}
                </p>
              </div>
              <ChevronsUpDown size={14} className="shrink-0 text-muted-foreground/60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-60 rounded-xl p-1">
            <div className="flex items-center gap-2.5 px-2.5 py-2">
              <Avatar className="h-9 w-9 shrink-0">
                {qingflowAvatarUrl && (
                  <AvatarImage src={qingflowAvatarUrl} alt={qingflowName} />
                )}
                <AvatarFallback className="bg-gradient-to-br from-emerald-500 to-teal-600 text-[11px] font-semibold text-white">
                  {qingflowInitial(qingflowStatus)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{qingflowName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {qingflowStatus?.user_email ?? qingflowSubline}
                </p>
              </div>
            </div>
            <DropdownMenuSeparator className="mx-1" />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-lg"
                onClick={() => {
                  setActiveView("account");
                  if (isMobile) setDrawerOpen(false);
                }}
              >
                <UserRound size={15} className="text-muted-foreground" />
                账号设置
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-lg"
                onClick={() => {
                  setActiveView("model");
                  if (isMobile) setDrawerOpen(false);
                }}
              >
                <Cpu size={15} className="text-muted-foreground" />
                模型配置
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-lg"
                onClick={() => {
                  setActiveView("mcp");
                  if (isMobile) setDrawerOpen(false);
                }}
              >
                <Blocks size={15} className="text-muted-foreground" />
                MCP 服务器
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator className="mx-1" />
            <DropdownMenuItem
              className="cursor-pointer gap-2.5 rounded-lg text-destructive focus:text-destructive"
              onClick={requestQingflowLogout}
            >
              <LogOut size={15} />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}>
      {/* ── Desktop: Product Tabs ── */}
      {IS_DESKTOP && (
        <ProductTabs active={activeProduct} onChange={setActiveProduct} />
      )}

      {/* ── Mobile top bar ── */}
      {isMobile && (
        <div
          className="shrink-0 flex items-center gap-3 px-4 mobile-top-bar border-b border-border/50"
          style={{ height: 52, background: "var(--bg-surface)" }}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-secondary-foreground [&_svg]:size-auto"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={20} />
          </Button>
          <span className="text-[15px] font-semibold tracking-tight truncate text-foreground">
            {session?.title ?? "Qingputer"}
          </span>
        </div>
      )}

      {/* ── Mobile connection banner ── */}
      {isMobile && connState !== "connected" && (
        <ConnectionBanner state={connState} onDisconnect={handleDisconnect} />
      )}

      {/* ── QingCode mode ── */}
      {IS_DESKTOP && activeProduct === "qingcode" ? (
        <div className="flex flex-1 min-h-0">
          {/* QingCode Sidebar */}
          <aside className="flex flex-col w-[260px] shrink-0 border-r border-border/50" style={{ background: "var(--bg-surface)" }}>
            <div
              className="shrink-0 px-4 pt-4 pb-3"
              data-tauri-drag-region="true"
            >
              <div className="flex items-center gap-2.5" style={{ pointerEvents: "none" }}>
                <div className="relative h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[15px] font-bold text-white shadow-sm">
                  QC
                  <span
                    className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2"
                    style={{ background: qcConnection ? "var(--accent)" : "var(--text-muted)", borderColor: "var(--bg-surface)" }}
                  />
                </div>
                <span className="text-[15px] font-semibold tracking-tight text-foreground">QingCode</span>
              </div>
            </div>
            <div className="px-3 py-2 shrink-0">
              <div className="flex flex-col gap-1">
                <Button
                  variant="ghost"
                  className="h-10 justify-start gap-2.5 rounded-xl px-3 text-sm font-medium text-foreground hover:bg-accent/10"
                  disabled={!qcConnection}
                  onClick={handleQcCreateConversation}
                >
                  <SquarePen size={16} className="text-muted-foreground" />
                  New Task
                </Button>
                <Button
                  variant="ghost"
                  className={`h-10 justify-start gap-2.5 rounded-xl px-3 text-sm font-medium transition-colors ${qcActiveView === "settings" ? "bg-accent/10 text-foreground" : "text-foreground hover:bg-muted"}`}
                  disabled={!qcConnection}
                  onClick={() => setQcActiveView((v) => v === "settings" ? "chat" : "settings")}
                >
                  <Settings size={16} className={qcActiveView === "settings" ? "text-accent-foreground" : "text-muted-foreground"} />
                  Settings
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
              {qcConversations.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">No conversations</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {qcConversations.map((item) => {
                    const active = item.conversation_id === qcConversation?.conversation_id;
                    return (
                      <div key={item.conversation_id} className="group relative">
                        <Button
                          variant="ghost"
                          className={`w-full justify-start px-3 py-2 h-auto rounded-xl text-[13px] font-normal transition-colors ${active ? "bg-accent/10 text-foreground font-medium" : "text-secondary-foreground/70 hover:bg-muted"}`}
                          onClick={() => void handleQcSelectConversation(item)}
                        >
                          <p className="text-[13px] truncate pr-5">
                            {item.title}
                          </p>
                        </Button>
                        <div className="absolute top-1/2 right-2 -translate-y-1/2" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-6 w-6 rounded-lg opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground [&_svg]:size-auto">
                                <MoreHorizontal size={13} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem
                                className="cursor-pointer gap-2 text-destructive focus:text-destructive"
                                onClick={() => void handleQcDeleteConversation(item)}
                              >
                                <Trash2 size={12} />
                                Delete
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

          {/* QingCode Main Area */}
          <main className="flex-1 min-w-0 flex flex-col">
            {qcActiveView === "settings" ? (
              <QingCodeSettingsPage
                settings={qcSettings}
                disabled={!qcConnection || qcBusy}
                onSave={handleQcSaveSettings}
                onBack={() => setQcActiveView("chat")}
                onOpenQingputerSettings={() => { setActiveProduct("qingputer"); setActiveView("model"); }}
              />
            ) : (
              <QingCodePanel
                api={qcApi}
                conversation={qcConversation}
                history={qcHistory}
                busy={qcBusy}
                disabled={!qcConnection}
                defaultWorkspace={qcWorkspace}
                onSend={handleQcSend}
                onSelectWorkspace={setQcWorkspace}
                onWsEvent={handleQcWsEvent}
              />
            )}
          </main>
        </div>
      ) : (
      <div className="flex flex-1 min-h-0">

        {/* ── Desktop: fixed sidebar ── */}
        {IS_DESKTOP && (
          <aside className="flex flex-col w-[260px] shrink-0 border-r border-border/50" style={{ background: "var(--bg-surface)" }}>
            {sidebarContent}
          </aside>
        )}

        {/* ── Mobile: drawer overlay ── */}
        {isMobile && drawerOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />
            <aside
              className="fixed inset-y-0 left-0 z-50 flex flex-col w-[280px] shadow-2xl anim-slide-drawer"
              style={{ background: "var(--bg-surface)" }}
            >
              {sidebarContent}
            </aside>
          </>
        )}

        {/* ── 主区域 ── */}
        <main className="flex-1 min-w-0 flex flex-col">
          {activeView !== "chat" && IS_DESKTOP ? (
            <SettingsPage
              settings={settings}
              qingflowStatus={qingflowStatus}
              mcpServers={mcpServers}
              disabled={!connection || busy || qingflowBusy}
              section={activeView}
              onSave={handleSaveSettings}
              onStartQingflowAuth={handleStartQingflowAuth}
              onSelectQingflowWorkspace={handleQingflowSelectWorkspace}
              onSyncQingflowMcp={handleQingflowSyncMcp}
              onLogoutQingflow={async () => { requestQingflowLogout(); }}
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
              disabled={!connection && !api}
              sessionActive={session?.status === "active"}
              onSend={handleSend}
              onApprove={(id) => handleApproval(id, true)}
              onDeny={(id) => handleApproval(id, false)}
              onSetApprovalMode={(mode) => void handleUpdateSession({ approval_mode: mode })}
            />
          )}
        </main>
      </div>
      )}

      {error && (
        <div className="px-4 py-2.5 text-[13px] anim-slide-bottom border-t" style={{ background: "var(--danger-dim)", color: "var(--danger)", borderColor: "var(--danger)" }}>
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
              <span className="font-semibold text-foreground">
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

      <AlertDialog open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认登出</AlertDialogTitle>
            <AlertDialogDescription>
              确定要退出当前轻流账号吗？
              <br />
              登出后会清除本地保存的轻流登录态，并断开默认 Qingflow MCP 的账号同步。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setLogoutConfirmOpen(false);
                void handleQingflowLogout();
              }}
            >
              确认登出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
