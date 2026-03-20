import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, FileDown, ShieldAlert } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

import { McpPanel } from "./McpPanel";
import type {
  McpServerConfig,
  McpServerRuntimeState,
  QingflowAuthStatus,
  SettingsPayload,
} from "../types";

export type SettingsSection = "account" | "model" | "mcp";

interface SettingsPageProps {
  settings: SettingsPayload | null;
  qingflowStatus: QingflowAuthStatus | null;
  mcpServers: McpServerRuntimeState[];
  disabled: boolean;
  section: SettingsSection;
  onSave: (payload: {
    model_provider?: "openai" | "openrouter";
    openai_base_url?: string;
    openai_model?: string;
    openai_api_key?: string;
    openrouter_base_url?: string;
    openrouter_model?: string;
    openrouter_api_key?: string;
    qingflow_web_origin?: string;
    qingflow_api_base_url?: string;
  }) => Promise<void>;
  onStartQingflowAuth: (payload: { webOrigin: string; apiBaseUrl: string }) => Promise<void>;
  onSelectQingflowWorkspace: (wsId: number) => Promise<void>;
  onSyncQingflowMcp: () => Promise<void>;
  onLogoutQingflow: () => Promise<void>;
  onDeleteKey: (provider: "openai" | "openrouter") => Promise<void>;
  onResetBrowserProfile: () => Promise<void>;
  onExportHistory: () => void;
  onUpsertMcpServer: (config: McpServerConfig, isNew: boolean) => Promise<void>;
  onDeleteMcpServer: (serverId: string) => Promise<void>;
  onRefreshMcpServer: (serverId: string) => Promise<void>;
}

const PAGE_META: Record<SettingsSection, { title: string; description: string }> = {
  account: { title: "账号", description: "管理轻流账号连接和工作区设置" },
  model: { title: "模型", description: "配置 AI 模型提供方和 API 密钥" },
  mcp: { title: "MCP", description: "管理 MCP 服务器连接" },
};

