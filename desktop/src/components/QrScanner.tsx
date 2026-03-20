import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Camera } from "lucide-react";
import { isMobileApp } from "../lib/api-factory";
import { scanQrCode, hapticSuccess } from "../lib/mobile-bridge";

interface Props {
  onScan: (data: string) => void;
  onError?: (error: string) => void;
}

export function QrScanner({ onScan, onError }: Props) {
  // Mobile: use native barcode scanner
  if (isMobileApp()) {
    return <NativeQrScanner onScan={onScan} onError={onError} />;
  }

  // Desktop / dev: keep html5-qrcode fallback
  return <Html5QrScanner onScan={onScan} onError={onError} />;
}

function NativeQrScanner({ onScan, onError }: Props) {
  const [scanning, setScanning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const doScan = async () => {
    setScanning(true);
    setErrorMsg(null);
    try {
      const result = await scanQrCode();
      if (result) {
        void hapticSuccess();
        onScan(result);
      } else {
        setErrorMsg("未扫描到二维码，请重试");
      }
    } catch (e) {
      const msg = String(e);
      setErrorMsg(msg);
      onError?.(msg);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void doScan();
  }, []);

  return (
    <div
      className="flex flex-col items-center justify-center gap-3"
      style={{ width: "100%", maxWidth: 400, aspectRatio: "1", borderRadius: 12, background: "var(--bg-overlay)" }}
    >
      <Camera size={48} style={{ color: "var(--text-muted)" }} />
      {errorMsg ? (
        <>
          <span className="text-[13px] px-4 text-center" style={{ color: "var(--text-error, #ef4444)" }}>
            {errorMsg}
          </span>
          <button
            onClick={() => void doScan()}
            className="px-4 py-2 rounded-lg text-[14px]"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            重新扫描
          </button>
        </>
      ) : (
        <span className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
          {scanning ? "正在扫描…" : "请对准二维码"}
        </span>
      )}
    </div>
  );
}

function Html5QrScanner({ onScan, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const id = "qr-scanner-" + Date.now();
    containerRef.current.id = id;

    const scanner = new Html5Qrcode(id);
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        onScan(decodedText);
      },
      () => {},
    ).catch((err) => {
      onError?.(String(err));
    });

    return () => {
      scanner.stop().catch(() => {});
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", maxWidth: 400, aspectRatio: "1", borderRadius: 12, overflow: "hidden" }}
    />
  );
}
