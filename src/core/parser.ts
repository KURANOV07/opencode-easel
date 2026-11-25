import { readFileSync } from "node:fs"
import type { AutoChartMeta, Cell, ParsedTable, Row } from "./types.ts"

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/**
 * Tool results and `read` output often prefix every line with "<line>: ".
 * Strip that only when the prefix dominates the output.
 */
export function stripToolPrefixes(text: string): string {
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter((line) => line.trim().length > 0)
  if (nonEmpty.length === 0) return text
  const prefixed = nonEmpty.filter((line) => /^\s*\d+:\s?/.test(line)).length
  let result = text
  if (prefixed / nonEmpty.length >= 0.6) {
    result = lines.map((line) => line.replace(/^\s*\d+:\s?/, "")).join("\n")
  }

  // The read tool prefixes its output with a human-readable header such as
  // "Read file /path/file.csv, lines 1-43". It is not data.
  const output = result.split(/\r?\n/)
  let start = 0
  while (start < Math.min(output.length, 4)) {
    const line = output[start].trim()
    if (!line) {
      start++
      continue
    }
    if (
      /^Read file\b/i.test(line) ||
      /^Showing lines?\b/i.test(line) ||
      /^\(End of file\b/i.test(line) ||
      /^<file(?:\s[^>]*)?>$/i.test(line) ||
      /^<\/file>$/i.test(line)
    ) {
      start++
      continue
    }
    break
  }
  return output.slice(start).join("\n")
}

export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/)
  return match ? match[1] : text
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
}

function cleanCell(value: string): string {
  return value.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim()
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === delimiter && !quoted) {
      out.push(current)
      current = ""
      continue
    }
    current += char
  }
  out.push(current)
  return out
}

function countOutsideQuotes(line: string, needle: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') i++
      else quoted = !quoted
    } else if (line[i] === needle && !quoted) count++
  }
  return count
}

function uniqColumns(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((raw, index) => {
    let name = cleanCell(raw).replace(/\s+/g, " ") || `column${index + 1}`
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count > 0) name = `${name}_${count + 1}`
    return name
  })
}

function rowsFromMatrix(matrix: string[][], format: string): ParsedTable | undefined {
  if (matrix.length === 0) return undefined
  const width = Math.max(...matrix.map((row) => row.length))
  if (width < 2) return undefined
  const columns = uniqColumns(matrix[0])
  const rows: Row[] = []
  for (const cells of matrix.slice(1)) {
    if (cells.every((cell) => cell.trim() === "")) continue
    const row: Row = {}
    columns.forEach((column, index) => {
      row[column] = coerceValue(cells[index] ?? "")
    })
    rows.push(row)
  }
  if (rows.length === 0) return undefined
  return { columns, rows, format }
}

export function parseDelimited(text: string): ParsedTable | undefined {
  const lines = splitLines(text).filter((line) => line.trim() !== "")
  if (lines.length < 2) return undefined
  const sample = lines.slice(0, 20)
  const candidates = [",", "\t", ";", "|"] as const
  let delimiter = ","
  let best = 0
  for (const candidate of candidates) {
    const score = sample.reduce((sum, line) => sum + countOutsideQuotes(line, candidate), 0)
    if (score > best) {
      best = score
      delimiter = candidate
    }
  }
  if (best === 0) return undefined
  const matrix = lines
    .filter((line) => !/^\s*[+|:\-\s]+$/.test(line))
    .map((line) => parseDelimitedLine(line, delimiter))
    .filter((cells) => cells.length > 1)
  if (matrix.length < 2) return undefined
  const format = delimiter === "\t" ? "tsv" : delimiter === "|" ? "table" : delimiter === ";" ? "ssv" : "csv"
  return rowsFromMatrix(matrix, format)
}

export function parsePipeTable(text: string): ParsedTable | undefined {
  const lines = splitLines(text)
  const pipeLines = lines.filter((line) => line.includes("|") || line.includes("│"))
  if (pipeLines.length < 2) return undefined
  const matrix: string[][] = []
  for (const line of pipeLines) {
    const trimmed = line.trim()
    if (/^[+|├┼└┴┬─═╪╫╬:\-\s]+$/.test(trimmed)) continue
    if (trimmed.startsWith("(") && /row[s]?\)/i.test(trimmed)) continue
    let normalized = trimmed
    if (normalized.includes("│")) normalized = normalized.replaceAll("│", "|")
    normalized = normalized.replace(/^\|/, "").replace(/\|$/, "")
    const cells = normalized.split("|").map(cleanCell)
    if (cells.length >= 2) matrix.push(cells)
  }
  if (matrix.length < 2) return undefined
  return rowsFromMatrix(matrix, "table")
}

