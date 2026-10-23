import { describe, expect, test } from 'claude-code/testing'
import { paneMarkdown } from '../hooks/markdown'

describe('pane Markdown tables', () => {
  test('keeps every cell, inline style, Unicode and surrounding prose', () => {
    const source = [
      'Before', '', '| Command | Result |', '| :--- | ---: |',
      '| `pnpm lint` | **Passed** — [log](https://example.com) |',
      '| `pnpm test` | tests 101, suites 27, pass 101, fail 0, cancelled 0, skipped 0, todo 0 (was 97), exit 0 |',
      '', 'Después 中文',
    ].join('\n')
    const result = paneMarkdown(source)
    expect(result).toContain('- **Command:** `pnpm lint`')
    expect(result).toContain('**Result:** **Passed** — [log](https://example.com)')
    expect(result).toContain('tests 101, suites 27, pass 101, fail 0, cancelled 0, skipped 0, todo 0 (was 97), exit 0')
    expect(result).toContain('Before')
    expect(result).toContain('Después 中文')
    expect(result).not.toContain('| :--- |')
  })

  test('preserves escaped pipes and inline code pipes in their cells', () => {
    const result = paneMarkdown([
      '| Command | Result |', '| --- | --- |',
      '| `printf a | cat` | a\\|b |',
      '| ``echo `a|b` `` | done |',
    ].join('\n'))
    expect(result).toContain('**Command:** `printf a | cat`')
    expect(result).toContain('**Result:** a\\|b')
    expect(result).toContain('**Command:** ``echo `a|b` ``')
    expect(result).toContain('**Result:** done')
  })

  test('leaves fenced and indented code examples unchanged', () => {
    for (const fence of ['```', '````', '~~~']) {
      const source = [fence + 'markdown', '| Command | Result |', '| --- | --- |', '| lint | pass |', fence].join('\n')
      expect(paneMarkdown(source)).toBe(source)
    }
    const indented = '    | Command | Result |\n    | --- | --- |\n    | lint | pass |'
    expect(paneMarkdown(indented)).toBe(indented)
  })

  test('does not close a fence with a shorter or different marker', () => {
    const source = ['````markdown', '```', '| A | B |', '| --- | --- |', '| a | b |', '~~~', '````'].join('\n')
    expect(paneMarkdown(source)).toBe(source)
  })

  test('retains ordinary Markdown and non-table pipe expressions exactly', () => {
    for (const source of ['## Result\n\nAll good', 'Title\n---', 'a | b\nc | d', '| a | b |\n| --- |', 'A\r\n\r\nB']) {
      expect(paneMarkdown(source)).toBe(source)
    }
  })

  test('supports optional outer pipes, blank cells, styled labels and extra data', () => {
    const result = paneMarkdown('**Command** | Result\n--- | ---\nlint | pass\nbuild | | retained extra cell')
    expect(result).toContain('**Command:** lint')
    expect(result).toContain('**Result:** pass')
    expect(result).toContain('**Result:** —')
    expect(result).toContain('**Column 3:** retained extra cell')
    expect(result).not.toContain('****Command')
  })

  test('keeps empty-table headers and adapts multiple tables', () => {
    const result = paneMarkdown('| A | B |\n| --- | --- |\n\n| C | D |\n| --- | --- |\n| c | d |')
    expect(result).toContain('A · B')
    expect(result).toContain('**C:** c')
    expect(result).toContain('**D:** d')
  })
})
