// Photo upload control for the Shop page and barber editors. Posts multipart to
// /api/sandbox/media and hands back the /media/<id> path to store in the existing URL field.
import { useRef, useState } from "react";
import { Button, Icon } from "./ui";

export type UploadKind = "cover" | "gallery" | "staff";
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export async function uploadPhoto(file: File, kind: UploadKind, alt = ""): Promise<{ id: string; url: string }> {
  if (file.size > MEDIA_MAX_BYTES) throw new Error("Photos must be 5 MB or smaller.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Only JPEG, PNG or WebP photos are accepted.");
  const fd = new FormData();
  fd.append("file", file);
  fd.append("kind", kind);
  if (alt) fd.append("alt", alt);
  const res = await fetch("/api/sandbox/media", { method: "POST", credentials: "same-origin", body: fd });
  const body = (await res.json().catch(() => ({}))) as { media?: { id: string; url: string }; message?: string };
  if (!res.ok || !body.media) throw new Error(body.message || "Upload failed.");
  return body.media;
}

export function PhotoUpload({ kind, onUploaded, label = "Upload photo", multiple = false, testId }: { kind: UploadKind; onUploaded: (urls: string[]) => void; label?: string; multiple?: boolean; testId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <span className="photo-upload">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple={multiple}
        hidden
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          if (!files.length) return;
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
        }}
      />
      <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()} data-testid={testId}>
        <Icon name="imagePlus" size={15} /> {busy ? "Uploading…" : label}
      </Button>
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
