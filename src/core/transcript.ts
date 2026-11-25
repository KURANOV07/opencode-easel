import { decodePayload } from "./charting.ts"
import { chartCanonicalKey, isIgnoredPayload } from "./chart-store.ts"
import type { EaselPayload } from "./types.ts"

const FENCE = /```easel(?:-chart)?[ \t]*\r?\n([\s\S]*?)```/g

/** Extract the raw JSON bodies of every ```easel / ```easel-chart block in a string. */
export function easelBlocksInText(text: string): string[] {
  if (!text || !text.includes("```easel")) return []
  const blocks: string[] = []
  FENCE.lastIndex = 0
  for (const match of text.matchAll(FENCE)) {
    if (match[1]?.trim()) blocks.push(match[1])
  }
  return blocks
}

/** Decode every valid easel payload found in a string. */
export function easelPayloadsInText(text: string): EaselPayload[] {
  const payloads: EaselPayload[] = []
  for (const block of easelBlocksInText(text)) {
    const payload = decodePayload(block)
    if (payload) payloads.push(payload)
  }
  return payloads
}

export interface ExtractOptions {
  maxDepth?: number
  maxTextLength?: number
}

/**
 * Recursively walk session messages (text parts, tool inputs/outputs, content
 * arrays, metadata) and return every unique easel payload found. This is what
 * makes `/easel` show charts that were only ever pasted into the transcript.
 */
export function extractEaselPayloads(root: unknown, options: ExtractOptions = {}): EaselPayload[] {
  const maxDepth = options.maxDepth ?? 12
  const maxTextLength = options.maxTextLength ?? 4_000_000
  const found: EaselPayload[] = []
  const seen = new Set<string>()

  const visit = (node: unknown, depth: number) => {
    if (node === null || node === undefined || depth > maxDepth) return
    if (typeof node === "string") {
      if (node.length > maxTextLength || !node.includes("```easel")) return
      for (const payload of easelPayloadsInText(node)) {
        if (isIgnoredPayload(payload)) continue
        const key = chartCanonicalKey(payload)
        if (seen.has(key)) continue
        seen.add(key)
        found.push(payload)
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) visit(value, depth + 1)
    }
  }

  visit(root, 0)
  return found
}
