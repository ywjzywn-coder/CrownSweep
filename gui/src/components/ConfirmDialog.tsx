import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal modal confirm dialog. */
export default function ConfirmDialog({
  open,
  title,
  children,
  confirmText = "确认",
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    card.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancelRef.current(); }
      if (event.key !== "Tab") return;
      const buttons = card.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div ref={card} role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h4 id={titleId}>{title}</h4>
        <div className="modal-body">{children}</div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
