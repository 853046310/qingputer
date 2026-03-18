import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Server, ShieldAlert, FileDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { McpPanel } from "./McpPanel";
import type { McpServerConfig, McpServerRuntimeState, SettingsPayload } from "../types";

interface SettingsPageProps {
  settings: SettingsPayload | null;
  mcpServers: McpServerRuntimeState[];
  disabled: boolean;
  onSave: (payload: { openai_base_url?: string; openai_model?: string; openai_api_key?: string }) => Promise<void>;
  onDeleteKey: () => Promise<void>;
  onResetBrowserProfile: () => Promise<void>;
  onExportHistory: () => void;
  onUpsertMcpServer: (config: McpServerConfig, isNew: boolean) => Promise<void>;
  onDeleteMcpServer: (serverId: string) => Promise<void>;
  onRefreshMcpServer: (serverId: string) => Promise<void>;
}

export function SettingsPage({
  settings,
  mcpServers,
  disabled,
  onSave,
  onDeleteKey,
  onResetBrowserProfile,
  onExportHistory,
  onUpsertMcpServer,
  onDeleteMcpServer,
  onRefreshMcpServer,
}: SettingsPageProps) {
  const [baseUrl, setBaseUrl] = useState(settings?.openai_base_url ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(settings?.openai_model ?? "gpt-4.1");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setBaseUrl(settings?.openai_base_url ?? "https://api.openai.com/v1");
    setModel(settings?.openai_model ?? "gpt-4.1");
  }, [settings?.openai_base_url, settings?.openai_model]);

  return (
    <div className="h-full overflow-y-auto" style={{ background: "var(--bg-surface)" }}>
      <div className="max-w-[560px] mx-auto px-8 py-8 flex flex-col gap-6">

        <h1 className="text-[18px] font-semibold" style={{ color: "var(--text-primary)" }}>
          设置
        </h1>

        {/* ── 模型配置 ── */}
        <section
          className="rounded-xl px-5 py-4 flex flex-col gap-4"
          style={{ background: "var(--bg-base)", border: "1px solid var(--border-muted)" }}
        >
          <div className="flex items-center gap-2">
            <KeyRound size={14} style={{ color: "var(--text-muted)" }} />
            <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
              模型配置
            </p>
          </div>

          {!settings?.openai_api_key_set && (
            <div
              className="rounded-lg px-3 py-2 text-[12px] leading-relaxed"
              style={{ background: "var(--warning-dim)", color: "var(--warning)" }}
            >
              当前未配置 API 密钥，智能体无法调用模型。保存密钥后再发送任务。
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>接口地址</span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={disabled}
              className="h-8 text-[13px]"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>模型名称</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={disabled}
              className="h-8 text-[13px]"
            />
          </label>

          <label className="flex flex-col gap-1">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>API 密钥</span>
              {settings?.openai_api_key_set && (
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0 h-4 gap-1"
                  style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
                >
                  <CheckCircle2 size={10} />
                  已保存
                </Badge>
              )}
            </div>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={disabled}
              placeholder={settings?.openai_api_key_set ? "已存储在 macOS Keychain" : "sk-..."}
              className="h-8 text-[13px]"
            />
          </label>

          <div>
            <Button
              size="sm"
              className="text-[12px]"
              disabled={disabled}
              onClick={async () => {
                await onSave({
                  openai_base_url: baseUrl,
                  openai_model: model,
                  openai_api_key: apiKey || undefined,
                });
                setApiKey("");
              }}
            >
              保存
            </Button>
          </div>
        </section>

        {/* ── MCP 服务器 ── */}
        <section
          className="rounded-xl px-5 py-4 flex flex-col gap-3"
          style={{ background: "var(--bg-base)", border: "1px solid var(--border-muted)" }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Server size={14} style={{ color: "var(--text-muted)" }} />
            <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
              MCP 服务器
            </p>
          </div>
          <McpPanel
            mcpServers={mcpServers}
            disabled={disabled}
            onUpsertMcpServer={onUpsertMcpServer}
            onDeleteMcpServer={onDeleteMcpServer}
            onRefreshMcpServer={onRefreshMcpServer}
          />
        </section>

        {/* ── 日志与历史 ── */}
        <section
          className="rounded-xl px-5 py-4 flex flex-col gap-3"
          style={{ background: "var(--bg-base)", border: "1px solid var(--border-muted)" }}
        >
          <div className="flex items-center gap-2">
            <FileDown size={14} style={{ color: "var(--text-muted)" }} />
            <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
              日志与历史
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-fit text-[12px]"
            onClick={onExportHistory}
          >
            导出会话 JSON
          </Button>
        </section>

        {/* ── 危险操作 ── */}
        <section
          className="rounded-xl px-5 py-4 flex flex-col gap-3"
          style={{ background: "var(--bg-base)", border: "1px solid var(--border-muted)" }}
        >
          <div className="flex items-center gap-2">
            <ShieldAlert size={14} style={{ color: "var(--text-muted)" }} />
            <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
              危险操作
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="text-[12px]"
              disabled={disabled || !settings?.openai_api_key_set}
              onClick={() => void onDeleteKey()}
            >
              删除 API 密钥
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-[12px]"
              disabled={disabled}
              onClick={() => void onResetBrowserProfile()}
            >
              重置浏览器配置
            </Button>
          </div>
        </section>

      </div>
    </div>
  );
}
