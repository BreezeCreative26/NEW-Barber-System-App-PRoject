// Object storage for uploaded photos. Supabase Storage (S3-like) behind a tiny interface so the
// media routes stay the same. In local dev without Supabase keys we fall back to the filesystem.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream | Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export const putObject = (s: ObjectStore, key: string, bytes: Uint8Array, contentType: string) => s.put(key, bytes, contentType);
export const deleteObject = (s: ObjectStore, key: string) => s.delete(key);

const BUCKET = process.env.SUPABASE_MEDIA_BUCKET || "media";

class SupabaseStore implements ObjectStore {
  constructor(private url: string, private serviceKey: string) {}
  private endpoint(key: string) {
    return `${this.url}/storage/v1/object/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }
  async ensureBucket() {
    const r = await fetch(`${this.url}/storage/v1/bucket/${BUCKET}`, { headers: this.headers() });
    if (r.status === 404 || r.status === 400) {
      await fetch(`${this.url}/storage/v1/bucket`, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] }) });
    }
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const r = await fetch(this.endpoint(key), { method: "POST", headers: this.headers({ "Content-Type": contentType, "x-upsert": "true" }), body: bytes as unknown as BodyInit });
    if (!r.ok) throw new Error(`storage_put_failed ${r.status} ${await r.text()}`);
  }
  async get(key: string) {
    const r = await fetch(this.endpoint(key), { headers: this.headers() });
    if (!r.ok || !r.body) return null;
    return { body: r.body, contentType: r.headers.get("content-type") || "application/octet-stream" };
  }
  async delete(key: string) {
    await fetch(`${this.url}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ prefixes: [key] }) });
  }
}

class FileStore implements ObjectStore {
  constructor(private root: string) {}
  private file(key: string) {
    return path.join(this.root, key.replace(/[^A-Za-z0-9._\/-]/g, "_"));
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, bytes);
    await fs.writeFile(f + ".type", contentType);
  }
  async get(key: string) {
    try {
      const f = this.file(key);
      const [body, contentType] = await Promise.all([fs.readFile(f), fs.readFile(f + ".type", "utf8").catch(() => "application/octet-stream")]);
      return { body: new Uint8Array(body), contentType };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
    await fs.rm(this.file(key) + ".type", { force: true });
  }
}

let store: ObjectStore | null = null;
export function getStore(): ObjectStore {
  if (store) return store;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const s = new SupabaseStore(url, key);
    void s.ensureBucket().catch(() => {});
    store = s;
  } else store = new FileStore(process.env.MEDIA_DIR || path.join(process.cwd(), ".media"));
  return store;
}
