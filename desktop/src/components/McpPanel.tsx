import { useState } from "react";
import { AlertCircle, ChevronRight, Plus, RefreshCcw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
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

function statusDotColor(status: McpServerRuntimeState["status"]) {
  if (status === "connected") return "bg-emerald-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground/50";
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
          className="h-8 gap-1.5 text-xs"
          disabled={disabled}
          onClick={openNew}
        >
          <Plus size={14} />
          新增服务器
        </Button>
      </div>

      {/* Card list */}
      <div className="flex flex-col gap-2">
        {mcpServers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">暂无 MCP 服务器</p>
            <p className="mt-1 text-xs text-muted-foreground/70">点击「新增服务器」开始添加</p>
          </div>
        )}
        {mcpServers.map((server) => (
          <button
            key={server.config.server_id}
            type="button"
            className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/5"
            onClick={() => openEdit(server)}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotColor(server.status)}`} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {server.config.name || "未命名 MCP"}
                </span>
                <Badge
                  variant={statusVariant(server.status)}
                  className="h-5 shrink-0 px-1.5 text-[10px]"
                >
                  {statusLabel(server.status)}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {server.config.transport}
                {server.tools.length > 0 ? ` · ${server.tools.length} 个工具` : ""}
                {server.last_error ? ` · ${server.last_error}` : ""}
              </p>
            </div>

            <ChevronRight size={14} className="shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>

      {/* Config drawer */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="flex w-[440px] flex-col gap-0 bg-background p-0 sm:max-w-[440px]"
        >
          <SheetHeader className="shrink-0 border-b px-6 py-4">
            <SheetTitle className="text-base">
              {editingDraft?.isNew ? "新增 MCP" : (editingDraft?.config.name || "配置 MCP")}
            </SheetTitle>
          </SheetHeader>

          {editingDraft && (
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
              {mcpError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{mcpError}</span>
                </div>
              )}

              {/* Basic info */}
              <div className="space-y-4">
                <div className="grid gap-2">
                  <Label>名称</Label>
                  <Input
                    value={editingDraft.config.name}
                    onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, name: e.target.value } }))}
                    disabled={disabled}
                    placeholder="My MCP Server"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>说明</Label>
                  <Input
                    value={editingDraft.config.description ?? ""}
                    onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, description: e.target.value } }))}
                    disabled={disabled}
                    placeholder="可选描述"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>ID</Label>
                  <Input
                    value={editingDraft.config.server_id}
                    onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, server_id: e.target.value } }))}
                    disabled={disabled || !editingDraft.isNew}
                    className="font-mono"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Transport</Label>
                  <Select
                    value={editingDraft.config.transport}
                    onValueChange={(v) => updateDraft((d) => ({ ...d, config: { ...d.config, transport: v as McpTransport } }))}
                    disabled={disabled}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stdio">stdio</SelectItem>
                      <SelectItem value="streamable_http">streamable_http</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Switches */}
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`sheet-enabled-${editingDraft.config.server_id}`}
                    checked={editingDraft.config.enabled}
                    onCheckedChange={(c) => updateDraft((d) => ({ ...d, config: { ...d.config, enabled: c === true } }))}
                    disabled={disabled}
                  />
                  <Label htmlFor={`sheet-enabled-${editingDraft.config.server_id}`} className="cursor-pointer font-normal">
                    启用
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`sheet-auto-${editingDraft.config.server_id}`}
                    checked={editingDraft.config.auto_connect}
                    onCheckedChange={(c) => updateDraft((d) => ({ ...d, config: { ...d.config, auto_connect: c === true } }))}
                    disabled={disabled}
                  />
                  <Label htmlFor={`sheet-auto-${editingDraft.config.server_id}`} className="cursor-pointer font-normal">
                    自动连接
                  </Label>
                </div>
              </div>

              <Separator />

              {/* Transport-specific fields */}
              {editingDraft.config.transport === "stdio" ? (
                <div className="space-y-4">
                  <div className="grid gap-2">
                    <Label>Command</Label>
                    <Input
                      value={editingDraft.config.command ?? ""}
                      onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, command: e.target.value } }))}
                      disabled={disabled}
                      className="font-mono"
                      placeholder="npx / uvx / ..."
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label>Args（每行一个）</Label>
                    <Textarea
                      value={editingDraft.argsText}
                      onChange={(e) => updateDraft((d) => ({ ...d, argsText: e.target.value }))}
                      disabled={disabled}
                      rows={3}
                      className="resize-y font-mono text-sm"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label>Env（JSON）</Label>
                    <Textarea
                      value={editingDraft.envText}
                      onChange={(e) => updateDraft((d) => ({ ...d, envText: e.target.value }))}
                      disabled={disabled}
                      rows={3}
                      className="resize-y font-mono text-sm"
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label>CWD</Label>
                    <Input
                      value={editingDraft.config.cwd ?? ""}
                      onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, cwd: e.target.value } }))}
                      disabled={disabled}
                      className="font-mono"
                      placeholder="/path/to/cwd"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-2">
                    <Label>URL</Label>
                    <Input
                      value={editingDraft.config.url ?? ""}
                      onChange={(e) => updateDraft((d) => ({ ...d, config: { ...d.config, url: e.target.value } }))}
                      disabled={disabled}
                      className="font-mono"
                      placeholder="https://..."
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label>Headers（JSON）</Label>
                    <Textarea
                      value={editingDraft.headersText}
                      onChange={(e) => updateDraft((d) => ({ ...d, headersText: e.target.value }))}
                      disabled={disabled}
                      rows={4}
                      className="resize-y font-mono text-sm"
                    />
                  </div>
                </div>
              )}

              {/* Tools (existing only) */}
              {!editingDraft.isNew && (() => {
                const state = runtimeStates.get(editingDraft.config.server_id);
                if (!state || state.tools.length === 0) return null;
                return (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <Label className="text-muted-foreground">
                        已发现工具（{state.tools.length}）
                      </Label>
                      <div className="flex flex-wrap gap-1.5">
                        {state.tools.slice(0, 16).map((tool) => (
                          <Badge
                            key={`${tool.server_id}:${tool.name}`}
                            variant="secondary"
                            className="font-mono text-[10px] font-normal"
                          >
                            {tool.name}
                          </Badge>
                        ))}
                        {state.tools.length > 16 && (
                          <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                            +{state.tools.length - 16}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          <SheetFooter className="shrink-0 flex-row gap-2 border-t px-6 py-4">
            {editingDraft && !editingDraft.isNew && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={disabled}
                  onClick={() => void onRefreshMcpServer(editingDraft.config.server_id)}
                >
                  <RefreshCcw size={14} />
                  刷新
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-1.5"
                  disabled={disabled}
                  onClick={() => {
                    void onDeleteMcpServer(editingDraft.config.server_id);
                    setSheetOpen(false);
                  }}
                >
                  <Trash2 size={14} />
                  删除
                </Button>
              </>
            )}
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSheetOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
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
