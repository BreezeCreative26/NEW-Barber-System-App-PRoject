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
  Inbox,
  Contact,
  Sun,
  UserRound,
  Landmark,
  Banknote,
  Gift,
  Footprints,
  Cloud,
  Heart,
  BadgeCheck,
  Lock,
  FileText,
  LogIn,
  Phone,
  Download,
  CalendarCheck,
  Ban,
  LogOut,
  KeyRound,
  Globe,
  Hourglass,
  Send,
  Copy,
  MessageSquareReply,
  ImagePlus,
  Trash2,
  EyeOff,
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
  inbox: Inbox,
  contact: Contact,
  sun: Sun,
  userRound: UserRound,
  landmark: Landmark,
  banknote: Banknote,
  gift: Gift,
  footprints: Footprints,
  cloud: Cloud,
  heart: Heart,
  paid: BadgeCheck,
  lock: Lock,
  file: FileText,
  login: LogIn,
  call: Phone,
  download: Download,
  payrun: CalendarCheck,
  blocked: Ban,
  logout: LogOut,
  key: KeyRound,
  globe: Globe,
  hourglass: Hourglass,
  send: Send,
  copy: Copy,
  messageReply: MessageSquareReply,
  imagePlus: ImagePlus,
  trash: Trash2,
  eyeOff: EyeOff,
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

/* ---------------- Shell components (see docs/DESIGN.md) ---------------- */
export type NavItem = { key: string; label: string; icon: string };

export function TopBar({
  search,
  wallet,
  queue,
  bell,
  account,
  onSearch,
  onWallet,
  onQueue,
  onBell,
  onAccount,
  accountOpen = false,
  children,
}: {
  accountOpen?: boolean;
  search?: string;
  wallet?: { amount: string; caption: string; open?: boolean } | null;
  queue?: { count: number; offered: number; open?: boolean } | null;
  bell?: { count: number; open?: boolean } | null;
  account?: { initials: string; name: string; caption: string; online?: boolean; logo?: string } | null;
  onSearch?: () => void;
  onWallet?: () => void;
  onQueue?: () => void;
  onBell?: () => void;
  onAccount?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="topbar" data-testid="topbar">
      <Brand />
      {onSearch && (
        <button type="button" className="topbar-search" onClick={onSearch} aria-label="Search">
          <Icon name="search" size={16} />
          <span className="topbar-search-text">{search || "Search customers, appointments, services"}</span>
          <kbd aria-hidden="true">/</kbd>
        </button>
      )}
      <span className="topbar-grow" />
      {children}
      {wallet && (
        <button type="button" className="wallet-chip" onClick={onWallet} aria-expanded={wallet.open ? "true" : "false"} aria-label={`Wallet: ${wallet.amount} ${wallet.caption}`} data-testid="wallet-chip">
          <span className="chip-ic"><Icon name="wallet" size={15} /></span>
          <span><b>{wallet.amount}</b><small>{wallet.caption}</small></span>
          <Icon name="down" size={14} />
        </button>
      )}
      {queue && (
        <button
          type="button"
          className={`queue-chip ${queue.offered ? "has-offers" : ""}`}
          onClick={onQueue}
          aria-expanded={queue.open ? "true" : "false"}
          aria-label={`Waiting list: ${queue.count} waiting${queue.offered ? `, ${queue.offered} offer${queue.offered === 1 ? "" : "s"} pending` : ""}`}
          data-testid="queue-chip"
        >
          <span className="chip-ic"><Icon name="hourglass" size={15} /></span>
          <span><b>{queue.count}</b><small>{queue.offered ? `${queue.offered} offered` : "waiting"}</small></span>
          {queue.offered > 0 && <span className="presence-dot offer-dot" aria-hidden="true" />}
        </button>
      )}
      {bell && (
        <button type="button" className="topbar-iconbtn" onClick={onBell} aria-expanded={bell.open ? "true" : "false"} aria-label={`Notifications${bell.count ? `, ${bell.count} unread` : ""}`} data-testid="bell">
          <Icon name="bell" />
          {bell.count > 0 && <span className="count-badge">{bell.count > 99 ? "99+" : bell.count}</span>}
        </button>
      )}
      {account && (
        <button type="button" className="account-pill" onClick={onAccount} aria-haspopup="menu" aria-expanded={accountOpen ? "true" : "false"} aria-label={`Account: ${account.name}, ${account.caption}`} data-testid="account-pill">
          {account.logo ? <img className="avatar-ink avatar-logo" src={account.logo} alt="" /> : <span className="avatar-ink">{account.initials}</span>}
          <span className="account-pill-text">
            <b>{account.name}</b>
            <small>{account.online !== false && <span className="presence-dot" aria-hidden="true" />}{account.caption}</small>
          </span>
          <Icon name="down" size={14} />
        </button>
      )}
    </header>
  );
}

