import { parseAnnotations } from './parser.ts';
import type { Annotation, CommentEntry } from './types.ts';

export interface ContextComment {
  author: string;
  date: string;
  type: string;
  text: string;
  truncated: boolean;
}

/** A snapshot from the same saved note revision as the triggering comment. */
export interface CommentContext {
  before: string;
  after: string;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  /** Earlier entries only, in their original order. The current question is separate. */
  thread: ContextComment[];
  omittedComments: number;
}

export const MAX_REQUEST_CONTEXT = 40000;
export const MAX_ADDITIONAL_CONTEXT = 18000;
const size = (value: unknown): number => JSON.stringify(value).length;

function plainProse(content: string): string {
  for (const ann of parseAnnotations(content).reverse()) {
    content = content.slice(0, ann.from) + ann.highlightText + content.slice(ann.to);
  }
  return content;
}

/** Limit serialized size too: quotes, newlines and control characters cost more. */
function fitText(text: string, budget: number, tail = false): string {
  let low = 0, high = text.length;
  const part = (n: number): string => {
    let result = tail ? text.slice(text.length - n) : text.slice(0, n);
    // Never split a UTF-16 surrogate pair at the excerpt boundary.
    if (tail && /^[\uDC00-\uDFFF]/.test(result)) result = result.slice(1);
    if (!tail && /[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result;
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(part(mid)) <= budget) low = mid; else high = mid - 1;
  }
  let result = part(low);
  // Prefer whole paragraphs when a boundary exists inside the excerpt.
  if (result.length < text.length) {
    const boundary = tail ? result.indexOf('\n\n') : result.lastIndexOf('\n\n');
    if (boundary >= 0) {
      const paragraph = tail ? result.slice(boundary + 2) : result.slice(0, boundary);
      if (paragraph.trim()) result = paragraph;
    }
  }
  return result;
}

export function captureCommentContext(content: string, ann: Annotation, commentIndex: number): CommentContext | undefined {
  const comment = ann.comments[commentIndex];
  if (!comment) throw new Error('Missing triggering comment');
  // Reserve object/key overhead so the exact combined request stays under its cap.
  const budget = Math.min(MAX_ADDITIONAL_CONTEXT,
    MAX_REQUEST_CONTEXT - size({ highlight: ann.highlightText, comment }) - 32);
  if (budget < 256) return undefined;
  const before = plainProse(content.slice(0, ann.from));
  const after = plainProse(content.slice(ann.to));
  const sideBudget = Math.min(3002, Math.floor((budget - 180) / 4));
  const context: CommentContext = {
    before: fitText(before, sideBudget, true), after: fitText(after, sideBudget),
    truncatedBefore: false, truncatedAfter: false, thread: [], omittedComments: commentIndex,
  };
  context.truncatedBefore = context.before.length < before.length;
  context.truncatedAfter = context.after.length < after.length;

  const add = (entry: CommentEntry, limit: number, position: number): boolean => {
    const remaining = Math.min(limit, budget - size(context) - 8);
    const base: ContextComment = { author: entry.author, date: entry.date, type: entry.type, text: '', truncated: false };
    const textBudget = remaining - size(base) + 2;
    if (textBudget < 32) return false;
    base.text = fitText(entry.text, textBudget);
    base.truncated = base.text.length < entry.text.length;
    context.thread.splice(position, 0, base);
    context.omittedComments--;
    return true;
  };
  // Keep the question that started the discussion, then prioritize recent replies.
  if (commentIndex > 0) add(ann.comments[0], Math.min(2500, Math.floor((budget - size(context)) / 3)), 0);
  const hasRoot = context.thread.length > 0;
  for (let i = commentIndex - 1; i >= 1; i--) {
    if (!add(ann.comments[i], 4000, hasRoot ? 1 : 0)) break;
  }
  return context;
}

export function validateCommentContext(context: CommentContext): void {
  if (!context || typeof context.before !== 'string' || typeof context.after !== 'string' ||
      typeof context.truncatedBefore !== 'boolean' || typeof context.truncatedAfter !== 'boolean' ||
      !Number.isInteger(context.omittedComments) || context.omittedComments < 0 ||
      !Array.isArray(context.thread) || context.thread.some(c => !c ||
        !['author', 'date', 'type', 'text'].every(k => typeof (c as any)[k] === 'string') || typeof c.truncated !== 'boolean') ||
      size(context) > MAX_ADDITIONAL_CONTEXT) {
    throw new Error('Invalid or oversized comment context snapshot');
  }
}
