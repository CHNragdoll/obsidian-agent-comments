/** Obsidian-bound half of the in-plugin mention scanner (see mentionDelivery.ts). */
import { t } from './i18n.ts';
import { nodeFsp, nodePath } from './node.ts';
import type { App, TFile } from 'obsidian';
import { parseAnnotations, identifyComment } from './parser.ts';
import { captureCommentContext, type CommentContext } from './commentContext.ts';
import type { CommentEntry } from './types.ts';
import { loadRoster, type RosterEntry } from './atSelector.ts';
import {
  DEFAULT_MAILBOX_ROOT,
  MENTION_RE,
  STATE_PATH,
  buildLetter,
  isScannable,
  mentionKey,
  skipReason,
  type Candidate,
  type DeliverySettings,
} from './mentionDelivery.ts';

interface DeliveryContext { key: string; highlight: string; comment: CommentEntry; snapshot?: CommentContext; predecessors?: string[] }
interface PendingDelivery { candidate: Candidate; relPath: string; letterPath: string; context: DeliveryContext }

export class MentionDelivery {
  private processed = new Set<string>();
  private loaded = false;
  private timers = new Map<string, number>();
  private sweeping = false;
  private inFlight = new Set<string>();
  private stopped = false;
  private initialTimer?: number;
  private pending = new Map<string, PendingDelivery>();
  private loading?: Promise<void>;
  private owners = new Map<string, string>();
  private scans = new Map<string, Promise<number>>();
  private warnings = new Set<string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private app: App,
    private settings: () => DeliverySettings,
    private notice: (msg: string) => void = () => {},
    private onDelivered: (c: Candidate, relPath: string, letterPath: string, context: DeliveryContext) => void | Promise<void> = () => {},
  ) {}

  private get mailboxRoot(): string {
    return (this.settings().mailboxRoot || DEFAULT_MAILBOX_ROOT).replace(/^\/+|\/+$/g, '');
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (!(await this.app.vault.adapter.exists(STATE_PATH))) { this.loaded = true; return; }
      const raw = await this.app.vault.adapter.read(STATE_PATH);
      const data = JSON.parse(raw) as { processed?: unknown; pending?: PendingDelivery[]; owners?: Record<string, string> };
      if (!Array.isArray(data.processed) || (data.pending !== undefined && !Array.isArray(data.pending))) throw new Error('Invalid mention delivery state');
      if (Array.isArray(data.processed)) this.processed = new Set(data.processed.filter((x) => typeof x === 'string'));
      if (Array.isArray(data.pending)) this.pending = new Map(data.pending.map(p => [p.context.key, p]));
      this.owners = new Map(Object.entries(data.owners ?? {}));
      this.loaded = true;
    })();
    try { await this.loading; } finally { this.loading = undefined; }
  }

  private async saveState(): Promise<void> {
    const save = this.saving.catch(() => {}).then(async () => {
      await this.mkdirp('_os');
      const payload = { processed: [...this.processed].sort(), pending: [...this.pending.values()], owners: Object.fromEntries(this.owners) };
      await this.app.vault.adapter.write(STATE_PATH + '.tmp', JSON.stringify(payload, null, 2) + '\n');
      const base = (this.app.vault.adapter as { basePath?: string }).basePath;
      if (base) {
        // DataAdapter.rename rejects existing destinations. The desktop Node
        // rename operation replaces the old state atomically instead.
        await nodeFsp().rename(nodePath().join(base, STATE_PATH + '.tmp'), nodePath().join(base, STATE_PATH));
      } else {
        // Mobile has no Node filesystem. Preserve the adapter's existing write
        // behavior and retain the temporary copy for manual recovery.
        await this.app.vault.adapter.write(STATE_PATH, JSON.stringify(payload, null, 2) + '\n');
      }
    });
    this.saving = save;
    return save;
  }

  // ── Triggers ───────────────────────────────────────────────────────────────

  /** Call once after plugin load: full sweep, delayed so the vault index is ready */
  init(delayMs = 4000): void {
    this.initialTimer = window.setTimeout(() => void this.sweep(false).catch(error => this.reportError(error)), delayMs);
  }

  dispose(): void {
    this.stopped = true;
    if (this.initialTimer) window.clearTimeout(this.initialTimer);
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  hasPending(id: string): boolean { return this.pending.has(id); }

  async renameNote(oldPath: string, newPath: string): Promise<void> {
    await this.loadState();
    for (const [id, path] of this.owners) if (path === oldPath) this.owners.set(id, newPath);
    for (const pending of this.pending.values()) if (pending.relPath === oldPath) pending.relPath = newPath;
    await this.saveState();
  }

  /** Debounced per-file rescan — call on vault `modify` */
  schedule(file: TFile): void {
    if (this.stopped || !this.settings().enabled) return;
    if (!isScannable(file.path, this.mailboxRoot)) return;
    const prev = this.timers.get(file.path);
    if (prev) window.clearTimeout(prev);
    this.timers.set(file.path, window.setTimeout(() => {
      this.timers.delete(file.path);
      void this.scanFile(file, true).catch(error => this.reportError(error));
    }, 1500));
  }

  /** Full vault sweep; returns number of letters delivered */
  async sweep(notice = true): Promise<number> {
    if (this.stopped || !this.settings().enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      await this.loadState();
      for (const pending of [...this.pending.values()]) {
        if (this.stopped || !this.settings().enabled) break;
        await this.notifyDelivered(pending);
      }
      const candidates = await this.loadCandidates();
      let delivered = 0;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!isScannable(file.path, this.mailboxRoot)) continue;
        delivered += await this.scanFileWith(file, candidates, true);
      }
      if (notice) this.notice(delivered > 0 ? t('已投递 {0} 封 @ 留言', [delivered]) : t('没有待投递的 @ 留言'));
      return delivered;
    } finally {
      this.sweeping = false;
    }
  }

  async scanFile(file: TFile, quiet = false): Promise<number> {
    if (this.stopped || !this.settings().enabled) return 0;
    await this.loadState();
    const candidates = await this.loadCandidates();
    return this.scanFileWith(file, candidates, quiet);
  }

  // ── Core ───────────────────────────────────────────────────────────────────

  private async loadCandidates(): Promise<{ byShort: Map<string, Candidate>; names: Set<string> }> {
    const entries: RosterEntry[] = await loadRoster(this.app);
    const byShort = new Map<string, Candidate>();
    const names = new Set<string>();
    for (const e of entries) {
      if (e.isAction) continue;
      names.add(e.name);
      const full = e.sessionId ?? e.shortId;
      const short = full.slice(0, 8).toLowerCase();
      const mailbox = e.mailbox && !e.mailbox.startsWith('/') && !e.mailbox.includes('..') ? e.mailbox : undefined;
      byShort.set(short, { name: e.name, sessionId: full, shortId: short, mailbox, harness: e.harness, cwd: e.cwd, autoStart: e.autoStart });
    }
    return { byShort, names };
  }

  private scanFileWith(file: TFile, candidates: { byShort: Map<string, Candidate>; names: Set<string> }, quiet: boolean): Promise<number> {
    const previous = this.scans.get(file.path) ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(() => this.scanFileOnce(file, candidates, quiet));
    this.scans.set(file.path, next);
    void next.finally(() => { if (this.scans.get(file.path) === next) this.scans.delete(file.path); }).catch(() => {});
    return next;
  }

  private reportError(error: unknown): void {
    if (!this.stopped) this.warnOnce(String(error), t('评论投递失败：{0}', [String(error)]));
  }

  private warnOnce(key: string, text: string): void {
    if (!this.warnings.has(key)) { this.warnings.add(key); this.notice(text); }
  }

  private async scanFileOnce(
    file: TFile,
    candidates: { byShort: Map<string, Candidate>; names: Set<string> },
    quiet: boolean,
  ): Promise<number> {
    let content: string;
    try { content = await this.app.vault.cachedRead(file); } catch { return 0; }
    if (!content.includes('](agent:')) return 0; // cheap pre-check

    const relPath = file.path;
    // Migrate only undelivered legacy notifications. Old processed hashes remain valid.
    const upgrades: Array<{ ann: ReturnType<typeof parseAnnotations>[number]; index: number }> = [];
    for (const ann of parseAnnotations(content)) {
      for (const [index, c] of ann.comments.entries()) {
        if (c.commentId) continue;
        const mentions = [...c.text.matchAll(MENTION_RE)];
        const historical = await Promise.all(mentions.filter(mm => mm[3]).map(mm => mentionKey(relPath, ann.highlightText, c.text, mm[2].toLowerCase())));
        if (historical.some(key => this.processed.has(key))) continue;
        for (const mm of c.text.matchAll(MENTION_RE)) {
          const shortId = mm[2].toLowerCase();
          if (skipReason({ name: mm[1], shortId, notify: !!mm[3] }, c, candidates.byShort.get(shortId), candidates.names)) continue;
          if (!this.processed.has(await mentionKey(relPath, ann.highlightText, c.text, shortId))) {
            upgrades.push({ ann, index }); break;
          }
        }
      }
    }
    if (upgrades.length) {
      const expected = content;
      let migrated = false;
      content = await this.app.vault.process(file, current => {
        if (current !== expected) return current; // Never apply offsets from an older revision.
        migrated = true;
        for (const { ann, index } of upgrades.reverse()) current = identifyComment(current, ann, index, crypto.randomUUID());
        return current;
      });
      if (!migrated) return 0;
    }
    const annotations = parseAnnotations(content);
    const idCounts = new Map<string, number>();
    for (const ann of annotations) for (const c of ann.comments) if (c.commentId) idCounts.set(c.commentId, (idCounts.get(c.commentId) ?? 0) + 1);
    let delivered = 0;
    let dirty = false;

    for (const ann of annotations) {
      for (const [commentIndex, c] of ann.comments.entries()) {
        for (const mm of c.text.matchAll(MENTION_RE)) {
          const m = { name: mm[1], shortId: mm[2].toLowerCase(), notify: mm[3] !== undefined };
          const candidate = candidates.byShort.get(m.shortId);
          if (skipReason(m, c, candidate, candidates.names)) continue;

          if (c.commentId && idCounts.get(c.commentId) !== 1) {
            this.warnOnce(c.commentId, t('评论身份重复，请重新创建复制的评论：{0}', [relPath])); continue;
          }
          const owner = c.commentId ? this.owners.get(c.commentId) : undefined;
          if (owner && owner !== relPath && await this.app.vault.adapter.exists(owner)) {
            this.warnOnce(c.commentId!, t('评论身份重复，请重新创建复制的评论：{0}', [relPath])); continue;
          }
          if (c.commentId) this.owners.set(c.commentId, relPath);
          const key = await mentionKey(relPath, ann.highlightText, c.text, m.shortId, c.commentId);
          if (this.processed.has(key) || this.inFlight.has(key) || this.stopped) continue;
          this.inFlight.add(key);

          try {
            const now = new Date();
            const letter = buildLetter(candidate!.sessionId, relPath, ann.highlightText, c.text, c.author, c.date, now, candidate!.name);
            const written = await this.writeLetter(candidate!, relPath, letter, key, now);
            if (written) {
              this.processed.add(key);
              dirty = true;
              delivered++;
              const predecessors: string[] = [];
              for (const earlier of ann.comments.slice(0, commentIndex)) {
                for (const mention of earlier.text.matchAll(MENTION_RE)) {
                  if (mention[2].toLowerCase() === m.shortId && mention[3]) {
                    const priorKey = await mentionKey(relPath, ann.highlightText, earlier.text, m.shortId, earlier.commentId);
                    if (!ann.comments.some(reply => reply.replyId === priorKey)) predecessors.push(priorKey);
                  }
                }
              }
              const delivery = { candidate: candidate!, relPath, letterPath: written, context: { key, highlight: ann.highlightText, comment: c,
                predecessors, snapshot: candidate!.harness === 'codex' ? captureCommentContext(content, ann, commentIndex) : undefined } };
              this.pending.set(key, delivery);
              // Durable outbox before invoking a callback with external effects.
              await this.saveState();
              if (!quiet) this.notice(t('已投信给 @{0}', [m.name]));
              await this.notifyDelivered(delivery);
            }
          } finally { this.inFlight.delete(key); }
        }
      }
    }
    if (dirty) await this.saveState();
    if (delivered > 0 && quiet) this.notice(t('已投信 {0} 封（{1}）', [delivered, relPath.split('/').pop()]));
    return delivered;
  }

  private async notifyDelivered(delivery: PendingDelivery): Promise<void> {
    if (this.stopped) return;
    try {
      await this.onDelivered(delivery.candidate, delivery.relPath, delivery.letterPath, delivery.context);
      this.pending.delete(delivery.context.key);
      await this.saveState();
    } catch (error) {
      this.notice(t('投信成功，但自动回复未启动：{0}', [String((error as Error).message ?? error)]));
    }
  }

  /** Create-without-overwrite; returns the vault path written */
  private async writeLetter(c: Candidate, relPath: string, letter: string, key: string, now: Date): Promise<string | null> {
    const dir = (c.mailbox ?? `${this.mailboxRoot}/${c.shortId}`).replace(/\/+$/, '');
    const adapter = this.app.vault.adapter;
    const path = `${dir}/comment-${key}.md`;
    const tagged = letter.replace('from: comment-scanner', `from: comment-scanner\nrequest_key: ${key}`);
    try {
      await this.mkdirp(dir);
      // Stable path closes the crash gap between letter creation and outbox save.
      if (await adapter.exists(path)) {
        const existing = await adapter.read(path);
        if (!existing.includes(`request_key: ${key}\n`) || !existing.includes(`to: ${c.sessionId}\n`)) {
          throw new Error('Existing mailbox letter does not match this request');
        }
      } else await adapter.write(path, tagged);
      return path;
    } catch (err) {
      console.error(t('[ilc] 投信失败'), dir, err);
      this.notice(t('投信失败：{0}（{1}）', [dir, String((err as Error)?.message ?? err)]));
    }
    return null;
  }

  private async mkdirp(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
  }
}
