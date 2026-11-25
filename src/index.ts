import { existsSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { EaselRpc } from "./rpc.ts"
import {
  buildModel,
  chartCanonicalKey,
  chartStoreFromLegacy,
  clearChartsInStore,
  defaultChartStorePath,
  deleteChartInStore,
  detectMetrics,
  encodePayload,
  loadChartStore,
  makePayload,
  mergeChartEntries,
  mergeChartStores,
  normalizeChartRequest,
  parseData,
  parseFile,
  parseTable,
  recordChartEntry,
  renderPayload,
  renderSvg,
  saveChartStore,
  stripToolPrefixes,
  type ChartEntry,
  type ChartRequest,
  type ChartStoreFile,
  type EaselPayload,
  type ParsedTable,
} from "./core/index.ts"

const EASEL_MARKER = "[easel:instructions]"

const TOOL_NAME = "easel_chart"

const INSTRUCTIONS = `${EASEL_MARKER}
Easel charting is available in this session through the ${TOOL_NAME} tool (Code Mode: tools.easel_chart).

Use ${TOOL_NAME} whenever the user asks to visualize, chart, plot, graph or compare data. It accepts:
- data: JSON, CSV, TSV, Markdown or SQL pipe tables, aligned shell columns, XML records, or an array of row objects.
- path: a local file to read instead of data.
- form: "line" | "columns" | "bars" | "sparks" | "share" | "pie".
- x, y, series (alias by): optional column names when automatic inference is ambiguous; y/series accept a string or an array.
- title, unit, combine ("sum" stacks columns, "mean"/"avg"/"max"/"min" aggregate repeated x+series rows), scale ("log" or log: true), marks (x or at).
- limit (alias top) caps series; width shrinks the chart for a side panel.
- Omit both data and path to chart the most recent tool result in this session.

A successful call returns one fenced code block whose language is "easel" and whose body is a self-contained JSON payload.
You MUST include that complete fenced block VERBATIM in your reply, on its own lines, without editing the JSON, changing
the fence language, wrapping it in another fence, or summarizing it. The TUI renders that block as a full-colour chart
inside the conversation. You may write a short sentence before or after the block.

Prometheus, Datadog and Grafana MCP tool results are charted automatically when they contain time-series metrics. Do not
duplicate those automatic charts. The user can inspect all charts in the session with the /easel panel.`

interface CachedToolResult {
  tool: string
  text: string
  at: number
}

type ChartConfig = {
  autoCharts: boolean
  autoChartSkip: string[]
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
}

function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return false
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^]*")
    .replaceAll("\u0000", "[^]*")
  try {
    return new RegExp(`^${source}$`, "i").test(value)
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase())
  }
}

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const record = result as Record<string, unknown>
  const content = record.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          return (item as Record<string, unknown>).text as string
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (record.output !== undefined) {
    try {
      return typeof record.output === "string" ? record.output : JSON.stringify(record.output)
    } catch {
      return String(record.output)
    }
  }
  return ""
}

function appendContent(content: unknown, block: string): string | Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return `${content.trimEnd()}\n\n${block}`
  if (Array.isArray(content)) {
    return [...(content as Array<{ type: "text"; text: string }>), { type: "text", text: block }]
  }
  return block
}

function codeBlock(payload: EaselPayload): string {
  return `\`\`\`easel\n${encodePayload(payload)}\n\`\`\``
}

