import { access, mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { abortable } from "./cancellation.ts"
import { BUILTIN_ROOTS, languageIdForExtension } from "./catalog.ts"
import { LspClient, LspError, errorMessage, type Diagnostic } from "./client.ts"
import type { ServerConfig, Settings } from "./config.ts"

// After the first fresh push, a server that stays quiet this long is done publishing for now.
const SETTLE_MS = 300
// Servers answer pull requests quickly or not at all.
const PULL_TIMEOUT_MS = 3_000
const PULL_ATTEMPTS = 3
// Cold servers often answer navigation requests with nothing until their first analysis finishes.
const WARMUP_TIMEOUT_MS = 6_000
// Codes for "still loading" and "cancelled because the document changed".
const TRANSIENT_CODES = new Set([-32800, -32801, -32802])

interface Target {
  /** One client per server and root, as OpenCode 1 ran them. */
  readonly key: string
  readonly server: ServerConfig
  readonly root: string
}

interface Entry {
  client?: LspClient
  starting?: Promise<LspClient>
  broken?: string
  warmed?: boolean
  lastUsed: number
  readonly opened: Set<string>
}

interface Synced {
  readonly client: LspClient
  readonly version: number
  /** When this version reached the client; earlier reports describe older contents. */
  readonly sentAt: number
}

interface Published {
  readonly diagnostics: Diagnostic[]
  readonly at: number
  readonly version?: number
}

export interface FileDiagnostics {
  /** Diagnostics for the requested file, merged across its servers. Undefined when no server reported. */
  readonly file?: Diagnostic[]
  /** Other files whose diagnostics a server published while this file was checked. */
  readonly others: Map<string, Diagnostic[]>
  /** Servers for the file that are still starting or indexing, so their report is missing or may be incomplete. */
  readonly pending: string[]
}

/** A file's extension, or `.name` for an extensionless file such as `Dockerfile`. */
export function extensionKey(file: string): string {
  return extname(file).toLowerCase() || `.${basename(file).toLowerCase()}`
}

/** Whether the file, after resolving symlinks, is inside the project. */
export async function insideProject(root: string, file: string): Promise<boolean> {
  if (!within(root, file)) return false
  const real = await realpath(file).catch(() => undefined)
  return real !== undefined && within(await realpath(root).catch(() => root), real)
}

/**
 * Reads a project file, checking the file that was opened rather than the path,
 * so a symlink swapped between the check and the read cannot send outside contents.
 */
export async function readInside(root: string, file: string): Promise<string> {
  const outside = new Error(`${file} is outside the project directory ${root}.`)
  if (!within(root, file)) throw outside
  const handle = await open(file, "r")
  try {
    const opened = await handle.stat()
    const real = await realpath(file)
    const current = await stat(real)
    if (!within(await realpath(root).catch(() => root), real)) throw outside
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw outside
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

export function within(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The directory a server runs in for this file, or undefined when the server does not apply to it. */
export async function serverRoot(id: string, file: string, project: string): Promise<string | undefined> {
  const rule = BUILTIN_ROOTS[id]
  if (!rule) return project
  if (rule.exclude && (await nearest(file, project, rule.exclude))) return undefined
  const found = await nearest(file, project, rule.markers)
  if (!found) return rule.required ? undefined : project
  return id === "rust" ? cargoWorkspace(found, project) : found
}

/** The nearest directory from the file's up to `stop` holding one of `markers`. */
async function nearest(file: string, stop: string, markers: string[]): Promise<string | undefined> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    for (const marker of markers) {
      if (await access(join(dir, marker)).then(() => true, () => false)) return dir
    }
    if (dir === stop || dir === dirname(dir)) return undefined
  }
}

/** The nearest directory from the crate up to the project whose Cargo.toml declares a workspace, else the crate. */
async function cargoWorkspace(crate: string, project: string): Promise<string> {
  for (let dir = crate; ; dir = dirname(dir)) {
    const manifest = await readFile(join(dir, "Cargo.toml"), "utf8").catch(() => "")
    if (manifest.includes("[workspace]")) return dir
    if (dir === project || dir === dirname(dir)) return crate
  }
}

export type ServerState = "starting" | "indexing" | "ready" | "broken" | "stopped"

/** The state file for a project: its absolute path with every other character than `A-Za-z0-9._-` turned into `-`. */
export function statusFile(dir: string, root: string): string {
  return join(dir, `${root.replace(/[^A-Za-z0-9._-]/g, "-")}.json`)
}

export class LspManager {
  readonly #settings: Settings
  readonly #root: string
  readonly #entries = new Map<string, Entry>()
  readonly #versions = new Map<string, number>()
  readonly #deleted = new Set<string>()
  readonly #published = new Map<string, Map<string, Published>>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #reaper?: ReturnType<typeof setInterval>
  readonly #states = new Map<string, { state: ServerState; since: number; detail?: string }>()
  #statusWrite?: Promise<void>
  #statusDirty = false
  #closed = false

  constructor(settings: Settings, root: string) {
    this.#settings = settings
    this.#root = root
    if (settings.idleTimeoutMs > 0) {
      this.#reaper = setInterval(() => void this.#reap(), Math.min(60_000, Math.max(1_000, settings.idleTimeoutMs / 4)))
      this.#reaper.unref?.()
    }
  }

  /** Servers for the file that the agent may use. Servers listing `agents` serve only those agents. */
  serversFor(file: string, agent?: string): ServerConfig[] {
    const key = extensionKey(file)
    const name = basename(file).toLowerCase()
    return this.#settings.servers.filter(
      (server) =>
        server.extensions.some((extension) => [key, name].includes(extension.toLowerCase())) &&
        (server.agents === undefined || (agent !== undefined && server.agents.includes(agent))),
    )
  }

  /** Servers for the file that are running but still importing or indexing the project. */
  async busyServers(file: string, agent?: string): Promise<string[]> {
    const busy: string[] = []
    for (const target of await this.#targets(file, agent)) {
      const entry = this.#entries.get(target.key)
      if (entry?.starting || entry?.client?.busy) busy.push(target.key)
    }
    return busy
  }

  async #targets(file: string, agent?: string): Promise<Target[]> {
    const targets: Target[] = []
    for (const server of this.serversFor(file, agent)) {
      const target = await this.#target(server, file)
      if (target) targets.push(target)
    }
    return targets
  }

  async #target(server: ServerConfig, file: string): Promise<Target | undefined> {
    const root = await serverRoot(server.id, file, this.#root)
    if (!root) return undefined
    const key = root === this.#root ? server.id : `${server.id} (${relative(this.#root, root)})`
    return { key, server, root }
  }

  /**
   * Start a server ahead of the agents it serves, for the project holding `file`;
   * a missing file or a failed start is ignored. Returns the server's key when started.
   */
  async prewarm(server: ServerConfig, file: string): Promise<string | undefined> {
    if (this.#closed || !(await access(file).then(() => true, () => false))) return undefined
    const target = await this.#target(server, file)
    if (!target) return undefined
    this.#log(`${target.key} prewarming`)
    void this.#client(target).catch(() => undefined)
    return target.key
  }

  /** Run one document operation per file at a time, so versions reach servers in order. */
  #serialize<T>(uri: string, run: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(uri) ?? Promise.resolve()).then(run)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(uri, tail)
    void tail.then(() => {
      if (this.#queues.get(uri) === tail) this.#queues.delete(uri)
    })
    return result
  }

  /** Start any missing servers for the file and send them its current contents. */
  async sync(file: string, signal?: AbortSignal, agent?: string, pending?: string[]): Promise<Synced[]> {
    signal?.throwIfAborted()
    const uri = pathToFileURL(file).href
    return abortable(this.#serialize(uri, () => this.#sync(file, uri, signal, agent, pending)), signal)
  }

  /**
   * Tell servers a deleted file is gone and forget what they reported. Reports that
   * arrive later describe deleted contents and are dropped until the file is synced
   * again. The version counter survives, so a recreated file never reuses a version
   * a late report names.
   */
  close(file: string): Promise<void> {
    const uri = pathToFileURL(file).href
    return this.#serialize(uri, async () => {
      this.#deleted.add(uri)
      for (const [key, entry] of this.#entries) {
        this.#published.get(key)?.delete(uri)
        if (!entry.opened.delete(uri)) continue
        if (entry.client?.running) entry.client.notify("textDocument/didClose", { textDocument: { uri } })
      }
    })
  }

  /**
   * With `pending`, a server still starting after `startWaitMs` is skipped and named
   * there instead of holding up the edit; it keeps starting in the background.
   */
  async #sync(file: string, uri: string, signal?: AbortSignal, agent?: string, pending?: string[]): Promise<Synced[]> {
    signal?.throwIfAborted()
    // OpenCode 1 asked before touching files outside the project; plugins cannot ask, so they are never sent.
    const text = await readInside(this.#root, file)
    signal?.throwIfAborted()
    const ready: { target: Target; client: LspClient }[] = []
    for (const target of await this.#targets(file, agent)) {
      signal?.throwIfAborted()
      // Initialization is shared; cancelling one tool must not break another caller's server.
      const starting = this.#client(target).catch(() => undefined)
      const client = await abortable(pending ? withinMs(starting, this.#settings.startWaitMs) : starting, signal)
      if (client === STILL_STARTING) {
        pending!.push(target.key)
        continue
      }
      signal?.throwIfAborted()
      if (client) ready.push({ target, client })
    }
    signal?.throwIfAborted()
    if (this.#closed) throw new Error("LSP is shut down")
    if (ready.length === 0) return []
    // Commit the version only after startup finishes, then notify every client without
    // yielding. A cancelled startup must not make their last actual reports stale.
    const version = (this.#versions.get(uri) ?? 0) + 1
    this.#versions.set(uri, version)
    this.#deleted.delete(uri)
    const synced: Synced[] = []
    for (const { target, client } of ready) {
      const entry = this.#entries.get(target.key)!
      entry.lastUsed = Date.now()
      const sentAt = Date.now()
      if (entry.opened.has(uri)) {
        client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
      } else {
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: languageIdForExtension(extensionKey(file)), version, text },
        })
        entry.opened.add(uri)
      }
      // Edit tools write to disk, and some servers (rust-analyzer, for one) only re-check on save.
      const save = client.capabilities.textDocumentSync?.save
      if (save === true || (save && typeof save === "object")) {
        client.notify("textDocument/didSave", save?.includeText ? { textDocument: { uri }, text } : { textDocument: { uri } })
      }
      synced.push({ client, version, sentAt })
    }
    return synced
  }

  /** Sync the file and wait for its diagnostics. */
  async diagnostics(file: string, timeoutMs = this.#settings.diagnosticsTimeoutMs, signal?: AbortSignal, agent?: string): Promise<FileDiagnostics> {
    signal?.throwIfAborted()
    const uri = pathToFileURL(file).href
    const pending: string[] = []
    const synced = await this.sync(file, signal, agent, pending).catch((error) => {
      signal?.throwIfAborted()
      this.#log(`${file}: ${errorMessage(error)}`)
      return []
    })
    // Reports from before this file's contents reached the server describe older contents.
    const reports = await Promise.all(synced.map(({ client, version, sentAt }) => this.#collect(client, uri, version, sentAt, timeoutMs, signal)))
    signal?.throwIfAborted()
    const reported = reports.filter((report): report is Diagnostic[] => report !== undefined)
    const others = new Map<string, Diagnostic[]>()
    for (const { client, sentAt } of synced) {
      for (const [other, published] of this.#published.get(client.id) ?? []) {
        if (other === uri || published.at < sentAt) continue
        others.set(other, [...(others.get(other) ?? []), ...published.diagnostics])
      }
    }
    for (const { client } of synced) if (client.busy && !pending.includes(client.id)) pending.push(client.id)
    return { file: reported.length ? reported.flat() : undefined, others, pending }
  }

  async #collect(client: LspClient, uri: string, version: number, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted()
    if (client.capabilities.diagnosticProvider) {
      try {
        // A pull answers for the contents the server held when the request arrived. Sending it from
        // the file's queue pins that version; if a later sync replaced it meanwhile, ask again.
        for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
          const { sent, response } = await abortable(this.#serialize(uri, async () => {
            signal?.throwIfAborted()
            const response = client.request("textDocument/diagnostic", { textDocument: { uri } }, Math.min(timeoutMs, PULL_TIMEOUT_MS), signal)
            // Cancellation can win before the queue returns this nested promise to its caller.
            void response.catch(() => undefined)
            return {
              sent: this.#versions.get(uri),
              response,
            }
          }), signal)
          const report = await response
          if (this.#deleted.has(uri)) return undefined
          if (sent === undefined || this.#versions.get(uri) !== sent) continue
          if (report?.kind === "full" && Array.isArray(report.items)) {
            this.#store(client.id, uri, report.items, sent)
            return report.items
          }
          if (report?.kind === "unchanged") return this.#published.get(client.id)?.get(uri)?.diagnostics
          break
        }
      } catch (error) {
        signal?.throwIfAborted()
        this.#log(`${client.id}: pull diagnostics failed, waiting for a push: ${errorMessage(error)}`)
      }
    }
    // An older report describes the file before this change, so no report beats a stale one.
    return this.#waitForPush(client.id, uri, version, since, timeoutMs, signal)
  }

  /** Resolve once the server has published for this version and gone quiet, or undefined on timeout. */
  #waitForPush(serverID: string, uri: string, version: number, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let settle: ReturnType<typeof setTimeout> | undefined
      const current = () => {
        const published = this.#published.get(serverID)?.get(uri)
        if (!published || published.at < since) return undefined
        if (published.version !== undefined && published.version < version) return undefined
        return published
      }
      const cleanup = () => {
        clearTimeout(timeout)
        if (settle) clearTimeout(settle)
        this.#listeners.get(serverID)?.delete(listener)
        signal?.removeEventListener("abort", abort)
      }
      const finish = () => {
        cleanup()
        resolve(current()?.diagnostics)
      }
      const abort = () => {
        cleanup()
        reject(signal!.reason)
      }
      // Any message from the server restarts the quiet period, so an early empty
      // result from a server that is still indexing is not taken as clean.
      const listener = () => {
        if (!current()) return
        if (settle) clearTimeout(settle)
        settle = setTimeout(finish, SETTLE_MS)
      }
      const timeout = setTimeout(finish, timeoutMs)
      const listeners = this.#listeners.get(serverID) ?? new Set()
      listeners.add(listener)
      this.#listeners.set(serverID, listeners)
      signal?.addEventListener("abort", abort, { once: true })
      listener()
    })
  }

  /**
   * Run `send` against every server for the file that has the capability, and
   * concatenate their results. Throws when none can answer.
   */
  async request(file: string, capability: string, send: (client: LspClient) => Promise<unknown>, signal?: AbortSignal, agent?: string): Promise<unknown[]> {
    signal?.throwIfAborted()
    if (this.serversFor(file, agent).length === 0) throw new Error("No LSP server available for this file type.")
    const targets = await abortable(this.#targets(file, agent), signal)
    if (targets.length === 0) throw new Error("No configured LSP server applies to this file's project.")
    const cold = targets.some((target) => !this.#entries.get(target.key)?.warmed)
    if (cold) await this.diagnostics(file, WARMUP_TIMEOUT_MS, signal, agent)
    else await this.sync(file, signal, agent)
    signal?.throwIfAborted()
    const clients: LspClient[] = []
    for (const target of targets) {
      const entry = this.#entries.get(target.key)
      if (!entry?.client?.running) continue
      entry.warmed = true
      clients.push(entry.client)
    }
    if (clients.length === 0) {
      const reasons = targets.map((target) => {
        const entry = this.#entries.get(target.key)
        return `${target.key}: ${entry?.broken ?? (entry?.starting ? "still starting, try again shortly" : "not running")}`
      })
      throw new Error(`No LSP server for this file could start. ${reasons.join("; ")}`)
    }
    const capable = clients.filter((client) => client.capabilities[capability])
    if (capable.length === 0) throw new Error(`No LSP server for this file supports ${capability}.`)
    const results = await Promise.all(capable.map(send))
    return results.flatMap((result) => (result === null || result === undefined ? [] : Array.isArray(result) ? result : [result]))
  }

  async #client({ key, server, root }: Target): Promise<LspClient> {
    if (this.#closed) throw new Error("LSP is shut down")
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { opened: new Set(), lastUsed: Date.now() }
      this.#entries.set(key, entry)
    }
    entry.lastUsed = Date.now()
    if (entry.broken) throw new Error(entry.broken)
    if (entry.client?.running) return entry.client
    if (entry.starting) return entry.starting
    const current = entry
    current.opened.clear()
    current.warmed = false
    this.#published.delete(key)
    const client = new LspClient({
      id: key,
      command: server.command,
      root,
      rootUri: pathToFileURL(root).href,
      env: server.env,
      initialization: server.initialization,
      initializeTimeoutMs: this.#settings.initializeTimeoutMs,
      requestTimeoutMs: this.#settings.requestTimeoutMs,
      onDiagnostics: (uri, diagnostics, version) => this.#store(key, uri, diagnostics, version),
      onActivity: () => this.#notify(key),
      onProgress: () => this.#status(key),
      onExit: () => {
        if (current.client === client) current.client = undefined
        this.#status(key)
      },
      debug: this.#settings.debug,
    })
    current.starting = client
      .start()
      .then(() => {
        current.client = client
        this.#log(`${key} started`)
        return client
      })
      .catch(async (error) => {
        // A server that cannot start stays off for this instance instead of costing every edit a retry.
        current.broken = errorMessage(error)
        this.#log(current.broken)
        await client.stop()
        throw error
      })
      .finally(() => {
        current.starting = undefined
        this.#status(key)
      })
    this.#status(key)
    return current.starting
  }

  #store(serverID: string, uri: string, diagnostics: Diagnostic[], version: number | undefined): void {
    if (this.#deleted.has(uri)) return
    const published = this.#published.get(serverID) ?? new Map<string, Published>()
    // A late report for an older version describes contents that are gone.
    const latest = this.#versions.get(uri) ?? published.get(uri)?.version
    if (version !== undefined && latest !== undefined && version < latest) return
    published.set(uri, { diagnostics, at: Date.now(), version })
    this.#published.set(serverID, published)
    this.#notify(serverID)
  }

  #notify(serverID: string): void {
    for (const listener of [...(this.#listeners.get(serverID) ?? [])]) listener()
  }

  /**
   * Record a server's state in `statusDir`, so a pipeline step can wait for a slow
   * import before agents start. Writes are coalesced and replace the file atomically.
   */
  #status(key: string): void {
    if (!this.#settings.statusDir) return
    const entry = this.#entries.get(key)
    const state: ServerState = entry?.broken
      ? "broken"
      : entry?.starting
        ? "starting"
        : entry?.client?.running
          ? entry.client.busy
            ? "indexing"
            : "ready"
          : "stopped"
    const previous = this.#states.get(key)
    if (previous?.state === state) return
    this.#states.set(key, { state, since: Date.now(), detail: entry?.broken })
    this.#statusDirty = true
    this.#statusWrite ??= this.#flushStatus().finally(() => {
      this.#statusWrite = undefined
    })
  }

  async #flushStatus(): Promise<void> {
    const dir = this.#settings.statusDir!
    const file = statusFile(dir, this.#root)
    while (this.#statusDirty) {
      this.#statusDirty = false
      const body = JSON.stringify({ root: this.#root, pid: process.pid, updatedAt: Date.now(), servers: Object.fromEntries(this.#states) }, null, 2)
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(`${file}.${process.pid}.tmp`, body + "\n")
        await rename(`${file}.${process.pid}.tmp`, file)
      } catch (error) {
        this.#log(`cannot write status ${file}: ${errorMessage(error)}`)
      }
    }
  }

  #log(message: string): void {
    if (this.#settings.debug) console.error(`[lsp] ${message}`)
  }

  /** Stop servers nobody has used for `idleTimeoutMs`; the next use starts them again. */
  async #reap(): Promise<void> {
    const cutoff = Date.now() - this.#settings.idleTimeoutMs
    for (const [key, entry] of this.#entries) {
      if (entry.starting || !entry.client || entry.lastUsed > cutoff) continue
      this.#entries.delete(key)
      this.#published.delete(key)
      this.#log(`${key} idle, stopping`)
      await entry.client.stop()
      this.#status(key)
    }
  }

  async shutdown(): Promise<void> {
    if (this.#reaper) clearInterval(this.#reaper)
    this.#closed = true
    await this.#statusWrite
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    await Promise.all(
      entries.map(async (entry) => {
        const client = entry.client ?? (await entry.starting?.catch(() => undefined))
        await client?.stop()
      }),
    )
    if (!this.#settings.statusDir || this.#states.size === 0) return
    for (const key of this.#states.keys()) this.#states.set(key, { state: "stopped", since: Date.now() })
    this.#statusDirty = true
    await (this.#statusWrite ?? this.#flushStatus())
  }
}

const STILL_STARTING = Symbol("still starting")

function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | typeof STILL_STARTING> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof STILL_STARTING>((resolve) => {
    timer = setTimeout(() => resolve(STILL_STARTING), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** Send a request, retrying while the server reports it is still loading. */
export async function requestWithRetry(client: LspClient, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await client.request(method, params, undefined, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt >= 5 || !(error instanceof LspError) || !TRANSIENT_CODES.has(error.code ?? 0)) throw error
      try {
        await delay(400 * attempt, undefined, { signal })
      } catch (error) {
        signal?.throwIfAborted()
        throw error
      }
    }
  }
}
