import { App, Modal, Notice, Platform, Setting, TFile } from 'obsidian';
import { parseAnnotations, isResolved } from './parser.ts';
import { t } from './i18n.ts';
import { nodeCp, nodeFsp, nodePath } from './node.ts';
import { loadRoster } from './atSelector.ts';
import { allowedResearchPath, captureVaultResearch } from './vaultResearch.ts';
import { formatResearchSources, verifyResearchSources } from './vaultResearchIO.ts';
import { applyCodexReply, locateComment, buildCodexPrompt, CodexReplyEngine, type CodexJob, type CodexRequest } from './codexReply.ts';

const MAX_JOB_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface CodexReplySettings {
  enableCodexAutoReply: boolean;
  codexExecutable: string;
  enableCodexVaultResearch?: boolean;
  mailboxRoot?: string;
}

/** Node APIs are loaded lazily; this module is safe to import on mobile. */
export class CodexReplyService {
  readonly engine: CodexReplyEngine;
  private stopped = false;
  private lastError = '';
  private checkedExecutable?: string;
  private polling = false;
  constructor(private app: App, private pluginDir: string, private settings: () => CodexReplySettings) {
    this.engine = new CodexReplyEngine({
      load: () => this.load(), save: j => this.save(j), queue: j => this.queue(j),
      response: j => this.response(j), apply: j => this.apply(j), markLetter: j => this.markLetter(j),
      notice: msg => { if (!this.stopped) new Notice(t(msg)); },
    }, () => this.enabled());
  }
  private enabled(): boolean { return Platform.isDesktop && !this.stopped && this.settings().enableCodexAutoReply; }
  stop(): void { this.stopped = true; this.engine.stop(); }
  async enqueue(request: CodexRequest): Promise<void> {
    if (!this.enabled()) return;
    if (this.settings().enableCodexVaultResearch) {
      const file = this.app.vault.getAbstractFileByPath(request.currentNotePath ?? request.notePath);
      const base = (this.app.vault.adapter as { basePath?: string }).basePath;
      if (!(file instanceof TFile) || !base) throw new Error('Research requires the current note and desktop Vault');
      const cache = this.app.metadataCache.getFileCache(file);
      const roster = await loadRoster(this.app);
      const extraExcluded = [this.app.vault.configDir, ...roster.map(member => member.mailbox ?? '')].filter(Boolean);
      request = { ...request, research: captureVaultResearch(base, this.settings().mailboxRoot ?? 'Agent协作空间/信箱',
        [...(cache?.links ?? []), ...(cache?.embeds ?? [])],
        link => this.app.metadataCache.getFirstLinkpathDest(link, file.path)?.path, extraExcluded) };
    }
    return this.engine.enqueue(request);
  }
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try { await this.engine.poll(); this.lastError = ''; }
    catch (error) {
      const message = String((error as Error).message ?? error);
      if (message !== this.lastError && !this.stopped) new Notice(t('Codex 自动回复错误：{0}', [message]));
      this.lastError = message;
    } finally { this.polling = false; }
  }
  private root(): string {
    const base = (this.app.vault.adapter as { basePath?: string }).basePath;
    if (!base) throw new Error('Codex auto reply requires a desktop filesystem vault');
    return nodePath().join(base, this.pluginDir, 'codex-jobs');
  }
  private async prepare(): Promise<string> {
    const root = this.root();
    await nodeFsp().mkdir(nodePath().join(root, 'responses'), { recursive: true });
    return root;
  }
  private async load(): Promise<CodexJob[]> {
    if (!Platform.isDesktop) return [];
    const root = await this.prepare();
    const jobs: CodexJob[] = [];
    for (const name of await nodeFsp().readdir(root)) {
      if (!/^[a-f0-9]{40}\.json$/.test(name)) continue;
      const raw = await this.readFile(nodePath().join(root, name), MAX_JOB_BYTES);
      if (raw === null) continue;
      const job = JSON.parse(raw) as CodexJob;
      if (job.id !== name.slice(0, -5)) throw new Error(`Codex job ID does not match filename: ${name}`);
      jobs.push(job);
    }
    return jobs;
  }
  private async save(job: CodexJob): Promise<void> {
    const root = await this.prepare();
    const path = nodePath().join(root, `${job.id}.json`);
    // Atomic rename leaves either the previous durable state or the new one.
    const serialized = JSON.stringify(job, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOB_BYTES) throw new Error('Codex job exceeds the durable storage limit');
    await nodeFsp().writeFile(`${path}.tmp`, serialized, { encoding: 'utf8', mode: 0o600 });
    await nodeFsp().rename(`${path}.tmp`, path);
  }
  private async readFile(path: string, maxBytes = MAX_RESPONSE_BYTES): Promise<string | null> {
    try {
      const stat = await nodeFsp().lstat(path);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid or oversized Codex response/state file');
      return await nodeFsp().readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
  private responsePath(job: CodexJob): string { return nodePath().join(this.root(), 'responses', `${job.id}.json`); }
  private response(job: CodexJob): Promise<string | null> { return this.readFile(this.responsePath(job)); }
  private async assertUniqueIdentity(job: CodexJob): Promise<void> {
    if (!job.comment.commentId) return;
    let matches = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      if (!content.includes(job.comment.commentId)) continue;
      for (const ann of parseAnnotations(content)) {
        matches += ann.comments.filter(c => c.commentId === job.comment.commentId).length;
        if (matches > 1) throw new Error(t('评论身份重复，请重新创建复制的评论：{0}', [file.path]));
      }
    }
    if (matches !== 1) throw new Error('Original comment identity no longer exists in the vault');
  }
  async checkSetup(): Promise<void> {
    if (!Platform.isDesktop) throw new Error(t('仅桌面端可用。'));
    const executable = this.settings().codexExecutable.trim() || 'codex';
    await new Promise<void>((resolve, reject) => {
      const path = nodePath();
      nodeCp().execFile(executable, ['queue', '--help'], {
        timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true,
        env: { ...process.env, PATH: [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter) },
      }, (error: unknown, stdout: string) => {
        if (error || !stdout.includes('--thread') || !stdout.includes('--message')) {
          reject(Object.assign(new Error(t('Codex CLI 不可用或不支持 queue，请检查可执行文件路径。')), { code: 'PRECHECK' }));
        } else resolve();
      });
    });
    this.checkedExecutable = executable;
  }
  private async queue(job: CodexJob): Promise<string> {
    await this.prepare();
    const executable = this.settings().codexExecutable.trim() || 'codex';
    if (this.checkedExecutable !== executable) await this.checkSetup();
    const file = this.app.vault.getAbstractFileByPath(job.currentNotePath ?? job.notePath);
    try {
      if (!(file instanceof TFile)) throw new Error('Original note no longer exists');
      if (job.research) {
        if (!this.settings().enableCodexVaultResearch) throw new Error(t('跨笔记查找已关闭，此请求尚未发送。'));
        const base = (this.app.vault.adapter as { basePath?: string }).basePath;
        if (!base || await nodeFsp().realpath(base) !== await nodeFsp().realpath(job.research.vaultRoot)) throw new Error('Research Vault moved; create a new comment in the current Vault');
        if (!allowedResearchPath(file.path, job.research.excludedPaths)) throw new Error('Current note is outside the allowed research scope');
      }
      await this.assertUniqueIdentity(job);
      if (isResolved(locateComment(await this.app.vault.read(file), job))) throw new Error('Thread is already resolved');
    } catch (error) { throw Object.assign(new Error(String((error as Error).message ?? error)), { code: 'PRECHECK' }); }
    const prompt = buildCodexPrompt(job, this.responsePath(job));
    if ((process.platform === 'win32' && prompt.length > 28000) || Buffer.byteLength(prompt, 'utf8') > 120000) {
      throw Object.assign(new Error(t('上下文超过本机命令长度限制，请缩短问题后重新发送。')), { code: 'PRECHECK' });
    }
    const path = nodePath();
    const env = { ...process.env, PATH: [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter) };
    // File reads/preflight can yield long enough for the user to revoke opt-in.
    // Recheck synchronously immediately before starting the external command.
    if (!this.enabled() || (job.research && !this.settings().enableCodexVaultResearch)) {
      throw Object.assign(new Error('Automatic replies or cross-note research were disabled before dispatch'), { code: 'PRECHECK' });
    }
    return new Promise((resolve, reject) => {
      nodeCp().execFile(executable, ['queue', '--thread', job.sessionId, '--message', prompt], {
        cwd: (this.app.vault.adapter as any).basePath, env, timeout: 20000, maxBuffer: 256 * 1024, windowsHide: true,
      }, (error: any, stdout: string) => {
        if (error) {
          // Do not echo the command (which contains private comment data).
          const failure = new Error(`codex queue failed (${error.code ?? 'unknown'}). Check CLI login, queue support and task availability.`);
          Object.assign(failure, { code: error.code }); reject(failure); return;
        }
        const receipt = stdout.match(/Queued message ([a-f0-9-]+) for thread ([a-f0-9-]+)\./i);
        if (!receipt || receipt[2].toLowerCase() !== job.sessionId.toLowerCase()) {
          reject(new Error('Queue receipt could not be verified. Check the Codex task before sending another comment.')); return;
        }
        resolve(receipt[1]);
      });
    });
  }
  private async apply(job: CodexJob): Promise<void> {
    await this.assertUniqueIdentity(job);
    const file = this.app.vault.getAbstractFileByPath(job.currentNotePath ?? job.notePath);
    if (!(file instanceof TFile)) throw new Error('Original note no longer exists at its recorded path');
    if (job.research && !locateComment(await this.app.vault.read(file), job).comments.some(c => c.replyId === job.id)) {
      const base = (this.app.vault.adapter as { basePath?: string }).basePath;
      if (!base || await nodeFsp().realpath(base) !== await nodeFsp().realpath(job.research.vaultRoot)) throw new Error('Research Vault no longer matches the request');
      if (!job.sources) throw new Error('Research response is missing source evidence');
      await verifyResearchSources(job.research, job.sources);
    }
    await this.app.vault.process(file, content => {
      if (!this.enabled()) throw new Error('Automatic replies are paused');
      return applyCodexReply(content, job, job.reply! + (job.research ? formatResearchSources(job.sources ?? []) : ''), job.replyDate!);
    });
  }
  private async markLetter(job: CodexJob): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(job.letterPath);
    // Removing the mailbox letter is a user action; it should not undo a reply.
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, content => content.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_all, start, yaml, end) =>
      start + yaml.replace(/^status:.*$/m, 'status: 已回复') + end));
  }
  showStatus(): void { new CodexStatusModal(this.app, this.engine).open(); }
}