export function Rail({ items, current, onSelect, bottom }: { items: NavItem[]; current: string; onSelect: (key: string) => void; bottom?: NavItem[] }) {
  const render = (n: NavItem) => (
    <button key={n.key} type="button" aria-current={current === n.key ? "page" : undefined} aria-label={n.label} onClick={() => onSelect(n.key)}>
      <Icon name={n.icon} />
      <span className="rail-tip" aria-hidden="true">{n.label}</span>
    </button>
  );
  return (
    <nav className="rail" aria-label="Workspace sections" data-testid="rail">
      {items.map(render)}
      {bottom && bottom.length > 0 && (
        <>
          <span className="rail-spacer" />
          {bottom.map(render)}
        </>
      )}
    </nav>
  );
}

export function TabBar({ items, more = [], current, onSelect, fab }: { items: NavItem[]; more?: NavItem[]; current: string; onSelect: (key: string) => void; fab?: { label: string; onClick: () => void; disabled?: boolean } }) {
  const [open, setOpen] = useState(false);
  const left = items.slice(0, 2), right = items.slice(2, 3);
  const moreActive = more.some((n) => n.key === current);
  const render = (n: NavItem) => (
    <button key={n.key} type="button" aria-current={current === n.key ? "page" : undefined} onClick={() => { setOpen(false); onSelect(n.key); }}>
      <Icon name={n.icon} />
      {n.label}
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Workspace sections" data-testid="tabbar">
      {left.map(render)}
      {fab ? (
        <button type="button" className="tab-fab" onClick={fab.onClick} disabled={fab.disabled} aria-label={fab.label}>
          <span><Icon name="plus" size={22} /></span>
        </button>
      ) : (
        <span />
      )}
      {right.map(render)}
      {more.length > 0 && (
        <button type="button" className="tab-more" aria-expanded={open} aria-haspopup="menu" aria-current={moreActive && !open ? "page" : undefined} onClick={() => setOpen((o) => !o)} data-testid="tab-more">
          <Icon name="more" />
          More
        </button>
      )}
      {open && (
        <div className="tab-sheet" role="menu" aria-label="More sections">
          {more.map((n) => (
            <button key={n.key} type="button" role="menuitem" aria-current={current === n.key ? "page" : undefined} onClick={() => { setOpen(false); onSelect(n.key); }}>
              <Icon name={n.icon} />
              {n.label}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

export function WalletHero({ label, pill, amount, stats, progress, children }: { label: ReactNode; pill?: ReactNode; amount: string; stats: { value: string; label: string }[]; progress?: { pct: number; left: string; right: string }; children?: ReactNode }) {
  return (
    <section className="wallet-hero" data-testid="wallet-hero">
      <div className="hero-label"><span><Icon name="wallet" size={14} />{label}</span>{pill && <span className="hero-pill">{pill}</span>}</div>
      <div className="hero-amount">{amount}</div>
      <div className="hero-row">
        {stats.map((s) => (
          <div key={s.label}><b>{s.value}</b><span>{s.label}</span></div>
        ))}
      </div>
      {progress && (
        <>
          <div className="hero-bar" role="progressbar" aria-valuenow={Math.round(progress.pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }} /></div>
          <div className="hero-goal"><span>{progress.left}</span><span>{progress.right}</span></div>
        </>
      )}
      {children}
    </section>
  );
}

export function KPI({ icon, label, value, delta }: { icon: string; label: string; value: string; delta?: string }) {
  return (
    <div className="kpi">
      <small><Icon name={icon} size={13} />{label}</small>
      <b>{value}</b>
      {delta && <div className="kpi-delta">{delta}</div>}
    </div>
  );
}

export function TxRow({ icon, title, caption, amount, sub, onClick }: { icon: string; title: string; caption: string; amount: string; sub?: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="tx-ic"><Icon name={icon} size={15} /></span>
      <span><b>{title}</b><small>{caption}</small></span>
      <span className="tx-amount">{amount}{sub && <small>{sub}</small>}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="tx-row" onClick={onClick} style={{ width: "100%", border: 0, background: "transparent", font: "inherit", textAlign: "left", cursor: "pointer" }}>{inner}</button>
  ) : (
    <div className="tx-row">{inner}</div>
  );
}

export function StatusPill({ tone = "good", children, ...rest }: { tone?: "good" | "next" | "paid" | "warn" | "note"; children: ReactNode; "data-testid"?: string; title?: string }) {
  return (
    <span className={`status-pill ${tone}`} {...rest}>
      {children}
    </span>
  );
}

export function BlockIcons({ online, regular, series, walkIn, paid }: { online?: boolean; regular?: boolean; series?: boolean; walkIn?: boolean; paid?: boolean }) {
  const items: [boolean | undefined, string, string][] = [
    [regular, "heart", "Returning customer"],
    [series, "repeat", "Standing booking"],
    [online, "cloud", "Booked online"],
    [walkIn, "footprints", "Walk-in"],
    [paid, "paid", "Paid"],
  ];
  const shown = items.filter(([on]) => on);
  if (!shown.length) return null;
  return (
    <span className="block-icons" aria-label={shown.map(([, , l]) => l).join(", ")}>
      {shown.map(([, icon, label]) => (
        <Icon key={icon} name={icon} size={12} className={icon === "paid" ? "paid" : ""} />
      ))}
      <span className="visually-hidden">{shown.map(([, , l]) => l).join(", ")}</span>
    </span>
  );
}
