import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

/**
 * The upload folder: files a user drops in are stored verbatim and never travel through a prompt.
 *
 * This exists because prompt attachments are billed as input on every step of every turn (see
 * MAX_ATTACHMENT_COUNT in packages/app/src/constants/file-picker.ts), so a large corpus can never
 * live there. Here the bytes sit on disk and the agent pulls only what it needs with read/grep/glob.
 *
 * Everything in this module treats the client-supplied path as hostile: it is the only write-to-
 * workspace API the server exposes, so `resolve` confining the result to `root()` is the boundary.
 */
export namespace Assets {
  const log = Log.create({ service: "file.assets" })

  export const DIR = "__assets__"

  /**
   * Disk guards, not prompt guards. They exist so one upload cannot fill the volume, and are
   * deliberately far above the per-prompt attachment budget, which is a token-cost limit instead.
   */
  export const MAX_FILE_BYTES = 100 * 1024 * 1024
  export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
  export const MAX_FILE_COUNT = 1000
  /** Directory uploads keep their shape, but not an unbounded amount of it. */
  export const MAX_DEPTH = 8
  const MAX_SEGMENT_LENGTH = 100
  const MAX_EXTENSION_LENGTH = 16

  // Path separators and the characters Windows forbids in a name, plus C0/DEL controls (which
  // covers the null byte). Everything else, Unicode included, is kept: a file named "설계안.pdf"
  // has to survive the round trip or the user cannot recognize their own upload.
  const ILLEGAL = /[\x00-\x1f\x7f/\\:*?"<>|]/g

  // CON, PRN, AUX, NUL, COM1-9, LPT1-9 are unusable as filenames on Windows even with an extension.
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

  /**
   * Where uploads live: the session's own directory, which is what the file tree lists. Putting it
   * at the worktree root instead would hide the folder from a session opened in a subdirectory —
   * uploads would work but could never be seen or deleted, and this feature is driven from the tree.
   *
   * Uploads are therefore scoped to the workspace, deliberately. A session opened in a different
   * directory, or in a different worktree of the same project, gets its own folder and does not see
   * this one; the files go away with the workspace. That is the decision: an upload is material for
   * the work happening here, not a project-wide asset. Making it project-wide means storing outside
   * the workspace entirely (see Global.Path.data, the shape ATTACHMENT_DIR uses) — not moving this
   * path up a level, which only trades one blind spot for another.
   */
  export function root(): string {
    return path.join(Instance.directory, DIR)
  }

  /**
   * One path segment, made safe to write. Returns undefined when nothing usable survives, which the
   * caller must treat as a rejected upload rather than substituting a name of its own.
   */
  export function segment(input: string): string | undefined {
    // macOS hands over NFD filenames; normalizing keeps "설계.pdf" from comparing unequal to itself
    // and keeps the collision check in `unique` honest.
    let out = input.normalize("NFC").replace(ILLEGAL, "_")

    // A leading dot hides the file from the tree; "." and ".." are handled by `relative` before
    // they ever reach here, so this is only about visibility.
    out = out.replace(/^\.+/, "")
    // Windows silently strips trailing dots and spaces, which would let "a. " and "a" collide.
    out = out.replace(/[. ]+$/, "").trim()

    if (!out) return undefined
    if (RESERVED.test(out)) out = "_" + out
    if (out.length <= MAX_SEGMENT_LENGTH) return out

    // Truncate the stem, not the extension — the extension is what tells the agent how to read it.
    const ext = path.extname(out).slice(0, MAX_EXTENSION_LENGTH)
    const stem = out.slice(0, out.length - path.extname(out).length)
    return stem.slice(0, Math.max(1, MAX_SEGMENT_LENGTH - ext.length)) + ext
  }

  /**
   * A client-supplied relative path (a plain filename, or `webkitRelativePath` for a directory
   * upload) reduced to segments that are safe to join onto `root()`. Returns undefined when the
   * path is unusable — empty, too deep, containing "..", or nothing left after sanitizing.
   */
  export function relative(input: string): string | undefined {
    const parts: string[] = []
    for (const raw of input.split(/[/\\]/)) {
      // Collapses "a//b" and a leading separator, which are shape noise rather than an attack.
      if (raw === "" || raw === ".") continue
      // ".." is rejected outright rather than sanitized away: dropping it would silently relocate
      // the file, and a caller that sent one is not describing a path we should guess at.
      if (raw === "..") return undefined
      const part = segment(raw)
      if (!part) return undefined
      parts.push(part)
    }

    if (parts.length === 0) return undefined
    if (parts.length > MAX_DEPTH) return undefined
    return parts.join("/")
  }

  /**
   * Absolute destination for a client-supplied path, or undefined if it does not land inside the
   * assets folder. `relative` already removes the traversal primitives; this is the second,
   * independent check, so a gap in the sanitizer alone cannot produce a write outside the folder.
   */
  export function resolve(input: string): string | undefined {
    const rel = relative(input)
    if (!rel) return undefined

    const base = root()
    const target = path.resolve(base, rel)
    if (target === base) return undefined
    if (!Filesystem.contains(base, target)) return undefined
    return target
  }

  export type Entry = {
    /** Path relative to the assets folder, using forward slashes. */
    path: string
    size: number
    modified: number
  }

  /** Every uploaded file, depth-first. A missing folder reads as empty, not as an error. */
  export function list(): Entry[] {
    const base = root()
    const out: Entry[] = []

    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        // Never follow a link out of the folder while reporting what is in it.
        if (entry.isSymbolicLink()) continue
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(absolute, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const stat = Filesystem.stat(absolute)
        if (!stat) continue
        out.push({
          path: path.relative(base, absolute).split(path.sep).join("/"),
          size: Number(stat.size),
          modified: stat.mtime.getTime(),
        })
      }
    }

    walk(base, 0)
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  export type Usage = { count: number; bytes: number }

  function total(entries: Entry[]): Usage {
    return entries.reduce<Usage>((acc, entry) => ({ count: acc.count + 1, bytes: acc.bytes + entry.size }), {
      count: 0,
      bytes: 0,
    })
  }

  /** A walk of the folder, totalled. The truth, and the only thing that sees writes made elsewhere. */
  export function usage(): Usage {
    return total(list())
  }

  /** The listing and its totals in one walk, refreshing the cached totals on the way through. */
  export function snapshot(): { files: Entry[]; usage: Usage } {
    const files = list()
    const walked = total(files)
    const state = ledger()
    state.walked = { ...walked }
    state.at = Date.now()
    return { files, usage: walked }
  }

  /**
   * How long a walk is reused. The caps have to be checked before every single upload, and walking
   * the folder for each one makes a batch of N files cost O(N²) stats — the rejected tail of an
   * over-cap batch pays it too, on a folder that is by then at its fullest.
   *
   * Short, because the walk is the only thing that sees writes this module did not make: the agent's
   * own write tool, or the user in a terminal, can put files here. Two seconds collapses a burst of
   * uploads onto one walk while keeping that blind spot to about a blink.
   */
  const USAGE_TTL_MS = 2_000

  type Ledger = {
    /** The last walk, and when it was taken. */
    walked?: Usage
    at: number
    /** Room granted to uploads that have not finished writing yet. */
    pending: Usage
  }

  const ledger = Instance.state<Ledger>(() => ({ at: 0, pending: { count: 0, bytes: 0 } }))

  /** Totals as far as this module knows: the last walk, refreshed if stale, plus what is in flight. */
  function projected(): Usage {
    const state = ledger()
    if (!state.walked || Date.now() - state.at > USAGE_TTL_MS) {
      state.walked = usage()
      state.at = Date.now()
    }
    return { count: state.walked.count + state.pending.count, bytes: state.walked.bytes + state.pending.bytes }
  }

  /** Room taken for one file that is about to be written. */
  export type Claim = { bytes: number }

  /** Which cap stopped a claim. */
  export type Refusal = "count" | "total"

  /**
   * Room for one more file of `bytes`, taken before a byte of it is written, or the cap that
   * refused it.
   *
   * Claiming up front is what makes the caps hold when uploads overlap. The client sends four at a
   * time; four requests that each read "999 files, room for one more" are each right and together
   * wrong. A claim is visible to the next caller immediately, so the fourth one sees 1002.
   *
   * Every claim must be handed back with `settle`, including on the paths that fail.
   */
  export function claim(bytes: number): Claim | Refusal {
    const state = ledger()
    const now = projected()
    if (now.count + 1 > MAX_FILE_COUNT) return "count"
    if (now.bytes + bytes > MAX_TOTAL_BYTES) return "total"
    state.pending.count += 1
    state.pending.bytes += bytes
    return { bytes }
  }

  /**
   * What the folder would hold if the file behind `claim` ended at `written` bytes — its own claim
   * swapped for what it has actually produced, with every other upload's claim left standing. This
   * is what a streaming write checks against, because `content-length` is a hint the client chooses.
   */
  export function projectedBytes(claim: Claim, written: number): number {
    const state = ledger()
    return (state.walked?.bytes ?? 0) + state.pending.bytes - claim.bytes + written
  }

  /**
   * Hands a claim back. `written` is the size the file ended up at, or undefined when nothing was
   * stored.
   *
   * A stored file moves into the walked column rather than simply dropping out of the pending one:
   * the walk that would otherwise account for it may be up to USAGE_TTL_MS old, and a file that is
   * in neither column is a file the caps do not know about. Counting it twice for the rest of that
   * window — which happens when a walk caught it mid-write — only makes the caps stricter, and the
   * next walk settles it.
   */
  export function settle(claim: Claim, written?: number): void {
    const state = ledger()
    state.pending.count -= 1
    state.pending.bytes -= claim.bytes
    if (written === undefined || !state.walked) return
    state.walked.count += 1
    state.walked.bytes += written
  }

  /** Drops the cached walk, for a change to the folder this module did not account for. */
  export function invalidate(): void {
    const state = ledger()
    state.walked = undefined
    state.at = 0
  }

  /**
   * A destination that does not exist yet, derived from `target` by inserting " (2)", " (3)" … before
   * the extension. Two people uploading the same filename into a shared session is normal, and
   * silently overwriting one of them loses data.
   */
  export function unique(target: string): string {
    if (!Filesystem.stat(target)) return target
    const dir = path.dirname(target)
    const ext = path.extname(target)
    const stem = path.basename(target, ext)
    for (let i = 2; i < 1000; i++) {
      const candidate = path.join(dir, `${stem} (${i})${ext}`)
      if (!Filesystem.stat(candidate)) return candidate
    }
    return path.join(dir, `${stem} (${Date.now()})${ext}`)
  }

  /**
   * Creates the parent chain for `target` and verifies it is still inside the assets folder once
   * symlinks are resolved. `resolve` proves the *path string* is contained; this proves the
   * *physical directory* is, so a pre-existing symlinked subfolder cannot redirect the write.
   */
  export function prepare(target: string): boolean {
    const base = root()
    const dir = path.dirname(target)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const real = fs.realpathSync(dir)
      const realBase = fs.realpathSync(base)
      if (!Filesystem.contains(realBase, real)) {
        log.error("assets directory escapes root", { dir: real })
        return false
      }
      return true
    } catch (error) {
      log.error("failed to prepare assets directory", { error })
      return false
    }
  }

