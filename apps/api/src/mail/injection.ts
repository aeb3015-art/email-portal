/**
 * Heuristic prompt-injection detector. Email is untrusted DATA; this does not make it safe,
 * it only decides whether auto-send must fall back to human approval.
 */
const PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages|rules)/i,
  /disregard (all |any |the )?(previous|prior|above|your) (instructions|rules|guidelines)/i,
  /(you are|act as|pretend to be) (now )?(an? )?(ai|assistant|agent|chatbot|llm|system)/i,
  /\b(system|developer) (prompt|message|instruction)s?\b/i,
  /\b(new|updated|revised) instructions?\b\s*[:\-]/i,
  /\b(forward|send|email|cc|bcc) (this|all|every|the)? ?(email|message|thread|conversation|inbox|data|attachments?)s? to\b/i,
  /\b(reply|respond) (to|with) .* (password|credentials?|api key|token|secret)/i,
  /\bagent\b.*\b(must|should|shall)\b/i,
  /<\s*\/?\s*(system|assistant|instructions?|tool|prompt)\s*>/i,
  /\[\s*(system|inst)\s*\]/i,
  /\bauto[- ]?(send|reply|approve)\b/i,
  /\b(change|update|grant|elevate) (your |the )?(permissions?|access|recipients?)\b/i,
  /BEGIN (SYSTEM|PROMPT|INSTRUCTIONS)/i,
];

export interface InjectionResult { flagged: boolean; reasons: string[] }

export function detectInjection(...texts: (string | null | undefined)[]): InjectionResult {
  const text = texts.filter(Boolean).join('\n').slice(0, 200_000);
  const reasons: string[] = [];
  for (const p of PATTERNS) if (p.test(text)) reasons.push(p.source.slice(0, 60));
  // Hidden text tricks: zero-width chars in bulk, or HTML styled invisible
  if ((text.match(/[​-‏⁠﻿]/g) ?? []).length > 20) reasons.push('zero-width-characters');
  if (/(display\s*:\s*none|font-size\s*:\s*0|color\s*:\s*#?fff(fff)?\b[^>]*>[^<]{40,})/i.test(text)) reasons.push('hidden-text');
  return { flagged: reasons.length > 0, reasons };
}
