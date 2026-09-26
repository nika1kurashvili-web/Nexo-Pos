# Nexo POS

მოლარის სისტემა

A Georgian POS login and protected application shell for `pos.nexo.ge`, using
Next.js 15, TypeScript, App Router, ESLint, and plain CSS. The application lives
directly in the repository root; `@/*` resolves from that root.

## Requirements

- Node.js 22.13 or newer (Node.js 24 LTS recommended)
- pnpm 11.19.0

## Development

Copy `.env.example` to `.env.local` and set the shared Supabase project's public
URL and anon key. Apply the migration and provision a POS profile following
[the setup guide](docs/auth-setup.md). No service-role key is used or required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000.

## Validation

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

## Production

```sh
pnpm build
pnpm start
```

Vercel already has `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
configured according to the project setup. Before deployment, apply
`supabase/migrations/202609260001_create_pos_profiles.sql` and create the first
POS admin. See [setup, security, and verification](docs/auth-setup.md).

## Structure

- `app/login/`: Georgian login and login/logout Server Actions
- `app/(pos)/`: protected shell, register, sales, and admin placeholders
- `app/components/submit-button.tsx`: pending form feedback
- `app/layout.tsx`: root layout, language, and metadata
- `app/globals.css`: global styles
- `next.config.ts`: Next.js configuration
- `tsconfig.json`: strict TypeScript and import alias configuration
- `eslint.config.mjs`: Next.js and TypeScript lint rules
- `lib/supabase/`: SSR/browser clients, configuration, and POS profile types
- `lib/auth/`: authorization, Georgian role/error labels, and server guards
- `middleware.ts`: session refresh and initial access checks
- `supabase/migrations/`: POS-only SQL migration
- `tests/auth.test.mjs`: production-server authentication integration tests

`/` and `/sales` require an active POS profile. `/reports` and `/employees` are
admin-only placeholders. Existing order-management users are not authorized
unless they also have an active `pos_profiles` row.

No sales tables, cart, payments, inventory, receipt printing, reports logic,
or employee creation UI is implemented.