  /**
   * The directory git reads `info/exclude` from. For a normal checkout that is `.git`; in a linked
   * worktree `.git` is a *file* pointing at `.git/worktrees/<name>`, and git reads the exclude file
   * from the shared common dir, not the per-worktree one (verified: a per-worktree
   * `info/exclude` has no effect). Returns undefined when the layout is not recognized.
   */
  export function gitCommonDir(worktree: string): string | undefined {
    const dot = path.join(worktree, ".git")
    const stat = Filesystem.stat(dot)
    if (!stat) return undefined
    if (stat.isDirectory()) return dot

    try {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"))
      if (!pointer?.[1]) return undefined
      const gitdir = path.resolve(worktree, pointer[1].trim())
      // `commondir` holds the path (usually relative) back to the shared .git directory.
      const commondir = path.join(gitdir, "commondir")
      if (!Filesystem.stat(commondir)) return gitdir
      return path.resolve(gitdir, fs.readFileSync(commondir, "utf8").trim())
    } catch {
      return undefined
    }
  }

  /**
   * Adds `__assets__/` to git's info/exclude rather than the project's own .gitignore: uploads must
   * not show up in git status or a PR diff, and editing a tracked file to achieve that would itself
   * be a change the user has to review. Idempotent, and a no-op outside a git project.
   *
   * The pattern carries no leading slash, so it matches an upload folder at any depth — which is
   * what makes one write cover every session directory in the worktree, not just this one.
   *
   * Note the tradeoff — ripgrep honors info/exclude too, so the agent's glob/grep skip this folder
   * unless they are pointed at it (see Ripgrep `noIgnore`).
   */
  export function exclude(): void {
    if (Instance.project.vcs !== "git") return
    const worktree = Instance.worktree
    if (!worktree || worktree === path.parse(worktree).root) return

    const gitdir = gitCommonDir(worktree)
    if (!gitdir) return

    const file = path.join(gitdir, "info", "exclude")
    const line = DIR + "/"
    try {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
      if (existing.split(/\r?\n/).some((entry) => entry.trim() === line)) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, (existing && !existing.endsWith("\n") ? "\n" : "") + line + "\n")
      log.info("excluded assets directory from git", { file })
    } catch (error) {
      // Not fatal: the upload still works, the folder is just visible to git.
      log.error("failed to exclude assets directory", { error })
    }
  }

  /** True when `filepath` is inside the assets folder. Used to widen agent search into it. */
  export function contains(filepath: string): boolean {
    return Filesystem.contains(root(), path.resolve(filepath))
  }
}
