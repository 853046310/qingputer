import { useState } from "react";
import { AlertCircle, ArrowLeft, Keyboard, QrCode, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QrScanner } from "./QrScanner";
import { hapticSuccess, hapticError } from "../lib/mobile-bridge";
import type { RemoteConfig } from "../lib/api-remote";
import type { RelayConfig } from "../lib/api-relay";

export type PairingConfig =
  | { mode: "lan"; config: RemoteConfig }
  | { mode: "relay"; config: RelayConfig };

interface Props {
  onConnect: (pairing: PairingConfig) => void;
}

export function PairingScreen({ onConnect }: Props) {
  const [mode, setMode] = useState<"idle" | "scan" | "manual">("idle");
  const [error, setError] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState<"lan" | "relay">("lan");
  // LAN fields
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  // Relay fields
  const [relayUrl, setRelayUrl] = useState("");
  const [roomId, setRoomId] = useState("");
  const [relayToken, setRelayToken] = useState("");

  function handleScanResult(data: string) {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      // Relay mode: has "relay" field
      if (parsed.relay && parsed.room && parsed.token) {
        void hapticSuccess();
        onConnect({
          mode: "relay",
          config: {
            relay: String(parsed.relay),
            room: String(parsed.room),
            token: String(parsed.token),
          },
        });
        return;
      }

      // LAN mode: has "host" field
      if (parsed.host && parsed.port && parsed.token) {
        void hapticSuccess();
        onConnect({
          mode: "lan",
          config: {
            host: String(parsed.host),
            port: Number(parsed.port),
            token: String(parsed.token),
          },
        });
        return;
      }

      void hapticError();
      setError("二维码内容无效");
    } catch {
      void hapticError();
      setError("二维码解析失败");
    }
  }

  function handleManualConnect(e: React.FormEvent) {
    e.preventDefault();
    if (manualMode === "relay") {
      if (!relayUrl.trim() || !roomId.trim() || !relayToken.trim()) {
        setError("请填写完整的 Relay 连接信息");
        return;
      }
      onConnect({
        mode: "relay",
        config: { relay: relayUrl.trim(), room: roomId.trim(), token: relayToken.trim() },
      });
    } else {
      const p = parseInt(port, 10);
      if (!host.trim() || isNaN(p) || !token.trim()) {
        setError("请填写完整的连接信息");
        return;
      }
      onConnect({
        mode: "lan",
        config: { host: host.trim(), port: p, token: token.trim() },
      });
    }
  }

  return (
    <div className="h-full flex items-center justify-center px-6" style={{ background: "var(--bg-base)" }}>
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[380px]">

        {/* Header */}
        <div className="flex flex-col items-center space-y-3 text-center">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-[28px] font-bold text-white shadow-lg">
            Q
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Qingputer
            </h1>
            <p className="text-sm text-muted-foreground">
              扫描桌面端二维码或手动输入连接
            </p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Idle mode: two options */}
        {mode === "idle" && (
          <div className="grid gap-3">
            <Button
              size="lg"
              className="w-full gap-2"
              onClick={() => { setError(null); setMode("scan"); }}
            >
              <QrCode size={18} />
              扫码连接
            </Button>

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

            <Button
              variant="outline"
              size="lg"
              className="w-full gap-2"
              onClick={() => { setError(null); setMode("manual"); }}
            >
              <Keyboard size={18} />
              手动输入
            </Button>
          </div>
        )}

        {/* Scan mode */}
        {mode === "scan" && (
          <div className="flex flex-col items-center gap-4">
            <QrScanner
              onScan={handleScanResult}
              onError={(e) => setError(e)}
            />
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setMode("idle")}
            >
              <ArrowLeft size={14} />
              返回
            </Button>
          </div>
        )}

        {/* Manual mode */}
        {mode === "manual" && (
          <div className="space-y-4">
            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                  manualMode === "lan"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setManualMode("lan")}
              >
                <Wifi size={14} />
                局域网
              </button>
              <button
                type="button"
                className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                  manualMode === "relay"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setManualMode("relay")}
              >
                <Wifi size={14} />
                Relay 中继
              </button>
            </div>

            <form onSubmit={handleManualConnect} className="grid gap-3">
              {manualMode === "lan" ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="host">IP 地址</Label>
                    <Input
                      id="host"
                      placeholder="192.168.1.100"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="port">端口</Label>
                    <Input
                      id="port"
                      placeholder="9800"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      inputMode="numeric"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="token">Token</Label>
                    <Input
                      id="token"
                      placeholder="连接令牌"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="relayUrl">Relay 地址</Label>
                    <Input
                      id="relayUrl"
                      placeholder="wss://relay.qingputer.com"
                      value={relayUrl}
                      onChange={(e) => setRelayUrl(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="roomId">房间 ID</Label>
                    <Input
                      id="roomId"
                      placeholder="房间标识符"
                      value={roomId}
                      onChange={(e) => setRoomId(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="relayToken">Token</Label>
                    <Input
                      id="relayToken"
                      placeholder="连接令牌"
                      value={relayToken}
                      onChange={(e) => setRelayToken(e.target.value)}
                    />
                  </div>
                </>
              )}

              <Button type="submit" className="w-full mt-1">
                连接
              </Button>
            </form>

            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setMode("idle")}
              >
                <ArrowLeft size={14} />
                返回
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
