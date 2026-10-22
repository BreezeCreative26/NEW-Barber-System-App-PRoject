// Photo editor for portraits: take a photo with the camera (never mirrored in the saved picture,
// even though the live preview acts like a mirror), or pick one, then drag and zoom to crop it
// square. Flip and rotate fix photos that arrive the wrong way round.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Icon } from "./ui";

const STAGE = 288; // px, the square the person crops in
const OUT = 800; // px, saved size

type Pose = { zoom: number; x: number; y: number; flip: boolean; turns: number };
const FRESH: Pose = { zoom: 1, x: 0, y: 0, flip: false, turns: 0 };

function drawPose(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, size: number, p: Pose) {
  const quarter = p.turns % 2 === 1;
  const iw = quarter ? img.height : img.width;
  const ih = quarter ? img.width : img.height;
  const base = size / Math.min(iw, ih);
  const scale = base * p.zoom;
  // Largest the picture can be moved while still covering the square.
  const maxX = Math.max(0, (iw * scale - size) / 2);
  const maxY = Math.max(0, (ih * scale - size) / 2);
  const dx = Math.max(-maxX, Math.min(maxX, p.x * size));
  const dy = Math.max(-maxY, Math.min(maxY, p.y * size));
  ctx.save();
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, size, size);
  ctx.translate(size / 2 + dx, size / 2 + dy);
  ctx.rotate((p.turns * Math.PI) / 2);
  ctx.scale(p.flip ? -scale : scale, scale);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
}

export function PhotoEditor({ file, onCancel, onDone }: { file: File | null; onCancel: () => void; onDone: (f: File) => void }) {
  const [source, setSource] = useState<File | null>(file);
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [pose, setPose] = useState<Pose>(FRESH);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Decode the chosen file upright (honouring phone rotation flags).
  useEffect(() => {
    if (!source) return;
    let live = true;
    createImageBitmap(source, { imageOrientation: "from-image" })
      .then((b) => { if (live) { setImg(b); setPose(FRESH); } })
      .catch(() => setError("That picture could not be opened. Try a JPEG or PNG."));
    return () => { live = false; };
  }, [source]);

  const paint = useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== STAGE * dpr) { c.width = STAGE * dpr; c.height = STAGE * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPose(ctx, img, STAGE, pose);
  }, [img, pose]);
  useEffect(paint, [paint]);

  async function save() {
    if (!img) return;
    const out = document.createElement("canvas");
    out.width = out.height = OUT;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    drawPose(ctx, img, OUT, pose);
    const blob: Blob | null = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.9));
    if (!blob) { setError("Could not save that crop."); return; }
    onDone(new File([blob], "portrait.jpg", { type: "image/jpeg" }));
  }

  if (!source) return <CameraStep onCancel={onCancel} onShot={setSource} />;
  return (
    <div className="photo-editor-scrim" role="dialog" aria-modal="true" aria-label="Crop photo" data-testid="photo-editor">
      <div className="photo-editor">
        <h2>Crop photo</h2>
        <p className="workspace-footnote">Drag to move, use the slider to zoom. The circle is how it shows on your page.</p>
        <div
          className="photo-stage"
          style={{ width: STAGE, height: STAGE }}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pose.x, py: pose.y }; }}
          onPointerMove={(e) => { const d = drag.current; if (d) setPose((p) => ({ ...p, x: d.px + (e.clientX - d.x) / STAGE, y: d.py + (e.clientY - d.y) / STAGE })); }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <canvas ref={canvas} style={{ width: STAGE, height: STAGE }} aria-label="Photo preview" />
          <span className="photo-stage-ring" aria-hidden="true" />
        </div>
        <label className="photo-zoom">
          <span>Zoom</span>
          <input type="range" min={1} max={4} step={0.02} value={pose.zoom} onChange={(e) => setPose({ ...pose, zoom: Number(e.target.value) })} aria-label="Zoom" data-testid="photo-zoom" />
        </label>
        <div className="photo-editor-tools">
          <Button variant="secondary" onClick={() => setPose({ ...pose, flip: !pose.flip })} data-testid="photo-flip">Flip</Button>
          <Button variant="secondary" onClick={() => setPose({ ...pose, turns: (pose.turns + 1) % 4 })} data-testid="photo-rotate">Rotate</Button>
          <Button variant="ghost" onClick={() => setPose(FRESH)}>Reset</Button>
        </div>
        {error && <p className="workspace-error" role="alert">{error}</p>}
        <div className="photo-editor-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} disabled={!img} data-testid="photo-use">Use photo</Button>
        </div>
      </div>
    </div>
  );
}

// Live camera. The preview is mirrored (it feels like a mirror); the captured picture is not.
function CameraStep({ onCancel, onShot }: { onCancel: () => void; onShot: (f: File) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false;
    setReady(false);
    stream.current?.getTracks().forEach((t) => t.stop());
    if (!navigator.mediaDevices?.getUserMedia) { setError("This browser cannot open the camera. Choose a photo instead."); return; }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; video.current.play().then(() => setReady(true)).catch(() => setReady(true)); }
      })
      .catch(() => setError("The camera is blocked. Allow camera access in your browser, or choose a photo instead."));
    return () => { dead = true; stream.current?.getTracks().forEach((t) => t.stop()); };
  }, [facing]);
  function shoot() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    // Drawn straight from the camera: not mirrored, so writing and left/right are true to life.
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) { stream.current?.getTracks().forEach((t) => t.stop()); onShot(new File([b], "camera.jpg", { type: "image/jpeg" })); } }, "image/jpeg", 0.92);
  }
  return (
    <div className="photo-editor-scrim" role="dialog" aria-modal="true" aria-label="Take a photo" data-testid="photo-camera">
      <div className="photo-editor">
        <h2>Take a photo</h2>
        {error ? (
          <p className="workspace-error" role="alert">{error}</p>
        ) : (
          <div className="photo-stage camera" style={{ width: STAGE, height: STAGE }}>
            <video ref={video} playsInline muted style={facing === "user" ? { transform: "scaleX(-1)" } : undefined} />
            {!ready && <span className="photo-stage-wait">Starting camera…</span>}
          </div>
        )}
        <div className="photo-editor-tools">
          {!error && <Button variant="secondary" onClick={() => setFacing(facing === "user" ? "environment" : "user")}><Icon name="refresh" size={14} /> Switch camera</Button>}
        </div>
        <div className="photo-editor-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {!error && <Button onClick={shoot} disabled={!ready} data-testid="photo-shoot">Take photo</Button>}
        </div>
      </div>
    </div>
  );
}
