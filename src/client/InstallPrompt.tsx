// Shop app install: the first time a signed-in customer is on the shop's site on a device (straight
// after registering or signing in), a pop-up shows how to add the shop's app to their home screen.
// Android/Chrome: one-tap Install. iPhone/iPad: Share → Add to Home Screen.
import { useEffect, useState } from "react";
import { Button, Icon } from "./ui";
import { onShopHost } from "./theme";

export type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
export const standalone = () =>
  (typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches) || (navigator as unknown as { standalone?: boolean }).standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// On the shop's own host the app is the whole site; on the shared host it lives under /<slug>/.
export const swScope = (slug: string) => (onShopHost(slug) ? "/" : `/${slug}/`);
export async function registerShopWorker(slug: string) {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js", { scope: swScope(slug) }); } catch { return null; }
}

// Chrome fires beforeinstallprompt once, often before React mounts: keep it for whoever asks later.
let deferred: InstallEvent | null = null;
const listeners = new Set<(e: InstallEvent | null) => void>();
const announce = () => listeners.forEach((f) => f(deferred));
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallEvent; announce(); });
  window.addEventListener("appinstalled", () => { deferred = null; announce(); });
}
export function useInstallEvent() {
  const [evt, setEvt] = useState<InstallEvent | null>(deferred);
  useEffect(() => {
    listeners.add(setEvt);
    setEvt(deferred);
    return () => { listeners.delete(setEvt); };
  }, []);
  return evt;
}
export async function promptInstall(evt: InstallEvent) {
  await evt.prompt();
  const { outcome } = await evt.userChoice;
  deferred = null;
  announce();
  return outcome === "accepted";
}

const seenKey = (slug: string) => `foliyo:${slug}:install-pop`;
export function InstallPrompt({ slug, shopName, signedIn }: { slug: string; shopName: string; signedIn: boolean }) {
  const evt = useInstallEvent();
  const [open, setOpen] = useState(false);
  const ios = typeof navigator !== "undefined" && isIOS();
  useEffect(() => {
    if (!signedIn || standalone()) return;
    let seen = false;
    try { seen = localStorage.getItem(seenKey(slug)) === "1"; } catch { /* private mode */ }
    if (seen) return;
    void registerShopWorker(slug);
    if (ios || evt) setOpen(true);
  }, [signedIn, slug, evt, ios]);
  if (!open) return null;
  const close = () => {
    try { localStorage.setItem(seenKey(slug), "1"); } catch { /* private mode */ }
    setOpen(false);
  };
  const icon = onShopHost(slug) ? "/icon-192.png" : `/${encodeURIComponent(slug)}/icon-192.png`;
  return (
    <div className="install-pop-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section className="install-pop" role="dialog" aria-modal="true" aria-labelledby="install-pop-title" data-testid="install-popup">
        <img src={icon} alt="" width={64} height={64} className="install-pop-icon" />
        <h2 id="install-pop-title">Get the {shopName} app</h2>
        <p>Add it to your home screen to book in a couple of taps and keep your visits to hand.</p>
        {evt ? (
          <div className="install-pop-actions">
            <Button onClick={async () => { await promptInstall(evt).catch(() => false); close(); }} data-testid="install-popup-install">
              <Icon name="download" size={16} /> Install
            </Button>
            <button type="button" className="link" onClick={close} data-testid="install-popup-later">Not now</button>
          </div>
        ) : (
          <>
            <ol className="install-pop-steps">
              <li>Tap the <strong>Share</strong> button <Icon name="upload" size={14} /> in the browser toolbar</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
              <li>Tap <strong>Add</strong></li>
            </ol>
            <div className="install-pop-actions">
              <Button onClick={close} data-testid="install-popup-ok">Got it</Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
