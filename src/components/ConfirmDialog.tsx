"use client";

import { useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Modal } from "./Modal";

// A submit button that requires confirmation via a proper modal dialog
// (not window.confirm). Drop it inside any <form> with a server action.

export function ConfirmSubmit({
  children,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  className,
  disabled,
}: {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          formRef.current = e.currentTarget.closest("form");
          setOpen(true);
        }}
        className={clsx(tone === "danger" ? "btn btn-danger" : "btn btn-soft", className)}
      >
        {children}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={clsx(
                "btn btn-primary",
                tone === "danger" && "!bg-signal-fail !text-ink-0 hover:!brightness-110",
              )}
              onClick={() => {
                setOpen(false);
                queueMicrotask(() => formRef.current?.requestSubmit());
              }}
            >
              {confirmLabel}
            </button>
          </>
        }
      />
    </>
  );
}
