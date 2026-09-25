// Open string so custom types work without compile errors
export type CommentType = string;

export interface CommentEntry {
  author: string;
  date:   string;
  type:   CommentType;
  text:   string;
  /** Hidden receipt for idempotent Codex writeback. */
  replyId?: string;
  /** Stable identity for notifying comments. */
  commentId?: string;
}

export interface Annotation {
  /** Unique id derived from position: `ann-{from}` */
  id:            string;
  highlightText: string;
  comments:      CommentEntry[];
  /** Start offset of `{==` in the document */
  from:          number;
  /** End offset of the last `<<}` in the document */
  to:            number;
}

// ─── Configurable type chip ────────────────────────────────────────────────────

export interface CommentTypeConfig {
  id:    string; // used in markup, e.g. "agree"
  emoji: string;
  label: string;
  /** Hex color for card border and editor highlight, e.g. "#4CAF50" */
  color: string;
}

// ─── AI agent identity ─────────────────────────────────────────────────────────

export interface AIAgentConfig {
  id:         string; // internal key
  name:       string; // shown as author in comments
  avatarChar: string; // single char displayed in avatar
  avatarBg:   string; // hex background color of avatar
  sessionId?:  string; // Claude session id used by registered @Agent replies
  resumeType?: 'claude-resume'; // MVP supports Claude CLI --resume only
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

/** Derive a semi-transparent background from a hex color */
export function typeBgColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.22)`;
}

// ─── Built-in meta (fallback for rendering unknown types) ─────────────────────

export const COMMENT_TYPE_META: Record<string, { label: string; emoji: string }> = {
  agree:     { label: '认同',   emoji: '🟢' },
  disagree:  { label: '不认同', emoji: '🔴' },
  question:  { label: '疑问',   emoji: '🟡' },
  important: { label: '重要',   emoji: '🔵' },
  note:      { label: '备注',   emoji: '⚪' },
  reply:     { label: '回复',   emoji: '💬' },
  pending:   { label: '待回应', emoji: '⏳' },
  suggest:   { label: '建议',   emoji: '✏️' },
  accepted:  { label: '已采纳', emoji: '✅' },
  declined:  { label: '未采纳', emoji: '⛔' },
  resolve:   { label: '已解决', emoji: '✅' },
  react:     { label: '反应',   emoji: '👍' },
};

export const BUILTIN_TYPE_IDS = new Set([
  'agree', 'disagree', 'question', 'important', 'note', 'reply', 'pending', 'suggest', 'accepted', 'declined', 'resolve', 'react',
]);

/** Entry types that behave like replies in a thread (unread tracking, no type chip) */
export const THREAD_REPLY_TYPES = new Set(['reply', 'suggest', 'accepted', 'declined']);
/** Reply-like types that should count as unread when written by someone else */
export const UNREAD_TYPES = new Set(['reply', 'suggest']);

// ─── Deletion history ─────────────────────────────────────────────────────────

export interface DeletedRecord {
  id:                string;   // unique, e.g. "del-1717000000000-abc12"
  deletedAt:         string;   // ISO timestamp
  filePath:          string;   // vault-relative path
  highlightText:     string;   // the {==...==} text
  entries:           CommentEntry[];
  wasFullAnnotation: boolean;  // true if whole thread was deleted
}
