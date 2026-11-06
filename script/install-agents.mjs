#!/usr/bin/env node
// Installs the bundled agent definitions into the global OpenCode config.
// Used by `postinstall` when the plugin is installed from npm, and imported by
// the TUI plugin so local-path installs get the same agents on first run.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

function opencodeConfigDir() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
}

/**
 * Copies `agents/*.md` next to this module into `<config>/opencode/agents`.
 * Existing files are preserved unless `force` is set.
 * Returns the destination paths that were written.
 */
export function installAgents({ force = false, quiet = false } = {}) {
  const source = join(dirname(fileURLToPath(import.meta.url)), "..", "agents")
  if (!existsSync(source)) return []

  const target = join(opencodeConfigDir(), "agents")
  mkdirSync(target, { recursive: true })

  const written = []
  for (const entry of readdirSync(source)) {
    if (!entry.endsWith(".md")) continue
    const destination = join(target, entry)
    if (!force && existsSync(destination)) continue
    copyFileSync(join(source, entry), destination)
    written.push(destination)
  }

  if (!quiet) {
    if (written.length > 0) {
      for (const file of written) console.log(`agents: installed ${file}`)
    } else {
      console.log(`agents: already present in ${target}`)
    }
  }
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  installAgents({ force: process.argv.includes("--force") })
}
