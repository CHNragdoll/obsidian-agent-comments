import { beforeEach, describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { TFile } from 'obsidian';
import { CodexReplyService } from './codexReplyService';
import { buildAnnotationMarkup } from './parser';

const mocks=vi.hoisted(()=>({execFile:vi.fn(),mkdir:vi.fn(async()=>{}),realpath:vi.fn(async(p:string)=>p)}));
vi.mock('./atSelector.ts',()=>({loadRoster:async()=>[{mailbox:'PrivateMail'}]}));
vi.mock('obsidian',()=>({App:class{},Modal:class{},Notice:class{},Platform:{isDesktop:true},Setting:class{},TFile:class{path='';}}));
vi.mock('./node.ts',()=>({nodePath:()=>path,nodeCp:()=>({execFile:mocks.execFile}),nodeFsp:()=>({mkdir:mocks.mkdir,realpath:mocks.realpath})}));
const request={id:'a'.repeat(40),sessionId:'11111111-2222-4333-8444-555555555555',agentName:'Codex',notePath:'note.md',letterPath:'Mailbox/letter.md',highlight:'quote',
 comment:{author:'User',date:'today',type:'question',text:'Explain',commentId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}};
function fixture(copy=false){
 const files=new Map([['note.md',buildAnnotationMarkup('quote',[request.comment])]]);
 if(copy)files.set('copy.md',files.get('note.md')!);
 const file=(p:string)=>Object.assign(new TFile(),{path:p});
 const app={metadataCache:{getFileCache:()=>({links:[{link:'source#Result'}]}),getFirstLinkpathDest:()=>({path:'Sources/source.md'})},vault:{configDir:'Config',adapter:{basePath:'/tmp/vault'},getAbstractFileByPath:(p:string)=>files.has(p)?file(p):null,getMarkdownFiles:()=>[...files.keys()].map(file),read:async(f:TFile)=>files.get(f.path)!,cachedRead:async(f:TFile)=>files.get(f.path)!,process:vi.fn(async()=>{})}};
 const settings={enableCodexAutoReply:true,codexExecutable:'codex',enableCodexVaultResearch:false};
 const service=new CodexReplyService(app as any,'.obsidian/plugins/inline-comments',()=>settings);
 return {service,files,app,settings};
}
beforeEach(()=>{mocks.execFile.mockReset();mocks.execFile.mockImplementation((_e,args,_o,cb)=>cb(null,args.includes('--help')?'--thread --message':`Queued message aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee for thread ${request.sessionId}.`));});
describe('Codex adapter send/write boundaries',()=>{
 it('checks CLI capability before attempting a real queue',async()=>{const {service}=fixture();await (service as any).queue(request);expect(mocks.execFile.mock.calls[0][1]).toEqual(['queue','--help']);expect(mocks.execFile.mock.calls[1][1][0]).toBe('queue');});
 it('rejects an unsupported CLI before any comment is passed to it',async()=>{const {service}=fixture();mocks.execFile.mockImplementation((_e,_a,_o,cb)=>cb(null,'unsupported'));await expect((service as any).queue(request)).rejects.toMatchObject({code:'PRECHECK'});expect(mocks.execFile).toHaveBeenCalledTimes(1);});
 it('blocks a copied identity across files before dispatch and writeback',async()=>{const {service,app}=fixture(true);await expect((service as any).queue(request)).rejects.toMatchObject({code:'PRECHECK'});expect(mocks.execFile).toHaveBeenCalledTimes(1);await expect((service as any).apply(request)).rejects.toThrow();expect(app.vault.process).not.toHaveBeenCalled();});
 it('blocks changed and resolved threads before sending',async()=>{for(const change of ['changed','resolved']){const {service,files}=fixture();files.set('note.md',change==='changed'?buildAnnotationMarkup('quote',[{...request.comment,text:'edited'}]):files.get('note.md')+'{>>User|today|resolve: done<<}');await expect((service as any).queue(request)).rejects.toMatchObject({code:'PRECHECK'});}});
 it('captures explicit research opt-in and resolved links only for new requests',async()=>{
   const {service,settings}=fixture(); const enqueue=vi.spyOn(service.engine,'enqueue').mockResolvedValue();
   await service.enqueue(request); expect(enqueue.mock.calls[0][0].research).toBeUndefined();
   settings.enableCodexVaultResearch=true; await service.enqueue(request);
   expect(enqueue.mock.calls[1][0].research).toMatchObject({vaultRoot:'/tmp/vault',links:[{link:'source#Result',path:'Sources/source.md'}]});
   expect(enqueue.mock.calls[1][0].research?.excludedPaths).toEqual(expect.arrayContaining(['Config','PrivateMail']));
 });
 it('blocks unsent research after opt-out or Vault movement without dispatching a payload',async()=>{
   const {service,settings}=fixture(); const research={version:1,vaultRoot:'/tmp/vault',excludedPaths:[],links:[],linksTruncated:false};
   await expect((service as any).queue({...request,research})).rejects.toMatchObject({code:'PRECHECK'});
   settings.enableCodexVaultResearch=true;
   await expect((service as any).queue({...request,research:{...research,vaultRoot:'/different'}})).rejects.toMatchObject({code:'PRECHECK'});
   expect(mocks.execFile.mock.calls.every(c=>c[1].includes('--help'))).toBe(true);
 });
 it('rechecks opt-in after asynchronous preflight before starting the actual queue',async()=>{
   for(const flag of ['enableCodexVaultResearch','enableCodexAutoReply'] as const) {
     const {service,settings,app}=fixture(); settings.enableCodexVaultResearch=true;
     const research={version:1,vaultRoot:'/tmp/vault',excludedPaths:[],links:[],linksTruncated:false};
     const read=app.vault.cachedRead;
     app.vault.cachedRead=async file=>{settings[flag]=false; return read(file);};
     await expect((service as any).queue({...request,research})).rejects.toMatchObject({code:'PRECHECK'});
   }
   expect(mocks.execFile.mock.calls.every(c=>c[1].includes('--help'))).toBe(true);
 });
});
