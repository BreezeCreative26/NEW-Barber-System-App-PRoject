import {
  useEffect,
  useState,
  useRef,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  CalendarCheck2,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  CreditCard,
  Ellipsis,
  ExternalLink,
  Eye,
  Filter,
  LayoutDashboard,
  List,
  LoaderCircle,
  MapPin,
  Menu,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Package,
  Plus,
  RefreshCw,
  Repeat,
  Scissors,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Star,
  Store,
  TrendingUp,
  User,
  Users,
  Wallet,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";

const icons: Record<string, LucideIcon> = {
  arrowDown: ArrowDownToLine,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUpRight,
  bell: Bell,
  calendar: CalendarDays,
  calendarCheck: CalendarCheck2,
  check: Check,
  checks: CheckCheck,
  down: ChevronDown,
  left: ChevronLeft,
  right: ChevronRight,
  help: CircleHelp,
  clock: Clock3,
  card: CreditCard,
  dots: Ellipsis,
  external: ExternalLink,
  eye: Eye,
  filter: Filter,
  dashboard: LayoutDashboard,
  list: List,
  loader: LoaderCircle,
  pin: MapPin,
  menu: Menu,
  message: MessageSquare,
  minus: Minus,
  more: MoreHorizontal,
  package: Package,
  plus: Plus,
  refresh: RefreshCw,
  repeat: Repeat,
  scissors: Scissors,
  razor: Scissors,
  search: Search,
  settings: Settings2,
  sliders: SlidersHorizontal,
  phone: Smartphone,
  sparkles: Sparkles,
  star: Star,
  store: Store,
  trend: TrendingUp,
  user: User,
  users: Users,
  wallet: Wallet,
  offline: WifiOff,
  close: X,
  shield: ShieldCheck,
};
export function Icon({
  name,
  size = 18,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Component = icons[name] || Scissors;
  return (
    <Component
      size={size}
      strokeWidth={1.7}
      aria-hidden="true"
      className={className}
    />
  );
}
export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type="button"
      className={`button ${variant} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function IconButton({
  name,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { name: string; label: string }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={name} />
    </button>
  );
}
export function Avatar({
  initials,
  colour = "sage",
  size = "",
}: {
  initials: string;
  colour?: string;
  size?: string;
}) {
  return (
    <span className={`avatar ${colour} ${size}`} aria-hidden="true">
      {initials}
    </span>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand ${light ? "light" : ""}`}>
      <img className="brand-mark" src="/static/brand/ollo-mark.svg" alt="" width={33} height={33} />
      <span className="brand-word" aria-label="OLLO">
        OLLO
      </span>
    </span>
  );
}
export function Notice({
  children,
  icon = "shield",
  tone = "",
}: {
  children: ReactNode;
  icon?: string;
  tone?: string;
}) {
  return (
    <div className={`notice ${tone}`}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  context = "DESIGN PREVIEW",
  protectChanges = false,
}: {
  protectChanges?: boolean;
  context?: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [closeWarning, setCloseWarning] = useState("");
  function requestClose() {
    if (
      protectChanges &&
      ref.current?.querySelector("form fieldset[disabled]")
    ) {
      setCloseWarning(
        "A save is in progress. Wait for its result before closing.",
      );
      return;
    }
    if (
      protectChanges &&
      ref.current?.querySelector('form[data-dirty="true"]')
    ) {
      setCloseWarning(
        "You have unsaved changes. Keep editing or discard them before closing.",
      );
      return;
    }
    onClose();
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby="dialog-title"
      onChangeCapture={(e) => {
        if (protectChanges && e.target instanceof HTMLElement) {
          const form = e.target.closest("form");
          if (form) form.dataset.dirty = "true";
        }
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ) ?? [],
        ).filter((n) => n.getClientRects().length > 0);
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <div>
            <span className="eyebrow">{context}</span>
            <h2 id="dialog-title">{title}</h2>
          </div>
          <IconButton
            name="close"
            label="Close dialog"
            onClick={requestClose}
          />
        </header>
        {closeWarning && (
          <section className="dialog-close-warning" role="alert">
            <p>{closeWarning}</p>
            <Button variant="secondary" onClick={() => setCloseWarning("")}>
              Keep editing
            </Button>
            {closeWarning.startsWith("You have") && (
              <Button
                variant="danger"
                onClick={() => {
                  if (!ref.current?.querySelector("form fieldset[disabled]"))
                    onClose();
                }}
              >
                Discard changes and close
              </Button>
            )}
          </section>
        )}
        {children}
      </div>
    </dialog>
  );
}
export function Boundary({
  title,
  text,
  onClose,
}: {
  title: string;
  text: string;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="boundary-content">
        <span className="state-icon">
          <Icon name="shield" size={28} />
        </span>
        <h3>A clear next step, not a pretend action.</h3>
        <p>{text}</p>
        <Notice>
          This is an interactive design preview. No live record, payment or
          account has been changed.
        </Notice>
        <Button onClick={onClose}>
          Back to preview
          <Icon name="arrowRight" />
        </Button>
      </div>
    </Modal>
  );
}
