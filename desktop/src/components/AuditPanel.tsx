import { useMemo, useState } from "react";
import { AlertCircle, FolderOpen, Globe, Lock, ShieldCheck, Terminal } from "lucide-react";

import type { EventEnvelope } from "../types";

type AuditFilter = "all" | "terminal" | "filesystem" | "browser" | "policy";

function classify(kind: EventEnvelope["kind"]): AuditFilter {
  if (kind.startsWith("command")) {
    return "terminal";
  }
  if (kind.startsWith("file")) {
    return "filesystem";
  }
  if (kind.startsWith("browser")) {
    return "browser";
  }
  if (kind === "policy" || kind.startsWith("approval")) {
    return "policy";
  }
  return "all";
}

function EventIcon({ kind }: { kind: EventEnvelope["kind"] }) {
  const category = classify(kind);
  const size = 12;
  switch (category) {
    case "terminal":
      return <Terminal size={size} />;
    case "filesystem":
      return <FolderOpen size={size} />;
    case "browser":
      return <Globe size={size} />;
    case "policy":
      return kind === "error" ? <AlertCircle size={size} /> : <ShieldCheck size={size} />;
    default:
      return kind === "error" ? <AlertCircle size={size} /> : <Lock size={size} />;
  }
}

const FILTERS: { value: AuditFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "terminal", label: "终端" },
  { value: "filesystem", label: "文件" },
  { value: "browser", label: "浏览器" },
  { value: "policy", label: "策略" },
];

interface AuditPanelProps {
  events: EventEnvelope[];
}

export function AuditPanel({ events }: AuditPanelProps) {
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(
    () => events.filter((event) => filter === "all" || classify(event.kind) === filter),
    [events, filter],
  );

  return (
    <section className="flex flex-col p-3 gap-3">
      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors"
            onClick={() => setFilter(value)}
            style={{
              background: filter === value ? "var(--accent-dim)" : "var(--bg-overlay)",
              color: filter === value ? "var(--accent)" : "var(--text-muted)",
              border: filter === value ? "1px solid var(--accent)" : "1px solid var(--border)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div
          className="rounded-xl px-4 py-5 text-center text-[12px]"
          style={{ border: "1px dashed var(--border)", color: "var(--text-muted)" }}
        >
          暂无审计事件
        </div>
      ) : (
        <div className="flex flex-col relative">
          {/* Vertical line */}
          <div
            className="absolute left-[15px] top-2 bottom-2 w-px"
            style={{ background: "var(--border)" }}
          />
          {filtered
            .slice()
            .reverse()
            .map((event) => (
              <div key={event.event_id} className="flex gap-3 relative pl-8 pb-3">
                {/* Dot */}
                <div
                  className="absolute left-[10px] top-1.5 w-[11px] h-[11px] rounded-full flex items-center justify-center shrink-0"
                  style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", color: "var(--text-muted)" }}
                >
                  <EventIcon kind={event.kind} />
                </div>

                {/* Card */}
                <div
                  className="flex-1 rounded-lg overflow-hidden"
                  style={{ border: "1px solid var(--border)", background: "var(--bg-surface)" }}
                >
                  <button
                    className="w-full flex items-center justify-between px-3 py-2 text-left"
                    onClick={() => setExpandedId(expandedId === event.event_id ? null : event.event_id)}
                  >
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      {event.kind}
                    </span>
                    <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {new Date(event.created_at).toLocaleTimeString()}
                    </span>
                  </button>
                  {expandedId === event.event_id && (
                    <div className="px-3 pb-2" style={{ background: "var(--term-bg)" }}>
                      <pre className="text-[10px]" style={{ color: "var(--term-text)" }}>
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
