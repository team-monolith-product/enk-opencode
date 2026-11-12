import { readdir, readFile } from "node:fs/promises"
import type { MessageV2 } from "@/session/message-v2"

/** 작업 공간 메모리가 한도에 가까우면 무엇이 메모리를 쓰는지 AI 에게 알려, 무거운 작업을 줄이게 한다. */
export namespace MemoryNote {
  const MB = 1024 * 1024
  const LEVELS = [0.75, 0.85, 0.95]
  const TOP = 3

  export type Program = { cmd: string; mb: number; count: number }
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

  type Proc = { pid: number; ppid: number; bytes: number; cmd: string }

  async function processes(proc: string) {
    const entries = await readdir(proc).catch(() => [] as string[])
    const list = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry): Promise<Proc | undefined> => {
          const status = await read(`${proc}/${entry}/status`)
          if (!status) return
          const s = fields(status, ":")
          const cmdline = (await read(`${proc}/${entry}/cmdline`)) ?? ""
          return {
            pid: Number(entry),
            ppid: Number(s.PPid),
            bytes: kb(s.RssAnon) + kb(s.RssShmem),
            cmd: cmdline.split("\0").filter(Boolean).join(" ") || (s.Name ?? ""),
          }
        }),
    )
    return list.filter((item): item is Proc => item !== undefined)
  }

  function programs(list: Proc[], root: number): Program[] {
    const children = new Map<number, Proc[]>()
    for (const item of list) children.set(item.ppid, [...(children.get(item.ppid) ?? []), item])
    return (children.get(root) ?? [])
      .map((top) => {
        const members: Proc[] = []
        const stack = [top]
        while (stack.length) {
          const item = stack.pop()!
          members.push(item)
          stack.push(...(children.get(item.pid) ?? []))
        }
        const largest = members.reduce((a, b) => (b.bytes > a.bytes ? b : a))
        return {
          cmd: largest.cmd.slice(0, 160),
          mb: Math.round(members.reduce((sum, item) => sum + item.bytes, 0) / MB),
          count: members.length,
        }
      })
      .filter((item) => item.mb > 0)
      .sort((a, b) => b.mb - a.mb)
  }

  export async function usage(paths: Paths = DEFAULT): Promise<Usage | undefined> {
    const max = (await read(`${paths.cgroup}/memory.max`))?.trim()
    if (!max || max === "max") return
    const stat = await read(`${paths.cgroup}/memory.stat`)
    if (!stat) return
    const s = Object.fromEntries(Object.entries(fields(stat, " ")).map(([key, value]) => [key, Number(value)]))
    const used = (s.anon ?? 0) + (s.shmem ?? 0) + Math.max(0, (s.kernel ?? 0) - (s.slab_reclaimable ?? 0))
    const list = await processes(paths.proc)
    const self = list.find((item) => item.pid === paths.root)
    return {
      usedMb: Math.round(used / MB),
      limitMb: Math.round(Number(max) / MB),
      selfMb: Math.round((self?.bytes ?? 0) / MB),
      programs: programs(list, paths.root),
    }
  }

  export function level(usage: Usage) {
    const ratio = usage.usedMb / usage.limitMb
    return LEVELS.filter((item) => ratio >= item).length
  }

  export function compose(usage: Usage) {
    const top = usage.programs.slice(0, TOP)
    return [
      "<system-reminder>",
      `Workspace memory is high: ${usage.usedMb} MB of ${usage.limitMb} MB. OpenCode itself uses ${usage.selfMb} MB. If the limit is reached, the whole workspace restarts: your current work, the preview dev server and every other program stop at once.`,
      ...(top.length
        ? [
            "The largest programs you started:",
            ...top.map(
              (item) => `- \`${item.cmd}\` (${item.mb} MB${item.count > 1 ? `, ${item.count} processes` : ""})`,
            ),
          ]
        : []),
      "Before running anything heavy, free memory first: stop dev servers, watchers or browsers you no longer need, run one heavy job at a time, cap Node builds with NODE_OPTIONS=--max-old-space-size=512, and read large files or datasets in parts. Check usage with `cat /sys/fs/cgroup/memory.current` and `ps -eo pid,ppid,rss,args --sort=-rss | head`. Do not stop the preview dev server unless it is the cause; if you stop it, start it again with ensure_dev_server.",
      "</system-reminder>",
    ].join("\n")
  }

  const cache = new Map<string, { level: number; text: string }>()

  /** 같은 질문 안에서는 경고 단계가 올라갈 때만 문구를 바꿔, 스텝 사이 프롬프트 캐시를 깨지 않는다. */
  export async function text(userMessage: MessageV2.WithParts, paths: Paths = DEFAULT) {
    if (userMessage.info.role !== "user") return
    const cached = cache.get(userMessage.info.id)
    const current = await usage(paths).catch(() => undefined)
    const now = current ? level(current) : 0
    if (cached && cached.level >= now) return cached.text
    if (!current || now === 0) return
    const note = compose(current)
    if (cache.size > 100) cache.clear()
    cache.set(userMessage.info.id, { level: now, text: note })
    return note
  }
}
