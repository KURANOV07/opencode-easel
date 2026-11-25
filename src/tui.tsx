import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { RGBA, StyledText, TextAttributes, TextRenderable, type TextChunk } from "@opentui/core"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { EaselRpc } from "./rpc.ts"
import {
  CHART_FORMS,
  GUTTER,
  GUTTER_CONTINUATION,
  REST_COLOR,
  activePanelPage,
  chartCanonicalKey,
  chartEntryFromPayload,
  composePanelPages,
  decodePayload,
  extractEaselPayloads,
  isDeletedChart,
  mergeChartEntries,
  panelChartWidth,
  renderPayload,
  type ChartEntry,
  type ChartForm,
  type EaselPayload,
  type PanelChartItem,
  type RenderedChart,
  type StyledLine,
} from "./core/index.ts"

type EaselStore = {
  bySession: Record<string, ChartEntry[]>
  deletedBySession: Record<string, string[]>
}

const RECENT_SESSION = "__recent__"

function styledChunk(text: string, options: { fg?: string; bg?: string; bold?: boolean; dim?: boolean } = {}): TextChunk {
  let attributes = 0
  if (options.bold) attributes |= TextAttributes.BOLD
  if (options.dim) attributes |= TextAttributes.DIM
  return {
    __isChunk: true,
    text,
    fg: options.fg ? RGBA.fromHex(options.fg) : undefined,
    bg: options.bg ? RGBA.fromHex(options.bg) : undefined,
    attributes: attributes || undefined,
  }
}

function linesToStyled(lines: StyledLine[], gutter = true, gutterColor = "#6b7280"): StyledText {
  const chunks: TextChunk[] = []
  lines.forEach((line, lineIndex) => {
    if (gutter) {
      chunks.push(styledChunk(lineIndex === 0 ? GUTTER : GUTTER_CONTINUATION, { fg: gutterColor, dim: true }))
    }
    for (const span of line.spans) {
      chunks.push(
        styledChunk(span.text, {
          fg: span.fg,
          bg: span.bg,
          bold: span.bold,
          dim: span.dim,
        }),
      )
    }
    if (lineIndex < lines.length - 1) chunks.push(styledChunk("\n"))
  })
  return new StyledText(chunks)
}

