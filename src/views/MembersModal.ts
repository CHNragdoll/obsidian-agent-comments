import { statusLabel, t } from '../i18n.ts';
import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import { loadRoster, type RosterEntry } from '../atSelector.ts';
import { readRegistry, removeAgent, upsertAgent, validateName } from '../registry.ts';
import { discoverLocalSessions, shortCwd, timeAgo, type LocalSession } from '../sessionDiscovery.ts';
import { DEFAULT_MAILBOX_ROOT } from '../mentionDelivery.ts';

const STATUS_CLS: Record<string, string> = { '在线': 'online', '闲置': 'idle', '离线': 'offline' };

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 52%)`;
}

/**
 * 「评论 @ 成员」— one place that explains what @ does, lists who can be
 * mentioned, and lets the user add sessions found on this machine.
 */
export class MembersModal extends Modal {
  private membersEl!: HTMLElement;
  private sessionsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private sessions: LocalSession[] = [];
  private registrySnapshot: { joined: Map<string, string>; left: Map<string, string> } = { joined: new Map(), left: new Map() };

  constructor(app: App) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass('ilc-members-modal-shell');
    contentEl.addClass('ilc-members-modal');

    contentEl.createEl('h2', { text: t('评论 @ 成员') });
    contentEl.createEl('p', {
      cls: 'ilc-members-intro',
      text: t('在评论里输入 @ 可以点名一个 AI 会话。勾选「通知对方」，插件会把这条评论写成一封信放进它的信箱，它看到后会把回复写回这里。'),
    });
    const status = contentEl.createEl('div', { cls: 'ilc-members-hint ilc-members-delivery' });
    void this.renderDeliveryStatus(status);

    // ── Members
    const s1 = contentEl.createEl('section', { cls: 'ilc-members-section' });
    const h1 = s1.createEl('div', { cls: 'ilc-members-section-head' });
    h1.createEl('h3', { text: t('可以 @ 的成员') });
    this.membersEl = s1.createEl('div', { cls: 'ilc-members-list' });

    // ── Local sessions
    const s2 = contentEl.createEl('section', { cls: 'ilc-members-section' });
    const h2 = s2.createEl('div', { cls: 'ilc-members-section-head' });
    h2.createEl('h3', { text: t('这台电脑上的会话') });
    const tools = h2.createEl('div', { cls: 'ilc-members-tools' });
    this.searchEl = tools.createEl('input', {
      cls: 'ilc-members-search',
      attr: { type: 'search', placeholder: t('搜标题 / 目录 / 短 id'), spellcheck: 'false' },
    }) as HTMLInputElement;
    this.searchEl.addEventListener('input', () => this.renderSessionRows());
    const refresh = tools.createEl('button', { cls: 'ilc-members-refresh', text: t('刷新') });
    s2.createEl('p', {
      cls: 'ilc-members-hint',
      text: t('自动发现最近活跃的 Claude Code / Codex 会话。给它起个名字点「加入」，之后就能在评论里 @ 它。'),
    });
    this.sessionsEl = s2.createEl('div', { cls: 'ilc-members-list' });
    refresh.addEventListener('click', () => void this.renderSessions());

    // ── Other ways
    const s3 = contentEl.createEl('section', { cls: 'ilc-members-section ilc-members-section-muted' });
    s3.createEl('h3', { text: t('其他加入方式') });
    const ul = s3.createEl('ul');
    ul.createEl('li', { text: t('在任意 Claude Code / Codex 会话里输入 /comment-join，会话会自己起名并加入。') });
    ul.createEl('li', { text: t('公司花名册「在场」里的成员会自动出现，状态来自在场板。') });

    await Promise.all([this.renderMembers(), this.renderSessions()]);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private get plugin(): any {
    return (this.app as any).plugins?.plugins?.['inline-comments'];
  }

  /** Separate mailbox delivery, Codex dispatch and Claude hooks. */
  private async renderDeliveryStatus(el: HTMLElement): Promise<void> {
    el.empty();
    const plugin = this.plugin;
    const root: string = plugin?.settings?.mailboxRoot || DEFAULT_MAILBOX_ROOT;
    const enabled: boolean = plugin?.settings?.enableMentionDelivery ?? true;
    const exists = await this.app.vault.adapter.exists(root);
    el.createEl('span', {
      text: enabled
        ? t('投递：已开启 · 信箱 {0}{1}', [root, exists ? '' : '（首次投信时自动创建）'])
        : t('投递：已关闭（设置里可开启）'),
    });
    if (plugin) {
      new Setting(el)
        .setName(t('Codex 自动回复'))
        .setDesc(t('通过 Codex 任务自动回复，不需要 Claude hook。需开启信箱投递，并在评论中勾选「通知对方」。仅桌面端可用。'))
        .addToggle(toggle => toggle.setDisabled(!Platform.isDesktop)
          .setValue(plugin.settings.enableCodexAutoReply ?? false)
          .onChange(async value => {
            plugin.settings.enableCodexAutoReply = value;
            await plugin.saveSettings();
          }))
        .addButton(button => button.setButtonText(t('查看状态')).onClick(() => plugin.codexReplies.showStatus()));
    }
    const claude = el.createEl('div');
    claude.createEl('strong', { text: t('唤醒 hook（Claude Code）') });
    claude.appendText(' · ');
    const st = await plugin?.hookStatus?.();
    if (!st) {
      claude.appendText(t('仅桌面端可用。'));
      return;
    }
    if (st.installed && !st.stale) {
      claude.createEl('span', { cls: 'ilc-members-ok', text: t('已安装') });
      claude.setAttribute('title', t('会话说话前 / 收尾时 / 恢复时自动收到留言 · {0}', [st.settingsPath]));
      return;
    }
    claude.createEl('span', { cls: 'ilc-members-warn', text: st.installed ? t('需要重装') : t('未安装') });
    const btn = claude.createEl('button', { cls: 'ilc-members-join', text: st.installed ? t('重装') : t('安装') });
    btn.setAttribute('title', t('写入 {0}（只加自己的条目，先备份）', [st.settingsPath]));
    btn.addEventListener('click', async () => {
      await plugin.installHooks();
      await this.renderDeliveryStatus(el);
    });
    el.createEl('div', {
      cls: 'ilc-members-warn-hint',
      text: t('此 hook 仅用于 Claude Code；未安装时 Claude 需自行读取信箱。Codex 自动回复由上方开关独立控制。'),
    });
  }

  // ── Members list ─────────────────────────────────────────────────────────────

  private async renderMembers(): Promise<void> {
    const el = this.membersEl;
    el.empty();
    const entries = (await loadRoster(this.app)).filter((e) => !e.isAction);
    if (entries.length === 0) {
      el.createEl('div', { cls: 'ilc-members-empty', text: t('还没有成员。从下面的会话里加一个，或让会话自己运行 /comment-join。') });
      return;
    }
    for (const e of entries) this.renderMemberRow(el, e);
  }

  private renderMemberRow(container: HTMLElement, e: RosterEntry): void {
    const row = container.createEl('div', { cls: `ilc-members-row ilc-at-status-${STATUS_CLS[e.status]}` });

    const avatar = row.createEl('span', { cls: 'ilc-at-avatar', text: e.name.charAt(0) });
    avatar.setCssStyles({ background: avatarColor(e.name) });
    avatar.createEl('span', { cls: `ilc-at-dot ilc-at-dot-${STATUS_CLS[e.status]}` });

    const main = row.createEl('div', { cls: 'ilc-members-main' });
    const line1 = main.createEl('div', { cls: 'ilc-members-line' });
    line1.createEl('span', { cls: 'ilc-at-name', text: e.name });
    if (e.harness) line1.createEl('span', { cls: 'ilc-at-source', text: e.harness });
    if (e.autoStart) {
      const tag = line1.createEl('span', { cls: 'ilc-at-source ilc-at-source-muted', text: t('自动启动') });
      tag.setAttribute('title', t('有留言且它没在运行时，插件会在终端里启动/恢复这个会话并把留言交给它'));
    }
    line1.createEl('span', { cls: 'ilc-members-status', text: statusLabel(e.status) });
    const line2 = main.createEl('div', { cls: 'ilc-members-sub' });
    line2.appendText(e.source === 'registry' ? t('自己加入的会话') : t('花名册在编'));
    if (e.role) line2.appendText(` · ${e.role.replace(/^@/, '')}`);
    line2.appendText(` · ${e.shortId}`);

    if (e.source === 'registry') {
      const del = row.createEl('button', { cls: 'ilc-members-remove', text: t('移除') });
      del.addEventListener('click', async () => {
        await removeAgent(this.app, e.name);
        new Notice(t('已移除「{0}」', [e.name]));
        await Promise.all([this.renderMembers(), this.renderSessions()]);
      });
    }
  }

  // ── Local sessions ───────────────────────────────────────────────────────────

  private async renderSessions(): Promise<void> {
    const el = this.sessionsEl;
    el.empty();
    if (!Platform.isDesktop) {
      el.createEl('div', { cls: 'ilc-members-empty', text: t('仅桌面端支持自动发现。') });
      return;
    }
    el.createEl('div', { cls: 'ilc-members-empty', text: t('正在查找…') });

    let sessions: LocalSession[] = [];
    try {
      sessions = await discoverLocalSessions();
    } catch (err) {
      el.empty();
      el.createEl('div', { cls: 'ilc-members-empty', text: t('查找失败：{0}', [String((err as Error)?.message ?? err)]) });
      return;
    }
    const registry = await readRegistry(this.app);
    this.registrySnapshot = {
      joined: new Map(registry.agents.map((a) => [a.sessionId.toLowerCase(), a.name])),
      left: new Map((registry.left ?? []).map((a) => [a.sessionId.toLowerCase(), a.name])),
    };
    this.sessions = sessions;
    this.renderSessionRows();
  }

  /** Render the discovered sessions through the search filter */
  private renderSessionRows(): void {
    const el = this.sessionsEl;
    el.empty();
    if (this.sessions.length === 0) {
      el.createEl('div', { cls: 'ilc-members-empty', text: t('最近 48 小时没有发现 Claude Code / Codex 会话。') });
      return;
    }
    const q = (this.searchEl?.value ?? '').trim().toLowerCase();
    const hit = (s: LocalSession) =>
      !q || [s.title, s.cwd, s.shortId, s.sessionId, s.harness, this.registrySnapshot.joined.get(s.sessionId.toLowerCase())]
        .some((v) => v && v.toLowerCase().includes(q));
    const rows = this.sessions.filter(hit);
    if (rows.length === 0) {
      el.createEl('div', { cls: 'ilc-members-empty', text: t('没有匹配「{0}」的会话', [q]) });
      return;
    }
    const { joined, left } = this.registrySnapshot;
    for (const s of rows) this.renderSessionRow(el, s, joined.get(s.sessionId.toLowerCase()), left.get(s.sessionId.toLowerCase()));
  }

  private renderSessionRow(container: HTMLElement, s: LocalSession, joinedAs?: string, leftAs?: string): void {
    const row = container.createEl('div', { cls: `ilc-members-row ilc-members-session ${s.running ? 'is-running' : ''}` });

    const dot = row.createEl('span', { cls: `ilc-members-dot ${s.running ? 'is-on' : ''}` });
    dot.setAttribute('title', s.running ? t('正在运行') : t('最近活跃'));

    const main = row.createEl('div', { cls: 'ilc-members-main' });
    const line1 = main.createEl('div', { cls: 'ilc-members-line' });
    line1.createEl('span', { cls: 'ilc-at-source', text: s.harness });
    line1.createEl('span', { cls: 'ilc-members-title', text: s.title ?? shortCwd(s.cwd) ?? s.shortId });
    const line2 = main.createEl('div', { cls: 'ilc-members-sub' });
    const bits = [s.running ? t('运行中') : timeAgo(s.lastActive), shortCwd(s.cwd), s.shortId].filter(Boolean);
    line2.setText(bits.join(' · '));

    const action = row.createEl('div', { cls: 'ilc-members-action' });
    if (joinedAs) {
      action.createEl('span', { cls: 'ilc-members-joined', text: t('已加入 · {0}', [joinedAs]) });
      if (!s.running && s.harness === 'claude') {
        const resume = action.createEl('button', { cls: 'ilc-members-resume', text: t('在终端恢复') });
        resume.setAttribute('title', t('打开终端运行 claude --resume，恢复的是这个会话本身；它一启动就会收到未读留言'));
        resume.addEventListener('click', () => this.plugin?.resumeInTerminal?.(s.sessionId, s.cwd));
      }
      return;
    }
    const input = action.createEl('input', {
      cls: 'ilc-members-name',
      attr: { type: 'text', placeholder: t('起个名字'), maxlength: '12', value: leftAs ?? '' },
    }) as HTMLInputElement;
    const btn = action.createEl('button', { cls: 'ilc-members-join mod-cta', text: t('加入') });
    const submit = async () => {
      const err = validateName(input.value);
      if (err) { new Notice(err); input.focus(); return; }
      const res = await upsertAgent(this.app, { name: input.value, sessionId: s.sessionId, harness: s.harness });
      if (!res.ok) { new Notice(res.error); input.focus(); return; }
      new Notice(t('「{0}」已加入，评论里输入 @ 即可点名', [input.value.trim()]));
      await Promise.all([this.renderMembers(), this.renderSessions()]);
      // First member ever → offer the hook right away so the loop closes
      const st = await this.plugin?.hookStatus?.();
      if (st && !st.installed && s.harness === 'claude') {
        new Notice(t('提示：装上「唤醒 hook」后，这个会话下一次说话时就会自动看到你的留言（弹窗顶部可安装）'), 8000);
      }
    };
    btn.addEventListener('click', () => void submit());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
  }
}
