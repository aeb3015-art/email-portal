'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

const REMOTE = /^(https?:)?\/\//i;

/** Sanitise untrusted HTML email. Remote resources are stripped unless explicitly allowed. */
export function sanitizeEmail(html: string, allowRemote: boolean): { html: string; blocked: number } {
  let blocked = 0;
  const purifier = DOMPurify();
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    for (const attr of ['src', 'srcset', 'background', 'poster']) {
      const v = el.getAttribute?.(attr);
      if (v && !allowRemote && (REMOTE.test(v.trim()) || attr === 'srcset')) { el.removeAttribute(attr); blocked++; }
      if (v && /^cid:/i.test(v)) el.removeAttribute(attr);
    }
    const style = el.getAttribute?.('style');
    if (style && !allowRemote && /url\s*\(/i.test(style)) { el.setAttribute('style', style.replace(/url\s*\([^)]*\)/gi, 'none')); blocked++; }
  });
  const clean = purifier.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'frame', 'frameset'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'formaction'],
    ALLOW_DATA_ATTR: false,
  }) as string;
  const out = allowRemote ? clean : clean.replace(/url\s*\(\s*['"]?https?:[^)]*\)/gi, () => { blocked++; return 'none'; });
  return { html: out, blocked };
}

export function MailBody({ html, text }: { html: string | null; text: string }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(160);
  const ref = useRef<HTMLIFrameElement>(null);
  const result = useMemo(() => (html ? sanitizeEmail(html, allowRemote) : null), [html, allowRemote]);

  useEffect(() => { setAllowRemote(false); }, [html]);

  if (!result) return <pre>{text}</pre>;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${allowRemote ? 'https:' : ''}; font-src data:;`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;padding:10px 12px;background:#fff;font:14px/1.45 system-ui,sans-serif;color:#1c1c1a;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${result.html}</body></html>`;
  return (
    <div>
      {result.blocked > 0 && !allowRemote && (
        <div className="row small muted" style={{ marginBottom: 6 }}>
          Remote images blocked to protect your privacy. <button className="btn small" onClick={() => setAllowRemote(true)}>Load images</button>
        </div>
      )}
      <iframe
        ref={ref}
        className="mailframe"
        // No allow-scripts: email HTML can never run code. allow-same-origin only lets us measure height.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={doc}
        style={{ height }}
        onLoad={() => { const b = ref.current?.contentDocument?.body; if (b) setHeight(Math.min(4000, b.scrollHeight + 16)); }}
        title="Email content"
      />
    </div>
  );
}
