"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type NavItem = { href: string; label: string; match?: "exact" | "prefix" };
type NavSection = {
  label: "Home" | "Buy" | "Sell" | "Manage";
  items: Array<NavItem | { label: string; items: NavItem[] }>;
};

const sections: NavSection[] = [
  { label: "Home", items: [
    { href: "/today", label: "Today" },
    { href: "/", label: "Recommendations", match: "exact" },
    { href: "/review-session", label: "Review Session" },
  ] },
  { label: "Buy", items: [
    { href: "/seller-opportunities", label: "Auction Opportunities", match: "exact" },
    { href: "/scheduled-bids", label: "Scheduled Bids" },
    { href: "/comp-validation", label: "Comp Validation" },
  ] },
  { label: "Sell", items: [
    { href: "/inventory-actions", label: "Action Center" },
    { href: "/seller-opportunities/sales-velocity", label: "Sales Velocity" },
    { label: "Listing Optimization", items: [
      { href: "/seller-opportunities/title-inspection", label: "Title Inspection" },
      { href: "/seller-opportunities/listing-refresh", label: "Listing Refresh" },
      { href: "/seller-opportunities/listing-completeness", label: "Listing Completeness" },
      { href: "/seller-opportunities/image-quality", label: "Image Quality" },
    ] },
  ] },
  { label: "Manage", items: [
    { href: "/inventory", label: "Inventory", match: "exact" },
    { href: "/inventory-health", label: "Inventory Health" },
    { href: "/sales", label: "Sales & Performance" },
    { href: "/reconciliation", label: "Reconciliation" },
    { href: "/action-history", label: "Action History" },
    { href: "/cost-basis", label: "Cost Basis" },
  ] },
];

function isNavItem(item: NavItem | { label: string; items: NavItem[] }): item is NavItem {
  return "href" in item;
}

function isActive(pathname: string, item: NavItem) {
  if (item.match === "exact" || item.href === "/") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function sectionIsActive(pathname: string, section: NavSection) {
  return section.items.some((item) =>
    isNavItem(item) ? isActive(pathname, item) : item.items.some((nested) => isActive(pathname, nested)),
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  return <Link className="nav-leaf" href={item.href} aria-current={isActive(pathname, item) ? "page" : undefined}>{item.label}</Link>;
}

export default function AppNav() {
  const pathname = usePathname();
  const activeSection = sections.find((section) => sectionIsActive(pathname, section))?.label;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    Home: activeSection === "Home", Buy: activeSection === "Buy", Sell: activeSection === "Sell", Manage: activeSection === "Manage",
  }));

  useEffect(() => {
    if (activeSection) setExpanded((current) => ({ ...current, [activeSection]: true }));
  }, [activeSection]);

  return <aside className="app-nav">
    <Link className="nav-brand" href="/today" aria-label="Legends Operating System"><img src="/brand/legends-lockup.svg" alt="Legends Operating System" /></Link>
    <nav className="nav-tree" aria-label="Primary navigation">
      {sections.map((section) => {
        const active = section.label === activeSection;
        const open = active || expanded[section.label];
        const panelId = `nav-${section.label.toLowerCase()}`;
        return <section className={`nav-section${active ? " is-active" : ""}`} key={section.label}>
          <button type="button" className="nav-section-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => {
            if (!active) setExpanded((current) => ({ ...current, [section.label]: !open }));
          }}><span>{section.label}</span><span className="nav-chevron" aria-hidden="true">⌄</span></button>
          <div className="nav-section-items" id={panelId} hidden={!open}>
            {section.items.map((item) => isNavItem(item)
              ? <NavLink key={item.href} item={item} pathname={pathname} />
              : <div className="nav-subsection" key={item.label}><div className="nav-subsection-label">{item.label}</div>{item.items.map((nested) => <NavLink key={nested.href} item={nested} pathname={pathname} />)}</div>)}
          </div>
        </section>;
      })}
      <section className="nav-section nav-system"><div className="nav-system-label">System</div><Link className="nav-leaf" href="/stores" aria-current={pathname.startsWith("/stores") ? "page" : undefined}>Stores</Link></section>
    </nav>
  </aside>;
}
