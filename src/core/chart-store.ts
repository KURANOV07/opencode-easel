import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { renderPayload } from "./charting.ts"
import type { ChartEntry, ChartForm, EaselPayload } from "./types.ts"

export interface ChartStoreFile {
  version: number
  sessions: Record<string, ChartEntry[]>
  deleted?: Record<string, string[]>
}

const MAX_CHARTS_PER_SESSION = 100
let sequence = 0

/**
 * Titles that came from ad-hoc diagnostics while developing the plugin. They
 * are not real charts, so they must never show up in `/easel` even when an old
 * store file or session transcript still contains them.
 */
export const IGNORED_TITLES = new Set([
  "Test path",
  "Test ascii data",
  "Test data with path",
  "'fresh': by {'cache':",
])

export function isIgnoredTitle(title: string | undefined): boolean {
  return typeof title === "string" && IGNORED_TITLES.has(title.trim())
}

export function isIgnoredPayload(payload: EaselPayload | undefined): boolean {
  if (!payload) return false
  return isIgnoredTitle(payload.meta?.title) || isIgnoredTitle(payload.request?.title)
}

/** Shared on-disk chart index. Every server location instance reads this one file. */
export function defaultChartStorePath(): string {
  const override = process.env.EASEL_CHART_STORE?.trim()
  if (override) return override
  return join(homedir(), ".local/share/opencode/easel-charts.json")
}

function emptyStore(): ChartStoreFile {
  return { version: 1, sessions: {} }
}

export function loadChartStore(path = defaultChartStorePath()): ChartStoreFile {
  if (!existsSync(path)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ChartStoreFile>
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") return emptyStore()
    const deleted: Record<string, string[]> = {}
    for (const [sessionID, keys] of Object.entries(parsed.deleted ?? {})) {
      if (!Array.isArray(keys)) continue
      const normalized = normalizeDeletedKeys(keys)
      if (normalized.length > 0) deleted[sessionID] = normalized
    }
    const sessions: Record<string, ChartEntry[]> = {}
    for (const [sessionID, entries] of Object.entries(parsed.sessions)) {
      if (!Array.isArray(entries)) continue
      const tombstones = deleted[sessionID]
      sessions[sessionID] = mergeChartEntries([], entries).filter(
        (entry) => !isDeletedChart(tombstones, entry),
      )
    }
    const store: ChartStoreFile = { version: 1, sessions }
    if (Object.keys(deleted).length > 0) store.deleted = deleted
    return store
  } catch {
    return emptyStore()
  }
}

function normalizeDeletedKeys(keys: ReadonlyArray<unknown>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (typeof key !== "string" || !key) continue
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

/**
 * Checks whether a chart was deleted from a session. Deleted charts are stored
 * as tombstones so transcript scanning and store merges cannot resurrect them.
 */
export function isDeletedChart(
  deletedKeys: ReadonlySet<string> | ReadonlyArray<string> | undefined,
  entryOrPayload: ChartEntry | EaselPayload,
): boolean {
  const has = (key: string | undefined): boolean => {
    if (!key) return false
    if (deletedKeys instanceof Set) return deletedKeys.has(key)
    return Array.isArray(deletedKeys) ? deletedKeys.includes(key) : false
  }
  const payload = "payload" in entryOrPayload ? entryOrPayload.payload : entryOrPayload
  if (has(chartCanonicalKey(payload))) return true
  if ("payload" in entryOrPayload && has(`id:${entryOrPayload.id}`)) return true
  return false
}

export function saveChartStore(store: ChartStoreFile, path = defaultChartStorePath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8")
    renameSync(temporary, path)
    return true
  } catch {
    return false
  }
}

/**
 * Canonical identity used to deduplicate charts coming from the server, the
 * transcript scanner and `renderChartBlock`.
 */
