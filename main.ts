import { getLocale, setLocale, t } from './src/i18n.ts';
import { nodeCp, nodeFsp, nodePath } from './src/node.ts';
import { MarkdownView, Platform, Plugin, PluginSettingTab, App, Setting, Notice, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';
import { buildAgentReplyPrompt, cleanReplyText } from './src/agentReply.ts';
import { buildCommentExtension, type ICommentHost, type AnnotationPosition } from './src/editor/cmExtension.ts';
import { readingPostProcessor } from './src/readingView.ts';
import { CommentPanel, VIEW_TYPE_COMMENTS } from './src/views/CommentPanel.ts';
import { HistoryModal } from './src/views/HistoryModal.ts';
import { MembersModal } from './src/views/MembersModal.ts';
import { GlobalThreadModal } from './src/modal/GlobalThreadModal.ts';
import { appendReply, parseAnnotations } from './src/parser.ts';
import type { CommentEntry, CommentTypeConfig, AIAgentConfig, DeletedRecord } from './src/types.ts';
import { BUILTIN_TYPE_IDS, typeBgColor } from './src/types.ts';
import { AgentSuggest } from './src/AgentSuggest.ts';
import { UnreadTracker } from './src/unreadTracker.ts';
import { ExplorerBadge } from './src/explorerBadge.ts';
import { DEFAULT_MAILBOX_ROOT } from './src/mentionDelivery.ts';
import { MentionDelivery } from './src/mentionDeliveryService.ts';
import { CodexReplyService } from './src/codexReplyService.ts';
import { getHookStatus, installClaudeHooks, uninstallClaudeHooks, type HookStatus } from './src/hookInstaller.ts';
import { HOOK_SCRIPT_NAME } from './src/hookScript.ts';
import { buildLaunchPlan, buildLaunchPrompt, launchInTerminal, runningClaudeIds, sessionFileExists, writePromptFile } from './src/sessionLauncher.ts';
import type { Candidate } from './src/mentionDelivery.ts';
import { renderAgentRegistrySection } from './src/settings/agentRegistrySection.ts';
import {
  GLOBAL_THREAD_END_MARKER,
  GLOBAL_THREAD_START_MARKER,
  appendGlobalThreadEntry,
  hasOnlyGlobalThreadBlockChanged,
  parseGlobalThreadBlock,
  type GlobalThreadEngine,
} from './src/globalThread.ts';

// ─── Default type chips ────────────────────────────────────────────────────────

export const DEFAULT_COMMENT_TYPES: CommentTypeConfig[] = [
  { id: 'agree',     emoji: '🟢', label: '认同',   color: '#6FA287' },
  { id: 'disagree',  emoji: '🔴', label: '不认同', color: '#C96C6C' },
  { id: 'question',  emoji: '🟡', label: '疑问',   color: '#D4A24C' },
  { id: 'important', emoji: '🔵', label: '重要',   color: '#6A8FCF' },
  { id: 'note',      emoji: '⚪', label: '备注',   color: '#9AA0A6' },
];

export const DEFAULT_AI_AGENTS: AIAgentConfig[] = [
  { id: 'claude', name: 'Claude', avatarChar: 'C', avatarBg: '#7B61FF', resumeType: 'claude-resume' },
  { id: 'codex',  name: 'Codex',  avatarChar: 'X', avatarBg: '#10A37F', resumeType: 'claude-resume' },
  { id: 'gemini', name: 'Gemini', avatarChar: 'G', avatarBg: '#4285F4', resumeType: 'claude-resume' },
];

// ─── Settings ─────────────────────────────────────────────────────────────────

interface ILCSettings {
  authorName:     string;
  avatarBg:       string; // user avatar background color
  commentTypes:   CommentTypeConfig[];
  aiAgents:       AIAgentConfig[];
  defaultAIAgent: string; // id of the default AI agent to request
  globalThreadEngine: GlobalThreadEngine;
  enableUnreadSignal: boolean;
  /** Panel background: follow sidebar (theme default), follow editor, or a custom color */
  panelBackground: 'sidebar' | 'editor' | 'custom';
  panelBackgroundColor: string;
  /** Deliver `[@名字](agent:id?notify)` mentions as mailbox letters (in-plugin scanner) */
  enableMentionDelivery: boolean;
  enableCodexAutoReply: boolean;
  enableCodexVaultResearch: boolean;
  codexExecutable: string;
  /** Vault-relative mailbox root; letters go to <root>/<短id>/ */
  mailboxRoot: string;
  /** Show resolved threads in the panel (collapsed) or hide them */
  showResolved: boolean;
  /** UI language: follow Obsidian, or force zh / en */
  language: 'auto' | 'zh' | 'en';
}

const DEFAULT_SETTINGS: ILCSettings = {
  authorName:     'user',
  avatarBg:       '#7C4DFF',
  commentTypes:   DEFAULT_COMMENT_TYPES,
  aiAgents:       DEFAULT_AI_AGENTS,
  defaultAIAgent: 'claude',
  globalThreadEngine: 'claude',
  enableUnreadSignal: true,
  panelBackground: 'sidebar',
  panelBackgroundColor: '#f4f4f2',
  enableMentionDelivery: true,
  enableCodexAutoReply: false,
  enableCodexVaultResearch: false,
  codexExecutable: 'codex',
  mailboxRoot: DEFAULT_MAILBOX_ROOT,
  showResolved: true,
  language: 'auto',
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class InlineCommentsPlugin extends Plugin implements ICommentHost {
  settings: ILCSettings = DEFAULT_SETTINGS;
  private runningGlobalThreads = new Set<string>();
  private runningAgentReplies = new Set<string>();
  unreadTracker!: UnreadTracker;
  explorerBadge!: ExplorerBadge;
  mentionDelivery!: MentionDelivery;
  codexReplies!: CodexReplyService;

  async onload(): Promise<void> {
    await this.loadSettings();
    setLocale(this.settings.language);

    // Register sidebar view
    this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentPanel(leaf, this));

    // Register CodeMirror 6 extension
    this.registerEditorExtension(buildCommentExtension(this));

    // Reading view: same highlight + badge, raw comment markup hidden
    this.registerMarkdownPostProcessor(readingPostProcessor(this));
    // Mode switches (source ↔ reading) re-anchor everything
    this.registerEvent(this.app.workspace.on('layout-change', () => void this.getPanel()?.refresh()));

    // Command: add inline comment → opens draft card in sidebar
    this.addCommand({
      id: 'add-inline-comment',
      name: t('添加划线评论'),
      editorCallback: (editor) => this.addCommentFromSelection(editor),
    });

    // Right-click on a selection → 添加划线评论 (no hotkey needed)
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item
            .setTitle(t('添加划线评论'))
            .setIcon('message-square')
            .setSection('selection')
            .onClick(() => this.addCommentFromSelection(editor)),
        );
      }),
    );

    // Command: open/reveal comments panel
    this.addCommand({
      id: 'open-comments-panel',
      name: t('打开评论面板'),
      callback: async () => {
        await this.activatePanel();
      },
    });

    // Command: open deletion history
    this.addCommand({
      id: 'open-comment-history',
      name: t('查看评论删除历史'),
      callback: () => {
        new HistoryModal(this.app, this).open();
      },
    });

    // Command: deliver pending @ mentions now (full sweep)
    this.addCommand({
      id: 'deliver-mentions-now',
      name: t('投递未送达的 @ 留言（全库扫描）'),
      callback: () => void this.mentionDelivery.sweep(true),
    });

    // Command: manage @-mention members
    this.addCommand({
      id: 'manage-comment-members',
      name: t('管理评论 @ 成员'),
      callback: () => new MembersModal(this.app).open(),
    });

    // Command: document-level AI conversation block
    this.addCommand({
      id: 'start-or-continue-global-thread',
      name: t('开始/继续文档对话'),
      callback: () => {
        this.openGlobalThreadModal();
      },
    });

    // Ribbon icon
    this.addRibbonIcon('message-square', t('评论面板'), async () => {
      await this.activatePanel();
    });

    // Editor @-mention suggest (body text)
    this.registerEditorSuggest(new AgentSuggest(this.app, this));

    // Settings tab
    this.addSettingTab(new ILCSettingTab(this.app, this));

    // Unread reply tracker
    this.unreadTracker = new UnreadTracker(
      this.app,
      this.pluginDir(),
      () => this.settings.enableUnreadSignal,
      () => this.settings.authorName,
    );
    this.unreadTracker.init();

    // Red unread badge on file-explorer rows (driven by the tracker's counts)
    this.explorerBadge = new ExplorerBadge(this.app, () => this.settings.enableUnreadSignal);
    this.unreadTracker.onChange((counts) => this.explorerBadge.setCounts(counts));
    this.app.workspace.onLayoutReady(() => this.explorerBadge.attach());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.explorerBadge.attach()));

    this.codexReplies = new CodexReplyService(this.app, this.pluginDir(), () => this.settings);
    this.addCommand({ id: 'codex-auto-reply-status', name: t('Codex 自动回复状态'), callback: () => this.codexReplies.showStatus() });
    if (Platform.isDesktop) this.registerInterval(window.setInterval(() => void this.codexReplies.poll(), 2000));

    // @ mention → mailbox letter (replaces the external cron scanner)
    this.mentionDelivery = new MentionDelivery(
      this.app,
      () => ({ enabled: this.settings.enableMentionDelivery, mailboxRoot: this.settings.mailboxRoot }),
      (msg) => new Notice(msg),
      async (c, relPath, letterPath, context) => {
        if (c.harness === 'codex' && this.settings.enableCodexAutoReply && Platform.isDesktop) {
          const known = new Set((await this.codexReplies.engine.snapshot()).map(job => job.id));
          const predecessors = context.predecessors?.filter(id => known.has(id) || this.mentionDelivery.hasPending(id));
          await this.codexReplies.enqueue({ id: context.key, sessionId: c.sessionId, agentName: c.name,
            notePath: relPath, letterPath, highlight: context.highlight, comment: context.comment, context: context.snapshot, predecessors });
          return;
        }
        this.notifyDesktop(t('评论区有新留言给 {0}', [c.name]), t('{0} · 它下一次说话/收尾时会看到', [relPath.split('/').pop()]));
        void this.maybeAutoStart(c, letterPath);
      },
    );
    this.mentionDelivery.init();
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        void Promise.all([this.codexReplies.engine.renameNote(oldPath, file.path), this.mentionDelivery.renameNote(oldPath, file.path)]).catch(error => new Notice(String(error)));
      }
    }));

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        this.unreadTracker.scheduleRecompute(file);
        this.mentionDelivery.schedule(file);
      }),
    );
  }

  // ── Mailbox hook (Claude Code) ────────────────────────────────────────────────

  /** Absolute vault path (desktop adapters only) */
  vaultBasePath(): string | null {
    const base = (this.app.vault.adapter as any)?.basePath;
    return typeof base === 'string' ? base : null;
  }

  mailboxRootAbs(): string | null {
    const base = this.vaultBasePath();
    return base ? nodePath().join(base, this.settings.mailboxRoot) : null;
  }

  hookScriptPath(): string | null {
    const base = this.vaultBasePath();
    const dir = this.pluginDir();
    return base ? nodePath().join(base, dir, 'hooks', HOOK_SCRIPT_NAME) : null;
  }

  async hookStatus(): Promise<HookStatus | null> {
    if (!Platform.isDesktop) return null;
    const script = this.hookScriptPath();
    const root = this.mailboxRootAbs();
    if (!script || !root) return null;
    try { return await getHookStatus(script, root, getLocale()); } catch { return null; }
  }

  /** Write the hook script and register it in ~/.claude/settings.json (idempotent, backed up) */
  async installHooks(): Promise<{ backup?: string; settingsPath: string } | null> {
    if (!Platform.isDesktop) { new Notice(t('唤醒 hook 只能在桌面端安装')); return null; }
    const script = this.hookScriptPath();
    const root = this.mailboxRootAbs();
    if (!script || !root) { new Notice(t('仅桌面端支持安装唤醒 hook')); return null; }
    const res = await installClaudeHooks(script, root, getLocale());
    new Notice(t('唤醒 hook 已安装到 {0}{1}', [res.settingsPath, res.backup ? '（原文件已备份）' : '']));
    return res;
  }

  async uninstallHooks(): Promise<void> {
    if (!Platform.isDesktop) return;
    await uninstallClaudeHooks();
    new Notice(t('唤醒 hook 已移除'));
  }

  /** macOS notification (best-effort, desktop only) */
  notifyDesktop(title: string, body: string): void {
    if (!Platform.isDesktop) return;
    if (process.platform !== 'darwin') return;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      nodeCp().execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
    } catch { /* ignore */ }
  }

  /** Open a terminal that resumes (or starts) the given session in its directory (macOS) */
  async resumeInTerminal(sessionId: string, cwd?: string): Promise<void> {
    if (!Platform.isDesktop) { new Notice(t('在终端恢复会话只支持桌面端')); return; }
    const exists = await sessionFileExists(sessionId);
    const plan = buildLaunchPlan({ sessionId, cwd: cwd || this.vaultBasePath() || process.cwd(), exists });
    const r = await launchInTerminal(plan);
    if (r === 'unsupported') new Notice(t('仅 macOS 支持在终端启动会话'));
  }

  /**
   * A letter was delivered to a member that asked to be auto-started: if its
   * session is not running, start (new) or resume (known) it in a terminal with
   * the letter as the first message. The letter is marked as handed over so the
   * hook does not inject it a second time.
   */
  async maybeAutoStart(c: Candidate, letterPath: string): Promise<void> {
    if (!Platform.isDesktop) return; // letters are still written; a desktop session picks them up
    if (!c.autoStart || (c.harness ?? 'claude') !== 'claude') return;
    try {
      const running = await runningClaudeIds();
      if (running.has(c.sessionId.toLowerCase())) return;
      const adapter = this.app.vault.adapter;
      const raw = await adapter.read(letterPath);
      if (!raw.includes('status: 未读')) return; // already handed over by the hook
      await adapter.write(letterPath, raw.replace('status: 未读', 'status: 已读（启动代标）'));
      const body = raw.split('\n---\n').slice(1).join('\n---\n');
      const prompt = buildLaunchPrompt(c.name, body, todayIsoDate(), getLocale());
      const promptFile = await writePromptFile(c.sessionId, prompt);
      const exists = await sessionFileExists(c.sessionId);
      const plan = buildLaunchPlan({ sessionId: c.sessionId, cwd: c.cwd || this.vaultBasePath() || process.cwd(), promptFile, exists });
      const r = await launchInTerminal(plan);
      if (r === 'launched') new Notice(t('已在终端{0}会话「{1}」，留言已交给它', [plan.mode === 'new' ? '启动' : '恢复', c.name]));
      else if (r === 'unsupported') new Notice(t('「{0}」未在运行，且当前平台不支持自动启动', [c.name]));
    } catch (err) {
      console.error('[ilc] auto-start failed', err);
      new Notice(t('自动启动「{0}」失败：{1}', [c.name, String((err as Error)?.message ?? err)]));
    }
  }

  /** Open the draft card for the current editor selection */
  async addCommentFromSelection(editor: Editor): Promise<void> {
    const sel = editor.getSelection();
    if (!sel) return;

    const from = editor.posToOffset(editor.getCursor('from'));

    await this.activatePanel();

    const panel = this.getPanel();
    if (!panel) return;

    const to = from + sel.length;
    panel.showDraftCard(sel, from, (markup: string) => {
      const fromPos = editor.offsetToPos(from);
      const toPos   = editor.offsetToPos(to);
      editor.replaceRange(markup, fromPos, toPos);
    });
  }

  /** Vault-relative folder of this plugin (honours a custom config dir) */
  pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  onunload(): void {
    this.codexReplies?.stop();
    this.mentionDelivery?.dispose();
    this.explorerBadge?.detach();
    // Deliberately no detachLeavesOfType: Obsidian restores the leaf itself, and
    // detaching here would reset a panel the user moved to another sidebar.
  }

  /** Badge after a highlight was clicked → open the panel and focus the card */
  onBadgeClick(annotationId: string): void {
    void (async () => {
      await this.activatePanel();
      this.getPanel()?.highlightCard(annotationId);
    })();
  }

  /** Called by CM6 extension when editor cursor enters an annotation */
  onEditorCursorInAnnotation(annotationId: string, view?: EditorView): void {
    const panel = this.getPanel();
    if (!panel || !panel.isCurrentEditor(view)) return;
    panel.highlightCard(annotationId);
  }

  /** Called by CM6 extension when annotation positions change */
  onPositionsUpdated(positions: AnnotationPosition[], view?: EditorView): void {
    this.getPanel()?.syncPositions(positions, view);
  }

  /** Called by CM6 extension when the editor scrolls */
  onEditorScroll(scrollTop: number, view?: EditorView): void {
    this.getPanel()?.syncEditorScroll(scrollTop, view);
  }

  /** Get the active CommentPanel instance (if any) */
  getPanel(): CommentPanel | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS);
    if (leaves.length > 0) return leaves[0].view as CommentPanel;
    return null;
  }

  /** Look up an AI agent by name (for avatar rendering) */
  getAIAgent(name: string): AIAgentConfig | undefined {
    return this.settings.aiAgents.find(
      (a) => a.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private getRegisteredAgentSession(agentName: string): {
    agent: AIAgentConfig;
    sessionId: string;
    resumeType: string;
  } | null {
    const normalizedName = agentName.trim().toLowerCase();
    const agent = this.settings.aiAgents.find(
      (item) => item.name.toLowerCase() === normalizedName,
    );
    const sessionId = agent?.sessionId?.trim();
    if (!agent || !sessionId) return null;

    const resumeType =
      (agent as AIAgentConfig & { resumeType?: string }).resumeType ??
      'claude-resume';
    return { agent, sessionId, resumeType };
  }

  // ── History ────────────────────────────────────────────────────────────────

  private get historyPath(): string {
    return `${this.manifest.dir}/history.json`;
  }

  async saveDeletedComment(
    record: Omit<DeletedRecord, 'id' | 'deletedAt'>,
  ): Promise<void> {
    const full: DeletedRecord = {
      ...record,
      id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      deletedAt: new Date().toISOString(),
    };
    const history = await this.loadDeletedHistory();
    history.unshift(full);
    if (history.length > 500) history.splice(500);
    try {
      await this.app.vault.adapter.write(
        this.historyPath,
        JSON.stringify(history, null, 2),
      );
    } catch (e) {
      console.error('ILC: failed to save history', e);
    }
  }

  async loadDeletedHistory(): Promise<DeletedRecord[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.historyPath);
      return JSON.parse(raw) as DeletedRecord[];
    } catch {
      return [];
    }
  }

  async clearDeletedHistory(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.historyPath, '[]');
    } catch (e) {
      console.error('ILC: failed to clear history', e);
    }
  }

  /** Name of the default AI agent to request responses from */
  getDefaultAIAgentName(): string {
    const agent = this.settings.aiAgents.find(
      (a) => a.id === this.settings.defaultAIAgent,
    );
    return agent?.name ?? 'Claude';
  }

  private openGlobalThreadModal(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice(t('请先打开一篇 Markdown 笔记'));
      return;
    }

    new GlobalThreadModal(this.app, async (message) => {
      await this.continueGlobalThread(file, message);
    }).open();
  }

  private async continueGlobalThread(file: TFile, message: string): Promise<void> {
    if (this.runningGlobalThreads.has(file.path)) {
      new Notice(t('文档对话正在进行中'));
      return;
    }

    const absolutePath = this.getAbsoluteFilePath(file);
    if (!absolutePath) {
      new Notice(t('文档对话需要桌面文件系统路径，当前 vault adapter 不支持'));
      return;
    }

    this.runningGlobalThreads.add(file.path);

    const date = todayIsoDate();
    const engine = this.settings.globalThreadEngine;
    const aiName = this.getGlobalThreadAgentName(engine);
    let contentWithUserMessage = '';

    try {
      const before = await this.app.vault.read(file);
      contentWithUserMessage = appendGlobalThreadEntry(before, {
        author: this.settings.authorName,
        date,
        text: message,
      });
      const expectedBlock = parseGlobalThreadBlock(contentWithUserMessage);
      if (!expectedBlock) throw new Error(t('无法创建文档对话块'));

      await this.app.vault.modify(file, contentWithUserMessage);
      new Notice(t('文档对话：正在请求 {0}...', [aiName]));

      await this.runGlobalThreadEngine(engine, absolutePath, aiName, date);

      const after = await this.app.vault.adapter.read(file.path);
      const afterBlock = parseGlobalThreadBlock(after);
      this.refreshActiveMarkdownView(file, after, contentWithUserMessage);

      if (!afterBlock) {
        new Notice(t('文档对话：AI 执行完成，但全局对话块未解析成功，请检查'), 10000);
        return;
      }

      const onlyThreadChanged = hasOnlyGlobalThreadBlockChanged(
        contentWithUserMessage,
        after,
      );
      const appendedReply = afterBlock.entries.length > expectedBlock.entries.length;

      if (!onlyThreadChanged) {
        new Notice(t('文档对话：AI 已返回，但检测到块外内容变化，请检查文档'), 10000);
      } else if (!appendedReply) {
        new Notice(t('文档对话：AI 已返回，但未检测到新增回复'), 10000);
      } else {
        new Notice(t('文档对话：AI 回复已写回'));
      }
    } catch (error) {
      const messageText = formatProcessError(error);
      console.error('ILC: global thread engine failed:', messageText);
      new Notice(t('文档对话：AI 应答失败：{0}', [messageText]), 10000);
    } finally {
      this.runningGlobalThreads.delete(file.path);
    }
  }

  /** Called by UI: ask a registered Agent session to reply to one annotation. */
  async requestAgentReply(
    file: TFile,
    annotationFrom: number,
    agentName: string,
  ): Promise<void> {
    if (!Platform.isDesktop) { new Notice(t('请 AI 直接回应只支持桌面端')); return; }
    const lockKey = `${file.path}:${annotationFrom}`;
    if (this.runningAgentReplies.has(lockKey)) {
      new Notice(t('评论回应正在进行中'));
      return;
    }

    const registeredAgent = this.getRegisteredAgentSession(agentName);
    if (!registeredAgent) {
      new Notice(t('未找到已注册会话: ') + agentName);
      return;
    }
    if (registeredAgent.resumeType !== 'claude-resume') {
      new Notice(t('暂不支持会话类型: ') + registeredAgent.resumeType);
      return;
    }

    const absolutePath = this.getAbsoluteFilePath(file);
    if (!absolutePath) {
      new Notice(t('评论回应需要桌面文件系统路径，当前 vault adapter 不支持'));
      return;
    }

    this.runningAgentReplies.add(lockKey);

    const cwd = getParentDir(absolutePath);
    const date = todayIsoDate();
    let before = '';

    try {
      before = await this.app.vault.read(file);
      const annotation = parseAnnotations(before).find(
        (item) => item.from === annotationFrom,
      );
      if (!annotation) {
        new Notice(t('评论回应：未找到目标评论块'), 10000);
        return;
      }

      const prompt = buildAgentReplyPrompt({
        absolutePath,
        agentName: registeredAgent.agent.name,
        highlightText: annotation.highlightText,
        existingComments: annotation.comments.map((comment) => ({
          author: comment.author,
          type:   comment.type,
          text:   comment.text,
        })),
        date,
      });

      new Notice(t('评论回应：正在请求 {0}...', [registeredAgent.agent.name]));
      const replyOutput = await runHeadlessCommandCapture(
        'claude',
        ['--print', '--resume', registeredAgent.sessionId, '-p', prompt],
        cwd,
      );
      const replyText = cleanReplyText(replyOutput);

      if (!replyText) {
        new Notice(t('评论回应：Agent 未返回内容'), 10000);
        return;
      }

      const reply: CommentEntry = {
        author: registeredAgent.agent.name,
        date,
        type: 'reply',
        text: replyText,
      };
      const current = await this.app.vault.read(file);
      if (current !== before) {
        new Notice(t('评论回应：文档已变更，请重试'), 10000);
        return;
      }
      const after = appendReply(before, annotationFrom, reply);
      await this.app.vault.modify(file, after);
      this.refreshActiveMarkdownView(file, after, before, t('评论回应'));
      await this.appendAgentReplyLog(
        cwd,
        registeredAgent.agent.name,
        file,
        annotation.highlightText,
      );
      new Notice(t('评论回应：AI 回复已写回'));
    } catch (error) {
      const messageText = formatProcessError(error);
      console.error('ILC: agent reply failed:', messageText);
      new Notice(t('评论回应：AI 应答失败：{0}', [messageText]), 10000);
    } finally {
      this.runningAgentReplies.delete(lockKey);
    }
  }

  private getGlobalThreadAgentName(engine: GlobalThreadEngine): string {
    return engine === 'glm' ? 'GLM' : 'Claude';
  }

  private async runGlobalThreadEngine(
    engine: GlobalThreadEngine,
    absolutePath: string,
    aiName: string,
    date: string,
  ): Promise<void> {
    const prompt = this.buildGlobalThreadPrompt(absolutePath, aiName, date);
    const cwd = getParentDir(absolutePath);

    if (engine === 'glm') {
      await runHeadlessCommand(
        '/Users/yytyyf/Documents/main/_os/scripts/glm.sh',
        [prompt],
        cwd,
      );
      return;
    }

    await runHeadlessCommand('claude', ['-p', prompt], cwd);
  }

  private async appendAgentReplyLog(
    documentDir: string | undefined,
    agentName: string,
    file: TFile,
    highlightText: string,
  ): Promise<void> {
    if (!documentDir) return;

    try {
      const logDir = nodePath().join(
        documentDir,
        '.agent-threads',
        safePathSegment(agentName),
      );
      await nodeFsp().mkdir(logDir, { recursive: true });
      const highlightSummary = buildLogField(highlightText).slice(0, 20);
      const line = [
        localMinuteTimestamp(),
        buildLogField(file.name),
        highlightSummary,
        '已回复',
      ].join(' | ');
      await nodeFsp().appendFile(nodePath().join(logDir, 'log.md'), `${line}\n`, 'utf8');
    } catch (error) {
      console.warn('ILC: failed to append agent reply log', error);
    }
  }

  private buildGlobalThreadPrompt(
    absolutePath: string,
    aiName: string,
    date: string,
  ): string {
    return [
      '你正在为 Obsidian Markdown 文件追加文档级 AI 对话回复。',
      `文件绝对路径：${JSON.stringify(absolutePath)}`,
      '',
      '只允许修改这个全局对话块内部：',
      GLOBAL_THREAD_START_MARKER,
      GLOBAL_THREAD_END_MARKER,
      '',
      '任务：',
      '1. 读取该文件，理解正文和全局对话块里最后一条用户消息。',
      `2. 只在全局对话块末尾追加一条 ${aiName} 回复。`,
      `3. 回复首行格式必须是：> **${aiName}｜${date}**：你的回复`,
      '4. 如果回复有多行，每一行都必须以 "> " 开头，保持在 Obsidian callout 内。',
      '5. 不要修改块外任何字符；不要修改已有对话；不要修改 `{==...==}{>>...<<}` 划线评论。',
      '6. 直接编辑并保存原文件；不要创建新文件，不要输出整篇文档。',
    ].join('\n');
  }

  private getAbsoluteFilePath(file: TFile): string | null {
    const adapter = this.app.vault.adapter as unknown;
    if (!hasFullPathAdapter(adapter)) return null;
    return adapter.getFullPath(file.path);
  }

  private refreshActiveMarkdownView(
    file: TFile,
    latestContent: string,
    expectedBeforeAI: string,
    contextLabel = t('文档对话'),
  ): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;

    const current = view.editor.getValue();
    if (current === latestContent) return;
    if (current === expectedBeforeAI) {
      view.editor.setValue(latestContent);
      return;
    }

    new Notice(t('{0}：当前编辑器已有新改动，未强制刷新视图', [contextLabel]), 8000);
  }

  /**
   * Highlight background for a user-defined comment type, carried inline on the
   * decoration. Built-in types return null and keep using their CSS class.
   * (Plugins must not create `<style>` elements, so there is no generated sheet.)
   */
  highlightBg(typeId: string): string | null {
    if (BUILTIN_TYPE_IDS.has(typeId)) return null;
    const cfg = this.settings.commentTypes.find((t) => t.id === typeId);
    return cfg?.color ? typeBgColor(cfg.color) : null;
  }

  private async activatePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_COMMENTS, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Ensure arrays have defaults if missing from older saves
    if (!Array.isArray(this.settings.commentTypes) || this.settings.commentTypes.length === 0) {
      this.settings.commentTypes = DEFAULT_COMMENT_TYPES;
    }
    if (!Array.isArray(this.settings.aiAgents) || this.settings.aiAgents.length === 0) {
      this.settings.aiAgents = DEFAULT_AI_AGENTS;
    }
    if (!['claude', 'glm'].includes(this.settings.globalThreadEngine)) {
      this.settings.globalThreadEngine = 'claude';
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localMinuteTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function buildLogField(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '｜').trim();
}

