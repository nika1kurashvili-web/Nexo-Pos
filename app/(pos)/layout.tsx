import Link from "next/link";
import { requirePosProfile } from "@/lib/auth/server";
import { roleLabels } from "@/lib/auth/access";
import { logout } from "@/app/login/actions";
import { SubmitButton } from "@/app/components/submit-button";
import PosNavigation from "@/app/components/pos-navigation";

export const dynamic = "force-dynamic";

export default async function PosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requirePosProfile();
  const isAdmin = profile.role === "admin";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        შინაარსზე გადასვლა
      </a>

      <header className="app-header">
        <Link href="/" className="brand" lang="en">
          Nexo POS
        </Link>

        <div className="account">
          <div className="account-details">
            <strong>{profile.full_name}</strong>
            <span>{roleLabels[profile.role]}</span>
          </div>

          <form action={logout}>
            <SubmitButton
              pendingText="გასვლა…"
              className="button secondary"
            >
              გასვლა
            </SubmitButton>
          </form>
        </div>
      </header>

      <aside className="sidebar">
        <PosNavigation isAdmin={isAdmin} />
      </aside>

      <main id="main" className="main-content">
        {children}
      </main>
    </div>
  );
}