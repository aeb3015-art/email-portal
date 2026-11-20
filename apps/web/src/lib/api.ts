export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string) { super(message); }
}

let token: string | null = null;
let orgId: string | null = null;

export function setAuth(t: string | null, o: string | null) {
  token = t;
  orgId = o;
  try {
    if (t) sessionStorage.setItem('iox_session', t); else sessionStorage.removeItem('iox_session');
    if (o) sessionStorage.setItem('iox_org', o); else sessionStorage.removeItem('iox_org');
  } catch { /* storage unavailable */ }
}

export function loadStoredAuth(): { token: string | null; orgId: string | null } {
  try {
    token = sessionStorage.getItem('iox_session');
    orgId = sessionStorage.getItem('iox_org');
  } catch { /* ignore */ }
  return { token, orgId };
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: Blob; noOrg?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (orgId && !opts.noOrg) headers['x-org-id'] = orgId;
  let body: BodyInit | undefined;
  if (opts.raw) { body = opts.raw; headers['content-type'] = opts.raw.type || 'application/octet-stream'; }
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
  const res = await fetch(`${API_URL}${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, cache: 'no-store' });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      setAuth(null, null);
      window.location.href = '/login';
    }
    throw new ApiError(res.status, json.message ?? `Request failed (${res.status})`, json.error ?? 'error');
  }
  return json as T;
}