export function parseAligned(text: string): ParsedTable | undefined {
  const lines = splitLines(text).filter((line) => line.trim() !== "")
  if (lines.length < 2) return undefined

  let headerIndex = -1
  let columns: string[] = []
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const parts = splitAlignedLine(lines[i])
    if (parts.length >= 2) {
      headerIndex = i
      columns = parts
      break
    }
  }
  if (headerIndex < 0) return undefined

  const rows: Row[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (/^[\s\-=+_]+$/.test(line)) continue
    const cells = splitAlignedLine(line)
    if (cells.length === 0) continue
    const row: Row = {}
    columns.forEach((column, index) => {
      row[column] = coerceValue(cells[index] ?? "")
    })
    if (Object.values(row).some((value) => value !== "" && value !== null && value !== undefined)) rows.push(row)
  }
  const numericColumns = columns.filter((column) => rows.filter((row) => typeof row[column] === "number").length > rows.length / 2)
  if (rows.length === 0 || numericColumns.length === 0) return undefined
  return { columns, rows, format: "aligned" }
}

function splitAlignedLine(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  if (trimmed.includes("\t")) return trimmed.split(/\t+/).map(cleanCell)
  const byGap = trimmed.split(/\s{2,}/).map(cleanCell)
  if (byGap.length >= 2) return byGap
  return trimmed.split(/\s+/).map(cleanCell)
}

export function parseXml(text: string): ParsedTable | undefined {
  const clean = text.replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!--[\s\S]*?-->/g, "")
  const tagCounts = new Map<string, number>()
  // Count opening tags without consuming nested elements, so <record> inside
  // <records> is still discovered.
  for (const match of clean.matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*?)?(?<!\/)>/g)) {
    tagCounts.set(match[1], (tagCounts.get(match[1]) ?? 0) + 1)
  }
  const preferred = ["record", "row", "item", "entry", "point", "sample", "metric", "result"]
  const repeated = [...tagCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => {
      const lp = preferred.indexOf(left[0].toLowerCase())
      const rp = preferred.indexOf(right[0].toLowerCase())
      if (lp !== rp) return (lp < 0 ? 99 : lp) - (rp < 0 ? 99 : rp)
      return right[1] - left[1]
    })
  const recordTag = repeated[0]?.[0]
  if (!recordTag) return undefined

  const recordPattern = new RegExp(`<${recordTag}(\\s[^>]*)?>([\\s\\S]*?)</${recordTag}>`, "gi")
  const records: Row[] = []
  const columns: string[] = []
  for (const match of clean.matchAll(recordPattern)) {
    const row: Row = {}
    for (const attr of (match[1] ?? "").matchAll(/([\w:.-]+)\s*=\s*["']([^"']*)["']/g)) {
      if (!columns.includes(attr[1])) columns.push(attr[1])
      row[attr[1]] = coerceValue(attr[2])
    }
    for (const child of match[2].matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const name = child[1]
      if (/<[A-Za-z_]/.test(child[2])) continue
      if (!columns.includes(name)) columns.push(name)
      row[name] = coerceValue(child[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    }
    if (Object.keys(row).length > 0) records.push(row)
  }
  if (records.length === 0) return undefined
  return { columns, rows: records, format: "xml" }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value
    if (value > 1e9) return value * 1000
  }
  if (typeof value === "string" && /^\d{10,13}$/.test(value)) return asTimestamp(Number(value))
  return undefined
}

function isoFromTimestamp(value: unknown): string | undefined {
  const millis = asTimestamp(value)
  if (millis === undefined) return undefined
  return new Date(millis).toISOString()
}

