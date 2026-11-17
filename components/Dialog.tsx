"use client";

import { useEffect, useRef } from "react";

type Props = {
  /** Esc / fon bosilganda; berilmasa modal yopilmaydi (masalan, test to'xtatilganda) */
  onClose?: () => void;
  /** Fonni bosish ham yopadi */
  closeOnBackdrop?: boolean;
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * Native <dialog> + showModal(): fokus modal ichida qoladi, orqa sahifa inert.
 * Shartli render qilinadi: mount — ochiladi, unmount — yopiladi.
 * Boshlang'ich fokus: `data-autofocus` belgilangan element.
 */
export function Dialog({ onClose, closeOnBackdrop, role, labelledBy, className, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    d.showModal();
    d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose?.();
      }}
      className={`m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border bg-white shadow-2xl backdrop:bg-zinc-950/50 backdrop:backdrop-blur-[2px] ${className ?? ""}`}
    >
      {children}
    </dialog>
  );
}