function safePathSegment(value: string): string {
  return value.replace(/[/:\\]/g, '_').trim() || 'agent';
}

function hasFullPathAdapter(
  adapter: unknown,
): adapter is { getFullPath(filePath: string): string } {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as { getFullPath?: unknown }).getFullPath === 'function'
  );
}

function getParentDir(filePath: string): string | undefined {
  const slashIndex = filePath.lastIndexOf('/');
  return slashIndex > 0 ? filePath.slice(0, slashIndex) : undefined;
}

function runHeadlessCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeCp().execFile(
      command,
      args,
      {
        cwd,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | string | null;
          };
          const reason = err.killed
            ? 'timeout'
            : `code=${err.code ?? 'unknown'} signal=${err.signal ?? 'none'}`;
          reject(new Error(reason));
          return;
        }
        resolve();
      },
    );
  });
}

function runHeadlessCommandCapture(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeCp().execFile(
      command,
      args,
      {
        cwd,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | string | null;
          };
          const reason = err.killed
            ? 'timeout'
            : `code=${err.code ?? 'unknown'} signal=${err.signal ?? 'none'}`;
          reject(new Error(reason));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function formatProcessError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'unknown';
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class ILCSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: InlineCommentsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Author ──
    new Setting(containerEl)
      .setName(t('默认署名'))
      .setDesc(t('添加评论时使用的作者名'))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value.trim() || 'user';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('头像颜色'))
      .setDesc(t('评论头像的背景色'))
      .addColorPicker((cp) =>
        cp
          .setValue(this.plugin.settings.avatarBg)
          .onChange(async (value) => {
            this.plugin.settings.avatarBg = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Comment types ──
    new Setting(containerEl).setName(t('评论类型')).setHeading();
    containerEl.createEl('p', {
      text: t('每个类型对应一个快捷标签。内置类型（agree/disagree 等）颜色由样式表控制；自定义类型按所选颜色着色。'),
      cls: 'setting-item-description',
    });

    const typesEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
    this.renderTypesList(typesEl);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText(t('+ 添加类型')).onClick(async () => {
        this.plugin.settings.commentTypes.push({
          id: 'custom',
          emoji: '💬',
          label: t('自定义'),
          color: '#9C27B0',
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // ── AI agents ──
    new Setting(containerEl).setName(t('AI 助手')).setHeading();
    containerEl.createEl('p', {
      text: t('当评论作者名与此处配置的 AI 名称匹配时，会显示对应的头像和颜色。'),
      cls: 'setting-item-description',
    });

    const agentsEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
    this.renderAgentsList(agentsEl);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText(t('+ 添加 AI 助手')).onClick(async () => {
        this.plugin.settings.aiAgents.push({
          id: `agent-${Date.now()}`,
          name: 'NewAgent',
          avatarChar: 'A',
          avatarBg: '#607D8B',
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // ── Default AI agent ──
    new Setting(containerEl)
      .setName(t('默认 AI 助手'))
      .setDesc(t('点击「请 AI 回应」时，默认请求哪个 AI'))
      .addDropdown((drop) => {
        for (const agent of this.plugin.settings.aiAgents) {
          drop.addOption(agent.id, agent.name);
        }
        drop.setValue(this.plugin.settings.defaultAIAgent);
        drop.onChange(async (value) => {
          this.plugin.settings.defaultAIAgent = value;
          await this.plugin.saveSettings();
        });
        return drop;
      });

    // ── Document-level thread engine ──
    new Setting(containerEl)
      .setName(t('文档对话引擎'))
      .setDesc(t('「开始/继续文档对话」命令调用的 headless 引擎'))
      .addDropdown((drop) => {
        drop.addOption('claude', 'Claude CLI');
        drop.addOption('glm', t('GLM 脚本'));
        drop.setValue(this.plugin.settings.globalThreadEngine);
        drop.onChange(async (value) => {
          this.plugin.settings.globalThreadEngine =
            value === 'glm' ? 'glm' : 'claude';
          await this.plugin.saveSettings();
        });
        return drop;
      });

    // ── Agent registry (评论互动成员) ──
    renderAgentRegistrySection(containerEl, this.app);

    // ── Language ──
    new Setting(containerEl)
      .setName(t('语言'))
      .setDesc(t('面板、设置和提示的语言。命令名和视图标题在重启 Obsidian 后更新。'))
      .addDropdown((d) =>
        d.addOptions({ auto: t('跟随 Obsidian'), zh: '中文', en: 'English' })
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as 'auto' | 'zh' | 'en';
            await this.plugin.saveSettings();
            setLocale(this.plugin.settings.language);
            this.display();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)) void (leaf.view as CommentPanel).refresh();
          }),
      );

    // ── Unread signal ──
    new Setting(containerEl)
      .setName(t('未读通知'))
      .setDesc(t('别人（或 AI）的回复带红点、面板顶部显示未读数、文件目录里对应文档显示红色角标，看完点「标为已读」。关闭后这些都不出现。'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableUnreadSignal)
          .onChange(async (value) => {
            this.plugin.settings.enableUnreadSignal = value;
            await this.plugin.saveSettings();
            if (value) await this.plugin.unreadTracker.recompute();
            else await this.plugin.unreadTracker.clear();
            this.plugin.explorerBadge.render();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)) {
              void (leaf.view as CommentPanel).refresh();
            }
          }),
      );

    new Setting(containerEl)
      .setName(t('投递 @ 留言到信箱'))
      .setDesc(t('评论里带「通知对方」的 @ 会写成一封信放进对方信箱（插件内置，不再依赖 cron 脚本）。文档保存后约 1.5 秒投递；启动时全库补扫一次。'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableMentionDelivery).onChange(async (v) => {
          this.plugin.settings.enableMentionDelivery = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t('Codex 自动回复'))
      .setDesc(t('仅桌面端。将新投递的 Codex 通知发送到成员绑定的任务，使用该任务的模型与额度，再写回原评论。需本机已登录且支持 codex queue；发送选中原文、本次评论、附近正文和本线程此前的讨论，超长内容会截断并标注。关闭时暂停发送和写回。'))
      .addToggle(toggle => toggle.setDisabled(!Platform.isDesktop).setValue(this.plugin.settings.enableCodexAutoReply).onChange(async value => {
        this.plugin.settings.enableCodexAutoReply = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName(t('Codex 跨笔记查找'))
      .setDesc(t('允许新评论请求按需读取当前 Vault 的 Markdown、追踪链接和搜索来源；回答附来源与摘录。读取的内容会进入当前 Codex 任务及其模型服务。使用任务现有权限，范围由提示词约束，并非独立沙箱。关闭后阻止尚未发送的查找请求，已排队请求仍可能继续。'))
      .addToggle(toggle => toggle.setValue(this.plugin.settings.enableCodexVaultResearch).onChange(async value => {
        this.plugin.settings.enableCodexVaultResearch = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName(t('Codex CLI 路径'))
      .setDesc(t('可填 codex 或可执行文件的完整路径。不会更改目标任务的模型、权限或安装 hook。'))
      .addText(input => input.setPlaceholder('codex').setValue(this.plugin.settings.codexExecutable).onChange(async value => {
        this.plugin.settings.codexExecutable = value.trim() || 'codex';
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName(t('检查 Codex CLI'))
      .setDesc(t('检查本机命令是否支持自动回复，不发送评论。'))
      .addButton(button => button.setButtonText(t('检查')).onClick(async () => {
        try { await this.plugin.codexReplies.checkSetup(); new Notice(t('Codex CLI 检查通过')); }
        catch (error) { new Notice(String((error as Error).message ?? error)); }
      }));
    new Setting(containerEl).setName(t('Codex 自动回复状态'))
      .addButton(button => button.setButtonText(t('查看')).onClick(() => this.plugin.codexReplies.showStatus()));

    const hookSetting = new Setting(containerEl)
      .setName(t('唤醒 hook（Claude Code）'))
      .setDesc(t('装进 ~/.claude/settings.json 的三条 hook：会话说话前 / 收尾时 / 恢复时自动把新留言递给它并附回复方法。只添加自己的条目，安装前自动备份原文件。'));
    void (async () => {
      const st = await this.plugin.hookStatus();
      if (!st) { hookSetting.setDesc(t('仅桌面端可用。')); return; }
      hookSetting.setDesc(t('{0} · {1}', [st.installed ? (st.stale ? '已安装（路径已变，建议重装）' : '已安装') : '未安装', st.settingsPath]));
      hookSetting.addButton((b) =>
        b.setButtonText(st.installed ? t('重新安装') : t('安装')).setCta().onClick(async () => {
          await this.plugin.installHooks();
          this.display();
        }),
      );
      if (st.installed) {
        hookSetting.addButton((b) =>
          b.setButtonText(t('移除')).onClick(async () => {
            await this.plugin.uninstallHooks();
            this.display();
          }),
        );
      }
    })();

    new Setting(containerEl)
      .setName(t('信箱根目录'))
      .setDesc(t('vault 内相对路径，信放在 <根目录>/<会话短 id>/ 下。默认 {0}。', [DEFAULT_MAILBOX_ROOT]))
      .addText((t) =>
        t.setPlaceholder(DEFAULT_MAILBOX_ROOT).setValue(this.plugin.settings.mailboxRoot).onChange(async (v) => {
          const clean = v.trim().replace(/^\/+|\/+$/g, '');
          this.plugin.settings.mailboxRoot = clean.includes('..') ? DEFAULT_MAILBOX_ROOT : clean || DEFAULT_MAILBOX_ROOT;
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) => b.setButtonText(t('立即全库投递')).onClick(() => void this.plugin.mentionDelivery.sweep(true)));

    const bgSetting = new Setting(containerEl)
      .setName(t('面板背景'))
      .setDesc(t('评论面板的底色：跟随侧栏＝主题侧栏色；跟随正文＝与编辑区同色；自定义＝右侧取色。'))
      .addDropdown((d) =>
        d
          .addOptions({ sidebar: t('跟随侧栏'), editor: t('跟随正文'), custom: t('自定义颜色') })
          .setValue(this.plugin.settings.panelBackground)
          .onChange(async (value) => {
            this.plugin.settings.panelBackground = value as ILCSettings['panelBackground'];
            await this.plugin.saveSettings();
            this.plugin.getPanel()?.applyPanelBackground();
            this.display();
          }),
      );
    if (this.plugin.settings.panelBackground === 'custom') {
      bgSetting.addColorPicker((c) =>
        c
          .setValue(this.plugin.settings.panelBackgroundColor)
          .onChange(async (value) => {
            this.plugin.settings.panelBackgroundColor = value;
            await this.plugin.saveSettings();
            this.plugin.getPanel()?.applyPanelBackground();
          }),
      );
    }
  }

  private renderTypesList(container: HTMLElement): void {
    container.empty();
    this.plugin.settings.commentTypes.forEach((type, i) => {
      const row = container.createEl('div', { cls: 'ilc-settings-row' });

      const emojiIn = row.createEl('input', {
        cls: 'ilc-settings-input-emoji',
        attr: { type: 'text', value: type.emoji, title: 'emoji' },
      }) as HTMLInputElement;
      emojiIn.addEventListener('change', async () => {
        type.emoji = emojiIn.value.trim() || '💬';
        await this.plugin.saveSettings();
      });

      const idIn = row.createEl('input', {
        cls: 'ilc-settings-input-id',
        attr: { type: 'text', value: type.id, title: t('类型 ID（写入 Markdown）'), placeholder: 'id' },
      }) as HTMLInputElement;
      idIn.addEventListener('change', async () => {
        type.id = idIn.value.trim().replace(/\s+/g, '_') || 'custom';
        await this.plugin.saveSettings();
      });

      const labelIn = row.createEl('input', {
        cls: 'ilc-settings-input-label',
        attr: { type: 'text', value: type.label, title: t('显示标签'), placeholder: t('标签') },
      }) as HTMLInputElement;
      labelIn.addEventListener('change', async () => {
        type.label = labelIn.value.trim() || type.id;
        await this.plugin.saveSettings();
      });

      const colorIn = row.createEl('input', {
        cls: 'ilc-settings-input-color',
        attr: { type: 'color', value: type.color, title: t('颜色') },
      }) as HTMLInputElement;
      colorIn.addEventListener('change', async () => {
        type.color = colorIn.value;
        await this.plugin.saveSettings();
      });

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '×',
        attr: { title: t('删除') },
      });
      delBtn.addEventListener('click', async () => {
        this.plugin.settings.commentTypes.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  private renderAgentsList(container: HTMLElement): void {
    container.empty();
    this.plugin.settings.aiAgents.forEach((agent, i) => {
      const row = container.createEl('div', { cls: 'ilc-settings-row' });

      const preview = row.createEl('div', {
        cls: 'ilc-settings-avatar-preview',
        text: agent.avatarChar,
        attr: { style: `background: ${agent.avatarBg};` },
      });

      const nameIn = row.createEl('input', {
        cls: 'ilc-settings-input-label',
        attr: { type: 'text', value: agent.name, title: t('显示名称'), placeholder: t('名称') },
      }) as HTMLInputElement;
      nameIn.addEventListener('change', async () => {
        agent.name = nameIn.value.trim() || 'Agent';
        await this.plugin.saveSettings();
      });

      const charIn = row.createEl('input', {
        cls: 'ilc-settings-input-emoji',
        attr: { type: 'text', value: agent.avatarChar, title: t('头像字符（1个字符）'), maxlength: '2' },
      }) as HTMLInputElement;
      charIn.addEventListener('change', async () => {
        agent.avatarChar = charIn.value.trim().charAt(0).toUpperCase() || 'A';
        preview.textContent = agent.avatarChar;
        await this.plugin.saveSettings();
      });

      const colorIn = row.createEl('input', {
        cls: 'ilc-settings-input-color',
        attr: { type: 'color', value: agent.avatarBg, title: t('头像背景色') },
      }) as HTMLInputElement;
      colorIn.addEventListener('change', async () => {
        agent.avatarBg = colorIn.value;
        preview.setCssStyles({ background: agent.avatarBg });
        await this.plugin.saveSettings();
      });

      const sessionIn = row.createEl('input', {
        cls: 'ilc-settings-input-session',
        attr: {
          type: 'text',
          value: agent.sessionId ?? '',
          title: t('会话 ID'),
          placeholder: t('claude session id（填了才能 @它回应）'),
        },
      }) as HTMLInputElement;
      sessionIn.addEventListener('change', async () => {
        const val = sessionIn.value.trim();
        agent.sessionId = val || undefined;
        agent.resumeType = val ? 'claude-resume' : undefined;
        await this.plugin.saveSettings();
      });

      if (agent.sessionId) {
        row.createEl('span', {
          cls: 'ilc-settings-session-tag',
          text: 'claude-resume',
          attr: { title: t('会话类型') },
        });
      }

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '×',
        attr: { title: t('删除') },
      });
      delBtn.addEventListener('click', async () => {
        this.plugin.settings.aiAgents.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }
}
