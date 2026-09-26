import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { roleLabels } from "@/lib/auth/access";
import { logout } from "@/app/login/actions";
import { SubmitButton } from "@/app/components/submit-button";

export const dynamic = "force-dynamic";

export default async function PosLayout({ children }: { children: React.ReactNode }) {
  const profile = await requirePosProfile();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">შინაარსზე გადასვლა</a>
      <header className="app-header">
        <Link href="/" className="brand" lang="en">Nexo POS</Link>
        <div className="account">
          <div className="account-details"><strong>{profile.full_name}</strong><span>{roleLabels[profile.role]}</span></div>
          <form action={logout}><SubmitButton pendingText="გასვლა…" className="button secondary">გამოსვლა</SubmitButton></form>
        </div>
      </header>
      <aside className="sidebar">
        <nav aria-label="მთავარი ნავიგაცია">
          <Link href="/">სალარო</Link>
          <Link href="/sales">გაყიდვები</Link>
          {profile.role === "admin" && <>
            <Link href="/reports">რეპორტები</Link>
            <Link href="/employees">თანამშრომლები</Link>
          </>}
        </nav>
      </aside>
      <main id="main" className="main-content">{children}</main>
    </div>
  );
}
