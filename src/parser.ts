import { parser as markdownParser } from '@lezer/markdown';
import type { Annotation, CommentEntry, CommentType } from './types.ts';

/**
 * Matches a full annotation: {==text==} followed by one or more {>>...<<} blocks.
 * Group 1: highlight text
 * Group 2: all comment blocks concatenated (we re-match below)
 */
const FULL_RE =
  /\{==([\s\S]+?)==\}((?:\{>>[\s\S]+?<<\})+)/g;

/** Matches a single comment block */
const BLOCK_RE = /\{>>([\s\S]+?)<<\}/g;

/**
 * Parses a comment block body: "author|date|type: text"
 * Falls back to type=note if format doesn't match.
 */
function parseMeta(raw: string): CommentEntry {
  const metadata = raw.match(/(?:\n<!-- ilc-(?:codex:[a-f0-9]{40}|comment:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}) -->)+\s*$/)?.[0];
  const body = metadata ? raw.slice(0, -metadata.length) : raw;
  const replyId = metadata?.match(/ilc-codex:([a-f0-9]{40})/)?.[1];
  const commentId = metadata?.match(/ilc-comment:([a-f0-9-]{36})/)?.[1];
  const identity = { ...(replyId ? { replyId } : {}), ...(commentId ? { commentId } : {}) };
  const modern = body.match(/^([^|]+)\|([^|]+)\|([^:]+):\s*([\s\S]*)$/);
  if (modern) return { author: modern[1].trim(), date: modern[2].trim(), type: modern[3].trim(), text: modern[4].trim(), ...identity };
  const legacy = body.match(/^([^|]+)\|([^:]+):\s*([\s\S]*)$/);
  if (legacy) return { author: legacy[1].trim(), date: legacy[2].trim(), type: 'note', text: legacy[3].trim(), ...identity };
  return { author: 'unknown', date: '', type: 'note', text: body.trim(), ...identity };
}

/** Parse all annotations from raw document content */
export function parseAnnotations(content: string): Annotation[] {
  const results: Annotation[] = [];
  const ignored: Array<{ from: number; to: number }> = [];
  const literalNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CommentBlock', 'Comment', 'HTMLBlock']);
  // Comment bodies are an atomic extension to Markdown. Mask every code unit,
  // including internal line breaks, so their fences/HTML/metadata cannot alter
  // the surrounding document syntax; offsets into the real source stay exact.
  const prose = content.replace(new RegExp(FULL_RE.source, 'g'), (full, quote, blocks) =>
    full.slice(0, full.length - blocks.length) + 'x'.repeat(blocks.length));
  markdownParser.parse(prose).iterate({ enter(node) {
    if (literalNodes.has(node.name)) { ignored.push({ from: node.from, to: node.to }); return false; }
  } });
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (frontmatter) ignored.push({ from: 0, to: frontmatter[0].length });
  ignored.sort((a, b) => a.from - b.from);
  let range = 0;
  const matcher = new RegExp(FULL_RE.source, 'g');
  for (const m of content.matchAll(matcher)) {
    const from = m.index!;
    while (range < ignored.length && ignored[range].to <= from) range++;
    if (range < ignored.length && ignored[range].from <= from) continue;
    let slashes = 0;
    for (let i = from - 1; i >= 0 && content[i] === '\\'; i--) slashes++;
    if (slashes % 2) continue;
    const comments: CommentEntry[] = [];
    for (const block of m[2].matchAll(new RegExp(BLOCK_RE.source, 'g'))) comments.push(parseMeta(block[1]));
    results.push({ id: `ann-${from}`, highlightText: m[1], comments, from, to: from + m[0].length });
  }

  return results;
}

/** Build the raw markup string for a new annotation */
export function buildAnnotationMarkup(
  highlightText: string,
  comments: CommentEntry[],
): string {
  const blocks = comments
    .map(
      (c) =>
        commentBlock(c),
    )
    .join('');
  return `{==${highlightText}==}${blocks}`;
}

/**
 * Append a reply comment block to the annotation that starts at `annotationFrom`.
 * Returns the modified content string.
 */
export function appendReply(
  content: string,
  annotationFrom: number,
  reply: CommentEntry,
): string {
  const ann = parseAnnotations(content).find(a => a.from === annotationFrom);
  if (!ann) return content;
  return content.slice(0, ann.to) + commentBlock(reply) + content.slice(ann.to);
}

/** Escape `<<` and `>>` inside a comment body to prevent parser confusion */
function escapeBody(text: string): string {
  return text.replace(/<</g, '‹‹').replace(/>>/g, '››');
}

function commentBlock(c: CommentEntry): string {
  const receipt = c.replyId && /^[a-f0-9]{40}$/.test(c.replyId)
    ? `\n<!-- ilc-codex:${c.replyId} -->` : '';
  const identity = c.commentId ? `\n<!-- ilc-comment:${c.commentId} -->` : '';
  return `{>>${c.author}|${c.date}|${c.type}: ${escapeBody(c.text)}${identity}${receipt}<<}`;
}

/**
 * Remove an entire annotation from the document,
 * leaving only the plain highlighted text in its place.
 */
export function deleteAnnotation(content: string, annotationFrom: number): string {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index === annotationFrom) {
      return content.slice(0, m.index) + m[1] + content.slice(m.index + m[0].length);
    }
  }
  return content;
}

/**
 * Remove one comment entry block (by zero-based index) from an annotation.
 * If the deleted entry was the last one, the whole annotation is converted
 * back to plain text.
 */