export default Plugin.define({
  id: "easel.tui",
  setup(context) {
    const disposers: Array<() => void> = []
    const syncing = new Set<string>()
    const discovering = new Map<string, Promise<ChartEntry[]>>()
    const registered = new Set<string>()
    const [chartStore, updateChartStore] = context.storage.memory<EaselStore>("chart-index", {
      initial: { bySession: {}, deletedBySession: {} },
    })

    const rpc = () => context.client.rpc(EaselRpc)
    // Server plugin instances are scoped per location, so every RPC must name
    // the active workspace explicitly instead of falling back to ~.
    const getLocation = () => context.location ?? context.data.location.default()
    const rpcOptions = () => ({ location: getLocation() })

    const chartsFor = (sessionID: string | undefined): ChartEntry[] | undefined => {
      if (!sessionID) return undefined
      return chartStore.bySession[sessionID]
    }

    const isDeletedFor = (sessionID: string, entryOrPayload: ChartEntry | EaselPayload): boolean => {
      return isDeletedChart(chartStore.deletedBySession?.[sessionID], entryOrPayload)
    }

    const setCharts = (sessionID: string, charts: ChartEntry[]) => {
      updateChartStore((draft) => {
        draft.bySession[sessionID] = mergeChartEntries(charts).filter(
          (entry) => !isDeletedChart(draft.deletedBySession?.[sessionID], entry),
        )
      })
    }

    const rememberChart = (sessionID: string, entry: ChartEntry) => {
      if (isDeletedFor(sessionID, entry)) return
      updateChartStore((draft) => {
        if (isDeletedChart(draft.deletedBySession?.[sessionID], entry)) return
        draft.bySession[sessionID] = mergeChartEntries(draft.bySession[sessionID] ?? [], [entry]).filter(
          (candidate) => !isDeletedChart(draft.deletedBySession?.[sessionID], candidate),
        )
      })
    }

    const activeSessionID = (): string => {
      try {
        const route = context.ui.router.current()
        if (route.type === "session") return route.sessionID
      } catch {
        // The router may not be ready during early renders.
      }
      const panel = context.ui.panel.current()
      return panel?.sessionID ?? RECENT_SESSION
    }

    const registerChart = (sessionID: string, payload: EaselPayload) => {
      if (isDeletedFor(sessionID, payload)) return
      const key = `${sessionID}\u0000${chartCanonicalKey(payload)}`
      if (registered.has(key)) return
      registered.add(key)
      void rpc()
        .chartRecord({ sessionID, payload }, rpcOptions())
        .catch(() => {
          // The chart is already visible locally; the next sync retries.
        })
    }

    /**
     * Charts that were pasted into the conversation (Plan mode, session
     * reload, blocks copied from an earlier answer) never pass through the
     * server. Scan the transcript so `/easel` can always show them.
     */
    const extractChartsFromMessages = (sessionID: string): Promise<ChartEntry[]> => {
      const running = discovering.get(sessionID)
      if (running) return running
      const task = (async () => {
        try {
          await context.data.session.message.sync(sessionID)
        } catch {
          // The cached message list is still useful.
        }
        let messages: unknown[] = []
        try {
          messages = context.data.session.message.list(sessionID) ?? []
        } catch {
          messages = []
        }
        const payloads = extractEaselPayloads(messages)
        const entries = payloads
          .filter((payload) => !isDeletedFor(sessionID, payload))
          .map((payload) => chartEntryFromPayload(sessionID, payload, { createdAt: 0 }))
        if (entries.length > 0) {
          const existing = chartStore.bySession[sessionID] ?? []
          updateChartStore((draft) => {
            draft.bySession[sessionID] = mergeChartEntries(existing, entries).filter(
              (entry) => !isDeletedChart(draft.deletedBySession?.[sessionID], entry),
            )
          })
          for (const entry of entries) registerChart(sessionID, entry.payload)
        }
        return entries
      })().finally(() => {
        discovering.delete(sessionID)
      })
      discovering.set(sessionID, task)
      return task
    }

    const syncCharts = async (sessionID: string | undefined) => {
      if (!sessionID || syncing.has(sessionID)) return
      syncing.add(sessionID)
      try {
        const response = (await rpc().chartsList({ sessionID }, rpcOptions())) as {
          charts: ChartEntry[]
          deletedKeys?: string[]
        }
        if (response.deletedKeys?.length) {
          updateChartStore((draft) => {
            draft.deletedBySession ??= {}
            const tombstones = new Set(draft.deletedBySession[sessionID] ?? [])
            for (const key of response.deletedKeys ?? []) tombstones.add(key)
            draft.deletedBySession[sessionID] = [...tombstones]
          })
        }
        const discovered = await extractChartsFromMessages(sessionID)
        setCharts(
          sessionID,
          mergeChartEntries(response.charts, chartStore.bySession[sessionID], discovered).filter(
            (entry) => !isDeletedFor(sessionID, entry),
          ),
        )
      } catch {
        // The server may be reconnecting; the next event or render retries.
      } finally {
        syncing.delete(sessionID)
      }
    }

    const panelKey = "easel.panel"
    const chartWidth = () => Math.max(48, Math.min(110, (context.renderer.width ?? 100) - 16))

    const renderChartBlock = (block: { text: string }, fallback: () => any) => {
      const payload = decodePayload(block.text)
      if (!payload) return fallback()
      try {
        const chart = renderPayload(payload, { width: chartWidth() })
        const sessionID = activeSessionID()
        rememberChart(
          sessionID,
          chartEntryFromPayload(sessionID, payload, {
            plain: chart.plain,
            form: chart.form,
            title: chart.title,
          }),
        )
        registerChart(sessionID, payload)
        return new TextRenderable(context.renderer, {
          content: linesToStyled(chart.lines, true),
          wrapMode: "none",
          fg: RGBA.fromHex("#d7dce5"),
        })
      } catch (error) {
        console.error("[easel] chart render failed", error)
        return fallback()
      }
    }

    disposers.push(
      context.markdown.registerCodeBlockRenderer("easel", (block, render) => renderChartBlock(block, () => render.defaultRender())),
    )
    disposers.push(
      context.markdown.registerCodeBlockRenderer("easel-chart", (block, render) => renderChartBlock(block, () => render.defaultRender())),
    )

    function EaselPanel(props: { panel: PanelInput }) {
      const [entries, setEntries] = createSignal<ChartEntry[]>([])
      const [index, setIndex] = createSignal(0)
      const [formsById, setFormsById] = createSignal<Record<string, ChartForm>>({})
      const [auto, setAuto] = createSignal(true)
      const [loading, setLoading] = createSignal(true)
      const [termHeight, setTermHeight] = createSignal(context.renderer.height ?? 45)
      // The Solid reconciler coerces a `content={...}` prop to a string, which
      // turns StyledText into "[object Object]". Assign the value through the
      // native setter instead so the styled chunks survive.
      const [chartNode, setChartNode] = createSignal<TextRenderable | undefined>()

      const fullscreen = () => props.panel.presentation === "fullscreen"
      const panelHeight = () => Math.max(12, termHeight())

      const formFor = (entry: ChartEntry): ChartForm => formsById()[entry.id] ?? (entry.form as ChartForm) ?? "line"

      const applyEntries = (charts: ChartEntry[]) => {
        setEntries(charts)
        if (charts.length > 0) {
          const current = Math.min(index(), charts.length - 1)
          setIndex(current)
        } else {
          setIndex(0)
          setChartNode(undefined)
        }
        setCharts(props.panel.sessionID, charts)
      }

      const refresh = async () => {
        setLoading(true)
        try {
          let charts: ChartEntry[] = []
          try {
            const response = (await rpc().chartsList({ sessionID: props.panel.sessionID }, rpcOptions())) as {
              charts: ChartEntry[]
              deletedKeys?: string[]
            }
            charts = response.charts ?? []
            if (response.deletedKeys?.length) {
              const sessionID = props.panel.sessionID
              updateChartStore((draft) => {
                draft.deletedBySession ??= {}
                const tombstones = new Set(draft.deletedBySession[sessionID] ?? [])
                for (const key of response.deletedKeys ?? []) tombstones.add(key)
                draft.deletedBySession[sessionID] = [...tombstones]
              })
            }
          } catch {
            // Fall back to the local cache below.
          }
          try {
            const config = (await rpc().configGet({}, rpcOptions())) as { autoCharts: boolean }
            setAuto(Boolean(config.autoCharts))
          } catch {
            // Keep the previous toggle state.
          }
          const discovered = await extractChartsFromMessages(props.panel.sessionID)
          const keep = (entry: ChartEntry) => !isDeletedFor(props.panel.sessionID, entry)
          let merged = mergeChartEntries(
            charts,
            chartStore.bySession[props.panel.sessionID] ?? [],
            discovered,
          ).filter(keep)
          if (merged.length === 0) {
            // Last resort: a chart rendered in the transcript was captured in
            // the recent bucket before the panel knew its session.
            merged = mergeChartEntries(chartStore.bySession[RECENT_SESSION] ?? []).filter(keep)
          }
          applyEntries(merged)
        } catch {
          // Leave the previous list in place.
        } finally {
          setLoading(false)
        }
      }

      onMount(() => {
        void refresh()
        let stop: (() => void) | undefined
        try {
          const events = rpc().events
          const stopUpdate = events.on("updated", (event) => {
            if ((event.data as { sessionID?: string }).sessionID === props.panel.sessionID) void refresh()
          })
          const stopConfig = events.on("config", (event) => {
            setAuto(Boolean((event.data as { autoCharts?: boolean }).autoCharts))
          })
          stop = () => {
            stopUpdate()
            stopConfig()
          }
        } catch {
          stop = undefined
        }
        onCleanup(() => stop?.())
        const onResize = (_width: number, height: number) => setTermHeight(height)
        context.renderer.on?.("resize", onResize)
        onCleanup(() => context.renderer.off?.("resize", onResize))
      })

      const current = createMemo(() => {
        const list = entries()
        if (list.length === 0) return undefined
        return list[Math.max(0, Math.min(index(), list.length - 1))]
      })

      const currentForm = createMemo<ChartForm>(() => {
        const entry = current()
        return entry ? formFor(entry) : "line"
      })

      const chartWidth = createMemo(() =>
        panelChartWidth({ panelWidth: props.panel.width, fullscreen: fullscreen() }, entries().length),
      )

      const items = createMemo<PanelChartItem[]>(() => {
        const list = entries()
        return list.map((entry, position) => {
          const form = formFor(entry)
          let rendered: RenderedChart
          try {
            rendered = renderPayload(entry.payload, { width: chartWidth(), form })
          } catch {
            rendered = { form, title: entry.title, lines: [], plain: "", notes: [] }
          }
          return {
            id: entry.id,
            index: position,
            total: list.length,
            title: entry.title,
            form,
            rendered,
          }
        })
      })

      const pages = createMemo(() =>
        composePanelPages(items(), {
          panelWidth: props.panel.width,
          panelHeight: panelHeight(),
          fullscreen: fullscreen(),
          selectedIndex: index(),
        }),
      )

      const activePageIndex = createMemo(() => activePanelPage(pages(), index()))

      const activePage = createMemo(() => pages()[activePageIndex()])

      const styled = createMemo(() => {
        const page = activePage()
        return page ? linesToStyled(page.lines, false) : undefined
      })

      createEffect(() => {
        const node = chartNode()
        const content = styled()
        if (node && content) {
          node.content = content
        }
      })

      const cycleForm = () => {
        const entry = current()
        if (!entry) return
        const position = CHART_FORMS.indexOf(formFor(entry))
        const nextForm = CHART_FORMS[(position + 1) % CHART_FORMS.length]
        setFormsById((forms) => ({ ...forms, [entry.id]: nextForm }))
      }

      const nextPage = () => {
        const list = entries()
        if (list.length === 0) return
        const allPages = pages()
        if (allPages.length > 1) {
          const target = allPages[(activePageIndex() + 1) % allPages.length]
          if (target.indices.length > 0) setIndex(target.indices[0])
        } else if (list.length > 1) {
          setIndex((index() + 1) % list.length)
        }
      }

      const previousPage = () => {
        const list = entries()
        if (list.length === 0) return
        const allPages = pages()
        if (allPages.length > 1) {
          const target = allPages[(activePageIndex() - 1 + allPages.length) % allPages.length]
          if (target.indices.length > 0) setIndex(target.indices[0])
        } else if (list.length > 1) {
          setIndex((index() - 1 + list.length) % list.length)
        }
      }

      const selectNext = () => {
        const list = entries()
        if (list.length === 0) return
        setIndex((index() + 1) % list.length)
      }

      const selectPrevious = () => {
        const list = entries()
        if (list.length === 0) return
        setIndex((index() - 1 + list.length) % list.length)
      }

      const toggleAuto = async () => {
        try {
          const result = (await rpc().autoToggle({}, rpcOptions())) as { autoCharts: boolean }
          setAuto(result.autoCharts)
          context.ui.toast.show({
            message: `easel: automatic MCP charts ${result.autoCharts ? "on" : "off"}`,
            variant: "info",
          })
        } catch {
          context.ui.toast.show({ message: "easel: could not toggle automatic charts", variant: "error" })
        }
      }

      const deleteCurrent = () => {
        const target = current()
        if (!target) return
        const sessionID = props.panel.sessionID
        const key = chartCanonicalKey(target.payload)
        const idKey = `id:${target.id}`
        const isTarget = (entry: ChartEntry) => entry.id === target.id || chartCanonicalKey(entry.payload) === key

        // Hide the chart immediately, then persist the tombstone through RPC.
        updateChartStore((draft) => {
          draft.deletedBySession ??= {}
          const tombstones = new Set(draft.deletedBySession[sessionID] ?? [])
          tombstones.add(key)
          tombstones.add(idKey)
          draft.deletedBySession[sessionID] = [...tombstones]
          for (const session of [sessionID, RECENT_SESSION]) {
            const charts = draft.bySession[session]
            if (charts) draft.bySession[session] = charts.filter((entry) => !isTarget(entry))
          }
        })

        const remaining = entries().filter((entry) => !isTarget(entry))
        setEntries(remaining)
        setFormsById((forms) => {
          const next = { ...forms }
          delete next[target.id]
          return next
        })
        if (remaining.length > 0) {
          setIndex(Math.min(index(), remaining.length - 1))
        } else {
          setIndex(0)
          setChartNode(undefined)
        }

        void rpc()
          .chartDelete({ sessionID, chartID: target.id, key }, rpcOptions())
          .catch(() => {
            // The local tombstone still hides it; the next sync retries.
          })
        context.ui.toast.show({ message: `easel: deleted "${target.title}"`, variant: "info" })
      }

      context.keymap.layer(() => ({
        mode: "global",
        priority: 40,
        enabled: () => props.panel.focused,
        commands: [
          { id: "easel.panel.form", title: "Cycle chart form", bind: "m", run: cycleForm },
          { id: "easel.panel.next", title: "Next page", bind: "]", run: nextPage },
          { id: "easel.panel.previous", title: "Previous page", bind: "[", run: previousPage },
          { id: "easel.panel.selectNext", title: "Select next chart", bind: "down,j", run: selectNext },
          { id: "easel.panel.selectPrevious", title: "Select previous chart", bind: "up,k", run: selectPrevious },
          { id: "easel.panel.fullscreen", title: "Toggle fullscreen", bind: "f", run: () => props.panel.toggleFullscreen() },
          { id: "easel.panel.auto", title: "Toggle automatic charts", bind: "a", run: () => void toggleAuto() },
          { id: "easel.panel.delete", title: "Delete current chart", bind: "delete", run: () => void deleteCurrent() },
          { id: "easel.panel.close", title: "Close easel", bind: "escape", run: () => props.panel.close() },
        ],
        bindings: [
          "easel.panel.form",
          "easel.panel.next",
          "easel.panel.previous",
          "easel.panel.selectNext",
          "easel.panel.selectPrevious",
          "easel.panel.fullscreen",
          "easel.panel.auto",
          "easel.panel.delete",
          "easel.panel.close",
        ],
      }))

      return (
        <box flexDirection="column" width="100%" paddingLeft={1} paddingRight={1}>
          <text fg={REST_COLOR} attributes={TextAttributes.BOLD}>
            {"▁▃▅▇ easel"}
          </text>
          <Show
            when={entries().length > 0}
            fallback={
              <text fg={REST_COLOR}>
                {loading() ? "loading charts…" : "No charts yet. Ask for a chart, or the next MCP metric response will appear here."}
              </text>
            }
          >
            <text fg={REST_COLOR} attributes={TextAttributes.DIM}>
              {(() => {
                const page = activePage()
                const first = page?.indices[0] ?? 0
                const last = page ? page.indices[page.indices.length - 1] : 0
                return `page ${activePageIndex() + 1}/${pages().length} (charts ${first + 1}–${last + 1} of ${entries().length})  ·  selected #${index() + 1} (${currentForm()})  ·  auto ${auto() ? "on" : "off"}`
              })()}
            </text>
            <box marginTop={1} marginBottom={1}>
              <text
                ref={(node: TextRenderable) => {
                  setChartNode(node)
                  const content = styled()
                  if (content) node.content = content
                }}
                wrapMode="none"
              />
            </box>
            <text fg={REST_COLOR} attributes={TextAttributes.DIM}>
              {"[ ] page   ↑↓/jk select   m form   f fullscreen   a auto   del delete   esc close"}
            </text>
          </Show>
        </box>
      )
    }

    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === panelKey}>
            <EaselPanel panel={panel} />
          </Show>
        ),
      }),
    )

    disposers.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (footer) => {
          if (footer.sessionID && chartsFor(footer.sessionID) === undefined) void syncCharts(footer.sessionID)
          const count = chartsFor(footer.sessionID)?.length ?? 0
          return (
            <Show when={count > 0}>
              <text fg="#58b970">{`▁▃▅▇ easel (${count})`}</text>
            </Show>
          )
        },
      }),
    )

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "easel.open",
          title: "Easel: open chart panel",
          description: "Inspect charts generated in this session",
          group: "Easel",
          palette: true,
          slash: { name: "easel", aliases: ["charts"] },
          run: () => {
            const opened = context.ui.panel.open(panelKey)
            if (!opened) {
              context.ui.toast.show({ message: "easel: open a session first", variant: "warning" })
            }
          },
        },
        {
          id: "easel.cycle",
          title: "Easel: cycle chart form",
          description: "Cycle line, columns, bars, sparks, share and pie",
          group: "Easel",
          palette: true,
          run: () => context.keymap.dispatch("easel.panel.form"),
        },
        {
          id: "easel.delete",
          title: "Easel: delete current chart",
          description: "Remove the current chart from this session",
          group: "Easel",
          palette: true,
          run: () => context.keymap.dispatch("easel.panel.delete"),
        },
        {
          id: "easel.toggleAuto",
          title: "Easel: toggle automatic charting",
          description: "Turn automatic Prometheus, Datadog and Grafana charts on or off",
          group: "Easel",
          palette: true,
          run: async () => {
            try {
              const result = (await rpc().autoToggle({}, rpcOptions())) as { autoCharts: boolean }
              context.ui.toast.show({
                message: `easel: automatic MCP charts ${result.autoCharts ? "on" : "off"}`,
                variant: "info",
              })
            } catch {
              context.ui.toast.show({ message: "easel: could not toggle automatic charts", variant: "error" })
            }
          },
        },
      ],
    }))

    let stopUpdated: (() => void) | undefined
    let stopConfig: (() => void) | undefined
    try {
      stopUpdated = rpc().events.on("updated", (event) => {
        void syncCharts((event.data as { sessionID?: string }).sessionID)
      })
      stopConfig = rpc().events.on("config", () => {
        // Panels refresh their own config state when they mount.
      })
    } catch {
      // Events become available once the server connection settles.
    }
    if (stopUpdated) disposers.push(stopUpdated)
    if (stopConfig) disposers.push(stopConfig)

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Disposal is best-effort during plugin reload.
        }
      }
    }
  },
})
