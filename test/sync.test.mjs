import { describe, expect, it } from 'vitest';
import { buildHtml, notionToCommonMark } from '../src/sync.mjs';

describe('notionToCommonMark', () => {
  it('turns page and mention tags into links', () => {
    expect(notionToCommonMark('<page url="https://notion.so/abc">My Page</page>'))
      .toBe('[My Page](https://notion.so/abc)');
    expect(notionToCommonMark('<mention-page url="https://notion.so/x"></mention-page>'))
      .toBe('[Untitled](https://notion.so/x)');
    expect(notionToCommonMark('Hi <mention-user id="1">Ada</mention-user>')).toBe('Hi @Ada');
  });

  it('renders date mentions with optional time and end', () => {
    expect(notionToCommonMark('<mention-date start="2026-01-05"/>')).toBe('2026-01-05');
    expect(notionToCommonMark('<mention-date start="2026-01-05" end="2026-01-06"/>'))
      .toBe('2026-01-05 – 2026-01-06');
  });

  it('converts callouts to blockquotes with the icon inlined', () => {
    const out = notionToCommonMark('<callout icon="💡">\nBright idea\n</callout>');
    expect(out).toContain('<blockquote>');
    expect(out).toContain('💡 Bright idea');
    expect(out).toContain('</blockquote>');
  });

  it('expands toggles: details dropped, summary bolded', () => {
    const out = notionToCommonMark('<details>\n<summary>Click me</summary>\nHidden text\n</details>');
    expect(out).not.toContain('<details');
    expect(out).toContain('**Click me**');
    expect(out).toContain('Hidden text');
  });

  it('preserves code fence content, dropping only block nesting tabs', () => {
    const md = '\t```js\n\tconst x = 1;\n\t\tindented();\n\t```';
    expect(notionToCommonMark(md)).toBe('```js\nconst x = 1;\n\tindented();\n```');
  });

  it('does not rewrite tags inside code fences', () => {
    const md = '```\n<page url="https://x">not a link</page>\n```';
    expect(notionToCommonMark(md)).toContain('<page url="https://x">not a link</page>');
  });

  it('strips Notion attributes from tables and keeps cells', () => {
    const md = '<table fit-page-width="true" header-row="true">\n<colgroup><col/></colgroup>\n<tr><th width="120">H</th></tr>\n<tr><td color="blue">v</td></tr>\n</table>';
    const out = notionToCommonMark(md);
    expect(out).toContain('<table>');
    expect(out).toContain('<th>H</th>');
    expect(out).toContain('<td>v</td>');
    expect(out).not.toContain('colgroup');
    expect(out).not.toContain('width=');
  });

  it('strips block attributes and unwraps colored spans', () => {
    expect(notionToCommonMark('# Heading {color="blue"}')).toBe('# Heading');
    expect(notionToCommonMark('<span color="red">warm</span>')).toBe('warm');
    expect(notionToCommonMark('<span underline="true">under</span>')).toBe('<u>under</u>');
  });

  it('keeps tab nesting for list items but strips it from plain text', () => {
    expect(notionToCommonMark('- a\n\t- b')).toBe('- a\n\t- b');
    expect(notionToCommonMark('\tplain tabbed text')).toBe('plain tabbed text');
  });

  it('collapses runs of blank lines', () => {
    expect(notionToCommonMark('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('buildHtml', () => {
  const base = { title: 'T & Co', url: 'https://notion.so/t?a=1&b=2', markdown: 'Hello **world**' };

  it('renders title, body, and source link', () => {
    const html = buildHtml({ ...base, truncated: false });
    expect(html).toContain('<h1>T &amp; Co</h1>');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('href="https://notion.so/t?a=1&amp;b=2"');
    expect(html).not.toContain('Truncated');
  });

  it('flags truncated pages', () => {
    expect(buildHtml({ ...base, truncated: true })).toContain('⚠️ Truncated');
  });
});
