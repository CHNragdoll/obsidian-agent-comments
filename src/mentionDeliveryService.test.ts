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
      rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      write: async (p: string, v: string) => { files.set(p, v); }, mkdir: async (p: string) => { files.set(p, ''); } },
    process: async (f: { path: string }, fn: (s: string) => string) => { const content = fn(files.get(f.path)!); files.set(f.path, content); return content; },
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
    h.app.vault.adapter.write = async (p: string, v: string) => { if (p === STATE_PATH + '.tmp') throw new Error('disk'); await write(p, v); };
    await expect(new MentionDelivery(h.app, () => ({ enabled: true, mailboxRoot: 'Mailbox' }), () => {}, callback).scanFile(h.file)).rejects.toThrow('disk');
    expect(callback).not.toHaveBeenCalled();
  });
  it('fails closed when state is corrupted, rather than resending every notification', async () => {
    const h = vault(); const callback = vi.fn(); h.files.set(STATE_PATH, '{broken');
    await expect(new MentionDelivery(h.app, () => ({ enabled: true, mailboxRoot: 'Mailbox' }), () => {}, callback).sweep()).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
});


it('persists the same context through outbox recovery even when nearby prose changes', async () => {
  const h = vault();
  h.files.set(h.file.path, 'Before: reference code LIME-572.\n' + h.files.get(h.file.path) + '\nAfter: deadline Friday.');
  const callback = vi.fn(async () => { throw new Error('unavailable'); });
  const settings = () => ({ enabled: true, mailboxRoot: 'Mailbox' });
  await new MentionDelivery(h.app, settings, () => {}, callback).scanFile(h.file);
  const original = (callback.mock.calls[0] as unknown as any[])[3];
  expect(original.snapshot.before).toContain('LIME-572');
  expect(original.snapshot.after).toContain('Friday');
  h.files.set(h.file.path, h.files.get(h.file.path)!.replace('LIME-572', 'CHANGED'));
  const resumed = vi.fn();
  await new MentionDelivery(h.app, settings, () => {}, resumed).sweep();
  expect(resumed).toHaveBeenCalledTimes(1);
  expect(resumed.mock.calls[0][3]).toEqual(original);
});

it('gives two identical-looking legacy comments distinct identities and stable deliveries', async () => {
  const h = vault(); const raw = h.files.get(h.file.path)!;
  h.files.set(h.file.path, raw + '\n\n' + raw);
  const callback = vi.fn(); const service = new MentionDelivery(h.app, () => ({enabled:true,mailboxRoot:'Mailbox'}), () => {}, callback);
  await Promise.all([service.scanFile(h.file), service.scanFile(h.file)]);
  expect(callback).toHaveBeenCalledTimes(2);
  const contexts = callback.mock.calls.map(c => c[3]);
  expect(contexts[0].key).not.toBe(contexts[1].key);
  expect(contexts.every(c => c.comment.commentId)).toBe(true);
  await service.scanFile(h.file);
  expect(callback).toHaveBeenCalledTimes(2);
});

it('does not migrate or replay historical processed notifications', async () => {
  const { mentionKey } = await import('./mentionDelivery');
  const { parseAnnotations } = await import('./parser');
  const h = vault(); const raw = h.files.get(h.file.path)!;
  const ann = parseAnnotations(raw)[0];
  h.files.set(STATE_PATH, JSON.stringify({processed:[await mentionKey(h.file.path,ann.highlightText,ann.comments[0].text,'11111111')]}));
  const cb = vi.fn();
  await new MentionDelivery(h.app,()=>({enabled:true,mailboxRoot:'Mailbox'}),()=>{},cb).scanFile(h.file);
  expect(cb).not.toHaveBeenCalled();
  expect(h.files.get(h.file.path)).toBe(raw);
});

it('ignores code examples without changing their bytes or sending notifications', async () => {
  const h=vault(); const raw='```md\n'+h.files.get(h.file.path)+'\n```'; h.files.set(h.file.path,raw);
  const cb=vi.fn(); await new MentionDelivery(h.app,()=>({enabled:true,mailboxRoot:'Mailbox'}),()=>{},cb).scanFile(h.file);
  expect(cb).not.toHaveBeenCalled(); expect(h.files.get(h.file.path)).toBe(raw);
});

