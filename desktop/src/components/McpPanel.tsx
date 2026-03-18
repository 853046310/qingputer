import { useState } from "react";
import { ChevronRight, Plus, RefreshCcw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

import type { McpServerConfig, McpServerRuntimeState, McpTransport } from "../types";

interface McpPanelProps {
  mcpServers: McpServerRuntimeState[];
  disabled: boolean;
  onUpsertMcpServer: (config: McpServerConfig, isNew: boolean) => Promise<void>;
  onDeleteMcpServer: (serverId: string) => Promise<void>;
  onRefreshMcpServer: (serverId: string) => Promise<void>;
}

interface McpServerDraft {
  config: McpServerConfig;
  argsText: string;
  envText: string;
  headersText: string;
  isNew: boolean;
}

function makeMcpDraft(config: McpServerConfig, isNew = false): McpServerDraft {
  return {
    config,
    argsText: config.args.join("\n"),
    envText: JSON.stringify(config.env, null, 2),
    headersText: JSON.stringify(config.headers, null, 2),
    isNew,
  };
}

function newMcpConfig(): McpServerConfig {
  return {
    server_id: `mcp-${crypto.randomUUID().slice(0, 8)}`,
    name: "",
    transport: "stdio",
    enabled: true,
    auto_connect: true,
    description: "",
    command: "",
    args: [],
    env: {},
    cwd: "",
    url: "",
    headers: {},
  };
}

function parseJsonObject(raw: string, label: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "{}") return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, value == null ? "" : String(value)]),
  );
}

function statusLabel(status: McpServerRuntimeState["status"]) {
  if (status === "connected") return "已连接";
  if (status === "connecting") return "连接中";
  if (status === "error") return "错误";
  return "未连接";
}

function statusVariant(status: McpServerRuntimeState["status"]) {
  if (status === "connected") return "default" as const;
  if (status === "error") return "destructive" as const;
  return "secondary" as const;
}

