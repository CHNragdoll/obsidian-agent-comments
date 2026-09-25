import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allowedResearchPath, captureVaultResearch, parseResearchSources, validateVaultResearch } from './vaultResearch';
import { formatResearchSources, verifyResearchSources } from './vaultResearchIO';

const scope = captureVaultResearch('/tmp/vault', 'Custom inbox', [], () => undefined, ['Config', 'MemberMailbox']);

describe('Vault research scope and source evidence', () => {
  it('uses resolved paths for same-name notes, aliases and heading/block links', () => {
    const paths: Record<string, string> = { 'Source': 'Project/Source.md', '../Other/Source': 'Other/Source.md', 'Private': 'Custom inbox/secret.md', 'PDF': 'data.pdf' };
    const s = captureVaultResearch('/tmp/vault', 'Custom inbox', ['Source#Result', 'Source#^result', '../Other/Source', 'Private', 'PDF'].map(link => ({link})), link => paths[link]);
    expect(s.links).toEqual([{link:'Source#Result',path:'Project/Source.md'},{link:'Source#^result',path:'Project/Source.md'},{link:'../Other/Source',path:'Other/Source.md'}]);
  });
  it('bounds the link map and rejects unsafe or excluded evidence paths', () => {
    const s=captureVaultResearch('/tmp/vault','Inbox',Array.from({length:60},(_,i)=>({link:`note${i}`})),link=>link+'.md');
    expect(s.links).toHaveLength(32); expect(s.linksTruncated).toBe(true);
    for(const p of ['../outside.md','/outside.md','A/../../out.md','a\\b.md','.obsidian/data.md','A/.secret/x.md','_os/x.md','Custom inbox/a.md','Config/settings.md','MemberMailbox/x.md']) {
      expect(allowedResearchPath(p,scope.excludedPaths)).toBe(false);
      expect(()=>parseResearchSources(JSON.stringify({sources:[{path:p,excerpt:'x'}]}),scope)).toThrow();
    }
    expect(()=>validateVaultResearch({...scope,vaultRoot:'relative'})).toThrow();
    expect(()=>parseResearchSources('{"sources":null}',scope)).toThrow();
    expect(parseResearchSources('{"sources":[]}',scope)).toEqual([]);
  });
  it('verifies exact live excerpts and rejects changed, missing and symlink-escaped sources', async () => {
    const base=await mkdtemp(path.join(tmpdir(),'ilc-research-'));
    const root=path.join(base,'vault'); await mkdir(root);
    const s={...scope,vaultRoot:root};
    await writeFile(path.join(root,'Source.md'),'## Result\r\nOrchid ratio: 73.41%.\r\n');
    const evidence=[{path:'Source.md',excerpt:'## Result\nOrchid ratio: 73.41%.'}];
    try {
      await expect(verifyResearchSources(s,evidence)).resolves.toBeUndefined();
      await expect(verifyResearchSources(s,[{path:'missing.md',excerpt:'x'}])).rejects.toThrow();
      await writeFile(path.join(root,'Source.md'),'Changed');
      await expect(verifyResearchSources(s,evidence)).rejects.toThrow('cannot be verified');
      await writeFile(path.join(base,'external.md'),'secret');
      await symlink(path.join(base,'external.md'),path.join(root,'escape.md'));
      await expect(verifyResearchSources(s,[{path:'escape.md',excerpt:'secret'}])).rejects.toThrow();
      await mkdir(path.join(root,'Config')); await writeFile(path.join(root,'Config/secret.md'),'secret');
      await symlink(path.join(root,'Config/secret.md'),path.join(root,'inside.md'));
      await expect(verifyResearchSources(s,[{path:'inside.md',excerpt:'secret'}])).rejects.toThrow();
    } finally {await rm(base,{recursive:true,force:true});}
  });
  it('renders verified paths as wikilinks but keeps excerpt Markdown inert', () => {
    const text=formatResearchSources([{path:'来源/实验.md',excerpt:'![image](https://example.com/track)\n<script>payload</script>'}]);
    expect(text).toContain('[[来源/实验]]'); expect(text).not.toContain('![image]'); expect(text).not.toContain('<script>');
  });
});
