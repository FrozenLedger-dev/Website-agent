/**
 * Placeholder root layout, and the pattern Terra replaces it with.
 *
 * Two things here are load-bearing and must survive the rewrite:
 *
 * 1. `import './globals.css'`. It is the only thing that pulls Tailwind and the
 *    theme into the build. A layout that drops it compiles, exports, and
 *    produces a site with no stylesheet at all — black text on white. That has
 *    happened; the gates catch it, but only after a full build is paid for.
 *
 * 2. `LayoutProps<'/'>`, the type Next generates for this route. Writing
 *    `{ children: React.ReactNode }` by hand type-checks, then fails at
 *    prerender with a null `useContext` inside `/_global-error` — an error that
 *    names neither this file nor the real cause.
 *
 * Brand faces load through `next/font/google`, which downloads them at build
 * time and self-hosts them in the export. Nothing is fetched from Google when a
 * visitor arrives, and the font is genuinely delivered rather than named and
 * silently substituted.
 */
import type { Metadata } from 'next';
import { Inter_Tight } from 'next/font/google';
import './globals.css';

const body = Inter_Tight({ subsets: ['latin'], variable: '--font-body', display: 'swap' });

export const metadata: Metadata = {
  title: 'Not yet generated',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={body.variable}>
      <body className="font-[family-name:var(--font-body)] antialiased">{children}</body>
    </html>
  );
}
