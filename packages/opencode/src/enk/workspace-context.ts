import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

export namespace WorkspaceContext {
  const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".vscode",
    ".idea",
    "coverage",
  ])
  const IGNORE_FILES = new Set(["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".DS_Store"])
  const BINARY_EXT = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svg",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".mp3",
    ".mp4",
    ".webm",
    ".wav",
    ".zip",
    ".tar",
    ".gz",
    ".pdf",
  ])

  const MAX_FILES = 500
  const MAX_DEPTH = 8
  const PER_FILE_CAP = 8 * 1024
  const TOTAL_BODY_BUDGET = 64 * 1024

  const ENTRY_HINTS: RegExp[] = [
    /(^|\/)README(\.|$)/i,
    /(^|\/)package\.json$/,
    /(^|\/)pyproject\.toml$/,
    /(^|\/)Cargo\.toml$/,
    /(^|\/)go\.mod$/,
    /(^|\/)index\.html$/,
    /(^|\/)src\/main\.[jt]sx?$/,
    /(^|\/)src\/App\.[jt]sx?$/,
    /(^|\/)src\/index\.[jt]sx?$/,
    /(^|\/)app\/page\.[jt]sx?$/,
  ]

  const PATH_REGEX =
    /[\w./-]+\.(?:tsx?|jsx?|html|css|scss|md|json|py|go|rs|java|kt|rb|swift|vue|svelte|toml|yaml|yml)\b/g

  export async function collect(root: string): Promise<string[]> {
    const out: string[] = []
    async function walk(dir: string, depth: number) {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= MAX_FILES) return
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue
          await walk(path.join(dir, e.name), depth + 1)
        } else if (e.isFile()) {
          if (IGNORE_FILES.has(e.name)) continue
          const ext = path.extname(e.name).toLowerCase()
          if (BINARY_EXT.has(ext)) continue
          out.push(path.relative(root, path.join(dir, e.name)))
        }
      }
    }
    await walk(root, 0)
    return out
  }

  function extractMentionedPaths(transcript: string): Set<string> {
    return new Set(transcript.match(PATH_REGEX) ?? [])
  }

  function rankFiles(files: string[], mentioned: Set<string>): string[] {
    const score = (f: string) => {
      let s = 0
      for (const re of ENTRY_HINTS) if (re.test(f)) s += 1000
      for (const m of mentioned) {
        if (f === m || f.endsWith("/" + m) || m.endsWith("/" + f)) s += 500
      }
      return s
    }
    return [...files].sort((a, b) => score(b) - score(a))
  }

  export async function render(root: string, files: string[], transcript: string): Promise<string> {
    if (files.length === 0) return ""
    const mentioned = extractMentionedPaths(transcript)
    const ranked = rankFiles(files, mentioned)
    const tree = [...files].sort().join("\n")

    let used = 0
    const bodies: string[] = []
    for (const rel of ranked) {
      if (used >= TOTAL_BODY_BUDGET) break
      const abs = path.join(root, rel)
      let raw: string
      try {
        raw = await readFile(abs, "utf8")
      } catch {
        continue
      }
      const text = raw.length > PER_FILE_CAP ? raw.slice(0, PER_FILE_CAP) + "\n... (truncated)" : raw
      const block = `=== ${rel} ===\n${text}\n`
      const remain = TOTAL_BODY_BUDGET - used
      if (block.length > remain) {
        if (remain > 200) bodies.push(block.slice(0, remain) + "\n... (truncated)")
        break
      }
      bodies.push(block)
      used += block.length
    }

    return ["워크스페이스 트리:", tree, "", "핵심 파일:", bodies.join("\n")].join("\n")
  }
}
