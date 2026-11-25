/**
 * Packing for the `/easel` panel.
 *
 * The panel used to show one chart per screen. These helpers compose every
 * chart into pages: charts are stacked vertically (or laid out in two columns
 * in a wide fullscreen panel), and every page is filled with as many charts as
 * the terminal height allows.
 */

import type { ChartForm, RenderedChart, StyledLine, StyledSpan } from "./types.ts"

export const SELECTED_COLOR = "#5c9cf5"

/** Rows taken by the horizontal separator: blank line, dim rule, blank line. */
const SEPARATOR_ROWS = 3

function makeSeparator(width: number): StyledLine[] {
  const ruleWidth = Math.max(20, Math.min(width, 76))
  return [
    { spans: [] },
    { spans: [{ text: "─".repeat(ruleWidth), dim: true }] },
    { spans: [] },
  ]
}

export interface PanelChartItem {
  id: string
  index: number
  total: number
  title: string
  form: ChartForm
  rendered: RenderedChart
}

export interface PanelLayoutOptions {
  panelWidth: number
  panelHeight: number
  fullscreen?: boolean
  selectedIndex: number
}

export interface PanelPage {
  /** Indices of the charts on this page (0-based, into the original items). */
  indices: number[]
  /** Composed lines for every chart on this page, including sub-headers. */
  lines: StyledLine[]
}

/** Number of vertical columns used for the chart grid. */
export function panelColumns(
  options: Pick<PanelLayoutOptions, "panelWidth" | "fullscreen">,
  count: number,
): 1 | 2 {
  const wide = Boolean(options.fullscreen) || options.panelWidth >= 120
  return wide && options.panelWidth >= 104 && count > 1 ? 2 : 1
}

/** Width the charts themselves are rendered at before the grid places them. */
export function panelChartWidth(
  options: Pick<PanelLayoutOptions, "panelWidth" | "fullscreen">,
  count: number,
): number {
  if (panelColumns(options, count) === 2) return Math.max(44, Math.floor((options.panelWidth - 9) / 2))
  return Math.max(40, Math.min(150, options.panelWidth - 2))
}

/** Visible width of a styled line, counted in code points. */
export function visibleLength(line: StyledLine): number {
  return line.spans.reduce((sum, span) => sum + [...span.text].length, 0)
}

/** Clip a styled line to `width` code points, or pad it with spaces to exactly `width`. */
export function padOrClipLine(line: StyledLine | undefined, width: number): StyledSpan[] {
  const target = Math.max(0, Math.floor(width))
  if (!line) return target > 0 ? [{ text: " ".repeat(target) }] : []
  const spans: StyledSpan[] = []
  let remaining = target
  for (const span of line.spans) {
    if (remaining <= 0) break
    const chars = [...span.text]
    if (chars.length <= remaining) {
      spans.push({ ...span })
      remaining -= chars.length
    } else {
      spans.push({ ...span, text: chars.slice(0, remaining).join("") })
      remaining = 0
    }
  }
  if (remaining > 0) spans.push({ text: " ".repeat(remaining) })
  return spans
}

function markerSpans(item: PanelChartItem, selectedIndex: number): StyledSpan[] {
  if (item.index === selectedIndex) {
    return [
      { text: "▸ ", fg: SELECTED_COLOR, bold: true },
      { text: `${item.index + 1}/${item.total} `, fg: SELECTED_COLOR, bold: true },
    ]
  }
  return [{ text: `  ${item.index + 1}/${item.total} `, dim: true }]
}

/** Fallback header for a chart that rendered no lines at all. */
function headerLine(item: PanelChartItem, selectedIndex: number): StyledLine {
  return {
    spans: [...markerSpans(item, selectedIndex), { text: item.title, bold: true }, { text: ` · ${item.form}`, dim: true }],
  }
}

function isBlankLine(line: StyledLine): boolean {
  return visibleLength(line) === 0 || line.spans.every((span) => !span.text.trim())
}

/** Remove empty leading/trailing lines so charts pack tightly against each other. */
export function trimBlankLines(lines: StyledLine[]): StyledLine[] {
  let start = 0
  let end = lines.length
  while (start < end && isBlankLine(lines[start])) start += 1
  while (end > start && isBlankLine(lines[end - 1])) end -= 1
  return lines.slice(start, end)
}

/**
 * The panel header (selection marker, index and form) is merged into the
 * chart's own title line instead of being printed as a separate row, so the
 * title appears exactly once above every chart.
 */
function chartBlock(item: PanelChartItem, selectedIndex: number): StyledLine[] {
  const body = trimBlankLines(item.rendered.lines)
  const first = body[0]
  if (!first) return [headerLine(item, selectedIndex)]
  const firstText = first.spans.map((span) => span.text).join("")
  if (!firstText.startsWith(item.rendered.title)) return [headerLine(item, selectedIndex), ...body]
  // The panel header (selection marker, index and form) is merged into the
  // chart's own title line instead of being printed as a separate row, so the
  // title appears exactly once above every chart. The title text comes from the
  // panel item, which stays correct even if a form-overridden render lags.
  const [titleSpan, ...detailSpans] = first.spans
  return [
    {
      spans: [
        ...markerSpans(item, selectedIndex),
        { ...titleSpan, text: item.title },
        { text: ` · ${item.form}`, dim: true },
        ...detailSpans,
      ],
    },
    ...body.slice(1),
  ]
}