function metricLabel(metric: unknown): string | undefined {
  if (typeof metric === "string") return metric
  if (!metric || typeof metric !== "object") return undefined
  const labels = metric as Record<string, unknown>
  const name = typeof labels.__name__ === "string" ? labels.__name__ : undefined
  const rest = Object.entries(labels)
    .filter(([key, value]) => key !== "__name__" && value !== "" && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
  if (name && rest.length) return `${name}{${rest.join(",")}}`
  return name ?? (rest.length ? `{${rest.join(",")}}` : undefined)
}

function pointPair(point: unknown): { timestamp: unknown; value: unknown } | undefined {
  if (Array.isArray(point) && point.length >= 2) {
    const [first, second] = point
    const firstTs = asTimestamp(first)
    const secondTs = asTimestamp(second)
    if (firstTs !== undefined && secondTs === undefined) return { timestamp: first, value: second }
    if (secondTs !== undefined && firstTs === undefined) return { timestamp: second, value: first }
    return { timestamp: first, value: second }
  }
  if (point && typeof point === "object") {
    const record = point as Record<string, unknown>
    const timestamp = record.timestamp ?? record.time ?? record.ts ?? record.x ?? record.date
    const value = record.value ?? record.y ?? record.count ?? record.v
    if (timestamp !== undefined && value !== undefined) return { timestamp, value }
  }
  return undefined
}

function expandSeriesRecord(record: Record<string, unknown>, rows: Row[]): boolean {
  const label = metricLabel(record.metric) ?? metricLabel(record.labels) ?? (typeof record.name === "string" ? record.name : undefined)
  const seriesName =
    typeof record.series === "string"
      ? record.series
      : typeof record.scope === "string" && label
        ? `${label} (${record.scope})`
        : label
  const points =
    (Array.isArray(record.values) && record.values) ||
    (Array.isArray(record.pointlist) && record.pointlist) ||
    (Array.isArray(record.points) && record.points) ||
    (Array.isArray(record.datapoints) && record.datapoints) ||
    (Array.isArray(record.value) && Array.isArray(record.value[0]) ? record.value : undefined) ||
    (Array.isArray(record.value) && record.value.length >= 2 && typeof record.value[0] !== "object" ? [record.value] : undefined) ||
    undefined
  if (!points) return false
  let added = 0
  for (const point of points) {
    const pair = pointPair(point)
    if (!pair) continue
    const timestamp = isoFromTimestamp(pair.timestamp) ?? String(pair.timestamp ?? "")
    const numeric = toNumber(pair.value)
    if (numeric === undefined) continue
    const row: Row = {
      timestamp,
      value: numeric,
      series: seriesName ?? "value",
    }
    if (record.unit && typeof record.unit === "string") row.unit = record.unit
    rows.push(row)
    added++
  }
  return added > 0
}

function rowsFromFrame(frame: unknown): Row[] | undefined {
  if (!frame || typeof frame !== "object") return undefined
  const record = frame as Record<string, unknown>
  const schema = record.schema && typeof record.schema === "object" ? (record.schema as Record<string, unknown>) : undefined
  const fields = Array.isArray(schema?.fields) ? (schema.fields as Array<Record<string, unknown>>) : []
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : undefined
  const values = Array.isArray(data?.values) ? (data.values as unknown[][]) : undefined
  if (!values || values.length === 0) return undefined
  const names = fields.length
    ? fields.map((field, index) => String(field.name ?? field.displayName ?? `column${index + 1}`))
    : values.map((_, index) => (index === 0 ? "time" : `value${index}`))
  const rowCount = Math.max(...values.map((column) => (Array.isArray(column) ? column.length : 0)))
  const rows: Row[] = []
  for (let index = 0; index < rowCount; index++) {
    const row: Row = {}
    values.forEach((column, columnIndex) => {
      const name = names[columnIndex] ?? `column${columnIndex + 1}`
      const raw = Array.isArray(column) ? column[index] : undefined
      const time = /^(time|timestamp)$/i.test(name) ? isoFromTimestamp(raw) : undefined
      row[name] = time ?? coerceValue(raw)
    })
    if (Object.values(row).some((value) => value !== null && value !== undefined && value !== "")) rows.push(row)
  }
  return rows.length ? rows : undefined
}

function rowsFromGrafanaResults(results: unknown): Row[] | undefined {
  const rows: Row[] = []
  const entries =
    Array.isArray(results) ? results : results && typeof results === "object" ? Object.values(results as Record<string, unknown>) : []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (Array.isArray(record.frames)) {
      for (const frame of record.frames) {
        const frameRows = rowsFromFrame(frame)
        if (frameRows) rows.push(...frameRows)
      }
    }
    if (Array.isArray(record.series)) {
      for (const series of record.series) {
        if (series && typeof series === "object") expandSeriesRecord(series as Record<string, unknown>, rows)
      }
    }
    if (Array.isArray(record.data)) {
      const dataRows = rowsFromJsonValue(record.data, 1)
      if (dataRows) rows.push(...dataRows)
    }
  }
  return rows.length ? rows : undefined
}

