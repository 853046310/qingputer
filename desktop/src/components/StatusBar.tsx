import type { SessionRecord } from "../types";

interface StatusBarProps {
  connected: boolean;
  session: SessionRecord | null;
  busy: boolean;
  onCreateSession: () => void;
}

export function StatusBar({ connected, session, busy: _busy, onCreateSession: _onCreateSession }: StatusBarProps) {
  return (
    <footer
      className="flex items-center px-4 gap-3 shrink-0 text-[11px]"
      style={{
        height: "28px",
        background: "var(--bg-surface)",
        borderTop: "1px solid var(--border)",
        color: "var(--text-muted)",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: connected ? "var(--accent)" : "var(--text-muted)" }}
        />
        <span style={{ color: connected ? "var(--accent)" : "var(--text-muted)" }}>
          {connected ? "已连接" : "连接中"}
        </span>
      </div>

      {session && (
        <>
          <span style={{ color: "var(--border)" }}>·</span>
          <span className="truncate font-mono" style={{ color: "var(--text-muted)" }}>
            {session.current_cwd}
          </span>
        </>
      )}
    </footer>
  );
}
