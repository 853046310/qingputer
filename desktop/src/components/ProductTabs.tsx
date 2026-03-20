export type ProductId = "qingputer" | "qingcode";

interface ProductTabsProps {
  active: ProductId;
  onChange: (id: ProductId) => void;
}

export function ProductTabs({ active, onChange }: ProductTabsProps) {
  return (
    <div
      className="shrink-0 flex items-center justify-center border-b border-border/50"
      data-tauri-drag-region="true"
      style={{ height: 38, background: "var(--bg-surface)" }}
    >
      <div
        className="flex rounded-lg p-0.5"
        style={{ background: "var(--bg-raised)" }}
      >
        {(["qingputer", "qingcode"] as const).map((id) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`px-4 py-1 rounded-md text-[13px] font-medium transition-all ${active === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {id === "qingputer" ? "Qingputer" : "QingCode"}
          </button>
        ))}
      </div>
    </div>
  );
}
