import {
  PALETTE,
  REST_COLOR,
  THIN_COLUMN_NOTE,
  colorFor,
  letterFor,
  type Cell,
  type ChartForm,
  type ChartMark,
  type ChartModel,
  type ChartScale,
  type CombineMode,
  type ChartPart,
  type ChartRequest,
  type EaselPayload,
  type ParsedTable,
  type RenderOptions,
  type RenderedChart,
  type SeriesModel,
  type SeriesStats,
  type StyledLine,
  type StyledSpan,
} from "./types.ts"
import { columnLooksDate, isDateName, parseDateValue, toNumber } from "./parser.ts"
import { normalizeChartRequest } from "./request.ts"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "-"
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

function isInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9
}

function statNumber(value: number): string {
  if (!Number.isFinite(value)) return "-"
  if (Math.abs(value) >= 100 || isInteger(value)) return formatNumber(Math.round(value))
  return formatNumber(value, 1)
}

function dateParts(value: Cell): Date | undefined {
  return parseDateValue(value)
}

function shortDate(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

function fullDate(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${date.getUTCFullYear()}`
}

function xDisplay(value: Cell, kind: "time" | "number" | "category"): { key: string; label: string; full: string } {
  if (kind === "time") {
    const date = dateParts(value)
    if (date) {
      const short = shortDate(date)
      return { key: date.toISOString(), label: short, full: fullDate(date) }
    }
  }
  if (kind === "number") {
    const number = typeof value === "number" ? value : toNumber(value)
    if (number !== undefined) {
      const text = formatNumber(number)
      return { key: String(number), label: text, full: text }
    }
  }
  const text = value === null || value === undefined ? "-" : String(value)
  return { key: text, label: text, full: text }
}

function capitalize(text: string): string {
  if (!text) return text
  return text.slice(0, 1).toUpperCase() + text.slice(1)
}

function sortedUnique(values: Cell[], kind: "time" | "number" | "category"): Cell[] {
  const map = new Map<string, Cell>()
  for (const value of values) {
    const display = xDisplay(value, kind)
    if (!map.has(display.key)) map.set(display.key, value)
  }
  const result = [...map.values()]
  if (kind === "time") {
    result.sort((left, right) => {
      const a = dateParts(left)?.getTime() ?? 0
      const b = dateParts(right)?.getTime() ?? 0
      return a - b
    })
  } else if (kind === "number") {
    result.sort((left, right) => (toNumber(left) ?? 0) - (toNumber(right) ?? 0))
  }
  return result
}

function distinct(values: Cell[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue
    unique.add(String(value))
  }
  return [...unique]
}

function statsFor(values: Array<number | null>, xValues: ChartModel["xValues"]): SeriesStats {
  let max = -Infinity
  let min = Infinity
  let maxIndex = 0
  let total = 0
  let count = 0
  let last: number | undefined
  values.forEach((value, index) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return
    count++
    total += value
    last = value
    if (value > max) {
      max = value
      maxIndex = index
    }
    if (value < min) min = value
  })
  if (count === 0) {
    return { max: 0, maxX: "-", last: 0, min: 0, mean: 0, total: 0, count: 0 }
  }
  return {
    max,
    maxX: xValues[maxIndex]?.label ?? "-",
    last: last ?? 0,
    min,
    mean: total / count,
    total,
    count,
  }
}

function looksGeneric(name: string): boolean {
  return /^(value|values|count|total|sum|amount|metric|y|data)$/i.test(name.trim())
}

function chooseForm(request: ChartRequest, xKind: ChartModel["xKind"], seriesCount: number, rowCount: number): ChartForm {
  if (request.form) return request.form
  if (xKind === "time") return seriesCount > 1 || rowCount > 1 ? "line" : "bars"
  if (xKind === "category" || seriesCount === 1) return "bars"
  return "columns"
}

export function buildModel(table: ParsedTable, rawRequest: ChartRequest = {}): ChartModel {
  if (!table.columns.length || !table.rows.length) throw new Error("easel: parsed data has no rows")
  const request = normalizeChartRequest(rawRequest)

  const columnValues = new Map<string, Cell[]>()
  for (const column of table.columns) {
    columnValues.set(
      column,
      table.rows.map((row) => row[column]),
    )
  }

  const numericColumns = table.columns.filter((column) => {
    const values = columnValues.get(column) ?? []
    const present = values.filter((value) => value !== null && value !== undefined && value !== "")
    if (present.length === 0) return false
    const numeric = present.filter((value) => toNumber(value) !== undefined).length
    return numeric / present.length >= 0.7 && !columnLooksDate(values, column)
  })
  if (numericColumns.length === 0) throw new Error("easel: no numeric column found")

  const dateColumns = table.columns.filter((column) => columnLooksDate(columnValues.get(column) ?? [], column))
  const textColumns = table.columns.filter((column) => !numericColumns.includes(column) && !dateColumns.includes(column))

  const requestedX = typeof request.x === "string" && table.columns.includes(request.x) ? request.x : undefined
  const requestedYColumns = [
    ...(typeof request.y === "string" ? [request.y] : Array.isArray(request.y) ? request.y : []),
    ...(request.yColumns ?? []),
  ].filter((column, index, list) => Boolean(column) && list.indexOf(column) === index)
  const requestedY = requestedYColumns.find((column) => table.columns.includes(column))
  const requestedSeries = typeof request.series === "string" ? request.series : undefined

  if (request.x && !requestedX) throw new Error(`easel: x column "${request.x}" was not found`)
  for (const column of requestedYColumns) {
    if (!table.columns.includes(column)) throw new Error(`easel: y column "${column}" was not found`)
  }
  if (requestedSeries && !table.columns.includes(requestedSeries)) {
    throw new Error(`easel: series column "${requestedSeries}" was not found`)
  }

  // Automatic series naming only comes from text columns. Never steal a column
  // that was explicitly requested as an axis, and leave enough columns behind
  // for the x axis (and a y axis in wide format).
  let seriesColumn = requestedSeries && table.columns.includes(requestedSeries) ? requestedSeries : undefined
  if (!seriesColumn && !requestedSeries) {
    const mustReserveXAxis = dateColumns.length === 0 && !requestedX
    const canReserveXAxis = textColumns.length >= 2 || numericColumns.length >= 2
    if (!mustReserveXAxis || canReserveXAxis) {
      const candidates = textColumns.filter((column) => {
        if (column === requestedX || requestedYColumns.includes(column)) return false
        const values = columnValues.get(column) ?? []
        const count = distinct(values).length
        return count >= 2 && count <= 40 && count < values.length && count < table.rows.length
      })
      seriesColumn = candidates[0]
    }
  }

  let xColumn =
    requestedX ??
    dateColumns.find((column) => isDateName(column)) ??
    dateColumns[0] ??
    (seriesColumn ? textColumns.find((column) => column !== seriesColumn) : textColumns[0]) ??
    table.columns[0]

  // A column cannot be both the x axis and the series split.
  if (seriesColumn === xColumn) seriesColumn = undefined

  // Wide tables usually have several numeric columns; never reuse the x axis
  // (or the series split) as the y axis.
  const yPool = numericColumns.filter((column) => column !== xColumn && column !== seriesColumn)
  const yCandidates = yPool.length > 0 ? yPool : numericColumns
  let yColumn = requestedY ?? (yCandidates.find((column) => !looksGeneric(column)) ?? yCandidates[0])

  if (!numericColumns.includes(yColumn)) throw new Error(`easel: y column "${yColumn}" is not numeric`)

  const xValuesRaw = columnValues.get(xColumn) ?? []
  const xKind: ChartModel["xKind"] = dateColumns.includes(xColumn)
    ? "time"
    : numericColumns.includes(xColumn)
      ? "number"
      : "category"
  const rawUnique = sortedUnique(xValuesRaw, xKind)

  const xValues = rawUnique.map((value) => xDisplay(value, xKind))
  const indexByKey = new Map<string, number>()
  xValues.forEach((value, index) => indexByKey.set(value.key, index))

  const longFormat = Boolean(seriesColumn)
  const seriesSource = longFormat ? seriesColumn! : undefined
  const requestedWide = (request.yColumns ?? []).filter(
    (column) => numericColumns.includes(column) && column !== xColumn && column !== seriesColumn,
  )
  const wideColumns = longFormat
    ? [yColumn]
    : requestedWide.length > 0
      ? requestedWide
      : numericColumns.filter((column) => column !== xColumn && column !== seriesSource)

  if (wideColumns.length === 0) wideColumns.push(yColumn)

  const combine: CombineMode = request.combine ?? "none"
  type Buckets = Array<number[] | undefined>
  const seriesMap = new Map<string, { label: string; buckets: Buckets; unit?: string }>()

  // In wide format every numeric column starts a series (even if all of its
  // values are empty). In long format the series names come from the data, so
  // no placeholder "value" series is inserted.
  if (!longFormat) {
    for (const column of wideColumns) {
      if (!seriesMap.has(column)) seriesMap.set(column, { label: column, buckets: xValues.map(() => undefined) })
    }
  }
  const unitColumn = table.columns.find((column) => /^units?$/i.test(column) && column !== xColumn && column !== yColumn)

  const push = (label: string, index: number, value: number) => {
    let entry = seriesMap.get(label)
    if (!entry) {
      entry = { label, buckets: xValues.map(() => undefined) }
      seriesMap.set(label, entry)
    }
    const bucket = entry.buckets[index] ?? []
    bucket.push(value)
    entry.buckets[index] = bucket
  }

  for (const row of table.rows) {
    const xKey = xDisplay(row[xColumn], xKind).key
    const index = indexByKey.get(xKey)
    if (index === undefined) continue
    if (longFormat) {
      const rawLabel = row[seriesColumn!]
      const label = rawLabel === null || rawLabel === undefined || rawLabel === "" ? yColumn : String(rawLabel)
      const value = toNumber(row[yColumn])
      if (value === undefined) continue
      let entry = seriesMap.get(label)
      if (!entry) {
        entry = { label, buckets: xValues.map(() => undefined) }
        seriesMap.set(label, entry)
      }
      if (unitColumn && row[unitColumn] !== null && row[unitColumn] !== undefined) {
        entry.unit = String(row[unitColumn])
      }
      push(label, index, value)
    } else {
      for (const column of wideColumns) {
        const value = toNumber(row[column])
        if (value !== undefined) push(column, index, value)
      }
    }
  }

  const aggregate = (bucket: number[] | undefined): number | null => {
    if (!bucket || bucket.length === 0) return null
    if (combine === "mean") return bucket.reduce((sum, value) => sum + value, 0) / bucket.length
    if (combine === "max") return Math.max(...bucket)
    if (combine === "min") return Math.min(...bucket)
    // "none" with repeated (x, series) pairs and "sum" both add values up.
    return bucket.reduce((sum, value) => sum + value, 0)
  }

  const provisionalForm = chooseForm(request, xKind, seriesMap.size, table.rows.length)
  const defaultLimit = provisionalForm === "line" || provisionalForm === "columns" ? 8 : 40
  const seriesLimit =
    request.limit && request.limit > 0 ? Math.max(1, Math.min(defaultLimit, request.limit)) : defaultLimit
  const notes: string[] = []

  let series: SeriesModel[] = [...seriesMap.entries()].map(([key, entry]) => {
    const values = entry.buckets.map((bucket) => aggregate(bucket))
    return {
      key,
      label: entry.label,
      letter: "a",
      color: PALETTE[0],
      values,
      stats: statsFor(values, xValues),
      unit: entry.unit,
    }
  })
  series = series.filter((entry) => entry.stats.count > 0)
  series.sort((left, right) => right.stats.max - left.stats.max)
  if (series.length > seriesLimit) {
    notes.push(`showing the top ${seriesLimit} of ${series.length} series`)
    series = series.slice(0, seriesLimit)
  }
  series.forEach((entry, index) => {
    entry.letter = letterFor(index)
    entry.color = colorFor(index)
  })

  if (series.length === 0) throw new Error("easel: no numeric values to chart")

  const scale: ChartScale = request.scale ?? (request.log ? "log" : "linear")
  const parts = buildParts(series, xValues, xKind)

  const units = [...new Set(series.map((entry) => entry.unit).filter((value): value is string => Boolean(value)))]
  const unit =
    request.unit ??
    (units.length > 1
      ? ""
      : units[0] ??
        (!looksGeneric(yColumn) ? yColumn : series.length === 1 && !looksGeneric(series[0].label) ? series[0].label : ""))

  const nameForTitle = longFormat ? seriesColumn! : yColumn
  const autoTitle = longFormat
    ? `${capitalize(!looksGeneric(yColumn) ? yColumn : "value")} by ${nameForTitle}`
    : xKind === "time"
      ? `${capitalize(yColumn)} over ${xColumn}`
      : `${capitalize(yColumn)} by ${xColumn}`

  const form = request.form ?? provisionalForm
  return {
    form,
    title: request.title?.trim() || autoTitle,
    unit,
    xLabel: xColumn,
    xKind,
    xValues,
    series,
    parts,
    combine,
    scale,
    marks: request.marks ?? [],
    notes,
    source: table.source,
    width: Math.max(48, Math.min(220, request.width ?? 78)),
    mapping: { x: xColumn, y: yColumn, series: seriesColumn },
  }
}

function buildParts(series: SeriesModel[], xValues: ChartModel["xValues"], xKind: ChartModel["xKind"]): ChartPart[] {
  if (series.length > 1) {
    return series
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        letter: entry.letter,
        color: entry.color,
        value: entry.stats.total,
      }))
      .sort((left, right) => right.value - left.value)
  }

  const entry = series[0]
  let parts: ChartPart[] = entry.values.map((value, index) => ({
    key: xValues[index]?.key ?? String(index),
    label: xValues[index]?.label ?? String(index),
    letter: "a",
    color: PALETTE[0],
    value: value ?? 0,
  }))
  // Sort first, then assign the palette so the largest part is always `a`.
  parts.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
  if (xKind === "time" && parts.length > 12) parts = parts.slice(0, 12)
  parts.forEach((part, index) => {
    part.letter = letterFor(index)
    part.color = colorFor(index)
  })
  return parts
}

interface Axis {
  max: number
  ticks: number[]
  decimals: number
  log: boolean
}

function niceStep(raw: number): number {
  if (raw <= 0 || !Number.isFinite(raw)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

export function makeAxis(maxValue: number, intervals: number, log = false): Axis {
  const count = Math.max(1, Math.round(intervals))
  if (log) {
    const safe = maxValue > 0 && Number.isFinite(maxValue) ? maxValue : 10
    const top = 10 ** Math.ceil(Math.log10(safe))
    const ticks: number[] = []
    for (let value = 1; value <= top + 1e-9; value *= 10) ticks.push(value)
    return { max: top, ticks, decimals: 0, log: true }
  }
  // All-zero (or invalid) data still needs a clean 0..intervals axis. Using
  // Number.EPSILON here produced five identical "0.000" tick labels.
  const safe = maxValue > 0 && Number.isFinite(maxValue) ? maxValue : count
  const step = niceStep(safe / count)
  const top = step * count
  const ticks: number[] = []
  for (let index = 0; index <= count; index++) ticks.push(step * index)
  const decimals = step < 1 ? Math.min(3, Math.max(0, Math.ceil(-Math.log10(step)))) : 0
  return { max: top, ticks, decimals, log: false }
}

function scaleValue(value: number, axis: Axis): number {
  if (axis.log) {
    const top = Math.log10(Math.max(1, axis.max))
    if (top <= 0) return 0
    return Math.min(1, Math.max(0, Math.log10(Math.max(1, value)) / top))
  }
  return Math.min(1, Math.max(0, value / axis.max))
}

function tickLabel(value: number, axis: Axis): string {
  if (axis.log) {
    if (value >= 1_000_000) return `${value / 1_000_000}M`
    if (value >= 1_000) return `${value / 1_000}k`
    return formatNumber(value)
  }
  return formatNumber(value, axis.decimals)
}

function headerLine(model: ChartModel, suffix?: string): StyledLine {
  const spans: StyledSpan[] = [{ text: model.title, bold: true }]
  const bits: string[] = []
  if (model.unit) bits.push(model.unit)
  const range = rangeLabel(model)
  if (range) bits.push(range)
  if (suffix) bits.push(suffix)
  if (bits.length) spans.push({ text: ` · ${bits.join(" · ")}`, dim: true })
  return { spans }
}

function rangeLabel(model: ChartModel): string {
  if (model.xValues.length === 0) return ""
  const first = model.xValues[0]
  const last = model.xValues[model.xValues.length - 1]
  if (first.key === last.key) return first.full
  if (model.xKind === "time") return `${first.full} → ${last.label}`
  return `${first.label} → ${last.label}`
}

function statsWidths(series: SeriesModel[], includeTotal: boolean) {
  const widths = { max: 1, last: 1, min: 1, mean: 1, total: 1 }
  for (const entry of series) {
    widths.max = Math.max(widths.max, statNumber(entry.stats.max).length)
    widths.last = Math.max(widths.last, statNumber(entry.stats.last).length)
    widths.min = Math.max(widths.min, statNumber(entry.stats.min).length)
    widths.mean = Math.max(widths.mean, statNumber(entry.stats.mean).length)
    if (includeTotal) widths.total = Math.max(widths.total, statNumber(entry.stats.total).length)
  }
  return widths
}

function statsLine(
  entry: SeriesModel,
  nameWidth: number,
  widths: ReturnType<typeof statsWidths>,
  includeTotal: boolean,
  maxWidth = Number.POSITIVE_INFINITY,
): StyledLine {
  const name = `${entry.letter} ${entry.label}`
  const width = Math.max(0, Math.min(nameWidth, Number.isFinite(maxWidth) ? maxWidth - 8 : nameWidth))
  const padded = name.length > width ? name.slice(0, width) : name.padEnd(width)
  const parts: Record<"max" | "last" | "min" | "mean" | "total", string> = {
    max: ` max ${statNumber(entry.stats.max).padStart(widths.max)} at ${entry.stats.maxX}`,
    last: `  last ${statNumber(entry.stats.last).padStart(widths.last)}`,
    min: `  min ${statNumber(entry.stats.min).padStart(widths.min)}`,
    mean: `  avg ${statNumber(entry.stats.mean).padStart(widths.mean)}`,
    total: `  total ${statNumber(entry.stats.total).padStart(widths.total)}`,
  }
  const order: Array<"max" | "last" | "min" | "mean" | "total"> = ["max", "last", "min", "mean", "total"]
  const present = new Set(order.filter((key) => key !== "total" || includeTotal))
  const text = () => order.filter((key) => present.has(key)).map((key) => parts[key]).join("")
  // Narrow panels: drop the least important trailing statistics first.
  for (const key of ["total", "mean", "min", "last"] as const) {
    if (padded.length + text().length <= maxWidth) break
    present.delete(key)
  }
  return {
    spans: [
      { text: `${entry.letter} `, fg: entry.color, bold: true },
      { text: padded.slice(2), fg: entry.color },
      { text: text(), dim: true },
    ],
  }
}

function noteLines(notes: string[]): StyledLine[] {
  return notes.map((note) => ({ spans: [{ text: note, dim: true }] }))
}

function emptyLine(): StyledLine {
  return { spans: [{ text: "" }] }
}

function lineText(line: StyledLine): string {
  return line.spans.map((span) => span.text).join("")
}

function textLine(text: string, fg?: string, dim = false): StyledLine {
  return { spans: [{ text, fg, dim }] }
}

function groupMaxOf(group: SeriesModel[] | undefined): number {
  if (!group || group.length === 0) return 0
  return Math.max(0, ...group.map((item) => (Number.isFinite(item.stats.max) ? item.stats.max : 0)))
}

function logDistance(left: number, right: number): number {
  // Zero or negative maxima have no logarithmic distance; keep them together
  // instead of producing Math.log(0) = -Infinity / NaN.
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY
  if (left <= 0 || right <= 0) return left === right ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(Math.log(left / right))
}

function groupSeries(series: SeriesModel[], maxGroups = 3): SeriesModel[][] {
  const groups: SeriesModel[][] = []
  for (const entry of series) {
    let target = groups.find((group) => {
      const groupMax = groupMaxOf(group)
      const withinRange = logDistance(groupMax, entry.stats.max) <= Math.log(10)
      const sameUnit = !group[0].unit || !entry.unit || group[0].unit === entry.unit
      return withinRange && sameUnit
    })
    if (!target && groups.length < maxGroups) {
      target = []
      groups.push(target)
    }
    if (!target) {
      target = groups.reduce((best, group) => {
        const bestDistance = logDistance(groupMaxOf(best), entry.stats.max)
        const groupDistance = logDistance(groupMaxOf(group), entry.stats.max)
        return groupDistance < bestDistance ? group : best
      }, groups[0])
    }
    target.push(entry)
  }
  return groups
}

function xTickIndices(count: number, target = 7): number[] {
  if (count <= target) return Array.from({ length: count }, (_, index) => index)
  const step = Math.max(1, Math.round((count - 1) / (target - 1)))
  const result: number[] = []
  for (let index = 0; index < count; index += step) result.push(index)
  if (result.length > 9) return result.filter((_, index) => index % 2 === 0 || index === result.length - 1)
  return result
}

function placeLabels(positions: Array<{ pos: number; text: string }>, width: number): string {
  const cells = Array.from({ length: Math.max(0, width) }, () => " ")
  const fits = (start: number, text: string): boolean => {
    if (start < 0 || start + text.length > width) return false
    for (let index = 0; index < text.length; index++) {
      if (cells[start + index] !== " ") return false
    }
    return true
  }
  for (const { pos, text } of positions) {
    if (text.length > width) continue
    const start = Math.max(0, Math.min(pos, width - text.length))
    // Skip the whole label instead of writing a mangled prefix over a
    // neighbour (for example "Jan 1" + "Jan 6" becoming "JanJ1").
    if (!fits(start, text)) continue
    for (let index = 0; index < text.length; index++) cells[start + index] = text[index]
  }
  return cells.join("").replace(/\s+$/, "")
}

function renderLine(model: ChartModel): StyledLine[] {
  const lines: StyledLine[] = [headerLine(model)]
  const groups = groupSeries(model.series)
  const widths = statsWidths(model.series, model.combine === "sum")
  const nameWidth = Math.max(...model.series.map((entry) => `${entry.letter} ${entry.label}`.length))
  let firstPlot = true

  groups.forEach((group, groupIndex) => {
    if (!firstPlot) lines.push(emptyLine())
    firstPlot = false
    for (const entry of group) lines.push(statsLine(entry, nameWidth, widths, model.combine === "sum", model.width))

    const linearIntervals = 2
    const groupMax = groupMaxOf(group)
    const axis = makeAxis(groupMax, linearIntervals, model.scale === "log")
    const intervals = axis.log ? Math.max(1, axis.ticks.length - 1) : linearIntervals
    const rowsPerInterval = axis.log
      ? intervals <= 2
        ? 4
        : intervals <= 3
          ? 3
          : 2
      : group.length === 1
        ? 3
        : 4
    // Keeping height-1 an exact multiple of the tick intervals puts every
    // label on its true row and never leaves an extra │ between two ticks.
    const height = intervals * rowsPerInterval + 1
    const rightLabel = group.map((entry) => entry.letter).join("")
    const maxTick = Math.max(...axis.ticks.map((tick) => tickLabel(tick, axis).length))
    const plotWidth = Math.max(18, model.width - maxTick - 3 - rightLabel.length)
    const dotWidth = plotWidth * 2
    const dotHeight = height * 4
    const bits: number[][] = Array.from({ length: height }, () => Array.from({ length: plotWidth }, () => 0))
    const colors: Array<Array<string | undefined>> = Array.from({ length: height }, () =>
      Array.from({ length: plotWidth }, () => undefined as string | undefined),
    )

    for (const entry of group) {
      let previous: { x: number; y: number } | undefined
      entry.values.forEach((value, index) => {
        if (value === null || value === undefined || !Number.isFinite(value)) {
          previous = undefined
          return
        }
        const x = model.xValues.length <= 1 ? 0 : Math.round((index / (model.xValues.length - 1)) * (dotWidth - 1))
        const y = Math.round((1 - scaleValue(value, axis)) * (dotHeight - 1))
        const point = { x, y: Math.max(0, Math.min(dotHeight - 1, y)) }
        setDot(bits, colors, point.x, point.y, entry.color)
        if (previous) {
          const steps = Math.max(1, Math.abs(point.x - previous.x))
          for (let step = 0; step <= steps; step++) {
            const ratio = step / steps
            const px = Math.round(previous.x + (point.x - previous.x) * ratio)
            const py = Math.round(previous.y + (point.y - previous.y) * ratio)
            setDot(bits, colors, px, py, entry.color)
          }
        }
        previous = point
      })
    }

    const labels: Array<string | undefined> = Array.from({ length: height }, () => undefined)
    for (let row = 0; row < height; row += rowsPerInterval) {
      const tickIndex = intervals - row / rowsPerInterval
      const tick = axis.ticks[tickIndex]
      if (tick !== undefined) labels[row] = tickLabel(tick, axis)
    }
    for (let row = 0; row < height; row++) {
      const label = labels[row] ?? ""
      const spans: StyledSpan[] = [
        { text: label.padStart(maxTick), dim: true },
        { text: " ", dim: true },
        { text: label ? "┤" : "│", dim: true },
        { text: " " },
      ]
      let runText = ""
      let runColor: string | undefined
      const flush = () => {
        if (!runText) return
        spans.push({ text: runText, fg: runColor })
        runText = ""
      }
      for (let column = 0; column < plotWidth; column++) {
        const value = bits[row][column]
        const character = value === 0 ? " " : String.fromCodePoint(0x2800 + value)
        const color = value === 0 ? undefined : colors[row][column]
        if (color !== runColor) {
          flush()
          runColor = color
        }
        runText += character
      }
      flush()
      if (row === 0 && rightLabel) {
        for (const entry of group) spans.push({ text: entry.letter, fg: entry.color, bold: true })
      }
      lines.push({ spans })
    }

    if (groupIndex === groups.length - 1) {
      const tickIndices = xTickIndices(model.xValues.length)
      const positions = tickIndices.map((index) => ({
        pos:
          model.xValues.length <= 1
            ? 0
            : Math.round((index / (model.xValues.length - 1)) * (plotWidth - 1)) -
              Math.floor(model.xValues[index].label.length / 2),
        text: model.xValues[index].label,
      }))
      const pad = " ".repeat(Math.max(0, maxTick + 3))
      lines.push(textLine(`${" ".repeat(maxTick)} └─${"─".repeat(plotWidth)}`, undefined, true))
      lines.push(textLine(`${pad}${placeLabels(positions, plotWidth)}`, undefined, true))
      const markLine = renderMarks(model, maxTick + 3, plotWidth)
      if (markLine) lines.push(markLine)
    }
  })

  lines.push(...noteLines(model.notes))
  return lines
}

function setDot(bits: number[][], colors: Array<Array<string | undefined>>, x: number, y: number, color: string) {
  if (y < 0 || y >= bits.length * 4 || x < 0 || x >= bits[0].length * 2) return
  const cellX = Math.floor(x / 2)
  const cellY = Math.floor(y / 4)
  const localX = x % 2
  const localY = y % 4
  const bit = BRAILLE_BITS[localX][localY]
  bits[cellY][cellX] |= bit
  colors[cellY][cellX] = colors[cellY][cellX] ?? color
}

const BRAILLE_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

function markIndex(model: ChartModel, mark: ChartMark): number | undefined {
  const raw = String(mark.x)
  const direct = model.xValues.findIndex(
    (value) => value.key === raw || value.label === raw || value.full === raw,
  )
  if (direct >= 0) return direct
  const numeric = toNumber(mark.x)
  if (numeric !== undefined) {
    const index = model.xValues.findIndex((value) => toNumber(value.key) === numeric || toNumber(value.label) === numeric)
    if (index >= 0) return index
  }
  // Time axes normalize every x to a full ISO timestamp (noon UTC), while a
  // mark is usually written as a date only ("2026-11-15") or a Unix timestamp.
  // Match them by calendar day so the marker is not silently dropped.
  const markDate = parseDateValue(mark.x)
  if (markDate) {
    const day = markDate.toISOString().slice(0, 10)
    const index = model.xValues.findIndex((value) => value.key.slice(0, 10) === day)
    if (index >= 0) return index
  }
  return undefined
}

function renderMarks(
  model: ChartModel,
  indent: number,
  plotWidth: number,
  positionFor: (index: number) => number | undefined = (index) =>
    model.xValues.length <= 1 ? 0 : Math.round((index / (model.xValues.length - 1)) * (plotWidth - 1)),
): StyledLine | undefined {
  const marks = model.marks
    .map((mark) => ({ mark, index: markIndex(model, mark) }))
    .filter((entry): entry is { mark: ChartMark; index: number } => entry.index !== undefined)
    .map((entry) => ({ ...entry, pos: positionFor(entry.index) }))
    .filter((entry): entry is { mark: ChartMark; index: number; pos: number } => entry.pos !== undefined)
  if (marks.length === 0) return undefined
  const cells = Array.from({ length: plotWidth }, () => " ")
  const colors: Array<string | undefined> = Array.from({ length: plotWidth }, () => undefined)
  const order = [...marks].sort((left, right) => left.pos - right.pos)
  for (const { pos, mark } of order) {
    const start = Math.max(0, Math.min(pos, plotWidth - 1))
    const color = mark.color ?? "#e5a93c"
    cells[start] = "▲"
    colors[start] = color
    if (mark.label) {
      const label = ` ${mark.label}`
      for (let offset = 0; offset < label.length && start + offset < plotWidth; offset++) {
        if (cells[start + offset] === " ") {
          cells[start + offset] = label[offset]
          colors[start + offset] = color
        }
      }
    }
  }
  // Trim trailing blanks, then emit colour runs straight from the final cell
  // grid. This keeps every marker at its true column even when labels collide.
  let end = cells.length
  while (end > 0 && cells[end - 1] === " ") end--
  if (end === 0) return undefined
  const spans: StyledSpan[] = [{ text: " ".repeat(indent), dim: true }]
  let run = ""
  let runColor: string | undefined
  let runBold = false
  const flush = () => {
    if (!run) return
    spans.push({ text: run, fg: runColor, bold: runBold || undefined })
    run = ""
  }
  for (let column = 0; column < end; column++) {
    const color = cells[column] === " " ? undefined : colors[column]
    const bold = cells[column] === "▲"
    if (color !== runColor || bold !== runBold) {
      flush()
      runColor = color
      runBold = bold
    }
    run += cells[column]
  }
  flush()
  return { spans }
}

function halfCell(top: string | undefined, bottom: string | undefined): { char: string; fg?: string; bg?: string } {
  if (top && bottom) {
    if (top === bottom) return { char: "█", fg: top }
    return { char: "▀", fg: top, bg: bottom }
  }
  if (top) return { char: "▀", fg: top }
  if (bottom) return { char: "▄", fg: bottom }
  return { char: " " }
}

/**
 * Split `total` half-rows between floor values using the largest-remainder
 * (Hamilton) method. Every non-zero series receives at least one half-row
 * whenever the column has enough half-rows to give it one.
 */
function apportionHalves(values: number[], total: number): number[] {
  const allocation = values.map(() => 0)
  const nonZero = values
    .map((value, index) => ({ index, value }))
    .filter((entry) => entry.value > 0 && Number.isFinite(entry.value))
  if (total <= 0 || nonZero.length === 0) return allocation
  if (total <= nonZero.length) {
    for (const { index } of [...nonZero].sort((left, right) => right.value - left.value).slice(0, total)) {
      allocation[index] = 1
    }
    return allocation
  }

  const sum = nonZero.reduce((accumulator, entry) => accumulator + entry.value, 0)
  const shares = nonZero.map((entry) => {
    const exact = (entry.value / sum) * total
    return { index: entry.index, value: entry.value, exact, count: Math.floor(exact) }
  })
  let assigned = shares.reduce((accumulator, share) => accumulator + share.count, 0)
  for (const share of shares) {
    if (share.count === 0) {
      share.count = 1
      assigned++
    }
  }
  while (assigned > total) {
    const candidate = [...shares].filter((share) => share.count > 1).sort((left, right) => right.count - left.count)[0]
    if (!candidate) break
    candidate.count--
    assigned--
  }
  const order = [...shares].sort((left, right) => {
    const leftRemainder = left.exact - Math.floor(left.exact)
    const rightRemainder = right.exact - Math.floor(right.exact)
    if (rightRemainder !== leftRemainder) return rightRemainder - leftRemainder
    return right.value - left.value
  })
  let cursor = 0
  while (assigned < total && order.length > 0) {
    order[cursor % order.length].count++
    assigned++
    cursor++
  }
  for (const share of shares) allocation[share.index] = share.count
  return allocation
}

function columnHalfRows(value: number, axis: Axis, halfRows: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0
  const ratio = axis.log ? scaleValue(value, axis) : value / axis.max
  // A non-zero value must never disappear; a zero stays empty.
  return Math.max(1, Math.min(halfRows, Math.round(ratio * halfRows)))
}

interface ColumnLayout {
  indices: number[]
  bodyWidth: number
  gap: number
  usedWidth: number
}

function columnLayout(columns: number, plotWidth: number): ColumnLayout {
  let indices = Array.from({ length: columns }, (_, index) => index)
  if (columns > plotWidth) {
    const count = Math.max(1, plotWidth)
    indices = []
    for (let index = 0; index < count; index++) {
      const source = Math.round((index / Math.max(1, count - 1)) * (columns - 1))
      if (indices[indices.length - 1] !== source) indices.push(source)
    }
  }
  const shown = indices.length
  let gap = 1
  let bodyWidth = 1
  if (shown * 2 <= plotWidth) {
    const cellWidth = Math.max(2, Math.floor(plotWidth / shown))
    bodyWidth = Math.max(1, cellWidth - 1)
  } else {
    gap = 0
  }
  let usedWidth = bodyWidth * shown + gap * Math.max(0, shown - 1)
  if (usedWidth > plotWidth && shown > 0) {
    bodyWidth = Math.max(1, Math.floor((plotWidth - gap * Math.max(0, shown - 1)) / shown))
    usedWidth = bodyWidth * shown + gap * Math.max(0, shown - 1)
  }
  return { indices, bodyWidth, gap, usedWidth: Math.min(usedWidth, plotWidth) }
}

function renderColumns(model: ChartModel): StyledLine[] {
  const stacked = model.combine === "sum"
  const lines: StyledLine[] = []
  const totals = model.xValues.map((_, index) => model.series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0))
  const totalMaxIndex = totals.indexOf(Math.max(...totals, 0))
  const suffix = stacked
    ? `total max ${formatNumber(Math.max(...totals, 0))} at ${model.xValues[totalMaxIndex]?.label ?? "-"}`
    : undefined
  lines.push(headerLine(model, suffix))

  const widths = statsWidths(model.series, stacked)
  const nameWidth = Math.max(...model.series.map((entry) => `${entry.letter} ${entry.label}`.length))
  for (const entry of model.series) lines.push(statsLine(entry, nameWidth, widths, stacked, model.width))

  const maxValue = stacked ? Math.max(...totals, 0) : Math.max(...model.series.map((entry) => entry.stats.max), 0)
  const axis = makeAxis(maxValue, 4, model.scale === "log")
  const intervals = axis.log ? Math.max(1, axis.ticks.length - 1) : 4
  const rowsPerInterval = axis.log ? (intervals <= 2 ? 4 : intervals <= 3 ? 3 : 2) : 2
  const plotRows = intervals * rowsPerInterval
  const halfRows = plotRows * 2
  const maxTick = Math.max(...axis.ticks.map((tick) => tickLabel(tick, axis).length))
  const plotWidth = Math.max(18, model.width - maxTick - 3)
  const layout = columnLayout(model.xValues.length, plotWidth)
  const { indices, bodyWidth, gap, usedWidth } = layout

  const seriesCount = Math.max(1, model.series.length)
  const subWidths = Array.from({ length: seriesCount }, () => Math.max(0, Math.floor(bodyWidth / seriesCount)))
  for (let index = 0; index < bodyWidth - subWidths.reduce((sum, value) => sum + value, 0); index++) {
    subWidths[index % seriesCount]++
  }

  const tickLabelAt = (row: number): string | undefined => {
    if (row % rowsPerInterval !== 0) return undefined
    const tickIndex = intervals - row / rowsPerInterval
    const tick = axis.ticks[tickIndex]
    return tick === undefined ? undefined : tickLabel(tick, axis)
  }

  let thin = false
  for (let row = 0; row < plotRows; row++) {
    const label = tickLabelAt(row)
    const spans: StyledSpan[] = [
      { text: (label ?? "").padStart(maxTick), dim: true },
      { text: " ", dim: true },
      { text: label ? "┤" : "│", dim: true },
      { text: " " },
    ]
    const fromBottom = plotRows - 1 - row
    for (let position = 0; position < indices.length; position++) {
      const column = indices[position]
      if (stacked) {
        const values = model.series.map((entry) => entry.values[column] ?? 0)
        const total = values.reduce((sum, value) => sum + value, 0)
        const totalHalfRows = columnHalfRows(total, axis, halfRows)
        const allocation = apportionHalves(values, totalHalfRows)
        if (model.series.length > 1) {
          values.forEach((value, index) => {
            if (value > 0 && allocation[index] === 0) thin = true
          })
        }
        const segments: Array<string | undefined> = Array.from({ length: halfRows }, () => undefined)
        let cursor = 0
        allocation.forEach((count, index) => {
          const color = model.series[index].color
          for (let half = 0; half < count && cursor < halfRows; half++) segments[cursor++] = color
        })
        const bottomColor = segments[fromBottom * 2]
        const topColor = segments[fromBottom * 2 + 1]
        const cell = halfCell(topColor, bottomColor)
        spans.push({ text: cell.char.repeat(bodyWidth), fg: cell.fg, bg: cell.bg })
      } else {
        model.series.forEach((entry, seriesIndex) => {
          const width = subWidths[seriesIndex] ?? 0
          if (width <= 0) return
          const value = entry.values[column] ?? 0
          const half = columnHalfRows(value, axis, halfRows)
          const bottomSet = half > fromBottom * 2
          const topSet = half > fromBottom * 2 + 1
          const cell = halfCell(topSet ? entry.color : undefined, bottomSet ? entry.color : undefined)
          spans.push({ text: cell.char.repeat(width), fg: cell.fg, bg: cell.bg })
        })
        const drawn = subWidths.reduce((sum, value) => sum + value, 0)
        if (drawn < bodyWidth) spans.push({ text: " ".repeat(bodyWidth - drawn) })
      }
      if (position < indices.length - 1 && gap > 0) spans.push({ text: " ".repeat(gap) })
    }
    lines.push({ spans })
  }

  // Tick 0 sits on the baseline itself; bar rows end exactly at row 7 above it.
  const baselineLabel = axis.log ? tickLabel(axis.ticks[0] ?? 0, axis) : tickLabel(0, axis)
  const baselineCells = Array.from({ length: usedWidth }, () => "─")
  if (indices.length <= 16) {
    for (let position = 0; position < indices.length; position++) {
      const center = position * (bodyWidth + gap) + Math.floor(bodyWidth / 2)
      if (center >= 0 && center < baselineCells.length) baselineCells[center] = "┬"
    }
  }
  lines.push({
    spans: [
      { text: baselineLabel.padStart(maxTick), dim: true },
      { text: " ┼ ", dim: true },
      { text: baselineCells.join(""), dim: true },
    ],
  })

  const tickIndices = xTickIndices(indices.length)
  const positions = tickIndices.map((shownIndex) => {
    const index = indices[shownIndex]
    return {
      pos: shownIndex * (bodyWidth + gap) + Math.floor(bodyWidth / 2) - Math.floor(model.xValues[index].label.length / 2),
      text: model.xValues[index].label,
    }
  })
  lines.push(textLine(`${" ".repeat(maxTick + 3)}${placeLabels(positions, usedWidth)}`, undefined, true))

  const shownPosition = new Map<number, number>()
  indices.forEach((source, position) => shownPosition.set(source, position))
  const markLine = renderMarks(model, maxTick + 3, usedWidth, (index) => {
    const position = shownPosition.get(index)
    if (position === undefined) return undefined
    return position * (bodyWidth + gap) + Math.floor(bodyWidth / 2)
  })
  if (markLine) lines.push(markLine)

  if (stacked && thin) lines.push(textLine(THIN_COLUMN_NOTE, undefined, true))
  lines.push(...noteLines(model.notes))
  return lines
}

const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"]

function barText(ratio: number, width: number): string {
  const exact = Math.max(0, Math.min(1, ratio)) * width
  const full = Math.floor(exact)
  const fraction = Math.round((exact - full) * 8)
  const blocks = "█".repeat(full) + PARTIAL_BLOCKS[Math.min(8, fraction)]
  return blocks
}

function renderBars(model: ChartModel): StyledLine[] {
  const parts = model.parts.slice(0, 40)
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const lines: StyledLine[] = [headerLine(model, `total ${formatNumber(total)}`)]
  const maxValue = Math.max(...parts.map((part) => part.value), 0)
  const labelWidth = Math.max(4, Math.min(24, Math.max(...parts.map((part) => part.label.length))))
  const valueWidth = Math.max(...parts.map((part) => formatNumber(part.value).length), 1)
  const barWidth = Math.max(8, Math.min(54, model.width - labelWidth - valueWidth - 12))
  for (const part of parts) {
    const ratio = maxValue > 0 ? part.value / maxValue : 0
    const bar = barText(ratio, barWidth)
    const percent = total > 0 ? `${((part.value / total) * 100).toFixed(1)}%` : "0.0%"
    lines.push({
      spans: [
        { text: `${part.letter} `, fg: part.color, bold: true },
        { text: part.label.padEnd(labelWidth), fg: part.color },
        { text: " " },
        { text: bar, fg: part.color },
        { text: " ".repeat(Math.max(0, barWidth - [...bar].length)) },
        { text: ` ${formatNumber(part.value).padStart(valueWidth)}`, bold: true },
        { text: `  ${percent}`, dim: true },
      ],
    })
  }
  if (model.parts.length > 40) lines.push(textLine(`… and ${model.parts.length - 40} more categories`, undefined, true))
  lines.push(...noteLines(model.notes))
  return lines
}

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export function sparkline(values: number[], width?: number): string {
  const present = values.filter((value) => Number.isFinite(value))
  if (present.length === 0) return ""
  const min = Math.min(...present)
  const max = Math.max(...present)
  const limit = width ?? 28
  let sampled = values
  if (values.length > limit) {
    sampled = Array.from({ length: limit }, (_, index) => {
      const position = (index / Math.max(1, limit - 1)) * (values.length - 1)
      return values[Math.round(position)]
    })
  }
  return sampled
    .map((value) => {
      if (max === min) return SPARK_BLOCKS[3]
      const ratio = (value - min) / (max - min)
      return SPARK_BLOCKS[Math.max(0, Math.min(7, Math.round(ratio * 7)))]
    })
    .join("")
}

function renderSparks(model: ChartModel): StyledLine[] {
  const lines: StyledLine[] = [headerLine(model)]
  const present = model.series.filter((entry) => entry.stats.count > 0)
  const nameWidth = Math.max(...present.map((entry) => `${entry.letter} ${entry.label}`.length))
  const statsWidth = Math.max(...present.map((entry) => `max ${statNumber(entry.stats.max)}  avg ${statNumber(entry.stats.mean)}`.length))
  const sparkWidth = Math.max(8, Math.min(50, model.width - nameWidth - statsWidth - 4))
  for (const entry of present.slice(0, 40)) {
    const values = entry.values.map((value) => value ?? 0)
    lines.push({
      spans: [
        { text: `${entry.letter} `, fg: entry.color, bold: true },
        { text: entry.label.padEnd(nameWidth - 2), fg: entry.color },
        { text: "  " },
        { text: sparkline(values, sparkWidth), fg: entry.color },
        { text: `  max ${statNumber(entry.stats.max)}`, dim: true },
        { text: `  avg ${statNumber(entry.stats.mean)}`, dim: true },
      ],
    })
  }
  if (present.length > 40) lines.push(textLine(`… and ${present.length - 40} more series`, undefined, true))
  lines.push(...noteLines(model.notes))
  return lines
}

function shareSegments(parts: ChartPart[]): ChartPart[] {
  if (parts.length <= 8) return parts
  const head = parts.slice(0, 8)
  const rest = parts.slice(8).reduce((sum, part) => sum + part.value, 0)
  if (rest > 0) {
    head.push({ key: "__rest__", label: "rest", letter: " ", color: REST_COLOR, value: rest })
  }
  return head
}

function renderShare(model: ChartModel): StyledLine[] {
  const parts = shareSegments(model.parts)
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const lines: StyledLine[] = [headerLine(model, `total ${formatNumber(total)}`)]
  const width = Math.max(20, Math.min(70, model.width - 4))
  // Rounding every share independently can total width - 1 / width + 1, so
  // apportion the cells with the largest-remainder (Hamilton) method. That
  // guarantees exactly `width` cells and gives every non-zero part at least
  // one █ whenever the bar is wide enough.
  const allocation = total > 0 ? apportionHalves(parts.map((part) => part.value), width) : parts.map(() => 0)
  const spans: StyledSpan[] = []
  parts.forEach((part, index) => {
    const cells = allocation[index] ?? 0
    if (cells > 0) spans.push({ text: "█".repeat(cells), fg: part.color })
  })
  const drawn = spans.reduce((sum, span) => sum + span.text.length, 0)
  if (drawn < width) spans.push({ text: " ".repeat(width - drawn) })
  lines.push({ spans: [{ text: " " }, ...spans] })

  const labelWidth = Math.max(...parts.map((part) => part.label.length))
  const valueWidth = Math.max(...parts.map((part) => formatNumber(part.value).length))
  for (const part of parts) {
    const percent = total > 0 ? (part.value / total) * 100 : 0
    lines.push({
      spans: [
        { text: part.letter === " " ? "  " : `${part.letter} `, fg: part.color, bold: true },
        { text: part.label.padEnd(labelWidth), fg: part.color },
        { text: `  ${formatNumber(part.value).padStart(valueWidth)}`, bold: true },
        { text: `  ${percent.toFixed(1)}%`, dim: true },
      ],
    })
  }
  lines.push(...noteLines(model.notes))
  return lines
}

function renderPie(model: ChartModel): StyledLine[] {
  const parts = shareSegments(model.parts)
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const lines: StyledLine[] = [headerLine(model, `total ${formatNumber(total)}`)]

  // A circle drawn with half-block cells: each terminal cell is two vertical
  // half-rows. `aspect` widens the plot because terminal cells are taller than
  // they are wide, so the resulting disc looks round in a monospace font.
  const textRows = 9
  const radius = 8.4
  const cy = 8.5
  const aspect = 1.15
  const discCols = 21
  const cx = (discCols - 1) / 2

  // Precompute cumulative [start, end) fractions in clockwise order, starting
  // at 12 o'clock. Tiny non-zero slices are boosted to a minimum visual share
  // so a 1–5% wedge still paints a few half-cells on the small disc, while the
  // legend keeps the exact mathematical percentage. The last non-zero slice is
  // forced to exactly 1.0 so floating-point drift never leaves a gap.
  const slices: Array<{ startFrac: number; endFrac: number; color: string }> = []
  const nonZero = parts.filter((part) => part.value > 0)
  const minShare = Math.min(0.025, 0.5 / Math.max(1, nonZero.length))
  const rawShares = nonZero.map((part) => (total > 0 ? part.value / total : 0))
  const boosted = rawShares.map((share) => Math.max(share, minShare))
  const boostedSum = boosted.reduce((sum, share) => sum + share, 0) || 1
  const visualShares = boosted.map((share) => share / boostedSum)
  let cursor = 0
  nonZero.forEach((part, index) => {
    const startFrac = cursor
    cursor += visualShares[index] ?? 0
    const endFrac = index === nonZero.length - 1 ? 1 : cursor
    slices.push({ startFrac, endFrac, color: part.color })
  })

  const colorAt = (col: number, halfRow: number): string | undefined => {
    const nx = (col - cx) / (radius * aspect)
    const ny = (halfRow - cy) / radius
    if (Math.hypot(nx, ny) > 1.0) return undefined
    if (total <= 0) return REST_COLOR
    const angle = (Math.atan2(nx, -ny) + 2 * Math.PI) % (2 * Math.PI)
    const frac = angle / (2 * Math.PI)
    const slice = slices.find((range) => frac >= range.startFrac && frac < range.endFrac) ?? slices[slices.length - 1]
    return slice?.color
  }

  const discRows: StyledLine[] = []
  for (let row = 0; row < textRows; row += 1) {
    const spans: StyledSpan[] = []
    let runText = ""
    let runFg: string | undefined
    let runBg: string | undefined
    const flush = () => {
      if (!runText) return
      spans.push({ text: runText, fg: runFg, bg: runBg })
      runText = ""
    }
    for (let col = 0; col < discCols; col += 1) {
      const topColor = colorAt(col, row * 2)
      const bottomColor = colorAt(col, row * 2 + 1)
      const cell = halfCell(topColor, bottomColor)
      if (cell.fg !== runFg || cell.bg !== runBg) {
        flush()
        runFg = cell.fg
        runBg = cell.bg
      }
      runText += cell.char
    }
    flush()
    discRows.push({ spans })
  }

  const labelWidth = Math.max(4, Math.min(24, Math.max(...parts.map((part) => part.label.length), 4)))
  const valueWidth = Math.max(...parts.map((part) => formatNumber(part.value).length), 1)
  const legendRows: StyledSpan[][] = parts.map((part) => {
    const percent = total > 0 ? ((part.value / total) * 100).toFixed(1) : "0.0"
    return [
      { text: part.letter === " " ? "  " : `${part.letter} `, fg: part.color, bold: true },
      { text: "● ", fg: part.color },
      { text: part.label.slice(0, labelWidth).padEnd(labelWidth), fg: part.color },
      { text: `  ${formatNumber(part.value).padStart(valueWidth)}`, bold: true },
      { text: `  ${percent.padStart(5)}%`, dim: true },
    ]
  })

  const totalRows = Math.max(textRows, parts.length)
  const discOffset = Math.floor((totalRows - textRows) / 2)
  const legendOffset = Math.floor((totalRows - parts.length) / 2)
  for (let row = 0; row < totalRows; row += 1) {
    const spans: StyledSpan[] = [{ text: " " }]
    const disc = discRows[row - discOffset]
    if (disc) spans.push(...disc.spans)
    else spans.push({ text: " ".repeat(discCols) })
    const legend = legendRows[row - legendOffset]
    if (legend) spans.push({ text: "    " }, ...legend)
    lines.push({ spans })
  }

  lines.push(...noteLines(model.notes))
  return lines
}

export function renderChartModel(model: ChartModel): RenderedChart {
  let form = model.form
  if ((form === "line" || form === "columns") && model.xKind === "category") {
    model.notes.push(`x is categorical; showing bars instead of ${form}`)
    form = "bars"
  }
  let lines: StyledLine[]
  switch (form) {
    case "columns":
      lines = renderColumns(model)
      break
    case "bars":
      lines = renderBars(model)
      break
    case "sparks":
      lines = renderSparks(model)
      break
    case "share":
      lines = renderShare(model)
      break
    case "pie":
      lines = renderPie(model)
      break
    default:
      lines = renderLine(model)
      form = "line"
      break
  }
  const plain = lines.map(lineText).join("\n")
  return { form, title: model.title, lines, plain, notes: model.notes }
}

export function renderChart(table: ParsedTable, request: ChartRequest = {}): RenderedChart {
  const model = buildModel(table, request)
  return renderChartModel(model)
}

export function makePayload(table: ParsedTable, rawRequest: ChartRequest = {}): EaselPayload {
  const normalized = normalizeChartRequest(rawRequest)
  const model = buildModel(table, normalized)
  // The table is self-contained, so the raw source (CSV text or an array of
  // rows) does not need to be duplicated inside the fenced block.
  const { data: _data, path: _path, ...request } = normalized
  return {
    v: 1,
    request,
    table,
    meta: {
      title: model.title,
      unit: model.unit,
      form: model.form,
      combine: model.combine,
      scale: model.scale,
      x: model.mapping?.x,
      y: model.mapping?.y,
      series: model.mapping?.series,
    },
  }
}

export function encodePayload(payload: EaselPayload): string {
  return JSON.stringify(payload)
}

export function decodePayload(text: string): EaselPayload | undefined {
  try {
    const parsed = JSON.parse(text.trim()) as EaselPayload
    if (!parsed || parsed.v !== 1 || !parsed.table || !Array.isArray(parsed.table.rows)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function renderPayload(payload: EaselPayload, options: RenderOptions = {}): RenderedChart {
  const meta = payload.meta ?? {}
  const request: ChartRequest = {
    ...payload.request,
    title: payload.request.title ?? meta.title,
    unit: payload.request.unit ?? meta.unit,
    form: options.form ?? payload.request.form ?? meta.form,
    combine: payload.request.combine ?? meta.combine,
    scale: options.scale ?? payload.request.scale ?? meta.scale,
    x: payload.request.x ?? meta.x,
    y: payload.request.y ?? meta.y,
    series: payload.request.series ?? meta.series,
    width: options.width ?? payload.request.width,
  }
  const chart = renderChart(payload.table, request)
  return { ...chart, payload }
}

export function renderAnsi(chart: RenderedChart): string {
  return chart.lines.map(styledLineAnsi).join("\n")
}

export function styledLineAnsi(line: StyledLine): string {
  return line.spans
    .map((span) => {
      const codes: string[] = []
      if (span.fg) codes.push(`38;2;${hexToRgb(span.fg)}`)
      if (span.bg) codes.push(`48;2;${hexToRgb(span.bg)}`)
      if (span.bold) codes.push("1")
      if (span.dim) codes.push("2")
      if (codes.length === 0) return span.text
      return `\x1b[${codes.join(";")}m${span.text}\x1b[0m`
    })
    .join("")
}

function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "")
  const full = clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean
  const value = Number.parseInt(full, 16)
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
}

export function plainLine(line: StyledLine): string {
  return lineText(line)
}

export function allSeriesLetters(series: SeriesModel[]): string {
  return series.map((entry) => entry.letter).join("")
}