/**
 * Merge two chart columns into one aligned dashboard grid. The left column is
 * padded to its real content width (not the full nominal column width), so a
 * compact chart never leaves a wide empty void before the divider. Horizontal
 * rules are resized to their column's measured width so they never spill past
 * the content they separate.
 */
export function mergeColumns(leftLines: StyledLine[], rightLines: StyledLine[], colWidth: number): StyledLine[] {
  const height = Math.max(leftLines.length, rightLines.length)

  const isRuleLine = (line: StyledLine) => {
    const text = line.spans.map((span) => span.text).join("").trim()
    return text.length > 0 && /^─+$/.test(text)
  }
  const contentWidth = (lines: StyledLine[]): number =>
    Math.max(28, ...lines.filter((line) => !isRuleLine(line)).map((line) => visibleLength(line)))
  const measuredLeft = contentWidth(leftLines)
  const actualLeftWidth = Math.min(colWidth, measuredLeft + 2)
  const actualRightWidth = Math.min(colWidth, contentWidth(rightLines))

  const resizeRules = (line: StyledLine | undefined, width: number): StyledLine | undefined => {
    if (!line) return undefined
    return isRuleLine(line) ? { spans: [{ text: "─".repeat(width), dim: true }] } : line
  }

  const divider = "   │   "
  const lines: StyledLine[] = []
  for (let row = 0; row < height; row += 1) {
    const left = resizeRules(leftLines[row], actualLeftWidth)
    const right = resizeRules(rightLines[row], actualRightWidth)
    const spans: StyledSpan[] = [...padOrClipLine(left, actualLeftWidth)]
    if (right) {
      spans.push({ text: divider, dim: true }, ...padOrClipLine(right, actualRightWidth))
    } else {
      // Keep the divider intact when the right column has ended: the two
      // columns still read as one crisp, aligned grid.
      spans.push({ text: divider, dim: true })
    }
    lines.push({ spans })
  }
  return lines
}

/**
 * Compose the panel into pages of `StyledLine[]`, packing as many chart rows
 * as the panel height allows. The page containing `selectedIndex` can be found
 * with {@link activePanelPage}.
 */
export function composePanelPages(items: PanelChartItem[], options: PanelLayoutOptions): PanelPage[] {
  if (items.length === 0) return []

  const columns = panelColumns(options, items.length)
  const colWidth = Math.max(44, Math.floor((options.panelWidth - 9) / 2))
  const chartWidth = panelChartWidth(options, items.length)
  const availRows = Math.max(12, options.panelHeight - 6)

  if (columns === 1) {
    const pages: PanelPage[] = []
    let indices: number[] = []
    let lines: StyledLine[] = []
    let usedHeight = 0
    const flush = () => {
      if (indices.length === 0) return
      pages.push({ indices, lines })
      indices = []
      lines = []
      usedHeight = 0
    }

    for (const item of items) {
      const block = chartBlock(item, options.selectedIndex)
      if (indices.length > 0 && usedHeight + SEPARATOR_ROWS + block.length > availRows) flush()
      if (indices.length > 0) {
        lines.push(...makeSeparator(chartWidth))
        usedHeight += SEPARATOR_ROWS
      }
      indices.push(item.index)
      lines.push(...block)
      usedHeight += block.length
    }
    flush()
    return pages
  }

  // Two-column masonry: each chart is appended to the shorter column. Charts
  // therefore stack tightly instead of waiting for a fixed grid row to fill.
  const pages: PanelPage[] = []
  let leftIndices: number[] = []
  let leftLines: StyledLine[] = []
  let rightIndices: number[] = []
  let rightLines: StyledLine[] = []

  const flush = () => {
    if (leftIndices.length === 0 && rightIndices.length === 0) return
    pages.push({
      indices: [...leftIndices, ...rightIndices].sort((a, b) => a - b),
      lines: mergeColumns(leftLines, rightLines, colWidth),
    })
    leftIndices = []
    leftLines = []
    rightIndices = []
    rightLines = []
  }

  const hasRoom = (targetLines: StyledLine[], blockLength: number): boolean => {
    if (targetLines.length === 0 && leftLines.length === 0 && rightLines.length === 0) return true
    return targetLines.length === 0
      ? blockLength <= availRows
      : targetLines.length + SEPARATOR_ROWS + blockLength <= availRows
  }

  for (const item of items) {
    const block = chartBlock(item, options.selectedIndex)
    let useLeft = leftLines.length <= rightLines.length
    let targetLines = useLeft ? leftLines : rightLines
    if (!hasRoom(targetLines, block.length)) {
      useLeft = !useLeft
      targetLines = useLeft ? leftLines : rightLines
    }
    if (!hasRoom(targetLines, block.length)) {
      flush()
      useLeft = true
      targetLines = leftLines
    }

    const targetIndices = useLeft ? leftIndices : rightIndices
    if (targetLines.length > 0) {
      targetLines.push(...makeSeparator(colWidth))
    }
    targetLines.push(...block)
    targetIndices.push(item.index)
  }
  flush()
  return pages
}

/** Index of the page that contains `selectedIndex`, defaulting to the first page. */
export function activePanelPage(pages: PanelPage[], selectedIndex: number): number {
  const found = pages.findIndex((page) => page.indices.includes(selectedIndex))
  return found >= 0 ? found : 0
}
