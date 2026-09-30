import { authMessages } from "@/lib/auth/access";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { SubmitButton } from "@/app/components/submit-button";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const configured = Boolean(getSupabaseConfig());
  const message = !configured ? authMessages.configuration :
    error && Object.hasOwn(authMessages, error) ? authMessages[error as keyof typeof authMessages] : null;

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand" lang="en">Nexo POS</div>
        <p className="muted">მოლარის სისტემა</p>
        <h1 id="login-title">სისტემაში შესვლა</h1>
        {message && <p id="login-error" className="notice error" role="alert">{message}</p>}
        <form action={login} className="login-form" aria-describedby={message ? "login-error" : undefined}>
          <label htmlFor="email">ელფოსტა</label>
          <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} autoCapitalize="none" spellCheck={false} />
          <label htmlFor="password">პაროლი</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={4096} />
          {configured ? <SubmitButton pendingText="შესვლა…" className="button primary">შესვლა</SubmitButton> :
            <button className="button primary" disabled>შესვლა</button>}
        </form>
      </section>
    </main>
  );
}
