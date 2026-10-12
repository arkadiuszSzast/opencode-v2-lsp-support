import { relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Diagnostic } from "./client.ts"
import { isRecord } from "./config.ts"

const MAX_ERRORS_PER_FILE = 20
const MAX_WORKSPACE_SYMBOLS = 20

const SEVERITY: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }

// LSP SymbolKind, 1-based.
const SYMBOL_KINDS = [
  "", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
  "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object",
  "key", "null", "enum member", "struct", "event", "operator", "type parameter",
]

export function errorsOnly(diagnostics: Diagnostic[]): Diagnostic[] {
  // LSP leaves a missing severity to the client; treat it as an error.
  return diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) === 1)
}

/** OpenCode 1's diagnostics block, errors only. Empty when there are none. */
export function diagnosticsReport(file: string, diagnostics: Diagnostic[]): string {
  const errors = errorsOnly(diagnostics)
  if (errors.length === 0) return ""
  const lines = errors.slice(0, MAX_ERRORS_PER_FILE).map((diagnostic) => {
    const severity = SEVERITY[diagnostic.severity ?? 1] ?? "ERROR"
    const { line, character } = start(diagnostic.range)
    return `${severity} [${line}:${character}] ${diagnostic.message}`
  })
  const more = errors.length - MAX_ERRORS_PER_FILE
  if (more > 0) lines.push(`... and ${more} more`)
  return `<diagnostics file="${file}">\n${lines.join("\n")}\n</diagnostics>`
}

export function displayPath(uriOrPath: string, root: string): string {
  let file = uriOrPath
  if (uriOrPath.startsWith("file:")) {
    try {
      file = fileURLToPath(uriOrPath)
    } catch {
      return uriOrPath
    }
  }
  const rel = relative(root, file)
  return rel && !rel.startsWith("..") ? rel : file
}

export function formatHover(results: unknown[]): string {
  const sections = results.flatMap((result) => {
    const contents = isRecord(result) ? result.contents : undefined
    if (contents === undefined || contents === null) return []
    const text = (Array.isArray(contents) ? contents.map(markup) : [markup(contents)]).filter(Boolean).join("\n\n")
    return text ? [text] : []
  })
  return sections.map((section) => section.trim()).join("\n\n---\n\n")
}

function markup(value: unknown): string {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.value === "string") {
    return typeof value.language === "string" ? `\`\`\`${value.language}\n${value.value}\n\`\`\`` : value.value
  }
  return ""
}

/** Location, LocationLink, and SymbolInformation results as `path:line:character`. */
export function formatLocations(results: unknown[], root: string): string[] {
  const lines: string[] = []
  for (const item of results) {
    if (!isRecord(item)) continue
    if (typeof item.targetUri === "string") lines.push(location(item.targetUri, item.targetSelectionRange ?? item.targetRange, root))
    else if (typeof item.uri === "string") lines.push(location(item.uri, item.range, root))
  }
  return [...new Set(lines)]
}

export function formatDocumentSymbols(results: unknown[], root: string): string[] {
  const lines: string[] = []
  const walk = (items: unknown[], depth: number) => {
    for (const item of items) {
      if (!isRecord(item) || typeof item.name !== "string") continue
      const indent = "  ".repeat(depth)
      const detail = typeof item.detail === "string" && item.detail ? ` ${item.detail}` : ""
      if (isRecord(item.location)) {
        // SymbolInformation: flat, with a container name instead of children.
        const container = typeof item.containerName === "string" && item.containerName ? ` in ${item.containerName}` : ""
        lines.push(`${indent}${item.name} (${kind(item.kind)})${container} ${location(String(item.location.uri), item.location.range, root)}`)
        continue
      }
      const { line, character } = start(item.selectionRange ?? item.range)
      lines.push(`${indent}${item.name}${detail} (${kind(item.kind)}) ${line}:${character}`)
      if (Array.isArray(item.children)) walk(item.children, depth + 1)
    }
  }
  walk(results, 0)
  return lines
}

