import { useEffect, useRef } from "react";
import type { MenuItem } from "./reportContext";

/** A small right-click menu at screen coordinates. Closes on Escape, on outside click and after an item. */
export function ContextMenu({ items, x, y, onClose }: { items: MenuItem[]; x: number; y: number; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  useEffect(() => {
    (ref.current?.querySelector("[role=menuitem]:not([disabled])") as HTMLElement | null)?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 2000, minWidth: 180, background: "var(--colorNeutralBackground1, #fff)", color: "var(--colorNeutralForeground1, #222)", border: "1px solid #bbb", borderRadius: 4, boxShadow: "0 4px 16px rgba(0,0,0,.25)", padding: 4, fontSize: 13 }}
    >
      {items.map((it, i) =>
        it.separator ? (
          <hr key={i} style={{ margin: "4px 0", border: 0, borderTop: "1px solid #ddd" }} />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 10px", border: 0, background: "transparent", color: "inherit", cursor: it.disabled ? "default" : "pointer", opacity: it.disabled ? 0.5 : 1, font: "inherit" }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
