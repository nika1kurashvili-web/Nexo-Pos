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
      label: "გაყიდვები",
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
        {item.label}
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