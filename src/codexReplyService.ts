import { App, Modal, Notice, Platform, Setting, TFile } from 'obsidian';
import { t } from './i18n.ts';
import { nodeCp, nodeFsp, nodePath } from './node.ts';
import { applyCodexReply, buildCodexPrompt, CodexReplyEngine, type CodexJob, type CodexRequest } from './codexReply.ts';

export interface CodexReplySettings {
  enableCodexAutoReply: boolean;
  codexExecutable: string;
}

/** Node APIs are loaded lazily; this module is safe to import on mobile. */
export class CodexReplyService {
  readonly engine: CodexReplyEngine;
  private stopped = false;
  private lastError = '';
  constructor(private app: App, private pluginDir: string, private settings: () => CodexReplySettings) {
    this.engine = new CodexReplyEngine({
      load: () => this.load(), save: j => this.save(j), queue: j => this.queue(j),
      response: j => this.response(j), apply: j => this.apply(j), markLetter: j => this.markLetter(j),
      notice: msg => { if (!this.stopped) new Notice(t(msg)); },
    }, () => this.enabled());
  }
  private enabled(): boolean { return Platform.isDesktop && !this.stopped && this.settings().enableCodexAutoReply; }
  stop(): void { this.stopped = true; this.engine.stop(); }
  enqueue(request: CodexRequest): Promise<void> { return this.engine.enqueue(request); }
  async poll(): Promise<void> {
    try { await this.engine.poll(); this.lastError = ''; }
    catch (error) {
      const message = String((error as Error).message ?? error);
      if (message !== this.lastError && !this.stopped) new Notice(t('Codex 自动回复错误：{0}', [message]));
      this.lastError = message;
    }
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
      const raw = await this.readFile(nodePath().join(root, name));
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
    await nodeFsp().writeFile(`${path}.tmp`, JSON.stringify(job, null, 2), { encoding: 'utf8', mode: 0o600 });
    await nodeFsp().rename(`${path}.tmp`, path);
  }
  private async readFile(path: string): Promise<string | null> {
    try {
      const stat = await nodeFsp().lstat(path);
      if (!stat.isFile() || stat.size > 200000) throw new Error('Invalid or oversized Codex response/state file');
      return await nodeFsp().readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
  private responsePath(job: CodexJob): string { return nodePath().join(this.root(), 'responses', `${job.id}.json`); }
  private response(job: CodexJob): Promise<string | null> { return this.readFile(this.responsePath(job)); }
  private async queue(job: CodexJob): Promise<string> {
    await this.prepare();
    const executable = this.settings().codexExecutable.trim() || 'codex';
    const prompt = buildCodexPrompt(job, this.responsePath(job));
    const path = nodePath();
    const env = { ...process.env, PATH: [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter) };
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
    const file = this.app.vault.getAbstractFileByPath(job.notePath);
    if (!(file instanceof TFile)) throw new Error('Original note no longer exists at its recorded path');
    await this.app.vault.process(file, content => {
      if (!this.enabled()) throw new Error('Automatic replies are paused');
      return applyCodexReply(content, job, job.reply!, job.replyDate!);
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
      const labels: Record<string, string> = { dispatching: '正在发送', queued: '等待 Codex 回答', uncertain: '发送结果待确认', failed: '未能发送', applying: '正在写回', blocked: '回复已保留', complete: '已回复' };
      for (const job of jobs.slice(0, 50)) {
        el.createEl('h3', { text: `${t(labels[job.state] ?? job.state)} · ${job.notePath}` });
        el.createEl('p', { text: `${job.agentName} · ${job.sessionId} · ${new Date(job.createdAt).toLocaleString()}` });
        if (job.error) el.createEl('p', { text: job.error });
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
