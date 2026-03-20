import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { RuntimeConnection } from "../types";
import type { RelayInfo } from "../lib/relay-client";

interface Props {
  connection: RuntimeConnection | null;
  relayInfo?: RelayInfo | null;
}

export function MobileConnectDialog({ connection, relayInfo }: Props) {
  const [open, setOpen] = useState(false);
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRelay = !!relayInfo;

  useEffect(() => {
    if (!open || isRelay) return;
    let cancelled = false;
    invoke<string>("local_ip_address")
      .then((ip) => { if (!cancelled) setLocalIp(ip); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [open, isRelay]);

  const qrPayload = isRelay
    ? JSON.stringify({ relay: relayInfo!.relay, room: relayInfo!.room, token: relayInfo!.token })
    : connection && localIp
      ? JSON.stringify({ host: localIp, port: connection.port, token: connection.token })
      : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 justify-start gap-3 rounded-xl px-3 text-[14px] font-medium"
          disabled={!connection}
        >
          <Smartphone size={18} style={{ color: "var(--text-secondary)" }} />
          手机连接
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>手机连接</DialogTitle>
          <DialogDescription>
            使用 Qingputer 手机 App 扫描下方二维码配对
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4 py-4">
          {error && (
            <p className="text-[13px]" style={{ color: "var(--danger)" }}>{error}</p>
          )}
          {qrPayload ? (
            <>
              <div className="rounded-xl p-3" style={{ background: "#ffffff" }}>
                <QRCodeSVG value={qrPayload} size={200} level="M" />
              </div>
              <div className="text-center text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {isRelay ? (
                  <>
                    <p>
                      房间：<span className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
                        {relayInfo!.room.slice(0, 8)}…
                      </span>
                    </p>
                    <p className="mt-1" style={{ color: "var(--accent)" }}>
                      支持跨网络连接
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      地址：<span className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
                        {localIp}:{connection!.port}
                      </span>
                    </p>
                    <p className="mt-1" style={{ color: "var(--text-muted)" }}>
                      请确保手机与电脑在同一局域网
                    </p>
                  </>
                )}
              </div>
            </>
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              正在获取连接信息…
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
