import type { ChartModel, ChartRequest, EaselPayload, ParsedTable } from "./types.ts"
import { buildModel, formatNumber, makeAxis } from "./charting.ts"

export interface SvgOptions {
  width?: number
  height?: number
  background?: string
  foreground?: string
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function niceWidth(model: ChartModel): number {
  return Math.max(520, Math.min(1400, (model.width || 78) * 10))
}

export function renderSvg(table: ParsedTable, request: ChartRequest = {}, options: SvgOptions = {}): string {
  const model = buildModel(table, request)
  return renderModelSvg(model, options)
}

export function renderPayloadSvg(payload: EaselPayload, options: SvgOptions = {}): string {
  const meta = payload.meta ?? {}
  const request: ChartRequest = {
    ...payload.request,
    title: payload.request.title ?? meta.title,
    unit: payload.request.unit ?? meta.unit,
    form: payload.request.form ?? meta.form,
    combine: payload.request.combine ?? meta.combine,
    scale: payload.request.scale ?? meta.scale,
    x: payload.request.x ?? meta.x,
    y: payload.request.y ?? meta.y,
    series: payload.request.series ?? meta.series,
  }
  return renderModelSvg(buildModel(payload.table, request), options)
}

export function renderModelSvg(model: ChartModel, options: SvgOptions = {}): string {
  const width = options.width ?? niceWidth(model)
  const height = options.height ?? (model.form === "line" ? 520 : 460)
  const background = options.background ?? "#111318"
  const foreground = options.foreground ?? "#d7dce5"
  const pad = { left: 74, right: 34, top: 58, bottom: 64 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom

  const title = escapeXml(`${model.title}${model.unit ? ` · ${model.unit}` : ""}`)
  const body: string[] = [
    `<rect width="100%" height="100%" fill="${background}"/>`,
    `<text x="${pad.left}" y="30" fill="${foreground}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="16" font-weight="700">${title}</text>`,
  ]

  if (model.form === "pie") {
    body.push(...pieSvg(model, pad.left, pad.top, innerWidth, innerHeight))
  } else if (model.form === "share") {
    body.push(...shareSvg(model, pad.left, pad.top, innerWidth))
  } else if (model.form === "bars" || model.form === "sparks") {
    body.push(...barsSvg(model, pad.left, pad.top, innerWidth, innerHeight))
  } else if (model.form === "columns") {
    body.push(...columnsSvg(model, pad.left, pad.top, innerWidth, innerHeight))
  } else {
    body.push(...lineSvg(model, pad.left, pad.top, innerWidth, innerHeight))
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(model.title)}">${body.join("")}</svg>`
}

function lineSvg(model: ChartModel, x: number, y: number, width: number, height: number): string[] {
  const out: string[] = []
  const group = model.series.slice(0, 8)
  const max = Math.max(...group.map((entry) => entry.stats.max), 1)
  const axis = makeAxis(max, 4, model.scale === "log")
  const ratioFor = (value: number) =>
    axis.log
      ? Math.min(1, Math.max(0, Math.log10(Math.max(1, value)) / Math.log10(Math.max(1, axis.max))))
      : Math.min(1, Math.max(0, value / axis.max))
  for (const tick of axis.ticks) {
    const ratio = ratioFor(tick)
    const py = y + height - ratio * height
    out.push(`<line x1="${x}" y1="${py}" x2="${x + width}" y2="${py}" stroke="#2b303b" stroke-width="1"/>`)
    out.push(
      `<text x="${x - 10}" y="${py + 4}" text-anchor="end" fill="#8c94a3" font-family="ui-monospace, monospace" font-size="11">${escapeXml(formatNumber(tick))}</text>`,
    )
  }
  for (const entry of group) {
    const points: string[] = []
    entry.values.forEach((value, index) => {
      if (value === null || value === undefined) return
      const ratio = ratioFor(value)
      const px = x + (model.xValues.length <= 1 ? 0 : (index / (model.xValues.length - 1)) * width)
      const py = y + height - ratio * height
      points.push(`${px.toFixed(2)},${py.toFixed(2)}`)
    })
    out.push(
      `<polyline fill="none" stroke="${entry.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${points.join(" ")}"/>`,
    )
    const last = entry.values.findLast((value) => value !== null && value !== undefined)
    out.push(
      `<text x="${x + width + 6}" y="${y + 4 + group.indexOf(entry) * 16}" fill="${entry.color}" font-family="ui-monospace, monospace" font-size="12" font-weight="700">${entry.letter}</text>`,
    )
    if (last !== undefined && last !== null) {
      out.push(`<title>${escapeXml(`${entry.label}: max ${formatNumber(entry.stats.max)}`)}</title>`)
    }
  }
  const tickCount = Math.min(model.xValues.length, 7)
  for (let step = 0; step < tickCount; step++) {
    const index = Math.round((step / Math.max(1, tickCount - 1)) * (model.xValues.length - 1))
    const px = x + (model.xValues.length <= 1 ? 0 : (index / (model.xValues.length - 1)) * width)
    out.push(
      `<text x="${px}" y="${y + height + 22}" text-anchor="middle" fill="#8c94a3" font-family="ui-monospace, monospace" font-size="11">${escapeXml(model.xValues[index]?.label ?? "")}</text>`,
    )
  }
  return out
}

function columnsSvg(model: ChartModel, x: number, y: number, width: number, height: number): string[] {
  const out: string[] = []
  const stacked = model.combine === "sum"
  const totals = model.xValues.map((_, index) => model.series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0))
  // Stacked columns share one vertical scale (the column totals); grouped
  // columns compare series, so the tallest single series sets the scale.
  const maxValue = stacked
    ? Math.max(...totals, 1)
    : Math.max(...model.series.map((entry) => entry.stats.max), 1)
  const axis = makeAxis(maxValue, 4)
  for (const tick of axis.ticks) {
    const py = y + height - (tick / axis.max) * height
    out.push(`<line x1="${x}" y1="${py}" x2="${x + width}" y2="${py}" stroke="#2b303b"/>`)
    out.push(
      `<text x="${x - 10}" y="${py + 4}" text-anchor="end" fill="#8c94a3" font-family="ui-monospace, monospace" font-size="11">${formatNumber(tick)}</text>`,
    )
  }
  const slot = width / Math.max(1, model.xValues.length)
  const barWidth = Math.max(2, slot * 0.7)
  const seriesCount = Math.max(1, model.series.length)
  const subWidth = stacked ? barWidth : barWidth / seriesCount
  model.xValues.forEach((_, index) => {
    const slotX = x + index * slot + (slot - barWidth) / 2
    if (stacked) {
      let bottom = y + height
      for (const entry of model.series) {
        const value = Math.max(0, entry.values[index] ?? 0)
        const barHeight = (value / axis.max) * height
        bottom -= barHeight
        out.push(
          `<rect x="${slotX.toFixed(2)}" y="${bottom.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${entry.color}"/>`,
        )
      }
      return
    }
    model.series.forEach((entry, seriesIndex) => {
      const value = Math.max(0, entry.values[index] ?? 0)
      const barHeight = (value / axis.max) * height
      out.push(
        `<rect x="${(slotX + seriesIndex * subWidth).toFixed(2)}" y="${(y + height - barHeight).toFixed(2)}" width="${subWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${entry.color}"/>`,
      )
    })
  })

  const tickCount = Math.min(model.xValues.length, 7)
  for (let step = 0; step < tickCount; step++) {
    const index = Math.round((step / Math.max(1, tickCount - 1)) * (model.xValues.length - 1))
    const px = x + index * slot + slot / 2
    out.push(
      `<text x="${px.toFixed(2)}" y="${y + height + 22}" text-anchor="middle" fill="#8c94a3" font-family="ui-monospace, monospace" font-size="11">${escapeXml(model.xValues[index]?.label ?? "")}</text>`,
    )
  }
  return out
}

function barsSvg(model: ChartModel, x: number, y: number, width: number, height: number): string[] {
  const out: string[] = []
  const parts = model.parts.slice(0, model.form === "sparks" ? 40 : 40)
  const max = Math.max(...parts.map((part) => part.value), 1)
  const rowHeight = Math.min(32, height / Math.max(1, parts.length))
  const labelWidth = 150
  parts.forEach((part, index) => {
    const py = y + index * rowHeight
    const bar = (part.value / max) * Math.max(20, width - labelWidth - 120)
    out.push(
      `<text x="${x}" y="${py + rowHeight * 0.65}" fill="${part.color}" font-family="ui-monospace, monospace" font-size="12">${escapeXml(`${part.letter} ${part.label}`)}</text>`,
    )
    out.push(
      `<rect x="${x + labelWidth}" y="${py + rowHeight * 0.22}" width="${bar.toFixed(2)}" height="${Math.max(4, rowHeight * 0.55).toFixed(2)}" rx="2" fill="${part.color}"/>`,
    )
    out.push(
      `<text x="${x + labelWidth + bar + 8}" y="${py + rowHeight * 0.65}" fill="#d7dce5" font-family="ui-monospace, monospace" font-size="11">${formatNumber(part.value)}</text>`,
    )
  })
  return out
}

function pieSvg(model: ChartModel, x: number, y: number, width: number, height: number): string[] {
  const out: string[] = []
  const total = model.parts.reduce((sum, part) => sum + part.value, 0) || 1
  const parts = model.parts.slice(0, 8)
  const r = Math.min(height * 0.42, width * 0.25)
  const cx = x + r + 10
  const cy = y + height / 2
  const nonZero = parts.filter((part) => part.value > 0)

  if (nonZero.length === 1 && nonZero[0].value >= total * 0.999999) {
    out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${nonZero[0].color}"/>`)
  } else {
    let angle = -Math.PI / 2
    for (const part of parts) {
      if (!(part.value > 0)) continue
      const sweep = (part.value / total) * Math.PI * 2
      const end = angle + sweep
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const x2 = cx + r * Math.cos(end)
      const y2 = cy + r * Math.sin(end)
      const largeArc = sweep > Math.PI ? 1 : 0
      out.push(
        `<path d="M ${cx.toFixed(2)} ${cy.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${part.color}" stroke="#111318" stroke-width="1.5"/>`,
      )
      angle = end
    }
  }

  const lx = cx + r + 36
  parts.forEach((part, index) => {
    const percent = ((part.value / total) * 100).toFixed(1)
    const py = y + 24 + index * 22
    out.push(
      `<text x="${lx.toFixed(2)}" y="${py.toFixed(2)}" fill="${part.color}" font-family="ui-monospace, monospace" font-size="12">${escapeXml(`${part.letter} ${part.label}`)}</text>`,
    )
    out.push(
      `<text x="${(lx + 240).toFixed(2)}" y="${py.toFixed(2)}" fill="#d7dce5" font-family="ui-monospace, monospace" font-size="12">${formatNumber(part.value)}  ${percent}%</text>`,
    )
  })
  return out
}

function shareSvg(model: ChartModel, x: number, y: number, width: number): string[] {
  const out: string[] = []
  const total = model.parts.reduce((sum, part) => sum + part.value, 0) || 1
  let cursor = x
  model.parts.slice(0, 8).forEach((part) => {
    const segment = (part.value / total) * width
    out.push(`<rect x="${cursor.toFixed(2)}" y="${y}" width="${segment.toFixed(2)}" height="34" fill="${part.color}"/>`)
    cursor += segment
  })
  model.parts.slice(0, 8).forEach((part, index) => {
    const percent = ((part.value / total) * 100).toFixed(1)
    out.push(
      `<text x="${x}" y="${y + 62 + index * 20}" fill="${part.color}" font-family="ui-monospace, monospace" font-size="12">${escapeXml(`${part.letter} ${part.label}`)}</text>`,
    )
    out.push(
      `<text x="${x + 220}" y="${y + 62 + index * 20}" fill="#d7dce5" font-family="ui-monospace, monospace" font-size="12">${formatNumber(part.value)}  ${percent}%</text>`,
    )
  })
  return out
}
