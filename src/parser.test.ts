import { describe, expect, it } from 'vitest';
import { appendReply, parseAnnotations } from './parser.ts';

describe('appendReply', () => {
  it('escapes every comment delimiter pair in reply text', () => {
    const before = 'a {==高亮==}{>>user|2026-07-08|question: @回声?<<} z';
    const from = before.indexOf('{==');
    const after = appendReply(before, from, {
      author: '回声',
      date: '2026-07-08',
      type: 'reply',
      text: 'A << B << C and X >> Y >> Z',
    });

    expect(after).toContain('A ‹‹ B ‹‹ C and X ›› Y ›› Z');
    expect(parseAnnotations(after)[0].comments).toHaveLength(2);
    expect(parseAnnotations(after)[0].comments[1]).toMatchObject({
      author: '回声',
      type: 'reply',
      text: 'A ‹‹ B ‹‹ C and X ›› Y ›› Z',
    });
  });
});

it('ignores literal examples in fenced, inline, indented code, HTML comments and frontmatter', () => {
  const mark = '{==quoted==}{>>User|2026-09-25|question: [@Codex](agent:11111111?notify)<<}';
  for (const text of ['```md\n'+mark+'\n```', '~~~\n'+mark+'\n~~~', '`'+mark+'`', '``'+mark+'``', '    '+mark, '<!-- '+mark+' -->', '---\nexample: '+mark+'\n---\n', '> ```\n> '+mark+'\n> ```', '\\'+mark]) {
    expect(parseAnnotations(text)).toEqual([]);
  }
  expect(parseAnnotations('```\n'+mark+'\n```\n'+mark)).toHaveLength(1);
  expect(parseAnnotations('{==real==}{>>User|today|note: code `a` and\n```\nx\n```\ninside comment<<}')).toHaveLength(1);
});

it('keeps comment identity and receipt hidden through parse/build round trips', async () => {
  const { buildAnnotationMarkup, identifyComment } = await import('./parser');
  const id = '11111111-2222-4333-8444-555555555555';
  const raw = '{==quote==}{>>User|date|note:  original  text <<}';
  const updated = identifyComment(raw, parseAnnotations(raw)[0], 0, id);
  expect(updated).toContain('  original  text \n<!-- ilc-comment:');
  const parsed = parseAnnotations(updated)[0];
  expect(parsed.comments[0].text).toBe('original  text');
  expect(parsed.comments[0].commentId).toBe(id);
  const both = {...parsed.comments[0], replyId: 'a'.repeat(40)};
  expect(parseAnnotations(buildAnnotationMarkup('quote', [both]))[0].comments[0]).toEqual(both);
});

it('preserves real comments inside nested lists while skipping indented code', () => {
  const mark='{==quote==}{>>User|today|note: hello<<}';
  expect(parseAnnotations('- parent\n    - '+mark)).toHaveLength(1);
  expect(parseAnnotations('    '+mark)).toHaveLength(0);
});


it('does not let comment metadata or fences consume the next annotation', async () => {
  const { buildAnnotationMarkup } = await import('./parser');
  const entry = { author:'User', date:'today', type:'note', text:'hello', commentId:'11111111-2222-4333-8444-555555555555' };
  const second = buildAnnotationMarkup('second', [{...entry, commentId:'22222222-2222-4333-8444-555555555555'}]);
  for (const text of ['hello', 'hello\n```', 'hello\n<!-- unfinished']) {
    const first = buildAnnotationMarkup('first', [{...entry, text}]);
    expect(parseAnnotations(first+' and '+second).map(a=>a.highlightText)).toEqual(['first','second']);
    expect(parseAnnotations(first+'\n\n'+second)).toHaveLength(2);
  }
});

it('preserves stable identity and reply receipts when accepting a suggestion', async () => {
  const { buildAnnotationMarkup, applySuggestion } = await import('./parser');
  const entry = {author:'User',date:'today',type:'suggest',text:'replacement',commentId:'11111111-2222-4333-8444-555555555555',replyId:'a'.repeat(40)};
  const raw = buildAnnotationMarkup('original',[entry]);
  expect(parseAnnotations(applySuggestion(raw,0,0))[0].comments[0]).toEqual({...entry,type:'accepted'});
});
