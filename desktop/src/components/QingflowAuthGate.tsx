import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { QingflowAuthStatus, SettingsPayload } from "../types";

interface QingflowAuthGateProps {
  settings: SettingsPayload | null;
  qingflowStatus: QingflowAuthStatus | null;
  error: string | null;
  disabled: boolean;
  onLoginQingflow: (payload: {
    email: string;
    password: string;
    webOrigin: string;
    apiBaseUrl: string;
  }) => Promise<void>;
  onOpenQingflowRegistration: (payload: { webOrigin: string }) => Promise<void>;
  onSelectQingflowWorkspace: (wsId: number) => Promise<void>;
  onSyncQingflowMcp: () => Promise<void>;
  onLogoutQingflow: () => Promise<void>;
}

/* ── Shared left branding panel ──────────────────────────────────────────── */
function BrandingPanel() {
  return (
    <div className="hidden lg:flex flex-col justify-between bg-gradient-to-br from-emerald-500 to-teal-600 p-10 text-white">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center text-lg font-bold">
          Q
        </div>
        <span className="text-lg font-semibold tracking-tight">Qingputer</span>
      </div>
      <div className="space-y-2">
        <p className="text-lg font-medium leading-relaxed">
          "Qingputer 帮我们把流程自动化效率提升了一个量级，真正实现了 AI 驱动的智能工作流。"
        </p>
        <p className="text-sm text-white/70">—— 来自轻流用户</p>
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */
export function QingflowAuthGate({
  settings,
  qingflowStatus,
  error,
  disabled,
  onLoginQingflow,
  onOpenQingflowRegistration,
  onSelectQingflowWorkspace,
}: QingflowAuthGateProps) {
  const [qingflowWebOrigin, setQingflowWebOrigin] = useState(settings?.qingflow_web_origin ?? "https://qingflow.com");
  const [qingflowApiBaseUrl, setQingflowApiBaseUrl] = useState(settings?.qingflow_api_base_url ?? "https://qingflow.com/api");
  const [email, setEmail] = useState(qingflowStatus?.user_email ?? settings?.qingflow_user_email ?? "");
  const [password, setPassword] = useState("");
  const [workspaceValue, setWorkspaceValue] = useState(
    qingflowStatus?.selected_ws_id ? String(qingflowStatus.selected_ws_id) : "",
  );

  useEffect(() => {
    setQingflowWebOrigin(settings?.qingflow_web_origin ?? "https://qingflow.com");
    setQingflowApiBaseUrl(settings?.qingflow_api_base_url ?? "https://qingflow.com/api");
    setEmail((current) => current || settings?.qingflow_user_email || "");
  }, [settings?.qingflow_web_origin, settings?.qingflow_api_base_url]);

  useEffect(() => {
    if (qingflowStatus?.user_email) {
      setEmail(qingflowStatus.user_email);
    }
  }, [qingflowStatus?.user_email]);

  useEffect(() => {
    setWorkspaceValue(qingflowStatus?.selected_ws_id ? String(qingflowStatus.selected_ws_id) : "");
  }, [qingflowStatus?.selected_ws_id]);

  const qingflowSyncDegraded =
    qingflowStatus?.mcp_sync.builder_status === "error" ||
    qingflowStatus?.mcp_sync.user_status === "error" ||
    Boolean(qingflowStatus?.mcp_sync.last_error);

  // Step 2: token already saved → workspace selection page
  const isWorkspaceStep = !!qingflowStatus?.token_set;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    void onLoginQingflow({
      email,
      password,
      webOrigin: qingflowWebOrigin,
      apiBaseUrl: qingflowApiBaseUrl,
    });
  }

  /* ── Step 2: Workspace selection ───────────────────────────────────────── */
  if (isWorkspaceStep) {
    return (
      <div className="h-screen w-full lg:grid lg:grid-cols-2" style={{ background: "var(--bg-base)" }}>
        <BrandingPanel />

        <div className="flex items-center justify-center py-12 px-6">
          <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[380px]">
            {/* Header */}
            <div className="flex flex-col space-y-2 text-center">
              <div className="mx-auto mb-2 h-12 w-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xl font-bold text-white shadow-md lg:hidden">
                Q
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                选择工作区
              </h1>
              <p className="text-sm text-muted-foreground">
                选择一个工作区以继续使用 Qingputer
              </p>
            </div>

            {/* Logged-in user badge */}
            <div className="flex items-center justify-center gap-2">
              <Badge variant="secondary" className="gap-1 bg-accent/10 text-accent-foreground">
                <CheckCircle2 size={12} />
                已登录
              </Badge>
              {(qingflowStatus.user_email ?? qingflowStatus.user_name) && (
                <span className="text-xs text-muted-foreground">
                  {qingflowStatus.user_email ?? qingflowStatus.user_name}
                </span>
              )}
            </div>

            {/* Workspace selector */}
            {qingflowStatus.workspaces && qingflowStatus.workspaces.length > 0 ? (
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label>工作区</Label>
                  <Select value={workspaceValue} onValueChange={setWorkspaceValue} disabled={disabled}>
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
                </div>

                <Button
                  className="w-full"
                  disabled={disabled || !workspaceValue}
                  onClick={() => void onSelectQingflowWorkspace(Number(workspaceValue))}
                >
                  {disabled && <Loader2 size={16} className="animate-spin" />}
                  确认并进入
                </Button>
              </div>
            ) : !qingflowStatus.requires_workspace_creation ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">正在加载工作区列表…</p>
              </div>
            ) : null}

            {/* Warnings */}
            {qingflowStatus.requires_workspace_creation && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>当前账号还没有可用工作区。请在浏览器里完成创建或加入工作区，然后回到这里重新登录。</span>
              </div>
            )}

            {qingflowSyncDegraded && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>
                  账号已连接，但默认 Qingflow MCP 还没完全同步。
                  {qingflowStatus.mcp_sync.last_error ? ` ${qingflowStatus.mcp_sync.last_error}` : ""}
                </span>
              </div>
            )}

            {qingflowStatus.last_error && !qingflowSyncDegraded && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{qingflowStatus.last_error}</span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ── Step 1: Login ─────────────────────────────────────────────────────── */
  return (
    <div className="h-screen w-full lg:grid lg:grid-cols-2" style={{ background: "var(--bg-base)" }}>
      <BrandingPanel />

      <div className="flex items-center justify-center py-12 px-6">
        <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[380px]">
          {/* Header */}
          <div className="flex flex-col space-y-2 text-center">
            <div className="mx-auto mb-2 h-12 w-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xl font-bold text-white shadow-md lg:hidden">
              Q
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              连接轻流账号
            </h1>
            <p className="text-sm text-muted-foreground">
              登录后即可使用会话、MCP 等全部功能
            </p>
          </div>

          {/* Login form */}
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">轻流邮箱</Label>
              <Input
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={disabled}
                placeholder="name@example.com"
                autoComplete="username"
                type="email"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={disabled}
                type="password"
                placeholder="输入轻流密码"
                autoComplete="current-password"
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={disabled || !email.trim() || !password.trim()}
            >
              {disabled && <Loader2 size={16} className="animate-spin" />}
              登录
            </Button>
          </form>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-[var(--bg-base)] px-2 text-muted-foreground">
                或者
              </span>
            </div>
          </div>

          {/* Register button */}
          <Button
            variant="outline"
            className="w-full"
            disabled={disabled}
            onClick={() => void onOpenQingflowRegistration({ webOrigin: qingflowWebOrigin })}
          >
            <ExternalLink size={14} />
            在浏览器中注册
          </Button>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Footer */}
          <p className="px-4 text-center text-xs text-muted-foreground">
            登录即表示你同意 Qingputer 的服务条款和隐私政策。
          </p>
        </div>
      </div>
    </div>
  );
}