it('blocks copied identities and warns instead of silently sending to an ambiguous anchor', async () => {
  const h=vault(); const cb=vi.fn(), notice=vi.fn();
  const service=new MentionDelivery(h.app,()=>({enabled:true,mailboxRoot:'Mailbox'}),notice,cb);
  await service.scanFile(h.file);
  const identified=h.files.get(h.file.path)!;
  h.files.set(h.file.path,identified+'\n'+identified);
  await service.scanFile(h.file);
  expect(cb).toHaveBeenCalledTimes(1); expect(notice.mock.calls.flat().join(' ')).toContain('身份重复');
});

it('migrates legacy-format metadata only once without changing displayed text', async () => {
  const h=vault(); h.files.set(h.file.path,'{==quote==}{>>User|2026-09-25: [@Codex](agent:11111111?notify) Explain<<}');
  const cb=vi.fn(); const service=new MentionDelivery(h.app,()=>({enabled:true,mailboxRoot:'Mailbox'}),()=>{},cb);
  await service.scanFile(h.file); const saved=h.files.get(h.file.path);
  await service.scanFile(h.file); await service.scanFile(h.file);
  expect(cb).toHaveBeenCalledTimes(1); expect(h.files.get(h.file.path)).toBe(saved);
  expect(cb.mock.calls[0][3].comment.text).toBe('[@Codex](agent:11111111?notify) Explain');
});

it('reuses a letter after a crash before outbox state persisted, without creating another letter', async () => {
  const h=vault(), cb=vi.fn(); const write=h.app.vault.adapter.write;
  h.app.vault.adapter.write=async (p:string,v:string)=>{if(p===STATE_PATH+'.tmp')throw new Error('disk');await write(p,v);};
  const settings=()=>({enabled:true,mailboxRoot:'Mailbox'});
  await expect(new MentionDelivery(h.app,settings,()=>{},cb).scanFile(h.file)).rejects.toThrow('disk');
  const letters=()=>[...h.files.keys()].filter(p=>p.startsWith('Mailbox/')&&p.endsWith('.md'));
  expect(letters()).toHaveLength(1); expect(cb).not.toHaveBeenCalled();
  h.app.vault.adapter.write=write;
  await new MentionDelivery(h.app,settings,()=>{},cb).scanFile(h.file);
  expect(letters()).toHaveLength(1); expect(cb).toHaveBeenCalledTimes(1);
});


it('does not redeliver an already-notified suggestion after acceptance', async () => {
  const { applySuggestion } = await import('./parser');
  const h=vault(); h.files.set(h.file.path,h.files.get(h.file.path)!.replace('|question:', '|suggest:').replace('|note:', '|suggest:'));
  const cb=vi.fn(); const service=new MentionDelivery(h.app,()=>({enabled:true,mailboxRoot:'Mailbox'}),()=>{},cb);
  await service.scanFile(h.file);
  const before=h.files.get(h.file.path)!; const after=applySuggestion(before,before.indexOf('{=='),0);
  expect(after).not.toBe(before);
  h.files.set(h.file.path,after); await service.scanFile(h.file);
  expect(cb).toHaveBeenCalledTimes(1);
});


it('replaces existing desktop state atomically without using DataAdapter.rename', async () => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'ilc-state-'));
  const h=vault(); const adapter=h.app.vault.adapter;
  const mapWrite=adapter.write, mapRead=adapter.read, mapExists=adapter.exists;
  adapter.basePath=base;
  adapter.write=async(p:string,v:string)=>{if(p.startsWith('_os/')){await fs.mkdir(path.join(base,'_os'),{recursive:true});await fs.writeFile(path.join(base,p),v);}else await mapWrite(p,v);};
  adapter.read=async(p:string)=>p.startsWith('_os/')?fs.readFile(path.join(base,p),'utf8'):mapRead(p);
  adapter.exists=async(p:string)=>p.startsWith('_os/')?fs.access(path.join(base,p)).then(()=>true,()=>false):mapExists(p);
  adapter.rename=vi.fn(async()=>{throw new Error('Destination already exists');});
  const cb=vi.fn(),settings=()=>({enabled:true,mailboxRoot:'Mailbox'});
  try {
    await adapter.write(STATE_PATH,JSON.stringify({processed:[],pending:[]}));
    await new MentionDelivery(h.app,settings,()=>{},cb).scanFile(h.file);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(base,STATE_PATH),'utf8')).pending).toHaveLength(0);
    await new MentionDelivery(h.app,settings,()=>{},cb).sweep();
    expect(cb).toHaveBeenCalledTimes(1); expect(adapter.rename).not.toHaveBeenCalled();
  } finally { await fs.rm(base,{recursive:true,force:true}); }
});