function rowsFromJsonValue(value: unknown, depth = 0): Row[] | undefined {
  if (depth > 6) return undefined
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    if (value.every((entry) => typeof entry !== "object" || entry === null)) {
      return value.map((entry, index) => ({ index, value: coerceValue(entry) }))
    }
    const objects = value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    const expanded: Row[] = []
    let seriesRows = 0
    for (const object of objects) {
      if (expandSeriesRecord(object, expanded)) {
        seriesRows++
        continue
      }
      const nested = ["data", "rows", "records", "items", "points"].find((key) => Array.isArray(object[key]))
      if (nested) {
        const inner = rowsFromJsonValue(object[nested], depth + 1)
        if (inner) expanded.push(...inner)
        continue
      }
      expanded.push(object as Row)
    }
    if (expanded.length > 0) return expanded
    if (seriesRows > 0) return expanded
    return undefined
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    if (Array.isArray(object.result)) {
      const rows: Row[] = []
      for (const entry of object.result) {
        if (entry && typeof entry === "object") expandSeriesRecord(entry as Record<string, unknown>, rows)
      }
      if (rows.length > 0) return rows
    }
    if (Array.isArray(object.series)) {
      const rows: Row[] = []
      for (const entry of object.series) {
        if (entry && typeof entry === "object") expandSeriesRecord(entry as Record<string, unknown>, rows)
      }
      if (rows.length > 0) return rows
    }
    if (object.results !== undefined) {
      const rows = rowsFromGrafanaResults(object.results)
      if (rows) return rows
    }
    if (Array.isArray(object.frames)) {
      const rows: Row[] = []
      for (const frame of object.frames) {
        const frameRows = rowsFromFrame(frame)
        if (frameRows) rows.push(...frameRows)
      }
      if (rows.length > 0) return rows
    }
    for (const key of ["data", "rows", "records", "items", "metrics", "values", "points", "series"]) {
      const nested = object[key]
      if (Array.isArray(nested)) {
        const rows = rowsFromJsonValue(nested, depth + 1)
        if (rows) return rows
      } else if (nested && typeof nested === "object") {
        const rows = rowsFromJsonValue(nested, depth + 1)
        if (rows) return rows
      }
    }
    if (Array.isArray(object.values) && object.values.every((entry) => Array.isArray(entry))) {
      const rows: Row[] = []
      for (const pair of object.values) {
        const point = pointPair(pair)
        if (!point) continue
        rows.push({
          timestamp: isoFromTimestamp(point.timestamp) ?? String(point.timestamp),
          value: toNumber(point.value) ?? 0,
          series: metricLabel(object.metric) ?? "value",
        })
      }
      if (rows.length > 0) return rows
    }
    if (Object.keys(object).length > 0 && Object.values(object).every((entry) => typeof entry !== "object")) {
      return [object as Row]
    }
  }
  return undefined
}

export function parseJsonTable(text: string): ParsedTable | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const rows = rowsFromJsonValue(parsed)
  if (!rows || rows.length === 0) return undefined
  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }
  return { columns, rows, format: "json" }
}

export function parseTable(text: string, source?: string): ParsedTable {
  const clean = stripAnsi(stripMarkdownFence(text))
  if (!clean.trim()) throw new Error("easel: no data to chart")

  const json = looksLikeJson(clean) ? parseJsonTable(clean) : undefined
  if (json) return { ...json, source }

  const xml = /<\?xml|<[A-Za-z_][\w:.-]*[\s>]/.test(clean) ? parseXml(clean) : undefined
  if (xml) return { ...xml, source }

  const pipe = parsePipeTable(clean)
  if (pipe && (clean.includes("│") || /^\s*\|?\s*:?-{3,}/m.test(clean) || pipe.rows.length > 0)) {
    return { ...pipe, source }
  }

  const delimited = parseDelimited(clean)
  if (delimited) return { ...delimited, source }

  const aligned = parseAligned(clean)
  if (aligned) return { ...aligned, source }

  if (pipe) return { ...pipe, source }
  throw new Error("easel: could not detect JSON, CSV, TSV, a Markdown/SQL table, XML or aligned columns in the data")
}