export function deleteCommentEntry(
  content: string,
  annotationFrom: number,
  entryIndex: number,
): string {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index !== annotationFrom) continue;

    // Collect individual {>>...<<} blocks using a local regex to avoid state issues
    const blocks: string[] = [];
    const blockRe = /\{>>[\s\S]+?<<\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(m[2])) !== null) {
      blocks.push(bm[0]);
    }

    if (entryIndex < 0 || entryIndex >= blocks.length) return content;
    blocks.splice(entryIndex, 1);
    // Reactions point at entry indexes: drop the ones on the deleted entry, shift the rest
    for (let i = blocks.length - 1; i >= 0; i--) {
      const e = parseMeta(blocks[i].slice(3, -3));
      if (e.type !== 'react') continue;
      const r = parseReaction(e.text);
      if (!r) continue;
      if (r.target === entryIndex) blocks.splice(i, 1);
      else if (r.target > entryIndex) blocks[i] = `{>>${e.author}|${e.date}|react: ${r.emoji} #${r.target - 1}<<}`;
    }

    if (blocks.length === 0) {
      // Last entry removed → restore plain text
      return content.slice(0, m.index) + m[1] + content.slice(m.index + m[0].length);
    }

    const newAnnotation = `{==${m[1]}==}${blocks.join('')}`;
    return content.slice(0, m.index) + newAnnotation + content.slice(m.index + m[0].length);
  }
  return content;
}

// ─── Reactions ──────────────────────────────────────────────────────────────────
// `{>>author|date|react: 👍 #2<<}` — an emoji on entry #2 of the same thread.

export interface Reaction { emoji: string; target: number }

export function parseReaction(text: string): Reaction | null {
  const m = text.trim().match(/^(\S+)\s+#(\d+)$/);
  return m ? { emoji: m[1], target: Number(m[2]) } : null;
}

/** Add the author's reaction, or remove it if it is already there */
export function toggleReaction(
  content: string,
  annotationFrom: number,
  target: number,
  emoji: string,
  author: string,
  date: string,
): string {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index !== annotationFrom) continue;
    const blocks: string[] = [];
    const blockRe = /\{>>[\s\S]+?<<\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(m[2])) !== null) blocks.push(bm[0]);
    const idx = blocks.findIndex((b) => {
      const e = parseMeta(b.slice(3, -3));
      const r = e.type === 'react' ? parseReaction(e.text) : null;
      return !!r && r.emoji === emoji && r.target === target && e.author === author;
    });
    if (idx >= 0) blocks.splice(idx, 1);
    else blocks.push(`{>>${author}|${date}|react: ${emoji} #${target}<<}`);
    const rebuilt = `{==${m[1]}==}${blocks.join('')}`;
    return content.slice(0, m.index) + rebuilt + content.slice(m.index + m[0].length);
  }
  return content;
}

/** A thread is resolved when its last entry is a `resolve` marker (reopen = delete it) */
export function isResolved(ann: Annotation): boolean {
  const last = ann.comments[ann.comments.length - 1];
  return last?.type === 'resolve';
}

// ─── Suggestions ────────────────────────────────────────────────────────────────
// A `suggest` entry carries replacement text for the highlighted passage. Accepting
// swaps the passage and marks the entry `accepted`; declining marks it `declined`.
// Both are single string edits so the editor sees one undoable change.

/** Rebuild one annotation with a per-block transform; returns null if not found */
function rewriteAnnotation(
  content: string,
  annotationFrom: number,
  fn: (highlight: string, blocks: string[]) => { highlight: string; blocks: string[] } | null,
): string | null {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index !== annotationFrom) continue;
    const blocks: string[] = [];
    const blockRe = /\{>>[\s\S]+?<<\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(m[2])) !== null) blocks.push(bm[0]);
    const out = fn(m[1], blocks);
    if (!out) return null;
    const rebuilt = `{==${out.highlight}==}${out.blocks.join('')}`;
    return content.slice(0, m.index) + rebuilt + content.slice(m.index + m[0].length);
  }
  return null;
}

/** Change the type of one entry (e.g. suggest → declined) */
export function setEntryType(
  content: string,
  annotationFrom: number,
  entryIndex: number,
  newType: CommentType,
): string {
  const out = rewriteAnnotation(content, annotationFrom, (highlight, blocks) => {
    const raw = blocks[entryIndex];
    if (!raw) return null;
    const next = raw.replace(/^\{>>([^|]+)\|([^|]+)\|[^:]+:/, (_s, a, d) => `{>>${a}|${d}|${newType}:`);
    if (next === raw) return null;
    blocks[entryIndex] = next;
    return { highlight, blocks };
  });
  return out ?? content;
}

/**
 * Apply a suggestion: the highlighted passage becomes the entry's text and the
 * entry is marked `accepted`. Returns the content unchanged when the entry is not
 * a pending suggestion.
 */
export function applySuggestion(content: string, annotationFrom: number, entryIndex: number): string {
  const out = rewriteAnnotation(content, annotationFrom, (_highlight, blocks) => {
    const raw = blocks[entryIndex];
    if (!raw) return null;
    const meta = parseMeta(raw.slice(3, -3));
    if (meta.type !== 'suggest' || !meta.text) return null;
    blocks[entryIndex] = commentBlock({ ...meta, type: 'accepted' });
    return { highlight: meta.text, blocks };
  });
  return out ?? content;
}


/** Add metadata without normalizing any existing user text. */
export function identifyComment(content: string, ann: Annotation, index: number, id: string): string {
  const start = ann.from + 3 + ann.highlightText.length + 3;
  let current = 0;
  const blocks = content.slice(start, ann.to).replace(/\{>>[\s\S]+?<<\}/g, block =>
    current++ === index ? block.slice(0, -3) + `\n<!-- ilc-comment:${id} -->` + block.slice(-3) : block);
  return content.slice(0, start) + blocks + content.slice(ann.to);
}
