import { describe, expect, it } from 'vitest';
import { decideSend, type SendRequest } from './permissions.js';

const base: SendRequest = {
  origin: 'agent', settings: { permission_level: 'auto_send', auto_send_categories: ['scheduling'] }, category: 'scheduling',
  injectionFlagged: false, recipients: ['liana@client.test'], threadParticipants: ['liana@client.test'], isReply: true,
};

describe('decideSend permission gate', () => {
  it('people always send', () => {
    expect(decideSend({ ...base, origin: 'user', settings: { permission_level: 'read_only', auto_send_categories: [] } }).action).toBe('send');
  });
  it('read_only and draft deny agent sends', () => {
    expect(decideSend({ ...base, settings: { permission_level: 'read_only', auto_send_categories: [] } }).action).toBe('deny');
    expect(decideSend({ ...base, settings: { permission_level: 'draft', auto_send_categories: [] } }).action).toBe('deny');
  });
  it('send_with_approval always queues', () => {
    expect(decideSend({ ...base, settings: { permission_level: 'send_with_approval', auto_send_categories: ['scheduling'] } }).action).toBe('pending_approval');
  });
  it('auto_send sends only when every condition holds', () => {
    expect(decideSend(base).action).toBe('send');
    expect(decideSend({ ...base, category: 'invoice' }).action).toBe('pending_approval');
    expect(decideSend({ ...base, category: null }).action).toBe('pending_approval');
    expect(decideSend({ ...base, isReply: false }).action).toBe('pending_approval');
  });
  it('falls back to approval on prompt injection', () => {
    const d = decideSend({ ...base, injectionFlagged: true });
    expect(d).toMatchObject({ action: 'pending_approval' });
  });
  it('falls back to approval when recipients leave the thread', () => {
    expect(decideSend({ ...base, recipients: ['liana@client.test', 'attacker@evil.test'] }).action).toBe('pending_approval');
  });
  it('MCP origin follows the same rules', () => {
    expect(decideSend({ ...base, origin: 'mcp', settings: { permission_level: 'draft', auto_send_categories: [] } }).action).toBe('deny');
  });
});
