import type { ReactNode } from 'react';

export type MailBrand = 'icloud' | 'microsoft' | 'google' | 'yahoo' | 'aol' | 'other';

export const BRANDS: { id: MailBrand; name: string; hint?: string; help?: { label: string; url: string }; passwordLabel: string }[] = [
  { id: 'icloud', name: 'iCloud', passwordLabel: 'App-specific password', hint: 'Apple requires an app-specific password, not your Apple Account password.', help: { label: 'Create one at account.apple.com', url: 'https://account.apple.com/account/manage' } },
  { id: 'microsoft', name: 'Microsoft Outlook', passwordLabel: 'Password' },
  { id: 'google', name: 'Google', passwordLabel: 'App password', hint: 'Google requires a 16-character app password (2-Step Verification must be on).', help: { label: 'Create an app password', url: 'https://myaccount.google.com/apppasswords' } },
  { id: 'yahoo', name: 'Yahoo', passwordLabel: 'App password', hint: 'Yahoo requires an app password, not your normal password.', help: { label: 'Generate one in Yahoo security settings', url: 'https://login.yahoo.com/account/security' } },
  { id: 'aol', name: 'AOL', passwordLabel: 'App password', hint: 'AOL requires an app password, not your normal password.', help: { label: 'Generate one in AOL security settings', url: 'https://login.aol.com/account/security' } },
  { id: 'other', name: 'Other', passwordLabel: 'Password', hint: 'For your own domain or any other mail provider. We find the server settings for you.' },
];

export function brandFor(m: { provider: string; email_address: string; config_public?: { brand?: string; imapHost?: string } | null }): MailBrand {
  const b = m.config_public?.brand;
  if (b && BRANDS.some((x) => x.id === b)) return b as MailBrand;
  if (m.provider === 'gmail') return 'google';
  if (m.provider === 'outlook') return 'microsoft';
  const host = `${m.config_public?.imapHost ?? ''} ${m.email_address.split('@')[1] ?? ''}`.toLowerCase();
  if (/gmail|google/.test(host)) return 'google';
  if (/me\.com|icloud|mac\.com/.test(host)) return 'icloud';
  if (/office365|outlook|hotmail|live\.com/.test(host)) return 'microsoft';
  if (/yahoo/.test(host)) return 'yahoo';
  if (/aol/.test(host)) return 'aol';
  return 'other';
}

const tile = (bg: string, child: ReactNode, size: number, border = false) => (
  <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden style={{ flex: 'none' }}>
    <rect x=".5" y=".5" width="39" height="39" rx="9.5" fill={bg} stroke={border ? 'var(--line)' : 'none'} />
    {child}
  </svg>
);

/** Simple provider marks for the account picker. */
export function BrandLogo({ brand, size = 36 }: { brand: MailBrand; size?: number }) {
  switch (brand) {
    case 'icloud':
      return tile('#3b9bf5', <path d="M13.5 27a5 5 0 0 1-.6-9.960 7 7 0 0 1 13.5-1.640A5.8 5.8 0 0 1 26.5 27z" fill="#fff" />, size);
    case 'microsoft':
      return tile('#fff', <g><rect x="10" y="10" width="9.5" height="9.5" fill="#f25022" /><rect x="20.5" y="10" width="9.5" height="9.5" fill="#7fba00" /><rect x="10" y="20.5" width="9.5" height="9.5" fill="#00a4ef" /><rect x="20.5" y="20.5" width="9.5" height="9.5" fill="#ffb900" /></g>, size, true);
    case 'google':
      return tile('#fff', <g fill="none" strokeWidth="4.2"><path d="M28.5 14.200A10 10 0 0 0 11.3 15" stroke="#ea4335" /><path d="M11.3 15a10 10 0 0 0 0 10" stroke="#fbbc05" /><path d="M11.3 25a10 10 0 0 0 16.2 1.8" stroke="#34a853" /><path d="M27.5 26.800A10 10 0 0 0 30 20H20.5" stroke="#4285f4" /></g>, size, true);
    case 'yahoo':
      return tile('#6001d2', <text x="20" y="27" textAnchor="middle" fontSize="19" fontWeight="800" fontFamily="system-ui, sans-serif" fill="#fff">Y!</text>, size);
    case 'aol':
      return tile('#111', <text x="20" y="26" textAnchor="middle" fontSize="15" fontWeight="800" fontFamily="system-ui, sans-serif" fill="#fff">Aol.</text>, size);
    default:
      return tile('#71717a', <path d="M11 14h18v12.500H11zM11 15l9 6.5 9-6.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />, size);
  }
}
