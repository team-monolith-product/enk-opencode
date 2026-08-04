// Max size of a single attachment the client will read into memory.
// Must match the server-side doc-asset limit in
// packages/opencode/src/doc/routes.ts (MAX = 10 * 1024 * 1024). Files over this
// are rejected synchronously (via file.size) before any FileReader/arrayBuffer
// read, so an oversized file never crashes the tab.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

// Per-prompt attachment budget. Size alone is not the cost driver — every attachment rides along in
// the session history and is re-billed as input on every step of every turn, and a text attachment
// expands to its Read output (see ATTACHMENT_READ_LIMIT server-side). Ten covers real use
// (a handful of screenshots plus a couple of documents) while keeping the worst case bounded.
export const MAX_ATTACHMENT_COUNT = 10
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

export const ACCEPTED_FILE_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]

const MIME_EXT = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
  ["application/json", "json"],
  ["application/ld+json", "jsonld"],
  ["application/toml", "toml"],
  ["application/x-toml", "toml"],
  ["application/x-yaml", "yaml"],
  ["application/xml", "xml"],
  ["application/yaml", "yaml"],
])

const TEXT_EXT = ["txt", "text", "md", "markdown", "log", "csv"]

export const ACCEPTED_FILE_EXTENSIONS = Array.from(
  new Set(
    ACCEPTED_FILE_TYPES.flatMap((item) => {
      if (item.startsWith(".")) return [item.slice(1)]
      if (item === "text/*") return TEXT_EXT
      const out = MIME_EXT.get(item)
      return out ? [out] : []
    }),
  ),
).sort()

export function filePickerFilters(ext?: string[]) {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}
