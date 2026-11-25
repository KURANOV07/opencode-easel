import {
  CHART_FORMS,
  type Cell,
  type ChartForm,
  type ChartMark,
  type ChartRequest,
  type ChartScale,
  type CombineMode,
} from "./types.ts"

const COMBINE_MODES: CombineMode[] = ["none", "sum", "mean", "max", "min"]

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry)
      if (found) return found
    }
  }
  return undefined
}

function asInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return undefined
  return Math.trunc(number)
}

function asForm(value: unknown): ChartForm | undefined {
  return typeof value === "string" && (CHART_FORMS as readonly string[]).includes(value) ? (value as ChartForm) : undefined
}

function asCombine(value: unknown): CombineMode | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value === "avg" ? "mean" : value
  return (COMBINE_MODES as readonly string[]).includes(normalized) ? (normalized as CombineMode) : undefined
}

function asScale(value: unknown): ChartScale | undefined {
  return value === "log" || value === "linear" ? value : undefined
}

function asMarks(value: unknown): ChartMark[] | undefined {
  if (!Array.isArray(value)) return undefined
  const marks: ChartMark[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const raw = record.x ?? record.at
    if (typeof raw !== "string" && typeof raw !== "number") continue
    const mark: ChartMark = { x: raw }
    if (typeof record.label === "string") mark.label = record.label
    if (typeof record.color === "string") mark.color = record.color
    marks.push(mark)
  }
  return marks.length ? marks : undefined
}

function asData(value: unknown): ChartRequest["data"] | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    return value as Array<Record<string, Cell>>
  }
  return undefined
}

/**
 * Normalize the loose shape accepted by `easel_chart` into the canonical
 * `ChartRequest`. Aliases (`by`, `log`, `top`, `marks[].at`) and arrays for
 * `y`/`series` are all folded here so the renderer only sees one shape.
 */
export function normalizeChartRequest(input: unknown): ChartRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const request: ChartRequest = {}

  const data = asData(record.data)
  if (data !== undefined) request.data = data
  const path = firstString(record.path)
  if (path) request.path = path
  const format = record.format === "svg" || record.format === "text" ? record.format : undefined
  if (format) request.format = format

  const form = asForm(record.form)
  if (form) request.form = form
  const x = firstString(record.x)
  if (x) request.x = x
  const y = firstString(record.y)
  if (y) request.y = y
  // Keep the whole list for wide-format tables: `y: ["REQUESTS", "ERRORS"]`
  // means "draw both columns", not just the first one. `yColumns` is carried
  // through so a second normalization pass (buildModel) keeps it.
  const ySource = Array.isArray(record.yColumns) ? record.yColumns : record.y
  if (Array.isArray(ySource)) {
    const yColumns = ySource
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (yColumns.length > 1) request.yColumns = yColumns
  }
  const series = firstString(record.series) ?? firstString(record.by)
  if (series) request.series = series

  const title = firstString(record.title)
  if (title) request.title = title
  if (typeof record.unit === "string") request.unit = record.unit

  const combine = asCombine(record.combine)
  if (combine) request.combine = combine

  const log = record.log === true || record.log === "true"
  const scale = asScale(record.scale) ?? (log ? "log" : undefined)
  if (scale) request.scale = scale
  if (log) request.log = true

  const limit = asInteger(record.limit) ?? asInteger(record.top)
  if (limit !== undefined && limit > 0) request.limit = limit
  const width = asInteger(record.width)
  if (width !== undefined && width > 0) request.width = width

  const marks = asMarks(record.marks)
  if (marks) request.marks = marks

  return request
}
