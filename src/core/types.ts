/** Public types shared by the server, TUI and RPC parts of easel. */

export const CHART_FORMS = ["line", "columns", "bars", "sparks", "share", "pie"] as const
export type ChartForm = (typeof CHART_FORMS)[number]

export type ChartScale = "linear" | "log"
export type CombineMode = "none" | "sum" | "mean" | "max" | "min"

export interface ChartMark {
  x: string | number
  label?: string
  color?: string
}

/** The request accepted by the easel_chart tool. */
export interface ChartRequest {
  data?: string | Array<Record<string, Cell>>
  path?: string
  format?: "text" | "svg"
  form?: ChartForm
  x?: string
  /** Accepts a single column or an array; the first column is used. */
  y?: string | string[]
  /** Every numeric column requested for a wide-format table. */
  yColumns?: string[]
  series?: string | string[]
  /** Alias for `series`. */
  by?: string | string[]
  title?: string
  unit?: string
  combine?: CombineMode
  scale?: ChartScale
  /** Alias for `scale: "log"`. */
  log?: boolean
  marks?: ChartMark[]
  width?: number
  limit?: number
  /** Alias for `limit`. */
  top?: number
}

export type Cell = string | number | boolean | null | undefined
export type Row = Record<string, Cell>

export interface ParsedTable {
  columns: string[]
  rows: Row[]
  format: string
  source?: string
}

export interface SeriesPoint {
  x: string
  value: number | null
}

export interface SeriesStats {
  max: number
  maxX: string
  last: number
  min: number
  mean: number
  total: number
  count: number
}

export interface SeriesModel {
  /** Stable key from the source data. */
  key: string
  /** Display label without the palette letter. */
  label: string
  /** Palette letter, a..h. */
  letter: string
  color: string
  values: Array<number | null>
  stats: SeriesStats
  /** Optional unit when the source table has a per-series unit column. */
  unit?: string
}

export interface ChartPart {
  key: string
  label: string
  letter: string
  color: string
  value: number
}

export interface ChartModel {
  form: ChartForm
  title: string
  unit: string
  xLabel: string
  xKind: "time" | "number" | "category"
  xValues: Array<{ key: string; label: string; full: string }>
  series: SeriesModel[]
  parts: ChartPart[]
  combine: CombineMode
  scale: ChartScale
  marks: ChartMark[]
  notes: string[]
  source?: string
  width: number
  /** Resolved column mapping, useful for diagnostics and the panel. */
  mapping?: {
    x: string
    y: string
    series?: string
  }
}

export interface StyledSpan {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
}

export interface StyledLine {
  spans: StyledSpan[]
}

export interface AutoChartMeta {
  provider: "prometheus" | "datadog" | "grafana"
  tool: string
  metric?: string
}

/** The self-contained value stored in a ```easel fenced code block. */
export interface EaselPayload {
  v: 1
  request: ChartRequest
  table: ParsedTable
  /** Values resolved by the server, so the TUI does not have to guess again. */
  meta?: {
    title?: string
    unit?: string
    form?: ChartForm
    combine?: CombineMode
    scale?: ChartScale
    x?: string
    y?: string
    series?: string
  }
  auto?: AutoChartMeta
}

export interface RenderedChart {
  form: ChartForm
  title: string
  lines: StyledLine[]
  plain: string
  notes: string[]
  payload?: EaselPayload
}

export interface RenderOptions {
  width?: number
  /** Override the form stored in the payload. */
  form?: ChartForm
  /** Use log scale for line plotting. */
  scale?: ChartScale
}

export interface ChartEntry {
  id: string
  sessionID: string
  title: string
  form: ChartForm
  createdAt: number
  payload: EaselPayload
  plain: string
}

export const PALETTE = [
  "#5c9cf5",
  "#e5a93c",
  "#58b970",
  "#b48ef0",
  "#4ec9c9",
  "#e06c75",
  "#e58ac8",
  "#d7c25a",
] as const

export const REST_COLOR = "#6b7280"
export const GUTTER = "⎿ "
export const GUTTER_CONTINUATION = "  "
export const THIN_COLUMN_NOTE = "the thinnest parts of a column are too thin to draw"

export function letterFor(index: number): string {
  return String.fromCharCode(97 + (index % 8))
}

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

export function formLetter(index: number): string {
  return letterFor(index)
}
