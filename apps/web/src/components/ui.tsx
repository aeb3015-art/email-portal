import type { CSSProperties, ReactNode } from 'react';

const HUES = [248, 172, 22, 330, 200, 142, 280, 45];
export function hueFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length]!;
}

export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes('@') && !nameOrEmail.includes(' ') ? nameOrEmail.split('@')[0]!.replace(/[._-]+/g, ' ') : nameOrEmail;
  const parts = base.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const hue = hueFor(name.toLowerCase());
  const style: CSSProperties = { width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 70% 93%)`, color: `hsl(${hue} 55% 32%)` };
  return <span className="avatar" style={style} aria-hidden>{initials(name)}</span>;
}

export function Dot({ seed }: { seed: string }) {
  return <span className="dot" style={{ background: `hsl(${hueFor(seed)} 65% 55%)` }} />;
}

export function Brand({ size = 28 }: { size?: number }) {
  return (
    <span className="brand">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5b6cff" /><stop offset="1" stopColor="#8f5bff" /></linearGradient></defs>
        <rect width="32" height="32" rx="9" fill="url(#bg)" />
        <path d="M8 12.5l8 5.5 8-5.5M8 11h16v10.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 8 21.5z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <strong>Inbox OS</strong>
    </span>
  );
}

const PATHS: Record<string, string> = {
  inbox: 'M3 13l2.5-8h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1 2.500h6l1-2.500h5',
  unread: 'M4 6h16v12H4zM4 7l8 6 8-6',
  sent: 'M4 12l16-7-6 16-3-7z',
  archive: 'M4 5h16v4H4zM6 9v10h12V9M10 13h4',
  approvals: 'M5 12.5l4.5 4.500L19 7.5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.300l1.4 1.400M16.3 16.300l1.4 1.400M6.3 17.700l1.4-1.400M16.3 7.700l1.4-1.4',
  signout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
  compose: 'M5 19l1-4L16.5 4.500l3 3L9 18zM14.5 6.500l3 3',
  search: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.5-4.5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  spark: 'M12 3l1.8 5.200L19 10l-5.2 1.800L12 17l-1.8-5.200L5 10l5.2-1.800z',
  reply: 'M10 7L5 12l5 5M5 12h9a5 5 0 0 1 5 5v1',
  forward: 'M14 7l5 5-5 5M19 12h-9a5 5 0 0 0-5 5v1',
  clip: 'M8 12.500l6-6a3 3 0 0 1 4.2 4.200l-7.5 7.500a4.5 4.5 0 0 1-6.4-6.400L11 5',
  back: 'M15 6l-6 6 6 6',
  all: 'M4 6h16M4 12h16M4 18h16',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function EncryptedBadge({ children = 'End-to-end encrypted' }: { children?: ReactNode }) {
  return <span className="e2e"><Icon name="lock" size={13} /> {children}</span>;
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div className="authwrap">
      <div className="auth">
        <Brand size={36} />
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
        <div style={{ marginTop: 18, textAlign: 'center' }}><EncryptedBadge>Zero-access: only you hold the keys</EncryptedBadge></div>
      </div>
    </div>
  );
}