export function SettingsPage({
  settings,
  qingflowStatus,
  mcpServers,
  disabled,
  section,
  onSave,
  onStartQingflowAuth,
  onSelectQingflowWorkspace,
  onSyncQingflowMcp,
  onLogoutQingflow,
  onDeleteKey,
  onResetBrowserProfile,
  onExportHistory,
  onUpsertMcpServer,
  onDeleteMcpServer,
  onRefreshMcpServer,
}: SettingsPageProps) {
  const [provider, setProvider] = useState<"openai" | "openrouter">(settings?.model_provider ?? "openai");
  const [openAiBaseUrl, setOpenAiBaseUrl] = useState(settings?.openai_base_url ?? "https://api.openai.com/v1");
  const [openAiModel, setOpenAiModel] = useState(settings?.openai_model ?? "gpt-4.1");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [openRouterBaseUrl, setOpenRouterBaseUrl] = useState(settings?.openrouter_base_url ?? "https://openrouter.ai/api/v1");
  const [openRouterModel, setOpenRouterModel] = useState(settings?.openrouter_model ?? "openai/gpt-4.1");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [qingflowWorkspaceValue, setQingflowWorkspaceValue] = useState(
    qingflowStatus?.selected_ws_id ? String(qingflowStatus.selected_ws_id) : "",
  );

  useEffect(() => {
    setProvider(settings?.model_provider ?? "openai");
    setOpenAiBaseUrl(settings?.openai_base_url ?? "https://api.openai.com/v1");
    setOpenAiModel(settings?.openai_model ?? "gpt-4.1");
    setOpenRouterBaseUrl(settings?.openrouter_base_url ?? "https://openrouter.ai/api/v1");
    setOpenRouterModel(settings?.openrouter_model ?? "openai/gpt-4.1");
  }, [
    settings?.model_provider,
    settings?.openai_base_url,
    settings?.openai_model,
    settings?.openrouter_base_url,
    settings?.openrouter_model,
  ]);

  useEffect(() => {
    setQingflowWorkspaceValue(qingflowStatus?.selected_ws_id ? String(qingflowStatus.selected_ws_id) : "");
  }, [qingflowStatus?.selected_ws_id]);

  const activeBaseUrl = provider === "openrouter" ? openRouterBaseUrl : openAiBaseUrl;
  const activeModel = provider === "openrouter" ? openRouterModel : openAiModel;
  const activeApiKey = provider === "openrouter" ? openRouterApiKey : openAiApiKey;
  const activeApiKeySet = provider === "openrouter" ? settings?.openrouter_api_key_set : settings?.openai_api_key_set;
  const providerLabel = provider === "openrouter" ? "OpenRouter" : "OpenAI / OpenAI 兼容";
  const apiKeyPlaceholder = provider === "openrouter" ? "sk-or-..." : "sk-...";
  const qingflowSyncDegraded =
    qingflowStatus?.mcp_sync.builder_status === "error" ||
    qingflowStatus?.mcp_sync.user_status === "error" ||
    Boolean(qingflowStatus?.mcp_sync.last_error);

  async function handleSaveProviderSettings() {
    await onSave(
      provider === "openrouter"
        ? {
            model_provider: "openrouter",
            openrouter_base_url: openRouterBaseUrl,
            openrouter_model: openRouterModel,
            openrouter_api_key: openRouterApiKey || undefined,
          }
        : {
            model_provider: "openai",
            openai_base_url: openAiBaseUrl,
            openai_model: openAiModel,
            openai_api_key: openAiApiKey || undefined,
          },
    );
    setOpenAiApiKey("");
    setOpenRouterApiKey("");
  }

  async function handleStartQingflowAuth() {
    await onStartQingflowAuth({
      webOrigin: settings?.qingflow_web_origin ?? "https://qingflow.com",
      apiBaseUrl: settings?.qingflow_api_base_url ?? "https://qingflow.com/api",
    });
  }

  const qingflowDisplayName = qingflowStatus?.user_name ?? qingflowStatus?.user_email ?? "未获取";
  const qingflowAvatarUrl = qingflowStatus?.user_avatar_url ?? settings?.qingflow_user_avatar_url ?? null;
  const qingflowInitial = (qingflowStatus?.user_name ?? qingflowStatus?.user_email ?? "Q").trim().charAt(0).toUpperCase();
  const meta = PAGE_META[section];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-xl mx-auto px-8 py-8 space-y-8">

        {/* Page header */}
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{meta.title}</h1>
          <p className="text-sm text-muted-foreground">{meta.description}</p>
        </div>
        <Separator />

        {/* ── Account ─────────────────────────────────────────── */}
        {section === "account" && (
          <div className="space-y-8">
            {/* Profile card */}
            {(qingflowStatus?.user_name || qingflowStatus?.user_email) && (
              <div className="flex items-center gap-4">
                <Avatar className="h-14 w-14">
                  {qingflowAvatarUrl && <AvatarImage src={qingflowAvatarUrl} alt={qingflowDisplayName} />}
                  <AvatarFallback className="text-lg">{qingflowInitial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-base font-medium truncate text-foreground">{qingflowDisplayName}</p>
                  <p className="text-sm text-muted-foreground truncate">{qingflowStatus?.user_email ?? "未获取"}</p>
                  <div className="flex items-center gap-2 pt-0.5">
                    {qingflowStatus?.token_set && (
                      <Badge variant="secondary" className="gap-1 bg-accent/10 text-accent-foreground text-xs">
                        <CheckCircle2 size={10} /> 已连接
                      </Badge>
                    )}
                    {qingflowStatus?.selected_ws_name && (
                      <span className="text-xs text-muted-foreground">{qingflowStatus.selected_ws_name}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Workspace */}
            {qingflowStatus?.workspaces && qingflowStatus.workspaces.length > 0 && (
              <div className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-sm font-medium text-foreground">工作区</h3>
                  <p className="text-xs text-muted-foreground">
                    {qingflowStatus.connected ? "切换到其他工作区" : "选择工作区以继续"}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <Select value={qingflowWorkspaceValue} onValueChange={setQingflowWorkspaceValue} disabled={disabled}>
                    <SelectTrigger>
                      <SelectValue placeholder="请选择工作区" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {qingflowStatus.workspaces.map((workspace) => (
                        <SelectItem key={workspace.ws_id} value={String(workspace.ws_id)}>
                          {workspace.ws_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={disabled || !qingflowWorkspaceValue || String(qingflowStatus?.selected_ws_id ?? "") === qingflowWorkspaceValue}
                    onClick={() => void onSelectQingflowWorkspace(Number(qingflowWorkspaceValue))}
                  >
                    {qingflowStatus.connected ? "切换" : "确认"}
                  </Button>
                </div>
              </div>
            )}

            {/* Warnings */}
            {qingflowStatus?.requires_workspace_creation && (
              <WarningAlert>当前账号还没有可用工作区。请在浏览器里完成创建或加入工作区。</WarningAlert>
            )}
            {qingflowSyncDegraded && (
              <WarningAlert>
                MCP 同步异常 — builder: {qingflowStatus?.mcp_sync.builder_status ?? "disconnected"}，user: {qingflowStatus?.mcp_sync.user_status ?? "disconnected"}
                {qingflowStatus?.mcp_sync.last_error ? `。${qingflowStatus.mcp_sync.last_error}` : ""}
              </WarningAlert>
            )}
            {qingflowStatus?.last_error && !qingflowSyncDegraded && (
              <WarningAlert>{qingflowStatus.last_error}</WarningAlert>
            )}

            <Separator />

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {!qingflowStatus?.connected && (
                <Button size="sm" disabled={disabled} onClick={() => void handleStartQingflowAuth()}>
                  {qingflowStatus?.token_set ? "继续轻流页面" : "登录 / 注册"}
                </Button>
              )}
              {qingflowStatus?.token_set && (
                <>
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => void onSyncQingflowMcp()}>
                    重新同步 MCP
                  </Button>
                  <Button variant="outline" size="sm" disabled={disabled} onClick={() => void onLogoutQingflow()}>
                    退出登录
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Model ───────────────────────────────────────────── */}
        {section === "model" && (
          <div className="space-y-8">
            {/* Provider */}
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label>模型提供方</Label>
                <Select value={provider} onValueChange={(v: "openai" | "openrouter") => setProvider(v)} disabled={disabled}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI / 兼容接口</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {!activeApiKeySet && (
                <WarningAlert>当前未配置 {providerLabel} API 密钥，智能体无法调用模型。</WarningAlert>
              )}

              {provider === "openrouter" && (
                <p className="text-xs text-muted-foreground">OpenRouter 会保留现有 OpenAI 配置；切换只改变当前生效的模型入口。</p>
              )}
            </div>

            {/* Fields */}
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label>接口地址</Label>
                <Input
                  value={activeBaseUrl}
                  onChange={(e) => {
                    if (provider === "openrouter") setOpenRouterBaseUrl(e.target.value);
                    else setOpenAiBaseUrl(e.target.value);
                  }}
                  disabled={disabled}
                />
              </div>

              <div className="grid gap-2">
                <Label>模型名称</Label>
                <Input
                  value={activeModel}
                  onChange={(e) => {
                    if (provider === "openrouter") setOpenRouterModel(e.target.value);
                    else setOpenAiModel(e.target.value);
                  }}
                  disabled={disabled}
                />
              </div>

              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label>API 密钥</Label>
                  {activeApiKeySet && (
                    <Badge variant="secondary" className="gap-1 bg-accent/10 text-accent-foreground text-xs">
                      <CheckCircle2 size={10} /> 已保存
                    </Badge>
                  )}
                </div>
                <Input
                  type="password"
                  value={activeApiKey}
                  onChange={(e) => {
                    if (provider === "openrouter") setOpenRouterApiKey(e.target.value);
                    else setOpenAiApiKey(e.target.value);
                  }}
                  disabled={disabled}
                  placeholder={activeApiKeySet ? "已存储在 macOS Keychain" : apiKeyPlaceholder}
                />
              </div>

              <Button className="w-fit" disabled={disabled} onClick={() => void handleSaveProviderSettings()}>
                保存配置
              </Button>
            </div>

            <Separator />

            {/* Export */}
            <div className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                  <FileDown size={14} className="text-muted-foreground" /> 日志与历史
                </h3>
              </div>
              <Button variant="outline" size="sm" onClick={onExportHistory}>
                导出会话 JSON
              </Button>
            </div>

            <Separator />

            {/* Danger */}
            <div className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-destructive flex items-center gap-2">
                  <ShieldAlert size={14} /> 危险操作
                </h3>
                <p className="text-xs text-muted-foreground">这些操作不可撤销，请谨慎执行。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" size="sm" disabled={disabled || !activeApiKeySet} onClick={() => void onDeleteKey(provider)}>
                  删除 API 密钥
                </Button>
                <Button variant="destructive" size="sm" disabled={disabled} onClick={() => void onResetBrowserProfile()}>
                  重置浏览器配置
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── MCP ─────────────────────────────────────────────── */}
        {section === "mcp" && (
          <McpPanel
            mcpServers={mcpServers}
            disabled={disabled}
            onUpsertMcpServer={onUpsertMcpServer}
            onDeleteMcpServer={onDeleteMcpServer}
            onRefreshMcpServer={onRefreshMcpServer}
          />
        )}

      </div>
    </div>
  );
}

/* ── Shared warning alert ────────────────────────────────────────────────── */
function WarningAlert({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
