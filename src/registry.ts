import { t } from './i18n.ts';
import type { App } from 'obsidian';

/** Self-service member registry: sessions that can be @-mentioned in comments */
export const REGISTRY_PATH = '_os/comment-agents.json';

export interface RegistryAgent {
  name: string;
  sessionId: string;
  harness: string;
  joinedAt: string;
  /** Vault-relative mailbox folder; scanner falls back to defaultMailbox() when absent */
  mailbox?: string;
  /** Working directory to start/resume the session in (absolute) */
  cwd?: string;
  /** Start the session in a terminal automatically when a letter arrives and it is not running */
  autoStart?: boolean;
}

export interface RegistryFile {
  agents: RegistryAgent[];
  /** Members that left; kept so re-joining can reuse their settings */
  left?: RegistryAgent[];
}

export function defaultMailbox(sessionId: string): string {
  return `Agent协作空间/信箱/${sessionId.slice(0, 8)}/`;
}

export async function readRegistry(app: App): Promise<RegistryFile> {
  try {
    const raw = await app.vault.adapter.read(REGISTRY_PATH);
    const data = JSON.parse(raw) as RegistryFile;
    if (!Array.isArray(data?.agents)) return { agents: [] };
    return data;
  } catch {
    return { agents: [] };
  }
}

export async function writeRegistry(app: App, data: RegistryFile): Promise<void> {
  if (!(await app.vault.adapter.exists('_os'))) await app.vault.adapter.mkdir('_os');
  await app.vault.adapter.write(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

/** 新会话1, 新会话2, … — first name not already taken */
export function nextAutoSessionName(taken: Iterable<string>): string {
  const set = new Set([...taken]);
  for (let i = 1; i < 1000; i++) {
    const n = t('新会话{0}', [i]);
    if (!set.has(n)) return n;
  }
  return t('新会话{0}', [Date.now() % 100000]);
}

/** 2–12 chars, no whitespace or slashes */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return t('请输入名字');
  if (n.length < 2 || n.length > 12) return t('名字 2–12 个字');
  if (/[\s/\\]/.test(n)) return t('名字不能含空格或斜杠');
  return null;
}

/**
 * Add or update a member. Same sessionId → update in place (idempotent, like
 * `comment-agent.sh join`). Same name but a different session → conflict.
 */
export async function upsertAgent(
  app: App,
  agent: Omit<RegistryAgent, 'joinedAt'> & { joinedAt?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const err = validateName(agent.name);
  if (err) return { ok: false, error: err };

  const data = await readRegistry(app);
  const name = agent.name.trim();
  const clash = data.agents.find((a) => a.name === name && a.sessionId !== agent.sessionId);
  if (clash) return { ok: false, error: t('「{0}」已被另一个会话使用', [name]) };

  const entry: RegistryAgent = {
    name,
    sessionId: agent.sessionId,
    harness: agent.harness,
    joinedAt: agent.joinedAt ?? new Date().toISOString(),
    ...(agent.mailbox ? { mailbox: agent.mailbox } : {}),
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(agent.autoStart ? { autoStart: true } : {}),
  };
  const idx = data.agents.findIndex((a) => a.sessionId === agent.sessionId);
  if (idx >= 0) data.agents[idx] = { ...data.agents[idx], ...entry };
  else data.agents.push(entry);
  if (Array.isArray(data.left)) data.left = data.left.filter((a) => a.sessionId !== agent.sessionId);

  await writeRegistry(app, data);
  return { ok: true };
}

/** Remove a member by name; the entry is archived under `left` for easy re-join */
export async function removeAgent(app: App, name: string): Promise<void> {
  const data = await readRegistry(app);
  const gone = data.agents.filter((a) => a.name === name);
  if (gone.length === 0) return;
  data.agents = data.agents.filter((a) => a.name !== name);
  data.left = [...(data.left ?? []).filter((a) => !gone.some((g) => g.sessionId === a.sessionId)), ...gone];
  await writeRegistry(app, data);
}
