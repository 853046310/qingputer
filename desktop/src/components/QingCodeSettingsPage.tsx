import { useState } from "react";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QCSettings, QCUpdateSettingsPayload } from "../qingcode-types";

interface QingCodeSettingsPageProps {
  settings: QCSettings | null;
  disabled: boolean;
  onSave: (payload: QCUpdateSettingsPayload) => void;
  onBack: () => void;
  onOpenQingputerSettings?: () => void;
}

export function QingCodeSettingsPage({ settings, disabled, onSave, onBack, onOpenQingputerSettings }: QingCodeSettingsPageProps) {
  const [maxIter, setMaxIter] = useState(String(settings?.max_iterations ?? 50));
  const [defaultWorkspace, setDefaultWorkspace] = useState(settings?.default_workspace ?? "");
  const [dirty, setDirty] = useState(false);

  function handleSave() {
    onSave({
      max_iterations: parseInt(maxIter, 10) || 50,
      default_workspace: defaultWorkspace,
    });
    setDirty(false);
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div
        className="shrink-0 flex items-center gap-2 px-4"
        style={{ height: 52, borderBottom: "1px solid var(--border)" }}
      >
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronLeft size={18} />
        </Button>
        <span className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>
          QingCode Settings
        </span>
      </div>

      <div className="flex-1 px-6 py-6 max-w-xl mx-auto w-full flex flex-col gap-6">
        {/* Model Info (read-only, from Qingputer) */}
        <div
          className="flex flex-col gap-3 p-4 rounded-lg"
          style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
              Model Configuration
            </span>
            <span
              className="text-[11px] px-1.5 py-0.5 rounded"
              style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
            >
              From Qingputer
            </span>
          </div>
          <div className="flex flex-col gap-2 text-[13px]" style={{ color: "var(--text-primary)" }}>
            <div className="flex justify-between">
              <span style={{ color: "var(--text-muted)" }}>Provider</span>
              <span>{settings?.provider || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--text-muted)" }}>Base URL</span>
              <span className="text-right max-w-[280px] truncate">{settings?.base_url || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--text-muted)" }}>Model</span>
              <span>{settings?.model || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: "var(--text-muted)" }}>API Key</span>
              <span>{settings?.api_key_set ? "Set" : "Not set"}</span>
            </div>
          </div>
          {onOpenQingputerSettings && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 self-start h-8 text-[12px] gap-1.5"
              onClick={onOpenQingputerSettings}
            >
              <ExternalLink size={12} />
              Go to Qingputer Settings
            </Button>
          )}
        </div>

        {/* Max Iterations */}
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>Max Iterations</label>
          <Input
            type="number"
            value={maxIter}
            onChange={(e) => { setMaxIter(e.target.value); setDirty(true); }}
            disabled={disabled}
            min={1}
            max={200}
            className="h-10 text-[14px] w-32"
          />
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Maximum steps the agent can take per task (default: 50)
          </p>
        </div>

        {/* Default Workspace */}
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>Default Workspace</label>
          <Input
            value={defaultWorkspace}
            onChange={(e) => { setDefaultWorkspace(e.target.value); setDirty(true); }}
            disabled={disabled}
            placeholder="~/projects/my-app"
            className="h-10 text-[14px]"
          />
        </div>

        {/* Save */}
        <Button
          className="h-10 text-[14px]"
          disabled={disabled || !dirty}
          onClick={handleSave}
        >
          Save Settings
        </Button>
      </div>
    </div>
  );
}
