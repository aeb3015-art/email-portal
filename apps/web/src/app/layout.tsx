import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import './globals.css';
import { SessionProvider } from '@/lib/session';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const metadata = { title: 'Inbox OS', description: 'Zero-access, agent-first unified inbox' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('iox_theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}" }} />
      </head>
      <body><SessionProvider>{children}</SessionProvider></body>
    </html>
  );
}
