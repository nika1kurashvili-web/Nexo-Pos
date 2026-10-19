"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Props = {
  isAdmin: boolean;
};

type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
  primary?: boolean;
};

// პატარა ხატულები მენიუსთვის (ხაზოვანი, 24x24)
const ICONS: Record<string, string> = {
  "/": "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  "/sales/new": "M12 5v14M5 12h14",
  "/sales": "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  "/returns": "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  "/customers": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  "/registers": "M4 7h16v13H4zM8 7V4h8v3M8 12h8",
  "/payment-methods": "M3 6h18v12H3zM3 10h18",
  "/employees": "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  "/products": "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  "/purchases": "M6 6h15l-2 9H8zM6 6 5 3H2M9 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1M18 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1",
  "/inventories": "M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4",
  "/analytics": "M4 20V10M10 20V4M16 20v-8M22 20H2",
  "/profit": "M3 17l5-5 4 4 8-9M15 7h5v5",
  "/reports": "M6 3h8l5 5v13H6zM14 3v5h5M9 13h6M9 17h6",
};

export default function PosNavigation({
  isAdmin,
}: Props) {
  const pathname = usePathname();

  const mainItems: NavItem[] = [
    {
      href: "/",
      label: "მთავარი",
      exact: true,
    },
    {
      href: "/sales/new",
      label: "+ ახალი გაყიდვა",
      exact: true,
      primary: true,
    },
    {
      href: "/sales",
      label: "ტრანზაქციები",
    },
    {
      href: "/returns",
      label: "დაბრუნება",
    },
  ];

  const adminItems: NavItem[] = [
    {
      href: "/customers",
      label: "ბიზნეს კლიენტები",
    },
    {
      href: "/registers",
      label: "სალაროები",
    },
    {
      href: "/payment-methods",
      label: "გადახდის მეთოდები",
    },
    {
      href: "/employees",
      label: "თანამშრომლები",
    },
    {
      href: "/products",
      label: "პროდუქტები",
    },
    {
      href: "/purchases",
      label: "შესყიდვები",
    },
    {
      href: "/inventories",
      label: "ინვენტარიზაცია",
    },
    {
      href: "/analytics",
      label: "ანალიტიკა",
    },
    {
      href: "/profit",
      label: "გაყიდვები",
    },
    {
      href: "/reports",
      label: "რეპორტები",
    },
  ];

  function isActive(item: NavItem) {
    if (item.exact) {
      return pathname === item.href;
    }

    return (
      pathname === item.href ||
      pathname.startsWith(`${item.href}/`)
    );
  }

  function renderItem(item: NavItem) {
    const active = isActive(item);

    return (
      <Link
        key={item.href}
        href={item.href}
        className={[
          "sidebar-link",
          active ? "active" : "",
          item.primary ? "sidebar-primary" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-current={active ? "page" : undefined}
      >
        {ICONS[item.href] && (
          <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ICONS[item.href]} />
          </svg>
        )}
        <span>{item.label.replace(/^\+\s*/, "")}</span>
      </Link>
    );
  }

  return (
    <nav aria-label="მთავარი მენიუ">
      <div className="sidebar-group">
        {mainItems.map(renderItem)}
      </div>

      {isAdmin && (
        <div className="sidebar-group sidebar-admin-group">
          <div className="sidebar-section-title">
            მართვა
          </div>

          {adminItems.map(renderItem)}
        </div>
      )}
    </nav>
  );
}