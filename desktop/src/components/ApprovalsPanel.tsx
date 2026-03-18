import { useEffect, useState } from "react";
import { CheckCircle2, ShieldAlert, Trash2, XCircle } from "lucide-react";

import type { ApprovalMode, ApprovalRequest, SessionRecord } from "../types";

const RISK_ZH: Record<ApprovalRequest["risk_level"], string> = {
  low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险",
};

const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  default: "默认权限",
  maximum: "最高权限",
  session_once_plus_high_risk: "旧版风险模式",
};

interface ApprovalsPanelProps {
  session: SessionRecord | null;
  approvals: ApprovalRequest[];
  disabled: boolean;
  onApprove: (approvalId: string) => Promise<void>;
  onDeny: (approvalId: string) => Promise<void>;
  onUpdateSession: (payload: { title?: string; approval_mode?: ApprovalMode }) => Promise<void>;
  onDeleteSession: () => Promise<void>;
}

function riskStyle(level: ApprovalRequest["risk_level"]) {
  switch (level) {
    case "critical":
      return { border: "var(--critical)", bg: "var(--critical-dim)", badge: { bg: "var(--critical-dim)", color: "var(--critical)" } };
    case "high":
      return { border: "var(--warning)", bg: "var(--warning-dim)", badge: { bg: "var(--warning-dim)", color: "var(--warning)" } };
    default:
      return { border: "var(--accent)", bg: "transparent", badge: { bg: "var(--accent-dim)", color: "var(--accent)" } };
  }
}

export function ApprovalsPanel({
  session,
  approvals,
  disabled,
  onApprove,
  onDeny,
  onUpdateSession,
  onDeleteSession,
}: ApprovalsPanelProps) {
  const pending = approvals.filter((approval) => approval.status === "pending");
  const [titleDraft, setTitleDraft] = useState(session?.title ?? "");

  useEffect(() => {
    setTitleDraft(session?.title ?? "");
  }, [session?.session_id, session?.title]);

  async function handleSaveTitle() {
    const trimmed = titleDraft.trim();
    if (!session || !trimmed || trimmed === session.title) return;
    await onUpdateSession({ title: trimmed });
  }

  async function handleDelete() {
    if (!session) return;
    if (!window.confirm(`删除会话"${session.title}"后，聊天记录、审批和审计都会一并移除。继续吗？`)) return;
    await onDeleteSession();
  }

  return (
    <section className="flex flex-col p-3 gap-4">
      {/* 会话控制 */}
      {session ? (
        <div className="flex flex-col gap-3">
          {/* 名称 */}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg px-3 py-1.5 text-[12px]"
              disabled={disabled}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              style={{ background: "var(--bg-overlay)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
            <button
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium shrink-0"
              disabled={disabled || !titleDraft.trim() || titleDraft.trim() === session.title}
              onClick={() => void handleSaveTitle()}
              style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--border)" }}
            >
              保存
            </button>
          </div>

          {/* 权限模式 */}
          <div
            className="grid grid-cols-2 gap-1 rounded-lg p-1"
            style={{ background: "var(--bg-overlay)", border: "1px solid var(--border)" }}
          >
            {(["default", "maximum"] as const).map((mode) => {
              const active = session.config.approval_mode === mode;
              return (
                <button
                  key={mode}
                  className="rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors"
                  disabled={disabled || active}
                  onClick={() => void onUpdateSession({ approval_mode: mode })}
                  style={{
                    background: active ? "var(--accent-dim)" : "transparent",
                    color: active ? "var(--accent)" : "var(--text-muted)",
                    border: active ? "1px solid var(--border)" : "1px solid transparent",
                  }}
                >
                  {APPROVAL_MODE_LABELS[mode]}
                </button>
              );
            })}
          </div>

          <p className="text-[11px] leading-5" style={{ color: "var(--text-muted)" }}>
            {session.config.approval_mode === "maximum"
              ? "最高权限：终端和文件直接执行，浏览器操作同样直接执行。"
              : "默认权限：终端和文件需要你批准，浏览器操作会直接执行。"}
          </p>

          {/* 删除 */}
          <button
            className="self-start inline-flex items-center gap-1 text-[11px]"
            disabled={disabled}
            onClick={() => void handleDelete()}
            style={{ color: "var(--text-muted)" }}
          >
            <Trash2 size={11} />
            删除会话
          </button>
        </div>
      ) : (
        <p className="text-[12px] py-2" style={{ color: "var(--text-muted)" }}>
          未选择会话
        </p>
      )}

      {/* 分隔 */}
      <div style={{ borderTop: "1px solid var(--border)" }} />

      {/* 待审批列表 */}
      {pending.length === 0 ? (
        <p className="text-[12px] py-2" style={{ color: "var(--text-muted)" }}>
          无待审批操作
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {pending.map((approval) => {
            const style = riskStyle(approval.risk_level);
            return (
              <article
                key={approval.approval_id}
                className="rounded-xl p-3 flex flex-col gap-2"
                style={{ background: style.bg, border: "1px solid var(--border)", borderLeft: `3px solid ${style.border}` }}
              >
                <div className="flex items-center gap-2">
                  <ShieldAlert size={13} color={style.border} />
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-wide font-semibold"
                    style={style.badge}
                  >
                    {RISK_ZH[approval.risk_level]}
                  </span>
                </div>

                <p className="text-[12px] font-mono" style={{ color: "var(--text-primary)" }}>
                  {approval.preview}
                </p>

                <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  {approval.reason}
                </p>

                <div className="flex gap-2">
                  <button
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[12px] font-medium"
                    disabled={disabled}
                    onClick={() => void onApprove(approval.approval_id)}
                    style={{ background: "var(--accent)", color: "var(--bg-base)" }}
                  >
                    <CheckCircle2 size={13} />
                    批准
                  </button>
                  <button
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[12px] font-medium"
                    disabled={disabled}
                    onClick={() => void onDeny(approval.approval_id)}
                    style={{ background: "var(--bg-overlay)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                  >
                    <XCircle size={13} />
                    拒绝
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
