import type { ReactNode } from 'react';
import './globals.css';
import { SessionProvider } from '@/lib/session';

export const metadata = { title: 'Inbox OS', description: 'Zero-access, agent-first unified inbox' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
