export type FileDownloadViewer = { id: string; role: string } | null;

export type DownloadableUpload = {
  filename: string;
  contentType: string;
  size: number;
  contents: Uint8Array | Buffer;
  uploadedBy: string | null;
};

export interface FileDownloadDeps {
  fetchUpload: (id: string) => Promise<DownloadableUpload | null>;
  getCurrentUser: () => Promise<FileDownloadViewer>;
  isPublicFile: (id: string) => Promise<boolean>;
}

export type FileDownloadResult =
  | {
      status: 200;
      body: Uint8Array;
      headers: Record<string, string>;
    }
  | { status: 404 };

export function canReadPrivateUpload(
  row: { uploadedBy: string | null },
  viewer: FileDownloadViewer,
): boolean {
  if (!viewer) return false;
  if (viewer.role === "admin") return true;
  return row.uploadedBy !== null && row.uploadedBy === viewer.id;
}

export async function handleFileDownload(
  id: string,
  deps: FileDownloadDeps,
): Promise<FileDownloadResult> {
  const row = await deps.fetchUpload(id);
  if (!row) return { status: 404 };

  const isPublic = await deps.isPublicFile(id);
  if (!isPublic) {
    const viewer = await deps.getCurrentUser();
    if (!canReadPrivateUpload(row, viewer)) return { status: 404 };
  }

  return {
    status: 200,
    body: new Uint8Array(row.contents),
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(row.size),
      "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
      "Cache-Control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
    },
  };
}