export default Plugin.define({
  id: "easel",
  async setup(ctx) {
    const cache = new Map<string, CachedToolResult[]>()

    const storedConfig = (await ctx.storage.get("config").catch(() => undefined)) as Partial<ChartConfig> | undefined
    let config: ChartConfig = {
      autoCharts:
        typeof ctx.options.autoCharts === "boolean"
          ? ctx.options.autoCharts
          : typeof storedConfig?.autoCharts === "boolean"
            ? storedConfig.autoCharts
            : true,
      autoChartSkip:
        asStringArray(ctx.options.autoChartSkip) ??
        asStringArray(storedConfig?.autoChartSkip) ?? ["*easel_chart*"],
    }

    let rpcRegistration: any

    const persistConfig = async () => {
      try {
        await ctx.storage.set("config", config)
      } catch (error) {
        console.error("[easel] could not persist configuration", error)
      }
    }

    const chartFile =
      typeof ctx.options.chartStorePath === "string" && ctx.options.chartStorePath.trim()
        ? ctx.options.chartStorePath
        : defaultChartStorePath()
    let chartStore: ChartStoreFile = loadChartStore(chartFile)

    const readStore = async (): Promise<ChartStoreFile> => {
      const diskExists = existsSync(chartFile)
      let disk = loadChartStore(chartFile)
      if (!diskExists) {
        // One-time migration from the per-location `ctx.storage` keys.
        try {
          const whole = await ctx.storage.get("charts")
          const scanned = await ctx.storage.scan({ prefix: "charts:", limit: 1000 })
          const legacy = chartStoreFromLegacy(scanned.entries ?? [], whole)
          if (Object.keys(legacy.sessions).length > 0) {
            disk = mergeChartStores(disk, legacy)
            saveChartStore(disk, chartFile)
          }
        } catch {
          // Storage is only a fallback for the shared file.
        }
      }
      // If the file cannot be written in this process, keep what this
      // location already recorded instead of losing it.
      if (!existsSync(chartFile)) disk = mergeChartStores(disk, chartStore)
      chartStore = disk
      return chartStore
    }

    const writeStore = async (
      next: ChartStoreFile,
      mode: "merge" | "replace" = "merge",
      resurrect?: ChartEntry,
    ): Promise<void> => {
      // Merge charts written by other locations since our read; a clear
      // replaces the store so it can actually remove a session.
      chartStore = mode === "replace" ? next : mergeChartStores(loadChartStore(chartFile), chartStore, next)
      if (resurrect) {
        // An explicit chart request cleared the tombstone in `next`, but the
        // merge above may have re-added it from disk and filtered the chart
        // out. Clear it again and put the freshly requested chart back.
        const sessionID = resurrect.sessionID
        const key = chartCanonicalKey(resurrect.payload)
        const deletedKeys = chartStore.deleted?.[sessionID]
        if (deletedKeys) {
          const remaining = deletedKeys.filter((entry) => entry !== key)
          if (remaining.length > 0) chartStore.deleted![sessionID] = remaining
          else delete chartStore.deleted![sessionID]
          if (Object.keys(chartStore.deleted!).length === 0) delete chartStore.deleted
        }
        chartStore.sessions[sessionID] = mergeChartEntries(chartStore.sessions[sessionID] ?? [], [resurrect])
      }
      const saved = saveChartStore(chartStore, chartFile)
      // Never let the optional fallback block a tool result: a slow or busy
      // storage RPC used to leave `easel_chart` hanging ("Tool result missing").
      void ctx.storage
        .set("charts", chartStore as unknown as Parameters<typeof ctx.storage.set>[1])
        .catch((error: unknown) => console.error("[easel] could not persist chart fallback", error))
      if (!saved) console.error(`[easel] could not write shared chart store ${chartFile}`)
    }

    // Serialize read-modify-write cycles inside this location. Parallel
    // easel_chart calls otherwise read the same store and overwrite each other.
    let storeLock: Promise<void> = Promise.resolve()
    const withStoreLock = async <T>(work: () => Promise<T>): Promise<T> => {
      const previous = storeLock
      let release!: () => void
      storeLock = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous.catch(() => undefined)
      try {
        return await work()
      } finally {
        release()
      }
    }

    const emitUpdated = async (entry: ChartEntry, count: number) => {
      if (!rpcRegistration) return
      try {
        await rpcRegistration.events.emit("updated", {
          sessionID: entry.sessionID,
          count,
          chartID: entry.id,
          form: entry.form,
          title: entry.title,
        })
      } catch (error) {
        console.error("[easel] could not emit chart update", error)
      }
    }

    const recordChart = async (
      sessionID: string,
      payload: EaselPayload,
      fallbackForm: ChartEntry["form"] = "line",
    ): Promise<ChartEntry> => {
      return withStoreLock(async () => {
        const store = await readStore()
        const wasDeleted = store.deleted?.[sessionID]?.includes(chartCanonicalKey(payload)) ?? false
        const result = recordChartEntry(store, sessionID, payload, { form: fallbackForm, allowDeleted: true })
        if (result.created) await writeStore(store, "merge", wasDeleted ? result.chart : undefined)
        void emitUpdated(result.chart, result.count)
        return result.chart
      })
    }

    const shouldSkipAuto = (tool: string) => config.autoChartSkip.some((pattern) => globMatch(pattern, tool))

    // Cache recent tool output per session. The chart tool reads this when data is omitted.
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const raw = extractText(event.result)
      if (!raw) return
      const text = event.tool === "read" ? stripToolPrefixes(raw) : raw
      const list = cache.get(event.sessionID) ?? []
      list.push({ tool: event.tool, text, at: Date.now() })
      if (list.length > 12) list.splice(0, list.length - 12)
      cache.set(event.sessionID, list)

      if (event.tool === TOOL_NAME) return
      if (!config.autoCharts || shouldSkipAuto(event.tool)) return
      if (text.includes("```easel")) return

      const meta = detectMetrics(text, event.tool)
      if (!meta) return

      try {
        const table = parseTable(text)
        const probe = buildModel(table, { form: "line" })
        if (probe.xKind !== "time" || probe.xValues.length < 3) return
        const title = `${meta.provider === "prometheus" ? "Prometheus" : meta.provider === "datadog" ? "Datadog" : "Grafana"} · ${meta.metric ?? "metrics"}`
        const payload = makePayload(table, {
          form: "line",
          title,
          unit: "",
        })
        payload.auto = meta
        const entry = await recordChart(event.sessionID, payload)
        if (entry.plain) {
          event.result = {
            ...event.result,
            content: appendContent(event.result.content, codeBlock(payload)),
            metadata: { ...(event.result.metadata ?? {}), easel: { chartID: entry.id, automatic: true } },
          } as typeof event.result
        }
      } catch (error) {
        console.error("[easel] automatic chart failed", error)
      }
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "easel", description: "Render data as a chart in the conversation" })
      editor.add({
        name: "chart",
        description:
          "Render an inline terminal chart. Accepts JSON, CSV, TSV, Markdown/SQL tables, aligned shell output, XML, a local path, or (when data and path are omitted) the previous tool result. Returns a ```easel code block that must be included verbatim in the reply.",
        input: {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "object", additionalProperties: true } },
              ],
              description: "Raw JSON, CSV, TSV, Markdown/SQL table, aligned shell output, XML records, or an array of row objects.",
            },
            path: {
              type: "string",
              description: "Local file to parse when data is omitted.",
            },
            form: {
              type: "string",
              enum: ["line", "columns", "bars", "sparks", "share", "pie"],
              description: "Chart form. Defaults to line for time series and bars for categorical data.",
            },
            x: { type: "string", description: "Column to use for the x axis / categories." },
            y: {
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              description: "Numeric column to use for values (a single name or an array).",
            },
            series: {
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              description: "Column whose values split the data into series.",
            },
            by: {
              anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              description: "Alias for series.",
            },
            title: { type: "string" },
            unit: { type: "string", description: "Unit shown in the header, such as downloads or req/s." },
            combine: {
              type: "string",
              enum: ["none", "sum", "mean", "avg", "max", "min"],
              description:
                "sum stacks columns (and prints totals); mean/max/min aggregate repeated x+series rows. avg is an alias of mean.",
            },
            scale: { type: "string", enum: ["linear", "log"] },
            log: { type: "boolean", description: "Alias for scale: log." },
            marks: {
              type: "array",
              description: "Event markers at x values (use x or at).",
              items: {
                type: "object",
                properties: {
                  x: { type: ["string", "number"] },
                  at: { type: ["string", "number"] },
                  label: { type: "string" },
                  color: { type: "string" },
                },
                anyOf: [{ required: ["x"] }, { required: ["at"] }],
                additionalProperties: false,
              },
            },
            width: { type: "integer", minimum: 40, maximum: 220 },
            limit: { type: "integer", minimum: 1, maximum: 200, description: "Optional series limit." },
            top: { type: "integer", minimum: 1, maximum: 200, description: "Alias for limit." },
            format: {
              type: "string",
              enum: ["text", "svg"],
              description: "text returns an easel block; svg returns a standalone SVG block.",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "easel", codemode: false },
        execute: async (input, context): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
          const request: ChartRequest = normalizeChartRequest(input)
          let table: ParsedTable | undefined
          let sourceLabel = request.path
          const sessionID = String(context.sessionID)

          try {
            if (typeof request.data === "string" && request.data.trim()) {
              table = parseData(request.data, { path: request.path })
            } else if (Array.isArray(request.data) && request.data.length > 0) {
              table = parseTable(JSON.stringify(request.data), request.path)
            } else if (request.path) {
              table = parseFile(request.path)
            } else {
              const cached = cache.get(sessionID)
              if (cached && cached.length) {
                const latest = [...cached].reverse().find((entry) => entry.tool !== TOOL_NAME)
                if (latest) {
                  table = parseTable(latest.text, latest.tool)
                  sourceLabel = latest.tool
                }
              }
            }

            if (!table) {
              throw new Error("no data was supplied and no previous tool result is cached in this session")
            }

            // OpenCode's tool output validator rejects `undefined` metadata
            // values, which surfaced as "Tool result missing" whenever `data`
            // was passed without `path`. Always resolve a definite label.
            if (!sourceLabel) sourceLabel = table.source || table.format || "inline"

            if (request.format === "svg") {
              return {
                content: `\`\`\`svg\n${renderSvg(table, request)}\n\`\`\``,
                metadata: { form: request.form ?? "line", svg: true, source: sourceLabel },
              }
            }

            const payload = makePayload(table, request)
            const rendered = renderPayload(payload)
            const entry = await recordChart(sessionID, payload, rendered.form)
            return {
              content: codeBlock(payload),
              metadata: {
                chartID: entry.id,
                form: rendered.form,
                title: rendered.title,
                source: sourceLabel,
              },
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error("[easel] chart tool failed:", message)
            throw new Error(`easel_chart: ${message}`)
          }
        },
      })
    })

    await ctx.session.hook("context", (event) => {
      const already = event.system.some((part) => part.type === "text" && part.text.includes(EASEL_MARKER))
      if (!already) event.system.push({ type: "text", text: INSTRUCTIONS })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "easel-auto",
        description: "Toggle automatic Prometheus/Datadog/Grafana charts, or chart the latest tool result",
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = String((prompt as { text?: string } | undefined)?.text ?? "").trim()
          const lower = text.toLowerCase()
          if (!text || lower === "toggle") {
            config = { ...config, autoCharts: !config.autoCharts }
            await persistConfig()
            await rpcRegistration?.events.emit("config", { autoCharts: config.autoCharts })
            await ctx.session.synthetic({
              sessionID,
              text: `easel: automatic MCP metric charts are now ${config.autoCharts ? "on" : "off"}.`,
            })
            return
          }
          if (lower === "on" || lower === "off") {
            config = { ...config, autoCharts: lower === "on" }
            await persistConfig()
            await rpcRegistration?.events.emit("config", { autoCharts: config.autoCharts })
            await ctx.session.synthetic({
              sessionID,
              text: `easel: automatic MCP metric charts are now ${config.autoCharts ? "on" : "off"}.`,
            })
            return
          }
          if (lower === "status") {
            await ctx.session.synthetic({
              sessionID,
              text: `easel: automatic charts ${config.autoCharts ? "on" : "off"}; skipped tools: ${config.autoChartSkip.join(", ") || "none"}.`,
            })
            return
          }
          await ctx.session.prompt({
            sessionID,
            text: `${text}\n\nUse the ${TOOL_NAME} tool with no data to chart the most recent tool result in this session. Include the returned easel code block verbatim in your reply.`,
            delivery,
          } as Parameters<typeof ctx.session.prompt>[0])
        },
      })
      editor.add({
        name: "easel-chart",
        description: "Chart the most recent tool result",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            sessionID,
            text: `Use the ${TOOL_NAME} tool with no data to chart the most recent tool result in this session. Include the returned easel code block verbatim in your reply.${(prompt as { text?: string })?.text ? `\n\n${(prompt as { text?: string }).text}` : ""}`,
            delivery,
          } as Parameters<typeof ctx.session.prompt>[0])
        },
      })
    })

    rpcRegistration = await ctx.rpc.register(EaselRpc, {
      chartsList: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const store = await readStore()
        return {
          charts: store.sessions[sessionID] ?? [],
          deletedKeys: store.deleted?.[sessionID] ?? [],
        }
      },
      chartsClear: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const cleared = await withStoreLock(async () => {
          const store = await readStore()
          const count = clearChartsInStore(store, sessionID)
          await writeStore(store, "replace")
          return count
        })
        if (rpcRegistration) {
          try {
            await rpcRegistration.events.emit("updated", { sessionID, count: 0 })
          } catch {
            // Event delivery is best-effort.
          }
        }
        return { cleared }
      },
      chartDelete: async (input) => {
        const { sessionID, chartID, key } = input as { sessionID: string; chartID?: string; key?: string }
        return withStoreLock(async () => {
          const store = await readStore()
          const result = deleteChartInStore(store, sessionID, { chartID, key })
          await writeStore(store, "replace")
          if (rpcRegistration) {
            try {
              await rpcRegistration.events.emit("updated", { sessionID, count: result.count })
            } catch {
              // Event delivery is best-effort.
            }
          }
          return result
        })
      },
      chartRecord: async (input) => {
        const { sessionID, payload } = input as { sessionID: string; payload: EaselPayload }
        return withStoreLock(async () => {
          const store = await readStore()
          const result = recordChartEntry(store, sessionID, payload, { allowDeleted: false })
          if (result.created) {
            await writeStore(store)
            void emitUpdated(result.chart, result.count)
          }
          return { chart: result.chart, count: result.count }
        })
      },
      configGet: async () => ({ ...config }),
      configSet: async (input) => {
        const update = input as Partial<ChartConfig>
        if (typeof update.autoCharts === "boolean") config = { ...config, autoCharts: update.autoCharts }
        const skip = asStringArray(update.autoChartSkip)
        if (skip) config = { ...config, autoChartSkip: skip }
        await persistConfig()
        await rpcRegistration?.events.emit("config", { autoCharts: config.autoCharts })
        return { ...config }
      },
      autoToggle: async () => {
        config = { ...config, autoCharts: !config.autoCharts }
        await persistConfig()
        await rpcRegistration?.events.emit("config", { autoCharts: config.autoCharts })
        return { autoCharts: config.autoCharts }
      },
      status: async () => {
        const store = await readStore()
        return {
          autoCharts: config.autoCharts,
          autoChartSkip: [...config.autoChartSkip],
          sessions: Object.keys(store.sessions).length,
        }
      },
    })

    console.log(`[easel] loaded ${TOOL_NAME} (autoCharts=${config.autoCharts ? "on" : "off"})`)

    return () => {
      cache.clear()
    }
  },
})