export function McpPanel({
  mcpServers,
  disabled,
  onUpsertMcpServer,
  onDeleteMcpServer,
  onRefreshMcpServer,
}: McpPanelProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingDraft, setEditingDraft] = useState<McpServerDraft | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const runtimeStates = new Map(mcpServers.map((s) => [s.config.server_id, s]));

  function openEdit(server: McpServerRuntimeState) {
    setEditingDraft(makeMcpDraft(server.config));
    setMcpError(null);
    setSheetOpen(true);
  }

  function openNew() {
    setEditingDraft(makeMcpDraft(newMcpConfig(), true));
    setMcpError(null);
    setSheetOpen(true);
  }

  function updateDraft(updater: (d: McpServerDraft) => McpServerDraft) {
    setEditingDraft((cur) => (cur ? updater(cur) : cur));
  }

  async function saveEditingDraft() {
    if (!editingDraft) return;
    setMcpError(null);
    try {
      const config: McpServerConfig = {
        ...editingDraft.config,
        args: editingDraft.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
        env: parseJsonObject(editingDraft.envText, "环境变量"),
        headers: parseJsonObject(editingDraft.headersText, "请求头"),
      };
      if (config.transport === "stdio" && !(config.command ?? "").trim()) {
        throw new Error("stdio MCP 必须填写 command。");
      }
      if (config.transport === "streamable_http" && !(config.url ?? "").trim()) {
        throw new Error("Streamable HTTP MCP 必须填写 URL。");
      }
      await onUpsertMcpServer(config, editingDraft.isNew);
      setSheetOpen(false);
    } catch (err) {
      setMcpError(String(err));
    }
  }

  return (
    <>
      {/* Action bar */}
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-[12px] [&_svg]:size-auto"
          disabled={disabled}
          onClick={openNew}
        >
          <Plus size={11} />
          新增
        </Button>
      </div>

      {/* Card list */}
      <div className="flex flex-col gap-2">
        {mcpServers.length === 0 && (
          <p className="text-[12px] text-center py-6" style={{ color: "var(--text-muted)" }}>
            暂无 MCP 服务器，点击「新增」添加
          </p>
        )}
        {mcpServers.map((server) => (
          <button
            key={server.config.server_id}
            type="button"
            className="flex items-center gap-3 px-3 py-3 rounded-xl w-full text-left"
            style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)", cursor: "pointer" }}
            onClick={() => openEdit(server)}
          >
            {/* Status dot */}
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{
                background:
                  server.status === "connected"
                    ? "var(--accent)"
                    : server.status === "error"
                    ? "var(--danger)"
                    : "var(--text-muted)",
              }}
            />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium truncate" style={{ color: "var(--text-primary)" }}>
                  {server.config.name || "未命名 MCP"}
                </span>
                <Badge
                  variant={statusVariant(server.status)}
                  className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                >
                  {statusLabel(server.status)}
                </Badge>
              </div>
              <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                {server.config.transport}
                {server.tools.length > 0 ? ` · ${server.tools.length} 个工具` : ""}
                {server.last_error ? ` · ${server.last_error}` : ""}
              </p>
            </div>

            <ChevronRight size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          </button>
        ))}
      </div>

      {/* Config drawer */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="w-[440px] sm:max-w-[440px] flex flex-col p-0 gap-0"
          style={{ background: "var(--bg-surface)" }}
        >
          <SheetHeader
            className="px-5 py-4 shrink-0"
            style={{ borderBottom: "1px solid var(--border-muted)" }}
          >
            <SheetTitle className="text-[14px]">
              {editingDraft?.isNew ? "新增 MCP" : (editingDraft?.config.name || "配置 MCP")}
            </SheetTitle>
          </SheetHeader>

          {editingDraft && (
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
              {mcpError && (
                <div
                  className="px-3 py-2 rounded-lg text-[12px]"
                  style={{ background: "var(--danger-dim)", color: "var(--danger)" }}
                >
                  {mcpError}
                </div>
              )}

              {/* Basic */}
              <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>名称</span>
                <Input
                  value={editingDraft.config.name}
                  onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, name: e.target.value } }))}
                  disabled={disabled}
                  className="h-8 text-[13px]"
                  placeholder="My MCP Server"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>说明</span>
                <Input
                  value={editingDraft.config.description ?? ""}
                  onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, description: e.target.value } }))}
                  disabled={disabled}
                  className="h-8 text-[13px]"
                  placeholder="可选"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>ID</span>
                <Input
                  value={editingDraft.config.server_id}
                  onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, server_id: e.target.value } }))}
                  disabled={disabled || !editingDraft.isNew}
                  className="h-8 text-[13px] font-mono"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>Transport</span>
                <Select
                  value={editingDraft.config.transport}
                  onValueChange={(v) => updateDraft((d) => ({ ...d, config: { ...d.config, transport: v as McpTransport } }))}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio</SelectItem>
                    <SelectItem value="streamable_http">streamable_http</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              {/* Switches */}
              <div className="flex items-center gap-5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`sheet-enabled-${editingDraft.config.server_id}`}
                    checked={editingDraft.config.enabled}
                    onCheckedChange={(c) => updateDraft((d) => ({ ...d, config: { ...d.config, enabled: c === true } }))}
                    disabled={disabled}
                  />
                  <label htmlFor={`sheet-enabled-${editingDraft.config.server_id}`} className="cursor-pointer">启用</label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`sheet-auto-${editingDraft.config.server_id}`}
                    checked={editingDraft.config.auto_connect}
                    onCheckedChange={(c) => updateDraft((d) => ({ ...d, config: { ...d.config, auto_connect: c === true } }))}
                    disabled={disabled}
                  />
                  <label htmlFor={`sheet-auto-${editingDraft.config.server_id}`} className="cursor-pointer">自动连接</label>
                </div>
              </div>

              {/* Transport-specific fields */}
              {editingDraft.config.transport === "stdio" ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>Command</span>
                    <Input
                      value={editingDraft.config.command ?? ""}
                      onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, command: e.target.value } }))}
                      disabled={disabled}
                      className="h-8 text-[13px] font-mono"
                      placeholder="npx / uvx / ..."
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>Args（每行一个）</span>
                    <Textarea
                      value={editingDraft.argsText}
                      onChange={(e) => updateDraft((d) => ({ ...d, argsText: e.target.value }))}
                      disabled={disabled}
                      rows={3}
                      className="text-[13px] resize-y font-mono"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>Env（JSON）</span>
                    <Textarea
                      value={editingDraft.envText}
                      onChange={(e) => updateDraft((d) => ({ ...d, envText: e.target.value }))}
                      disabled={disabled}
                      rows={3}
                      className="text-[13px] resize-y font-mono"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>CWD</span>
                    <Input
                      value={editingDraft.config.cwd ?? ""}
                      onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, cwd: e.target.value } }))}
                      disabled={disabled}
                      className="h-8 text-[13px] font-mono"
                      placeholder="/path/to/cwd"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>URL</span>
                    <Input
                      value={editingDraft.config.url ?? ""}
                      onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, url: e.target.value } }))}
                      disabled={disabled}
                      className="h-8 text-[13px] font-mono"
                      placeholder="https://..."
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>Headers（JSON）</span>
                    <Textarea
                      value={editingDraft.headersText}
                      onChange={(e) => updateDraft((d) => ({ ...d, headersText: e.target.value }))}
                      disabled={disabled}
                      rows={4}
                      className="text-[13px] resize-y font-mono"
                    />
                  </label>
                </>
              )}

              {/* Tools (existing only) */}
              {!editingDraft.isNew && (() => {
                const state = runtimeStates.get(editingDraft.config.server_id);
                if (!state || state.tools.length === 0) return null;
                return (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      已发现工具（{state.tools.length}）
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {state.tools.slice(0, 16).map((tool) => (
                        <span
                          key={`${tool.server_id}:${tool.name}`}
                          className="px-2 py-0.5 rounded text-[10px] font-mono"
                          style={{ background: "var(--bg-raised)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                        >
                          {tool.name}
                        </span>
                      ))}
                      {state.tools.length > 16 && (
                        <span
                          className="px-2 py-0.5 rounded text-[10px]"
                          style={{ background: "var(--bg-raised)", color: "var(--text-muted)", border: "1px solid var(--border)" }}
                        >
                          +{state.tools.length - 16}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          <SheetFooter
            className="px-5 py-4 shrink-0 flex-row gap-2"
            style={{ borderTop: "1px solid var(--border-muted)" }}
          >
            {editingDraft && !editingDraft.isNew && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 text-[12px] [&_svg]:size-auto"
                  disabled={disabled}
                  onClick={() => void onRefreshMcpServer(editingDraft.config.server_id)}
                >
                  <RefreshCcw size={11} />
                  刷新连接
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1 text-[12px] [&_svg]:size-auto"
                  disabled={disabled}
                  onClick={() => {
                    void onDeleteMcpServer(editingDraft.config.server_id);
                    setSheetOpen(false);
                  }}
                >
                  <Trash2 size={11} />
                  删除
                </Button>
              </>
            )}
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              className="text-[12px]"
              onClick={() => setSheetOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="text-[12px]"
              disabled={disabled}
              onClick={() => void saveEditingDraft()}
            >
              保存
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
