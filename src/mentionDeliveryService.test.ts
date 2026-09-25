import { describe, it, expect, vi } from 'vitest';
import { MentionDelivery } from './mentionDeliveryService';
import { STATE_PATH } from './mentionDelivery';

vi.mock('./atSelector.ts', () => ({ loadRoster: async () => [{ name: 'Codex', shortId: '11111111', sessionId: '11111111-2222-3333-4444-555555555555', harness: 'codex' }] }));

function vault() {
  const files = new Map<string, string>();
  const file = { path: 'note.md' };
  files.set(file.path, '{==quote==}{>>User|2026-09-25|question: [@Codex](agent:11111111?notify) Explain<<}');
  const app = { vault: {
    adapter: { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p)!,
      write: async (p: string, v: string) => { files.set(p, v); }, mkdir: async (p: string) => { files.set(p, ''); } },
    cachedRead: async (f: { path: string }) => files.get(f.path)!, getMarkdownFiles: () => [file],
  } } as any;
  return { files, file, app };
}
describe('mention delivery durable callback outbox', () => {
  it('persists before invoking callbacks; retries failed enqueue after reload without another letter', async () => {
    const h = vault();
    const callback = vi.fn(async () => {
      expect(JSON.parse(h.files.get(STATE_PATH)!).pending).toHaveLength(1);
      throw new Error('job storage unavailable');
    });
    const settings = () => ({ enabled: true, mailboxRoot: 'Mailbox' });
    await new MentionDelivery(h.app, settings, () => {}, callback).scanFile(h.file);
    const letters = [...h.files.keys()].filter(k => k.startsWith('Mailbox/') && k.endsWith('.md'));
    expect(letters).toHaveLength(1);
    const resumed = vi.fn(async () => {});
    await new MentionDelivery(h.app, settings, () => {}, resumed).sweep();
    expect(resumed).toHaveBeenCalledTimes(1);
    expect([...h.files.keys()].filter(k => k.startsWith('Mailbox/') && k.endsWith('.md'))).toEqual(letters);
    expect(JSON.parse(h.files.get(STATE_PATH)!).pending).toHaveLength(0);
  });
  it('does not dispatch when saving the outbox fails', async () => {
    const h = vault(); const callback = vi.fn();
    const write = h.app.vault.adapter.write;
    h.app.vault.adapter.write = async (p: string, v: string) => { if (p === STATE_PATH) throw new Error('disk'); await write(p, v); };
    await expect(new MentionDelivery(h.app, () => ({ enabled: true, mailboxRoot: 'Mailbox' }), () => {}, callback).scanFile(h.file)).rejects.toThrow('disk');
    expect(callback).not.toHaveBeenCalled();
  });
  it('fails closed when state is corrupted, rather than resending every notification', async () => {
    const h = vault(); const callback = vi.fn(); h.files.set(STATE_PATH, '{broken');
    await expect(new MentionDelivery(h.app, () => ({ enabled: true, mailboxRoot: 'Mailbox' }), () => {}, callback).sweep()).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
});
