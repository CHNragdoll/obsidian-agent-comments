/**
 * In-plugin replacement for `_os/scripts/comment-mention-scanner.py`.
 *
 * Watches annotations for structured mentions `[@花名](agent:短id?notify)` and
 * delivers each new one as a mailbox letter (`<mailboxRoot>/<短id>/…md`) using
 * the same frontmatter, filename, dedupe key and skip rules as the old cron
 * scanner — so agents' inbox habits keep working, and nothing already delivered
 * by the old scanner is delivered twice (`_os/.comment-mention-state.json`).
 *
 * Trigger model: a modified markdown file is rescanned (debounced); a full
 * vault sweep runs once after load and on demand.
 *
 * This module holds the pure, dependency-free parts (regex, key, letter,
 * skip rules); the Obsidian-bound service lives in mentionDeliveryService.ts.
 */

export const STATE_PATH = '_os/.comment-mention-state.json';
export const DEFAULT_MAILBOX_ROOT = 'Agent协作空间/信箱';

/** 有效@：飞书式结构化标记，纯文本 @xxx 永不触发 */
export const MENTION_RE = /\[@([一-龥A-Za-z0-9]+)\]\(agent:([0-9a-fA-F]{8})(\?notify)?\)/g;

const SKIPPED_PARTS = new Set(['.obsidian', '.trash', 'node_modules', '.git']);

export interface DeliverySettings {
  enabled: boolean;
  mailboxRoot: string;
}

export interface Candidate {
  name: string;
  sessionId: string;
  shortId: string;
  mailbox?: string;
  harness?: string;
  cwd?: string;
  autoStart?: boolean;
}

/** Same key as the python scanner: sha1(relative_path + highlight + content + short_id) */
export async function mentionKey(relPath: string, highlight: string, content: string, shortId: string, commentId?: string): Promise<string> {
  const data = new TextEncoder().encode(commentId ? JSON.stringify(['v2', commentId, shortId]) : relPath + highlight + content + shortId);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
export function fmtDate(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function fmtDateTime(d: Date): string { return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function fmtStamp(d: Date): string { return `${fmtDate(d)}-${pad(d.getHours())}${pad(d.getMinutes())}`; }

export function safeDocFragment(relPath: string): string {
  const stem = relPath.split('/').pop()!.replace(/\.md$/, '').slice(0, 20);
  const frag = stem.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
  return frag || '未命名文档';
}

export function buildLetter(
  sessionId: string,
  relPath: string,
  highlight: string,
  content: string,
  author: string,
  commentDate: string,
  now: Date,
  toName = '',
): string {
  return `---
from: comment-scanner
to: ${sessionId}${toName ? `\nto_name: ${toName}` : ''}
urgency: 普通
wake: true
status: 未读
created: ${fmtDateTime(now)}
---
📄 文档留言：${author} 在文档里 @了你。

- 文档：${relPath}
- 划线原文：${highlight}
- 留言内容：${content}
- 留言者：${author}｜${commentDate}

请处理：读该文档理解上下文，用划线评论回复（在该评论块末尾追加 \`{>>你的花名|${fmtDate(now)}|reply: 内容<<}\`，评论体禁止出现连续的小于号或大于号）。
`;
}

/**
 * Why a mention must NOT be delivered (null = deliver).
 * Mirrors the python scanner exactly.
 */
export function skipReason(
  m: { name: string; shortId: string; notify: boolean },
  comment: { author: string; type: string },
  candidate: Candidate | undefined,
  rosterNames: Set<string>,
): string | null {
  if (!candidate) return `候选名单无匹配会话(短id ${m.shortId})`;
  if (!m.notify) return '无?notify（仅引用，不通知）';
  if (comment.author === m.name) return '留言者 @自己';
  // 只排除"已注册Agent写的reply"(防AI回复自触发)；人类在回复框写的@照常投
  if ((comment.type === 'reply' || comment.type === 'suggest') && rosterNames.has(comment.author)) return 'Agent的reply(防自触发)';
  return null;
}

export function isScannable(relPath: string, mailboxRoot: string): boolean {
  if (!relPath.endsWith('.md')) return false;
  const parts = relPath.split('/');
  if (parts.some((p) => SKIPPED_PARTS.has(p))) return false;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'Agent协作空间' && parts[i + 1] === '归档') return false;
  }
  const root = mailboxRoot.replace(/\/+$/, '');
  if (root && (relPath === root || relPath.startsWith(root + '/'))) return false; // never scan the letters themselves
  return true;
}
