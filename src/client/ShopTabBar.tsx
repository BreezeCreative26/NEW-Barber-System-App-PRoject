// The shop app's bottom tab bar (phones): Home · Book · Visits · Account. Every customer surface of a
// shop shares it, so the shop feels like one app rather than a set of pages. Hidden on wide screens,
// where the top navigation does the job.
import { Icon } from "./ui";
import { shopPath } from "./theme";

export type ShopTab = "home" | "book" | "visits" | "account";

export function ShopTabBar({ slug, active, signedIn }: { slug: string; active: ShopTab; signedIn: boolean }) {
  const tabs: { id: ShopTab; label: string; icon: string; href: string }[] = [
    { id: "home", label: "Home", icon: "home", href: shopPath(slug, "/") },
    { id: "book", label: "Book", icon: "calendar", href: shopPath(slug, "/book") },
    { id: "visits", label: "Visits", icon: "clock", href: shopPath(slug, "/me") },
    { id: "account", label: signedIn ? "Account" : "Sign in", icon: "userRound", href: shopPath(slug, "/me", signedIn ? "?tab=profile" : "") },
  ];
  return (
    <nav className="shop-tabbar" aria-label="Shop app">
      {tabs.map((t) => (
        <a key={t.id} href={t.href} aria-current={t.id === active ? "page" : undefined} data-testid={`tab-${t.id}`}>
          <Icon name={t.icon} size={22} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}
