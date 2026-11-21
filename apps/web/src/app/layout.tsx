import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { SessionProvider } from '@/lib/session';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const metadata = { title: 'Inbox OS', description: 'Zero-access, agent-first unified inbox' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
