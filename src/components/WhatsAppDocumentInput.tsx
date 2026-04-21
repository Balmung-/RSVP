"use client";

import { useRef, useState, type DragEvent } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";

// P17-D.3 — WhatsApp document picker (PDF-only).
//
// Sibling to `FileInput` but diverges on two critical points, and
// it's those divergences that justify a separate component rather
// than adding a new mode to `FileInput`:
//
//  1. Writes the FileUpload **id** (not the URL) into the hidden
//     form field. `whatsappDocumentUploadId` is a FK on `Campaign`;
//     the runtime resolves the bytes via
//     `prisma.fileUpload.findUnique({ where: { id } })` inside
//     `performWhatsAppSend` (see `src/lib/delivery.ts`). Storing
//     the URL would force a second parse step on every send and
//     break the `onDelete: SetNull` cascade P17-C.1 set up on the
//     FK.
//
//  2. No URL-paste fallback. Meta's WhatsApp Cloud API requires an
//     uploaded media handle it can fetch from our origin; an
//     arbitrary external URL wouldn't give us the media-id handshake
//     the send path needs. Keeping the input upload-only prevents
//     the operator from pasting a Dropbox link and then hitting
//     an obscure `doc_upload_deps_missing` / `doc_link_not_internal`
//     blocker at send time.
//
// PDF-only `accept` filter because the Meta-approved template the
// pilot uses has a document header bound to a PDF. Non-PDF uploads
// are not a crash hazard (the send-path's `doc_empty` /
// `doc_link_not_internal` / Meta upload-error modes already catch
// them), but filtering at the picker level keeps the operator from
// uploading a docx by habit and discovering the mismatch at send.
//
// On edit, the form re-mounts with `defaultValue` set to the saved
// FK and `defaultFilename` set to the FileUpload's stored filename
// (resolved on the edit page's server side — see
// `src/app/campaigns/[id]/edit/page.tsx`). This lets the operator
// see *which* PDF is currently attached rather than just a cuid.

export function WhatsAppDocumentInput({
  name,
  label = "Invitation PDF",
  defaultValue,
  defaultFilename,
  hint,
  className,
}: {
  name: string;
  label?: string;
  /** Initial FileUpload id to rehydrate on edit. */
  defaultValue?: string | null;
  /** Filename to display for `defaultValue` (resolved server-side). */
  defaultFilename?: string | null;
  hint?: string;
  className?: string;
}) {
  const [id, setId] = useState<string>(defaultValue ?? "");
  const [filename, setFilename] = useState<string>(defaultFilename ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "doc");
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const j = (await res.json()) as {
        ok: boolean;
        id?: string;
        filename?: string;
        error?: string;
      };
      if (!res.ok || !j.ok || !j.id) {
        setError(j.error ?? `Upload failed (${res.status}).`);
        return;
      }
      setId(j.id);
      setFilename(j.filename ?? file.name);
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

  function clear() {
    // Nulling both id + filename is what submits `null` for the FK
    // on save (the server-action parser reads "" → null via the
    // `clipNullIfEmpty` helper; the dangling-id FK existence check
    // then confirms no write happens on an empty value).
    setId("");
    setFilename("");
    setError(null);
  }

  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label ? <span className="text-micro uppercase text-ink-400">{label}</span> : null}
      <input type="hidden" name={name} value={id} />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        className={clsx(
          "rounded-xl border border-dashed transition-colors",
          hover ? "border-ink-900 bg-ink-50" : "border-ink-200 bg-ink-0",
        )}
      >
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="h-10 w-10 rounded-md bg-ink-100 text-ink-500 grid place-items-center">
            <Icon name="file-text" size={16} />
          </span>
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
                    {id ? "Replace PDF" : "Upload PDF"}
                  </>
                )}
              </button>
            </div>
            {id ? (
              <p className="text-mini text-ink-500 mt-1 truncate">
                {filename || id}
              </p>
            ) : (
              <p className="text-mini text-ink-400 mt-1">
                Drag a PDF in, or click Upload.
              </p>
            )}
          </div>
          {id ? (
            <button
              type="button"
              onClick={clear}
              className="btn btn-ghost btn-icon"
              aria-label="Remove PDF"
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0])}
        />
      </div>

      {error ? <p role="alert" className="text-mini text-signal-fail">{error}</p> : null}
      {hint && !error ? <p className="text-mini text-ink-400">{hint}</p> : null}
    </div>
  );
}