export function parseData(input: string, options: { path?: string } = {}): ParsedTable {
  let text = input
  if (options.path && !input.trim()) text = readFileSync(options.path, "utf8")
  text = stripToolPrefixes(stripAnsi(text))
  return parseTable(text, options.path)
}

export function parseFile(path: string): ParsedTable {
  const text = readFileSync(path, "utf8")
  return parseTable(stripToolPrefixes(stripAnsi(text)), path)
}

export function coerceValue(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === "number" || typeof value === "boolean") return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== "string") return JSON.stringify(value)
  const trimmed = value.trim()
  if (trimmed === "") return ""
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true"
  const numeric = toNumber(trimmed)
  if (numeric !== undefined && !/^0\d+$/.test(trimmed)) return numeric
  return trimmed
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const cleaned = trimmed.replace(/[$€£¥₹,\s]/g, "").replace(/%$/, "")
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(cleaned)) return undefined
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

const DATE_NAMES = /(^|[_\s-])(date|time|timestamp|ts|day|month|year|period|window)($|[_\s-])/i

export function isDateName(name: string): boolean {
  return DATE_NAMES.test(name)
}

export function parseDateValue(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === "number") {
    const millis = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined
    return millis ? new Date(millis) : undefined
  }
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/)
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
  match = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/)
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
  match = trimmed.match(/^(\d{4})-(\d{2})$/)
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1, 12))
  if (/^\d{4}$/.test(trimmed)) {
    const year = Number(trimmed)
    if (year >= 1900 && year <= 2200) return new Date(Date.UTC(year, 0, 1, 12))
  }
  if (/[a-z]/i.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return new Date(parsed)
  }
  return undefined
}

export function columnLooksDate(values: Cell[], name: string): boolean {
  const present = values.filter((value) => value !== null && value !== undefined && value !== "")
  if (present.length === 0) return false
  const dated = present.filter((value) => parseDateValue(value) !== undefined).length
  if (isDateName(name)) return dated / present.length >= 0.5
  return dated / present.length >= 0.85 && present.every((value) => !toNumber(value))
}

/** Identify Prometheus, Datadog or Grafana output. */
export function detectMetrics(text: string, toolName = ""): AutoChartMeta | undefined {
  const lower = toolName.toLowerCase()
  let provider: AutoChartMeta["provider"] | undefined
  if (lower.includes("prometheus")) provider = "prometheus"
  else if (lower.includes("datadog")) provider = "datadog"
  else if (lower.includes("grafana")) provider = "grafana"

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }

  if (parsed && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>
    const result = Array.isArray(root.result) ? root.result : Array.isArray((root.data as Record<string, unknown> | undefined)?.result) ? ((root.data as Record<string, unknown>).result as unknown[]) : undefined
    if (result?.some((entry) => entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).values))) {
      provider ??= "prometheus"
    }
    const series = Array.isArray(root.series) ? root.series : undefined
    if (series?.some((entry) => entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).pointlist))) {
      provider ??= "datadog"
    }
    const grafanaResults = root.results
    const grafanaEntries = Array.isArray(grafanaResults)
      ? grafanaResults
      : grafanaResults && typeof grafanaResults === "object"
        ? Object.values(grafanaResults as Record<string, unknown>)
        : []
    if (
      grafanaEntries.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (Array.isArray((entry as Record<string, unknown>).series) || Array.isArray((entry as Record<string, unknown>).frames)),
      )
    ) {
      provider ??= "grafana"
    }
    if (Array.isArray(root.frames)) provider ??= "grafana"
  }

  if (!provider) return undefined
  let metric: string | undefined
  const nameMatch = text.match(/"__name__"\s*:\s*"([^"]+)"/)
  if (nameMatch) metric = nameMatch[1]
  if (!metric) {
    const metricMatch = text.match(/"metric"\s*:\s*"([^"]+)"/)
    if (metricMatch) metric = metricMatch[1]
  }
  return { provider, tool: toolName, metric }
}