export function formatWorkspaceSymbols(results: unknown[], root: string): string[] {
  const lines = results.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.location)) return []
    const container = typeof item.containerName === "string" && item.containerName ? ` in ${item.containerName}` : ""
    const where = typeof item.location.uri === "string" ? location(item.location.uri, item.location.range, root) : ""
    return [`${item.name} (${kind(item.kind)})${container} ${where}`.trimEnd()]
  })
  // Servers such as gopls return a hundred matches from the standard library for a short query.
  if (lines.length <= MAX_WORKSPACE_SYMBOLS) return lines
  return [...lines.slice(0, MAX_WORKSPACE_SYMBOLS), `... and ${lines.length - MAX_WORKSPACE_SYMBOLS} more; use a more specific query`]
}

export function formatCallItem(item: unknown, root: string): string | undefined {
  if (!isRecord(item) || typeof item.name !== "string" || typeof item.uri !== "string") return undefined
  const detail = typeof item.detail === "string" && item.detail ? ` ${item.detail}` : ""
  return `${item.name}${detail} (${kind(item.kind)}) ${location(item.uri, item.selectionRange ?? item.range, root)}`
}

/** An incoming or outgoing call: the other function, then where the calls happen. */
export function formatCall(call: unknown, incoming: boolean, file: string, root: string): string | undefined {
  if (!isRecord(call)) return undefined
  const item = incoming ? call.from : call.to
  const line = formatCallItem(item, root)
  if (!line || !isRecord(item) || !Array.isArray(call.fromRanges) || call.fromRanges.length === 0) return line
  // The ranges are in the calling function's file: the other item for incoming calls, `file` (the prepared item's) for outgoing ones.
  const caller = incoming ? String(item.uri) : file
  return `${line} called at ${call.fromRanges.map((range) => location(caller, range, root)).join(", ")}`
}

/** Reads a result's file lines, or undefined when the source should not be shown. */
export type SourceReader = (uri: string) => Promise<readonly string[] | undefined>

export interface SourceOptions {
  readonly read: SourceReader
  /** Lines shown above and below a result when there are at most `contextUpTo` results. */
  readonly context: number
  readonly contextUpTo: number
}

/**
 * Adds the code at each result to `path:line:character` lines, as grep shows a
 * match: `path:line:character: code`. When there are few results, each also gets
 * the lines around it (`>` marks the result's line), so the agent can act
 * without opening the file. Lines that are not locations are kept as they are.
 */
export async function withSource(lines: string[], root: string, options: SourceOptions): Promise<string[]> {
  const pattern = /(\S+):(\d+):(\d+)$/
  const located = lines.filter((line) => pattern.test(line))
  const wide = options.context > 0 && located.length <= options.contextUpTo
  const out: string[] = []
  for (const line of lines) {
    const match = pattern.exec(line)
    const source = match ? await options.read(resolveUri(match[1], root)) : undefined
    const row = match ? Number(match[2]) : 0
    // A file ending in a newline splits into a trailing empty line that is not part of the file.
    const length = source ? (source.at(-1) === "" ? source.length - 1 : source.length) : 0
    // A server answering for an older version of the file can point past its end.
    if (!match || !source || row < 1 || row > length) {
      out.push(line)
      continue
    }
    out.push(`${line}: ${(source[row - 1] ?? "").trim()}`)
    if (!wide) continue
    const first = Math.max(1, row - options.context)
    const last = Math.min(length, row + options.context)
    const width = String(last).length
    for (let n = first; n <= last; n++) out.push(`  ${n === row ? ">" : " "} ${String(n).padStart(width)}| ${source[n - 1]}`.trimEnd())
  }
  return out
}

function resolveUri(path: string, root: string): string {
  return path.startsWith("/") ? path : `${root}/${path}`
}

function location(uri: string, range: unknown, root: string): string {
  const { line, character } = start(range)
  return `${displayPath(uri, root)}:${line}:${character}`
}

/** A range's start, 1-based. */
function start(range: unknown): { line: number; character: number } {
  const position = isRecord(range) && isRecord(range.start) ? range.start : {}
  const line = typeof position.line === "number" ? position.line : 0
  const character = typeof position.character === "number" ? position.character : 0
  return { line: line + 1, character: character + 1 }
}

function kind(value: unknown): string {
  return (typeof value === "number" && SYMBOL_KINDS[value]) || "symbol"
}
