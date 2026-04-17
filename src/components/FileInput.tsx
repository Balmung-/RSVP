"use client";

import { useRef, useState, type DragEvent } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";
import { acceptForKind, type UploadKind } from "@/lib/uploads";

// Drag-and-drop-or-paste-URL file input. Writes the final URL into a
// hidden form field so the server action just reads a string — no
// multipart surgery on the consumer side.

export function FileInput({
  name,
  kind = "image",
  label,
  defaultValue,
  hint,
  className,
}: {
  name: string;
  kind?: UploadKind;
  label?: string;
  defaultValue?: string | null;
  hint?: string;
  className?: string;
}) {
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = acceptForKind(kind);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const j = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!res.ok || !j.ok || !j.url) {
        setError(j.error ?? `Upload failed (${res.status}).`);
        return;
      }
      setValue(j.url);
    } catch (e) {
      setError(String(e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  }

  function onPickFile(file: File | null | undefined) {
    if (file) void upload(file);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setHover(false);
    onPickFile(e.dataTransfer.files?.[0]);
  }

  const preview =
    value && kind === "image" && !value.startsWith("http")
      ? value
      : value && value.startsWith("http") && kind === "image"
        ? value
        : null;

  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label ? <span className="text-micro uppercase text-ink-400">{label}</span> : null}
      <input type="hidden" name={name} value={value} />

      <div
        onDragOver={(e) => { e.preventDefault(); setHover(true); }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        className={clsx(
          "rounded-xl border border-dashed transition-colors",
          hover ? "border-ink-900 bg-ink-50" : "border-ink-200 bg-ink-0",
        )}
      >
        <div className="flex items-center gap-4 px-4 py-3">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt=""
              className="h-10 w-10 rounded-md object-cover bg-ink-100 border border-ink-100"
            />
          ) : (
            <span className="h-10 w-10 rounded-md bg-ink-100 text-ink-500 grid place-items-center">
              <Icon name={kind === "image" ? "file" : "file-text"} size={16} />
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="btn btn-soft !py-1 !px-3 text-mini"
              >
                {busy ? (
                  <>
                    <Icon name="spinner" size={12} className="animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Icon name="upload" size={12} />
                    {value ? "Replace" : "Upload file"}
                  </>
                )}
              </button>
              <span className="text-mini text-ink-400">or paste a URL</span>
            </div>
            <input
              type="url"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null); }}
              placeholder="https://…"
              className="field mt-2 !py-1.5 !text-mini"
            />
          </div>
          {value ? (
            <button
              type="button"
              onClick={() => setValue("")}
              className="btn btn-ghost btn-icon"
              aria-label="Clear"
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0])}
        />
      </div>

      {error ? <p role="alert" className="text-mini text-signal-fail">{error}</p> : null}
      {hint && !error ? <p className="text-mini text-ink-400">{hint}</p> : null}
    </div>
  );
}
