import { it, expect, vi } from 'vitest';
import { CommentPanel } from './CommentPanel';

vi.mock('obsidian', () => ({ ItemView: class {}, MarkdownView: class {}, TFile: class {}, WorkspaceLeaf: class {}, MarkdownRenderer: {}, Menu: class {} }));
vi.mock('./HistoryModal.ts', () => ({ HistoryModal: class {} }));
vi.mock('../atSelector.ts', () => ({ attachAtSelector() {} }));

it('ignores a stale asynchronous refresh instead of appending duplicate cards', async () => {
  const file = { path: 'test.md', extension: 'md' };
  const reads: Array<(s: string) => void> = [];
  const cards: string[] = [];
  vi.stubGlobal('window', { requestAnimationFrame() {}, setTimeout() {} });
  const panel = {
    refreshGeneration: 0, currentFilePath: file.path, draft: null,
    app: { workspace: { getActiveFile: () => file }, vault: { read: () => new Promise<string>(resolve => reads.push(resolve)) } },
    plugin: { settings: { showResolved: true } },
    cardsZone: { empty: () => { cards.length = 0; } }, cardEls: new Map(),
    updateHeader() {}, currentCm() {}, attachPreview() {}, computePositionsFromEditor() {}, layoutCards() {},
    renderCard: (_zone: unknown, ann: { highlightText: string }) => { cards.push(ann.highlightText); return {}; },
  };
  const first = CommentPanel.prototype.refresh.call(panel as any);
  const second = CommentPanel.prototype.refresh.call(panel as any);
  reads[1]('{==new==}{>>User|2026-09-25|note: new<<}'); await second;
  reads[0]('{==old==}{>>User|2026-09-25|note: old<<}'); await first;
  expect(cards).toEqual(['new']);
  vi.unstubAllGlobals();
});
