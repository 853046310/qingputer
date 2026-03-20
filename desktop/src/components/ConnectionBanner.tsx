import { Loader2, WifiOff, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectionState } from "../lib/connection-monitor";

interface Props {
  state: ConnectionState;
  onDisconnect: () => void;
}

export function ConnectionBanner({ state, onDisconnect }: Props) {
  if (state === "connected") return null;

  if (state === "reconnecting") {
    return (
      <div
        className="flex items-center justify-center gap-2 px-4 py-2 text-[13px] shrink-0"
        style={{ background: "var(--warning-dim)", color: "var(--warning)", borderBottom: "1px solid var(--warning)" }}
      >
        <Loader2 size={14} className="animate-spin" />
        正在重新连接…
      </div>
    );
  }

  if (state === "disconnected") {
    return (
      <div
        className="flex items-center justify-center gap-2 px-4 py-2 text-[13px] shrink-0"
        style={{ background: "var(--danger-dim)", color: "var(--danger)", borderBottom: "1px solid var(--danger)" }}
      >
        <Unplug size={14} />
        连接已断开
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[12px] ml-2"
          style={{ color: "var(--danger)", background: "rgba(255,255,255,0.1)" }}
          onClick={onDisconnect}
        >
          重新配对
        </Button>
      </div>
    );
  }

  // offline
  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-2 text-[13px] shrink-0"
      style={{ background: "var(--bg-overlay)", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}
    >
      <WifiOff size={14} />
      网络已断开
    </div>
  );
}
