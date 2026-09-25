import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexReplyService } from './codexReplyService';
import { validateRequest, type CodexJob } from './codexReply';
vi.mock('obsidian',()=>({App:class{},Modal:class{},Notice:class{},Platform:{isDesktop:true},Setting:class{},TFile:class{}}));
vi.mock('./atSelector.ts',()=>({loadRoster:async()=>[]}));

it('round-trips a valid large Chinese research job above the previous 200 KB limit', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'ilc-storage-'));
  const pluginDir='.obsidian/plugins/inline-comments';
  const service=new CodexReplyService({vault:{adapter:{basePath:root}}} as any,pluginDir,()=>({enableCodexAutoReply:true,codexExecutable:'codex'}));
  const job:CodexJob={id:'a'.repeat(40),sessionId:'11111111-2222-4333-8444-555555555555',agentName:'Codex',notePath:'笔记.md',letterPath:'Mailbox/letter.md',highlight:'文'.repeat(18500),comment:{author:'人',date:'2026-09-25',type:'question',text:'问'.repeat(19000)},research:{version:1,vaultRoot:root,excludedPaths:[],links:[],linksTruncated:false},version:1,state:'applying',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),reply:'答'.repeat(20000),sources:Array.from({length:8},(_,i)=>({path:`来源${i}.md`,excerpt:'据'.repeat(1200)}))};
  try {
    validateRequest(job);
    await (service as any).save(job);
    expect((await stat(path.join(root,pluginDir,'codex-jobs',job.id+'.json'))).size).toBeGreaterThan(200000);
    expect(await (service as any).load()).toEqual([job]);
    await expect((service as any).save({...job,reply:'字'.repeat(400000)})).rejects.toThrow('storage limit');
    expect(await (service as any).load()).toEqual([job]);
  } finally {await rm(root,{recursive:true,force:true});}
});
