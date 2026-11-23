import { readdir, readFile } from "node:fs/promises"
import type { MessageV2 } from "@/session/message-v2"
import { PartID } from "@/session/schema"

export namespace MemoryNote {
  const MB = 1024 * 1024
  const LEVELS = [0.75, 0.85, 0.95]
  const MARGIN = 0.05
  const MOSTLY_SELF = 0.25
  const TOP = 3
  const LABEL = 160
  const KEY = "memoryNote"
  const RESTART = "If the limit is reached, the whole workspace restarts."
  const GUIDE =
    "Before continuing, stop the programs above that are no longer needed (such as a browser you finished checking) and keep the preview dev server running. The names above are shortened, so stop a program by its pid, not by matching its name. While this note is shown, free memory before a command that uses more memory, such as a browser check or a build; if nothing can be stopped, tell the user briefly that the workspace may restart and then run it. In your final answer of this turn, always tell the user briefly the memory use, what you stopped, and, for each large program you left running, its memory use and what it does in plain words, even if you stopped nothing. Stopping these programs is what this note asks for, so do not apologize for it or call it a mistake. For a program you did not start, first read the start of its script in this turn (for example `head -30 <file>`) and describe it only from what you read, not from its name. If you cannot read it, say you do not know what it does."
  const ALONE =
    "Most of this memory is used by OpenCode itself, not by other programs, so there is little to stop. Do not stop the preview dev server. Before a command that uses more memory, such as a browser check or a build, tell the user briefly that the workspace may restart and then run it. In your final answer of this turn, always tell the user briefly that the workspace memory is high."
  const reminder = (text: string) => ["<system-reminder>", text, "</system-reminder>"].join("\n")
  const RECOVERED = reminder(
    "Workspace memory is back below the warning level. Earlier memory notes in this conversation are out of date; do not act on them.",
  )
  const FREED = reminder(
    "Workspace memory is back below the warning level, so you no longer need to free memory before heavy commands. In your final answer of this turn, still tell the user briefly the memory use now and what you stopped in this turn, if anything. Stopping them is what the earlier note asked for, so do not apologize for it or call it a mistake.",
  )
  const SECRET = /key|token|secret|pass|auth|cred/i

  export type Program = { cmd: string; pid: number; mb: number; count: number }
  export type Usage = { usedMb: number; limitMb: number; selfMb: number; programs: Program[] }
  export type Paths = { cgroup: string; proc: string; root: number }

  const DEFAULT: Paths = { cgroup: "/sys/fs/cgroup", proc: "/proc", root: process.pid }

  const read = (path: string) => readFile(path, "utf8").catch(() => undefined)

