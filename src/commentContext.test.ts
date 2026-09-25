import { describe, it, expect } from 'vitest';
import { captureCommentContext } from './commentContext';
import { buildAnnotationMarkup, parseAnnotations } from './parser';

const entry = (text: string) => ({ author: 'User', date: '2026-09-25', type: 'reply', text });
describe('comment context snapshot', () => {
  it('includes neighboring prose and earlier replies, but not later comments or other threads', () => {
    const previous = buildAnnotationMarkup('other passage', [entry('PRIVATE OTHER THREAD')]);
    const own = buildAnnotationMarkup('target', [entry('Earlier question'), entry('Earlier answer'), entry('Current question'), entry('Later answer')]);
    const content = `# Project\n\n${previous}\n\nBefore context\n\n${own}\n\nAfter context`;
    const ann = parseAnnotations(content)[1];
    const context = captureCommentContext(content, ann, 2)!;
    expect(context.before).toContain('Before context');
    expect(context.before).toContain('other passage');
    expect(context.after).toBe('\n\nAfter context');
    expect(context.thread.map(c => c.text)).toEqual(['Earlier question', 'Earlier answer']);
    expect(JSON.stringify(context)).not.toContain('PRIVATE OTHER THREAD');
    expect(JSON.stringify(context)).not.toContain('Later answer');
    expect(context.omittedComments).toBe(0);
    expect(context.truncatedBefore).toBe(false);
  });
  it('bounds large input while retaining the root and newest discussion and flagging omissions', () => {
    const comments = Array.from({ length: 50 }, (_, i) => entry(`comment ${i} ` + '文'.repeat(8000)));
    const content = '前'.repeat(100000) + buildAnnotationMarkup('target', comments) + '后'.repeat(100000);
    const context = captureCommentContext(content, parseAnnotations(content)[0], 49)!;
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(18000);
    expect(context.thread[0].text).toContain('comment 0');
    expect(context.thread.at(-1)?.text).toContain('comment 48');
    expect(context.omittedComments).toBeGreaterThan(0);
    expect(context.thread.some(c => c.truncated)).toBe(true);
    expect(context.truncatedBefore && context.truncatedAfter).toBe(true);
  });
  it('fits the total request context cap even with a very large current comment', () => {
    const content = 'Before'.repeat(1000) + buildAnnotationMarkup('target', [entry('root'), entry('x'.repeat(35000))]) + 'After'.repeat(1000);
    const ann = parseAnnotations(content)[0];
    const context = captureCommentContext(content, ann, 1);
    expect(JSON.stringify({ highlight: ann.highlightText, comment: ann.comments[1], context }).length).toBeLessThanOrEqual(40000);
  });
});

it('uses the explicit index for identical entries and counts omitted history', () => {
  const same = entry('same text');
  const content = buildAnnotationMarkup('target', [same, same, entry('after trigger')]);
  expect(captureCommentContext(content, parseAnnotations(content)[0], 1)?.thread.map(c => c.text)).toEqual(['same text']);
});

it('budgets JSON escaping and preserves complete emoji at excerpt boundaries', () => {
  for (const length of [0, 100, 5000, 20000, 39000, 39600, 39800]) {
    const content = ('😀"\\\n'.repeat(10000)) + buildAnnotationMarkup('target', [entry('😀"\\\n'.repeat(5000)), entry('x'.repeat(length))]) + '😀'.repeat(10000);
    const ann = parseAnnotations(content)[0];
    const context = captureCommentContext(content, ann, 1);
    expect(JSON.stringify({ highlight: ann.highlightText, comment: ann.comments[1], context }).length).toBeLessThanOrEqual(40000);
    if (context) {
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(18000);
      expect(context.before).not.toMatch(/^[\uDC00-\uDFFF]/);
      expect(context.after).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  }
});
