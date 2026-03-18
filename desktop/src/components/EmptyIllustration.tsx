import { useEffect, useRef } from "react";

function getColors() {
  const dark = document.documentElement.classList.contains("dark");
  return {
    accent:   dark ? "#2ec47a" : "#16a34a",
    line:     dark ? "#253029" : "#e5e7eb",
    textHint: dark ? "#4d6357" : "#9ca3af",
    textSub:  dark ? "#2f3f38" : "#d1d5db",
  };
}

function paint(canvas: HTMLCanvasElement) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = parent.clientWidth;
  const H = parent.clientHeight;
  if (W === 0 || H === 0) return;

  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const { accent, line, textHint, textSub } = getColors();
  const cx = W / 2;
  // 整体构图略高于垂直居中
  const originY = H * 0.42;

  // ── 1. 薄圆环 ────────────────────────────────────────────────────────────────
  const ringR = 30;
  ctx.beginPath();
  ctx.arc(cx, originY, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── 2. 中心绿点 ───────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, originY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();

  // ── 3. 文字占位线（三段，宽度递减） ─────────────────────────────────────────────
  const lineGap  = 13;
  const lineTop  = originY + ringR + 28;
  const widths   = [72, 54, 38];
  ctx.lineCap    = "round";
  ctx.lineWidth  = 1.5;
  ctx.strokeStyle = textSub;

  for (let i = 0; i < widths.length; i++) {
    const y  = lineTop + i * lineGap;
    const hw = widths[i] / 2;
    ctx.beginPath();
    ctx.moveTo(cx - hw, y);
    ctx.lineTo(cx + hw, y);
    ctx.stroke();
  }

  // ── 4. 提示文字 ───────────────────────────────────────────────────────────────
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle    = textHint;

  const hintY = lineTop + widths.length * lineGap + 28;
  ctx.font = `13px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif`;
  ctx.fillText("创建会话，告诉智能体你想完成的任务", cx, hintY);
}

export function EmptyIllustration() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const repaint = () => { if (ref.current) paint(ref.current); };
    repaint();

    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    const ro = new ResizeObserver(repaint);
    ro.observe(canvas.parentElement ?? canvas);

    return () => { mo.disconnect(); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} style={{ display: "block", width: "100%", flex: "1 1 0", minHeight: 0 }} />;
}