class CodexStatusModal extends Modal {
  constructor(app: App, private engine: CodexReplyEngine) { super(app); }
  onOpen(): void { void this.render(); }
  onClose(): void { this.contentEl.empty(); }
  private async render(): Promise<void> {
    const el = this.contentEl; el.empty();
    el.createEl('h2', { text: t('Codex 自动回复状态') });
    el.createEl('p', { text: t('关闭自动回复会暂停投递和写回；已排队的 Codex 任务仍可能运行。不确定是否已发送的请求不会自动重发。') });
    const buttons = new Setting(el);
    buttons.addButton(b => b.setButtonText(t('刷新')).onClick(() => void this.render()));
    buttons.addButton(b => b.setButtonText(t('重新检查已保留的回复')).onClick(async () => {
      try { await this.engine.poll(true); } catch (e) { new Notice(String(e)); }
      await this.render();
    }));
    try {
      const jobs = await this.engine.snapshot();
      if (!jobs.length) el.createEl('p', { text: t('暂无自动回复请求。开启后新投递的 Codex 通知会显示在这里。') });
      const labels: Record<string, string> = { waiting: '等待前一条评论', dispatching: '正在发送', queued: '等待 Codex 回答', uncertain: '发送结果待确认', failed: '未能发送', applying: '正在写回', blocked: '回复已保留', complete: '已回复' };
      for (const job of jobs.slice(0, 50)) {
        el.createEl('h3', { text: `${t(labels[job.state] ?? job.state)} · ${job.notePath}` });
        el.createEl('p', { text: `${job.agentName} · ${job.sessionId} · ${new Date(job.createdAt).toLocaleString()}` });
        if (job.error) el.createEl('p', { text: job.error });
        el.createEl('p', { text: t(job.research ? '跨笔记查找：已为本请求开启；来源按回答时的笔记内容核对。' : '跨笔记查找：未为本请求开启，仅使用上下文快照。') });
        for (const source of job.sources ?? []) el.createEl('pre', { cls: 'ilc-codex-recovery-text', text: `${source.path}\n${source.excerpt}` });
        const context = el.createEl('details');
        context.createEl('summary', { text: t('发送的上下文') });
        context.createEl('h4', { text: t('本次问题') });
        context.createEl('p', { text: job.comment.text });
        context.createEl('h4', { text: t('附近正文与引用') });
        context.createEl('pre', { cls: 'ilc-codex-recovery-text', text: `${job.context?.before ?? ''}【${job.highlight}】${job.context?.after ?? ''}` });
        if (job.context) {
          context.createEl('h4', { text: t('此前讨论') });
          for (const entry of job.context.thread) context.createEl('p', { text: `${entry.author} · ${entry.date}${entry.truncated ? ' · ' + t('已截断') : ''}\n${entry.text}` });
          if (job.context.truncatedBefore || job.context.truncatedAfter || job.context.omittedComments) {
            context.createEl('p', { text: t('部分正文或历史讨论因长度限制未包含。') });
          }
        }
        for (const reply of job.precedingReplies ?? []) context.createEl('p', { text: `${t('等待期间补充的回复')} · ${reply.author}${reply.truncated ? ' · ' + t('已截断') : ''}\n${reply.text}` });
        const raw = context.createEl('details');
        raw.createEl('summary', { text: t('原始数据') });
        raw.createEl('pre', { cls: 'ilc-codex-recovery-text', text: JSON.stringify({
          note: job.notePath, quote: job.highlight, comment: job.comment,
          context: job.context ?? t('未附带额外上下文（旧请求或大小限制）'),
          precedingReplies: job.precedingReplies ?? [],
          research: job.research ?? null,
        }, null, 2) });
        if (job.state === 'failed') {
          new Setting(el).addButton(b => b.setButtonText(t('重试未发送的请求')).onClick(async () => {
            try { await this.engine.retryFailed(job.id); } catch (e) { new Notice(String(e)); }
            await this.render();
          }));
        }
        if (job.reply) el.createEl('pre', { text: job.reply, cls: 'ilc-codex-recovery-text' });
      }
    } catch (e) { el.createEl('p', { text: String(e) }); }
  }
}
