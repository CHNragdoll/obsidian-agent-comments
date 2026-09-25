import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildCommentExtension } from './cmExtension';

describe('multiline comments', () => {
  it('supplies replacements directly from editor state, before viewport layout', () => {
    const raw = '{==quote==}{>>Codex|2026-09-25|reply: first line\nsecond line\n<!-- ilc-codex:' + 'a'.repeat(40) + ' --><<}';
    const host = { onEditorCursorInAnnotation() {}, onPositionsUpdated() {}, onEditorScroll() {} };
    let state = EditorState.create({ doc: raw, extensions: buildCommentExtension(host) });
    const replacementRanges = (s: EditorState) => {
      const ranges: Array<[number, number]> = [];
      for (const source of s.facet(EditorView.decorations)) {
        // A function provider cannot replace line breaks in CodeMirror.
        expect(typeof source).not.toBe('function');
        if (typeof source !== 'function') source.between(0, s.doc.length, (from, to, deco) => {
          if (deco.spec.widget) ranges.push([from, to]);
        });
      }
      return ranges;
    };
    expect(replacementRanges(state)).toEqual([[8, raw.length]]);
    state = state.update({ changes: { from: 0, insert: 'prefix\n' } }).state;
    expect(replacementRanges(state)).toEqual([[15, raw.length + 7]]);
  });
});
