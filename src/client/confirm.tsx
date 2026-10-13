// In-app confirm / prompt. Replaces the browser's grey window.confirm()/prompt() with a styled,
// accessible dialog that matches the workspace. Self-mounting: call `ask()` from anywhere.
//
//   if (!(await ask({ title: "Move Leo to 16:30?", confirm: "Move" }))) return;
//   const reason = await askText({ title: "Why void this pay run?", confirm: "Void" });
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

type AskOptions = {
  title: string;
  body?: string;
  confirm?: string;
  cancel?: string;
  tone?: "default" | "danger" | "warning";
};
type TextOptions = AskOptions & { label?: string; placeholder?: string; initial?: string; required?: boolean };
type Request =
  | { kind: "confirm"; opts: AskOptions; resolve: (v: boolean) => void }
  | { kind: "text"; opts: TextOptions; resolve: (v: string | null) => void };

let root: Root | null = null;
let push: ((r: Request) => void) | null = null;
const queue: Request[] = [];

function mount() {
  if (root || typeof document === "undefined") return;
  const el = document.createElement("div");
  el.id = "foliyo-confirm-root";
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(<Host />);
}

function enqueue(r: Request) {
  mount();
  if (push) push(r);
  else queue.push(r);
}

export function ask(opts: AskOptions): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: "confirm", opts, resolve }));
}
export function askText(opts: TextOptions): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: "text", opts, resolve }));
}

function Host() {
  const [items, setItems] = useState<Request[]>([]);
  useEffect(() => {
    push = (r) => setItems((xs) => [...xs, r]);
    if (queue.length) setItems((xs) => [...xs, ...queue.splice(0)]);
    return () => {
      push = null;
    };
  }, []);
  const current = items[0];
  if (!current) return null;
  const done = (value: boolean | string | null) => {
    if (current.kind === "confirm") current.resolve(value === true);
    else current.resolve(typeof value === "string" ? value : null);
    setItems((xs) => xs.slice(1));
  };
  return <AskDialog key={items.length + current.opts.title} req={current} onDone={done} />;
}

function AskDialog({ req, onDone }: { req: Request; onDone: (v: boolean | string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(req.kind === "text" ? req.opts.initial || "" : "");
  const { opts } = req;
  const tone = opts.tone || "default";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    window.setTimeout(() => {
      if (req.kind === "text") input.current?.focus();
      else ref.current?.querySelector<HTMLButtonElement>("[data-testid=confirm-accept]")?.focus();
    }, 0);
    return () => previous?.focus?.();
  }, [req.kind]);
  const cancel = () => onDone(req.kind === "text" ? null : false);
  const accept = () => {
    if (req.kind === "text") {
      if ((req.opts.required ?? true) && !text.trim()) {
        input.current?.focus();
        return;
      }
      onDone(text.trim());
    } else onDone(true);
  };
  return (
    <dialog
      ref={ref}
      className={`ask-dialog tone-${tone}`}
      aria-labelledby="ask-title"
      aria-describedby={opts.body ? "ask-body" : undefined}
      data-testid="confirm-dialog"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          accept();
        }}
      >
        <h2 id="ask-title">{opts.title}</h2>
        {opts.body && (
          <p id="ask-body">
            {opts.body.split("\n").map((line, i) => (
              <span key={i}>
                {line}
                <br />
              </span>
            ))}
          </p>
        )}
        {req.kind === "text" && (
          <label className="ask-field">
            <span>{req.opts.label || "Reason"}</span>
            <textarea
              ref={input}
              rows={3}
              value={text}
              placeholder={req.opts.placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) accept();
              }}
            />
          </label>
        )}
        <div className="ask-actions">
          <button type="button" className="button secondary" onClick={cancel} data-testid="confirm-cancel">
            {opts.cancel || "Cancel"}
          </button>
          <button type="submit" className={`button ${tone === "danger" ? "danger" : "primary"}`} data-testid="confirm-accept">
            {opts.confirm || "Confirm"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
