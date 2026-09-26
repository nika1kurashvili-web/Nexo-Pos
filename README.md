# Nexo POS

მოლარის სისტემა

A minimal Next.js 15 foundation using TypeScript, the App Router, ESLint,
and plain global CSS. The application lives directly in the repository root;
the `@/*` import alias resolves from that root.

## Requirements

- Node.js 22.13 or newer (Node.js 24 LTS recommended)
- pnpm 11.19.0

## Development

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
```

## Production

```sh
pnpm build
pnpm start
```

Deploy with a hosting provider that supports Next.js, or run the production
server in a Node.js environment. No environment variables or external services
are required for this foundation.

## Structure

- `app/page.tsx`: home page
- `app/layout.tsx`: root layout, language, and metadata
- `app/globals.css`: global styles
- `next.config.ts`: Next.js configuration
- `tsconfig.json`: strict TypeScript and import alias configuration
- `eslint.config.mjs`: Next.js and TypeScript lint rules

Authentication, Supabase, database tables, products, sales, and POS functionality
are intentionally outside the current scope.
