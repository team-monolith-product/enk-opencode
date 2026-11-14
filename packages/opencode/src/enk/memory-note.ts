import { readFile } from "node:fs/promises"
import type { MessageV2 } from "@/session/message-v2"

export namespace MemoryNote {
  type Kill = { type: "kill"; time: number; usedMb: number; limitMb: number; cmd: string; mb: number }
  type Warn = { type: "warn"; time: number; usedMb: number; limitMb: number; top: { cmd: string; mb: number }[] }
  type Event = Kill | Warn

  const WARN_FRESH_MS = 2 * 60_000

  export function file() {
    return process.env["ENK_MEMORY_GUARD_FILE"] || "/tmp/opencode-memory-guard.jsonl"
  }

  export async function events(path = file()): Promise<Event[]> {
    const text = await readFile(path, "utf8").catch(() => "")
    const out: Event[] = []
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const event = JSON.parse(line)
        if (event?.type === "kill" || event?.type === "warn") out.push(event)
      } catch {}
    }
    return out
  }

  export function compose(all: Event[], since: number, now = Date.now()) {
    const kills = all.filter((e): e is Kill => e.type === "kill" && e.time >= since)
    const warn = all.findLast((e): e is Warn => e.type === "warn" && e.time >= since && now - e.time <= WARN_FRESH_MS)
    if (kills.length === 0 && !warn) return

    const lines = ["<system-reminder>"]
    if (kills.length) {
      const last = kills[kills.length - 1]!
      lines.push(
        `The workspace container ran out of memory (${last.usedMb} MB of ${last.limitMb} MB) and the memory guard force-stopped these processes to keep you running:`,
        ...kills.map((k) => `- \`${k.cmd}\` (${k.mb} MB)`),
        "Tell the user in one short, plain sentence which program was stopped and why. Do not rerun the same heavy command unchanged.",
      )
    } else if (warn) {
      lines.push(
        `Workspace memory is high: ${warn.usedMb} MB of ${warn.limitMb} MB. The largest programs right now:`,
        ...warn.top.map((t) => `- \`${t.cmd}\` (${t.mb} MB)`),
        "If memory reaches the limit, the largest program will be force-stopped.",
      )
    }
    lines.push(
      "To stay under the limit: run one heavy job at a time, stop dev servers or watchers you no longer need, cap Node builds with NODE_OPTIONS=--max-old-space-size=512, and avoid loading large files or datasets into memory at once. If the preview dev server was stopped, start it again with ensure_dev_server.",
      "</system-reminder>",
    )
    return lines.join("\n")
  }

  const cache = new Map<string, { kills: number; text: string }>()

  export async function text(userMessage: MessageV2.WithParts) {
    if (userMessage.info.role !== "user") return
    const since = userMessage.info.time.created
    const all = await events()
    const kills = all.filter((e) => e.type === "kill" && e.time >= since).length
    const cached = cache.get(userMessage.info.id)
    if (cached && cached.kills === kills) return cached.text
    const note = compose(all, since)
    if (!note) return
    if (cache.size > 100) cache.clear()
    cache.set(userMessage.info.id, { kills, text: note })
    return note
  }
}
