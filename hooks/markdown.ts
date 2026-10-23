/** Avoid the host's wide table grids inside a constrained pane.
 * Keep all cell Markdown, but present each record as wrapping labeled fields.
 */
type PipeRow = { cells: string[]; indent: string }

function pipeRow(line: string): PipeRow | undefined {
  if (/^(?: {4}|\t)/.test(line)) return undefined
  const indent = line.match(/^ */)?.[0] ?? ''
  const source = line.trim()
  const cells: string[] = []
  let cell = ''
  let code = 0
  let pipes = 0
  let lastPipe = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    lastPipe = false
    if (character === '\\') {
      cell += character + (source[index + 1] ?? '')
      index += 1
    } else if (character === '`') {
      let end = index + 1
      while (source[end] === '`') end += 1
      const size = end - index
      cell += source.slice(index, end)
      if (code === 0) code = size
      else if (code === size) code = 0
      index = end - 1
    } else if (character === '|' && code === 0) {
      cells.push(cell.trim())
      cell = ''
      pipes += 1
      lastPipe = true
    } else {
      cell += character
    }
  }
  if (pipes === 0) return undefined
  cells.push(cell.trim())
  if (source.startsWith('|')) cells.shift()
  if (lastPipe) cells.pop()
  return { cells, indent }
}

function label(header: string | undefined, index: number): string {
  const text = header?.replace(/^\*\*(.*)\*\*$/, '$1').replace(/^__(.*)__$/, '$1')
  return text || 'Column ' + (index + 1)
}

export function paneMarkdown(source: string): string {
  const lines = source.split(/\r?\n/)
  const output: string[] = []
  let fence: { character: string; length: number } | undefined
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      output.push(line)
      if (
        marker &&
        marker[1]?.[0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2]?.trim() === ''
      ) fence = undefined
      continue
    }
    if (marker) {
      fence = { character: marker[1]?.[0] ?? '`', length: marker[1]?.length ?? 3 }
      output.push(line)
      continue
    }
    const header = pipeRow(line)
    const separator = pipeRow(lines[index + 1] ?? '')
    if (
      !header || !separator ||
      header.cells.length !== separator.cells.length ||
      separator.cells.length === 0 ||
      !separator.cells.every(cell => /^:?-+:?$/.test(cell))
    ) {
      output.push(line)
      continue
    }
    changed = true
    const rows: PipeRow[] = []
    let end = index + 2
    for (; end < lines.length; end += 1) {
      if (/^ {0,3}(`{3,}|~{3,})/.test(lines[end] ?? '')) break
      const row = pipeRow(lines[end] ?? '')
      if (!row || row.indent !== header.indent) break
      rows.push(row)
    }
    output.push('')
    if (rows.length === 0) {
      const labels = header.cells.map((cell, column) => label(cell, column))
      output.push(header.indent + labels.join(' · '))
    }
    for (const row of rows) {
      const fields: string[] = []
      for (let column = 0; column < Math.max(header.cells.length, row.cells.length); column += 1) {
        const prefix = column === 0 ? '- ' : '  '
        fields.push(
          header.indent + prefix + '**' + label(header.cells[column], column) +
          ':** ' + (row.cells[column] || '—'),
        )
      }
      output.push(fields.join('  \n'), '')
    }
    index = end - 1
  }
  return changed ? output.join('\n') : source
}