export function chartCanonicalKey(payload: EaselPayload | undefined): string {
  if (!payload) return "invalid"
  const meta = payload.meta ?? {}
  const request = payload.request ?? {}
  const title = request.title ?? meta.title ?? ""
  const form = request.form ?? meta.form ?? ""
  const x = request.x ?? meta.x ?? ""
  const y = Array.isArray(request.y) ? request.y.join(",") : request.y ?? meta.y ?? ""
  const series = Array.isArray(request.series)
    ? request.series.join(",")
    : request.series ?? request.by ?? meta.series ?? ""
  // Include a little table shape so two charts with the same title but
  // different data still stay distinct.
  const columns = payload.table?.columns?.join(",") ?? ""
  const rows = payload.table?.rows?.length ?? 0
  return [title, form, x, y, series, columns, rows].join("\u0001")
}

export function mergeChartEntries(...lists: Array<ChartEntry[] | undefined>): ChartEntry[] {
  const result: ChartEntry[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue
      if (!entry.payload || typeof entry.payload !== "object" || !Array.isArray(entry.payload.table?.rows)) continue
      if (isIgnoredTitle(entry.title) || isIgnoredPayload(entry.payload)) continue
      const key = chartCanonicalKey(entry.payload)
      const idKey = typeof entry.id === "string" ? `id:${entry.id}` : ""
      if (seen.has(key) || (idKey && seen.has(idKey))) continue
      seen.add(key)
      if (idKey) seen.add(idKey)
      result.push({
        id: typeof entry.id === "string" ? entry.id : `easel_legacy_${result.length}`,
        sessionID: typeof entry.sessionID === "string" ? entry.sessionID : "",
        title: typeof entry.title === "string" ? entry.title : entry.payload.meta?.title ?? "Easel chart",
        form: (entry.form ?? entry.payload.meta?.form ?? "line") as ChartForm,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
        payload: entry.payload,
        plain: typeof entry.plain === "string" ? entry.plain : "",
      })
    }
  }
  return result
}

export interface CreateEntryOptions {
  id?: string
  createdAt?: number
  form?: ChartForm
  title?: string
  plain?: string
  /**
   * Active chart creation (the `easel_chart` tool or the automatic MCP hook)
   * clears a tombstone so asking for a deleted chart again shows it. Passive
   * registration from the transcript must leave tombstones in place.
   */
  allowDeleted?: boolean
}

/** Build a `ChartEntry` from a payload without touching the filesystem. */
export function chartEntryFromPayload(
  sessionID: string,
  payload: EaselPayload,
  options: CreateEntryOptions = {},
): ChartEntry {
  let form: ChartForm = options.form ?? payload.meta?.form ?? "line"
  let title = options.title ?? payload.meta?.title ?? "Easel chart"
  let plain = options.plain ?? ""
  if (!plain) {
    try {
      const rendered = renderPayload(payload)
      plain = rendered.plain
      form = rendered.form
      title = rendered.title
    } catch {
      // The payload can still be rendered later by the panel.
    }
  }
  return {
    id: options.id ?? `easel_${Date.now().toString(36)}_${(sequence++).toString(36)}`,
    sessionID,
    title,
    form,
    createdAt: options.createdAt ?? Date.now(),
    payload,
    plain,
  }
}

export interface RecordChartResult {
  chart: ChartEntry
  count: number
  created: boolean
}

/** Add a chart to an in-memory store, returning the existing entry when it is a duplicate. */
export function recordChartEntry(
  store: ChartStoreFile,
  sessionID: string,
  payload: EaselPayload,
  options: CreateEntryOptions = {},
): RecordChartResult {
  const existing = store.sessions[sessionID] ?? []
  if (isIgnoredPayload(payload)) {
    // Diagnostics are never persisted, even if a caller explicitly records one.
    return { chart: chartEntryFromPayload(sessionID, payload, options), count: existing.length, created: false }
  }
  const key = chartCanonicalKey(payload)
  if (options.allowDeleted && store.deleted?.[sessionID]?.includes(key)) {
    // An explicit request re-creates a chart the user deleted earlier.
    const remaining = store.deleted[sessionID].filter((entry) => entry !== key)
    if (remaining.length > 0) store.deleted[sessionID] = remaining
    else delete store.deleted[sessionID]
    if (store.deleted && Object.keys(store.deleted).length === 0) delete store.deleted
  }
  if (!options.allowDeleted && store.deleted?.[sessionID]?.includes(key)) {
    // Passive transcript scanning must not resurrect a deleted chart.
    return { chart: chartEntryFromPayload(sessionID, payload, options), count: existing.length, created: false }
  }
  const match = existing.find((entry) => chartCanonicalKey(entry.payload) === key)
  if (match) return { chart: match, count: existing.length, created: false }

  const chart = chartEntryFromPayload(sessionID, payload, options)
  const charts = [...existing, chart]
  if (charts.length > MAX_CHARTS_PER_SESSION) charts.splice(0, charts.length - MAX_CHARTS_PER_SESSION)
  store.sessions[sessionID] = charts
  return { chart, count: charts.length, created: true }
}

