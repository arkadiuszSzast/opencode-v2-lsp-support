// OpenCode 2 accepts an `lsp` config block but has no LSP runtime. This plugin
// supplies OpenCode 1's two LSP features from that same block: the `lsp` tool
// and error diagnostics appended to write, edit, and patch results.
//
// The default export is the plain `{ id, setup }` shape OpenCode 2 loads, so
// the plugin needs no `@opencode/plugin` install.
import { resolveSettings } from "./src/config.ts"
import { absolute, afterTool, startsOnLoad } from "./src/diagnostics.ts"
import { LspManager } from "./src/manager.ts"
import { lspTool } from "./src/tool.ts"

export default {
  id: "opencode-v2-lsp-support",
  async setup(ctx: any) {
    const root: string = ctx.location.directory
    const settings = resolveSettings(root, ctx.options ?? {})
    if (settings.debug) console.error(`[lsp] servers: ${settings.servers.map((server) => server.id).join(", ") || "none"}`)
    if (settings.servers.length === 0) return

    const manager = new LspManager(settings, root)
    const tools = await ctx.tool.transform((editor: any) => editor.add(lspTool(manager, root)))
    const hook = await ctx.tool.hook("execute.after", afterTool(manager, root, settings.diagnostics, settings.servers))
    for (const server of settings.servers) {
      if (server.prewarm && startsOnLoad(server, root)) void manager.prewarm(server, absolute(root, server.prewarm.file))
    }
    return async () => {
      await hook.dispose()
      await tools.dispose()
      await manager.shutdown()
    }
  },
}
