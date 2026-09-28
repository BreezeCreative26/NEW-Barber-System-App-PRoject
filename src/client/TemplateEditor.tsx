import { useMemo } from "react";
import { Icon } from "./ui";

// Message wording editor with a live phone preview. Placeholders like {first} are filled from a
// sample built off the shop's real data, so the owner sees exactly what a customer would receive
// as they type. Character/segment counter warns when a text will bill as two segments.

export type TemplateSample = Record<string, string>;

export function fillTemplate(tpl: string, sample: TemplateSample) {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in sample ? sample[k] : m));
}

// GSM-7 single segment is 160 chars; anything outside GSM-7 (smart quotes, emoji, "—") drops to UCS-2 at 70.
const GSM7 = /^[\u0000-\u007F£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
export function segmentsOf(text: string) {
  const gsm = GSM7.test(text);
  const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  if (text.length <= single) return { segments: text.length ? 1 : 0, limit: single, gsm };
  return { segments: Math.ceil(text.length / multi), limit: multi, gsm };
}

export function TemplateEditor({
  label,
  value,
  onChange,
  placeholders,
  sample,
  sender,
  defaultValue,
  testId,
  maxLength = 400,
  unitPence,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholders: string[];
  sample: TemplateSample;
  sender: string;
  defaultValue?: string;
  testId: string;
  maxLength?: number;
  unitPence?: number;
}) {
  const rendered = useMemo(() => fillTemplate(value || "", sample), [value, sample]);
  const seg = segmentsOf(rendered);
  const unknown = Array.from(new Set((value.match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1)).filter((k) => !placeholders.includes(k))));
  const insert = (k: string) => onChange(`${value}${value.endsWith(" ") || !value ? "" : " "}{${k}}`);
  return (
    <div className="tpl" data-testid={`${testId}-editor`}>
      <div className="tpl-form">
        <label className="tpl-label" htmlFor={testId}>
          {label}
          <small>{rendered.length} chars · {seg.segments} text{seg.segments === 1 ? "" : "s"}{unitPence && seg.segments > 1 ? ` · ${seg.segments * unitPence}p` : ""}</small>
        </label>
        <textarea id={testId} value={value} rows={3} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
        <div className="tpl-chips" aria-label="Insert a placeholder">
          {placeholders.map((k) => (
            <button key={k} type="button" className={`sender-chip${value.includes(`{${k}}`) ? " on" : ""}`} onClick={() => insert(k)} title={sample[k] ? `e.g. ${sample[k]}` : undefined}>
              {`{${k}}`}
            </button>
          ))}
          {defaultValue !== undefined && value !== defaultValue && (
            <button type="button" className="linkish tpl-reset" onClick={() => onChange(defaultValue)}>Reset to default</button>
          )}
        </div>
        {unknown.length > 0 && <p className="sender-note bad"><Icon name="alert" size={13} /> Unknown placeholder{unknown.length === 1 ? "" : "s"}: {unknown.map((k) => `{${k}}`).join(", ")} — it will be sent as written.</p>}
        {seg.segments > 1 && <p className="sender-note warn"><Icon name="info" size={13} /> Over {seg.gsm ? 160 : 70} characters, so this bills as {seg.segments} texts. Trim a few words to keep it to one.</p>}
        {!seg.gsm && <p className="sender-note"><Icon name="info" size={13} /> Contains a symbol phones send in a costlier format (e.g. — or “ ”). Plain quotes and hyphens keep it cheap.</p>}
      </div>
      <div className="sender-phone tpl-phone" aria-hidden="true">
        <div className="sender-phone-bar"><span className="sender-phone-avatar">{(sender || "S").charAt(0).toUpperCase()}</span><b>{sender || "Your shop"}</b></div>
        <div className="sender-phone-time">Today 10:02</div>
        <div className="sender-phone-bubble">{rendered || <span style={{ opacity: 0.5 }}>Your message will appear here…</span>}</div>
      </div>
    </div>
  );
}