/**
 * Delete a chart from a session and remember per-session tombstones so the
 * transcript scanner cannot bring it back. Charts can be addressed by their
 * entry id, their canonical key, or both (a transcript-only chart has no
 * persisted entry yet, so the TUI sends the key it just rendered).
 */
export function deleteChartInStore(
  store: ChartStoreFile,
  sessionID: string,
  target: { chartID?: string; key?: string },
): { deleted: boolean; count: number; deletedKeys: string[] } {
  store.deleted ??= {}
  const tombstones = new Set(store.deleted[sessionID] ?? [])
  const existing = store.sessions[sessionID] ?? []
  const matches = existing.filter(
    (entry) =>
      (target.chartID !== undefined && entry.id === target.chartID) ||
      (target.key !== undefined && target.key !== "" && chartCanonicalKey(entry.payload) === target.key),
  )
  for (const entry of matches) {
    tombstones.add(chartCanonicalKey(entry.payload))
    tombstones.add(`id:${entry.id}`)
  }
  if (target.key) tombstones.add(target.key)
  if (target.chartID) tombstones.add(`id:${target.chartID}`)

  if (matches.length > 0) {
    store.sessions[sessionID] = existing.filter((entry) => !matches.includes(entry))
  }
  store.deleted[sessionID] = [...tombstones]
  return {
    deleted: matches.length > 0 || Boolean(target.key || target.chartID),
    count: store.sessions[sessionID]?.length ?? 0,
    deletedKeys: store.deleted[sessionID],
  }
}

export function clearChartsInStore(store: ChartStoreFile, sessionID: string): number {
  const charts = store.sessions[sessionID] ?? []
  delete store.sessions[sessionID]
  return charts.length
}

export function mergeChartStores(...stores: ChartStoreFile[]): ChartStoreFile {
  const merged = emptyStore()
  // Union tombstones first so entries from another location cannot resurrect
  // a chart that was deleted here.
  const tombstones: Record<string, Set<string>> = {}
  for (const store of stores) {
    if (!store?.deleted) continue
    for (const [sessionID, keys] of Object.entries(store.deleted)) {
      if (!Array.isArray(keys)) continue
      const set = (tombstones[sessionID] ??= new Set<string>())
      for (const key of keys) if (typeof key === "string" && key) set.add(key)
    }
  }
  const deleted: Record<string, string[]> = {}
  for (const [sessionID, keys] of Object.entries(tombstones)) {
    if (keys.size > 0) deleted[sessionID] = [...keys]
  }
  if (Object.keys(deleted).length > 0) merged.deleted = deleted

  for (const store of stores) {
    if (!store || !store.sessions) continue
    for (const [sessionID, entries] of Object.entries(store.sessions)) {
      const filtered = mergeChartEntries(merged.sessions[sessionID], entries).filter(
        (entry) => !isDeletedChart(deleted[sessionID], entry),
      )
      merged.sessions[sessionID] = filtered
    }
  }
  return merged
}

/** Convert legacy `ctx.storage` entries into the shared chart store shape. */
export function chartStoreFromLegacy(entries: ReadonlyArray<{ key: string; value: unknown }>, whole?: unknown): ChartStoreFile {
  const store = emptyStore()
  if (whole && typeof whole === "object" && (whole as ChartStoreFile).sessions) {
    return mergeChartStores(store, whole as ChartStoreFile)
  }
  for (const entry of entries) {
    if (!entry.key.startsWith("charts:") || !Array.isArray(entry.value)) continue
    const sessionID = entry.key.slice("charts:".length)
    store.sessions[sessionID] = mergeChartEntries(store.sessions[sessionID], entry.value as ChartEntry[])
  }
  return store
}
