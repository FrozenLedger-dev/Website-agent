import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'STATXAI Console',
  description: 'Control plane for the autonomous website delivery platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="masthead">
            <h1>STATXAI</h1>
            <span className="tag">Autonomous website delivery</span>
            <nav>
              <Link href="/">Runs</Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
