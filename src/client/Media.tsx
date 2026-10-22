// Photo upload control for the Shop page and barber editors. Posts multipart to
// /api/app/media and hands back the /media/<id> path to store in the existing URL field.
import { useRef, useState } from "react";
import { Button, Icon } from "./ui";
import { PhotoEditor } from "./PhotoEditor";

export type UploadKind = "cover" | "gallery" | "staff" | "logo";
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

// Phone camera shots are big and often carry a rotation flag that other pages ignore. Redraw them
// upright, at a sensible size, as a JPEG; staff portraits are cropped square around the top-centre
// so faces stay in frame. If the browser cannot decode the file the original goes up unchanged.
export async function prepareImage(file: File, kind: UploadKind): Promise<File> {
  if (kind === "logo" || typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const square = kind === "staff";
    const max = square ? 800 : 1800;
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (square) {
      const side = Math.min(bmp.width, bmp.height);
      sx = Math.round((bmp.width - side) / 2);
      sy = bmp.height > bmp.width ? Math.round((bmp.height - side) * 0.25) : 0;
      sw = sh = side;
    }
    const scale = Math.min(1, max / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return file; }
}

export async function uploadPhoto(original: File, kind: UploadKind, alt = ""): Promise<{ id: string; url: string }> {
  const file = await prepareImage(original, kind);
  if (file.size > MEDIA_MAX_BYTES) throw new Error("Photos must be 5 MB or smaller.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Only JPEG, PNG or WebP photos are accepted.");
  const fd = new FormData();
  fd.append("file", file);
  fd.append("kind", kind);
  if (alt) fd.append("alt", alt);
  const res = await fetch("/api/app/media", { method: "POST", credentials: "same-origin", body: fd });
  const body = (await res.json().catch(() => ({}))) as { media?: { id: string; url: string }; message?: string };
  if (!res.ok || !body.media) throw new Error(body.message || "Upload failed.");
  return body.media;
}

export function PhotoUpload({ kind, onUploaded, label = "Upload photo", multiple = false, testId }: { kind: UploadKind; onUploaded: (urls: string[]) => void; label?: string; multiple?: boolean; testId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Portraits go through the crop editor first; "Take photo" opens the camera.
  const [editing, setEditing] = useState<{ file: File | null } | null>(null);
  const edit = kind === "staff" && !multiple;
  async function send(files: File[]) {
    setBusy(true);
    setError("");
    try {
      const urls: string[] = [];
      for (const f of files) urls.push((await uploadPhoto(f, kind)).url);
      onUploaded(urls);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="photo-upload">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple={multiple}
        hidden
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          if (!files.length) return;
          if (edit) { setEditing({ file: files[0] }); return; }
          await send(files);
        }}
      />
      <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()} data-testid={testId}>
        <Icon name="imagePlus" size={15} /> {busy ? "Uploading…" : label}
      </Button>
      {edit && (
        <Button variant="secondary" disabled={busy} onClick={() => setEditing({ file: null })} data-testid={testId ? `${testId}-camera` : undefined}>
          <Icon name="camera" size={15} /> Take photo
        </Button>
      )}
      {editing && <PhotoEditor file={editing.file} onCancel={() => setEditing(null)} onDone={(f) => { setEditing(null); send([f]); }} />}
      {error && (
        <small className="photo-upload-error" role="alert">
          {error}
        </small>
      )}
    </span>
  );
}

// Thumbnail with a clear button, used for the cover and each gallery slot.
export function PhotoPreview({ url, onClear, label }: { url: string; onClear: () => void; label: string }) {
  if (!url) return null;
  return (
    <span className="photo-preview">
      <img src={url} alt="" />
      <button type="button" className="photo-preview-clear" aria-label={`Remove ${label}`} onClick={onClear}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}