  function fields(text: string, separator: string) {
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const at = line.indexOf(separator)
      if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim()
    }
    return out
  }

  const kb = (value?: string) => Number((value ?? "0").split(" ")[0]) * 1024 || 0

  type Proc = { pid: number; ppid: number; bytes: number; argv: string[] }

  async function processes(proc: string) {
    const entries = await readdir(proc).catch(() => [] as string[])
    const list = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry): Promise<Proc | undefined> => {
          const status = await read(`${proc}/${entry}/status`)
          if (!status) return
          const s = fields(status, ":")
          const argv = ((await read(`${proc}/${entry}/cmdline`)) ?? "").split("\0").filter(Boolean)
          return {
            pid: Number(entry),
            ppid: Number(s.PPid),
            bytes: kb(s.RssAnon) + kb(s.RssShmem),
            argv: argv.length ? argv : [s.Name ?? ""],
          }
        }),
    )
    return list.filter((item): item is Proc => item !== undefined)
  }

  export function label(argv: string[]) {
    const out: string[] = []
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (i > 0 && arg.startsWith("--")) {
        if (!arg.includes("=") && SECRET.test(arg)) i++
        continue
      }
      const at = arg.indexOf("=")
      if (at > 0 && SECRET.test(arg.slice(0, at))) {
        out.push(`${arg.slice(0, at)}=***`)
        continue
      }
      out.push(!arg.includes("/") && /^[\w.+=-]{32,}$/.test(arg) ? "***" : arg)
    }
    return out.join(" ").replace(/[`<>]/g, "").slice(0, LABEL)
  }

  function programs(list: Proc[], root: number): Program[] {
    const children = new Map<number, Proc[]>()
    for (const item of list) {
      const siblings = children.get(item.ppid)
      if (siblings) siblings.push(item)
      else children.set(item.ppid, [item])
    }
    return (children.get(root) ?? [])
      .map((top) => {
        const members: Proc[] = []
        const stack = [top]
        while (stack.length) {
          const item = stack.pop()!
          members.push(item)
          for (const child of children.get(item.pid) ?? []) stack.push(child)
        }
        const largest = members.reduce((a, b) => (b.bytes > a.bytes ? b : a))
        return {
          cmd: label(largest.argv),
          pid: largest.pid,
          mb: Math.round(members.reduce((sum, item) => sum + item.bytes, 0) / MB),
          count: members.length,
        }
      })
      .filter((item) => item.mb > 0)
      .sort((a, b) => b.mb - a.mb)
  }

  function kernel(s: Record<string, number>) {
    if (s.kernel !== undefined) return Math.max(0, s.kernel - (s.slab_reclaimable ?? 0))
    return ["kernel_stack", "pagetables", "sec_pagetables", "percpu", "sock", "vmalloc", "slab_unreclaimable"].reduce(
      (sum, key) => sum + (s[key] ?? 0),
      0,
    )
  }

  export async function usage(paths: Paths = DEFAULT, previous = 0): Promise<Usage | undefined> {
    const max = (await read(`${paths.cgroup}/memory.max`))?.trim()
    if (!max || max === "max") return
    const stat = await read(`${paths.cgroup}/memory.stat`)
    if (!stat) return
    const s = Object.fromEntries(Object.entries(fields(stat, " ")).map(([key, value]) => [key, Number(value)]))
    const used = (s.anon ?? 0) + (s.shmem ?? 0) + kernel(s)
    const base: Usage = {
      usedMb: Math.round(used / MB),
      limitMb: Math.round(Number(max) / MB),
      selfMb: 0,
      programs: [],
    }
    if (level(base, previous) === 0) return base
    const list = await processes(paths.proc)
    const self = list.find((item) => item.pid === paths.root)
    return { ...base, selfMb: Math.round((self?.bytes ?? 0) / MB), programs: programs(list, paths.root) }
  }

  export function level(usage: Usage, previous = 0) {
    const ratio = usage.usedMb / usage.limitMb
    const raw = LEVELS.filter((item) => ratio >= item).length
    const held = Math.min(previous, LEVELS.filter((item) => ratio >= item - MARGIN).length)
    return Math.max(raw, held)
  }

  export function compose(usage: Usage) {
    const top = usage.programs.slice(0, TOP)
    const others = usage.programs.reduce((sum, item) => sum + item.mb, 0)
    const percent = Math.round((usage.usedMb / usage.limitMb) * 100)
    return reminder(
      [
        `Workspace memory: ${usage.usedMb} MB of ${usage.limitMb} MB (${percent}%). OpenCode: ${usage.selfMb} MB.`,
        ...top.map(
          (item) =>
            `- \`${item.cmd}\` (pid ${item.pid}): ${item.mb} MB${item.count > 1 ? ` (${item.count} processes)` : ""}`,
        ),
        `${RESTART} ${others >= usage.usedMb * MOSTLY_SELF ? GUIDE : ALONE}`,
      ].join("\n"),
    )
  }

  function stored(message: MessageV2.WithParts) {
    for (const part of message.parts) {
      const value = part.type === "text" && part.synthetic ? part.metadata?.[KEY] : undefined
      if (typeof value === "number") return { part: part as MessageV2.TextPart, level: value }
    }
  }

  function earlier(users: MessageV2.WithParts[]) {
    for (let i = users.length - 2; i >= 0; i--) {
      const found = stored(users[i])
      if (found) return found
    }
  }

  export async function update(
    messages: MessageV2.WithParts[],
    paths: Paths = DEFAULT,
  ): Promise<MessageV2.TextPart | undefined> {
    const users = messages.filter((message) => message.info.role === "user")
    const last = users.at(-1)
    if (!last) return
    const existing = stored(last)
    const before = existing ?? earlier(users)
    const current = await usage(paths, before?.level).catch(() => undefined)
    const now = current ? level(current, before?.level) : 0
    if (existing?.level === now) return
    if (now === 0 && !before?.level) return
    return {
      id: existing?.part.id ?? PartID.ascending(),
      messageID: last.info.id,
      sessionID: last.info.sessionID,
      type: "text",
      text: now > 0 ? compose(current!) : existing ? FREED : RECOVERED,
      synthetic: true,
      metadata: { [KEY]: now },
    }
  }
}
