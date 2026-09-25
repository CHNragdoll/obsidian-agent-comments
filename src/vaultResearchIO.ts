import { nodeFsp, nodePath } from './node.ts';
import { parseResearchSources, type ResearchSource, type VaultResearch } from './vaultResearch.ts';

/** Verifies citations, not the agent's tool use or the semantic provenance claim. */
export async function verifyResearchSources(scope: VaultResearch, sources: ResearchSource[]): Promise<void> {
  parseResearchSources(JSON.stringify({ sources }), scope);
  const fs = nodeFsp(), path = nodePath();
  const root = await fs.realpath(scope.vaultRoot);
  for (const source of sources) {
    const real = await fs.realpath(path.join(root, source.path));
    const relative = path.relative(root, real);
    const normalized = relative.split(path.sep).join('/');
    // Apply exclusions again to the real path, including in-Vault symlink targets.
    parseResearchSources(JSON.stringify({ sources: [{ ...source, path: normalized }] }), scope);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Source leaves the allowed Vault');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Source is not a supported Markdown file (maximum 2 MiB)');
    const content = await fs.readFile(real, 'utf8');
    if (!content.replace(/\r\n/g, '\n').includes(source.excerpt.replace(/\r\n/g, '\n'))) {
      throw new Error('Source excerpt cannot be verified; the note may have changed');
    }
  }
}

export function formatResearchSources(sources: ResearchSource[]): string {
  if (!sources.length) return '';
  const literal = (text: string) => text.replace(/[\\`*_[\]{}()#!|<>]/g, '\\$&');
  return '\n\n' + sources.map(s => `[[${s.path.slice(0, -3)}]]\n\n${s.excerpt.split(/\r?\n/).map(line => '> ' + literal(line)).join('\n')}`).join('\n\n');
}
