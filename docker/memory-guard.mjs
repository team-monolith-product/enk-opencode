import { appendFileSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const CGROUP = process.env.ENK_MEMORY_GUARD_CGROUP || "/sys/fs/cgroup"
const PROC = process.env.ENK_MEMORY_GUARD_PROC || "/proc"
export const EVENTS_FILE = process.env.ENK_MEMORY_GUARD_FILE || "/tmp/opencode-memory-guard.jsonl"

const MB = 1024 * 1024

export const config = {
  root: Number(process.env.ENK_MEMORY_GUARD_ROOT_PID || 1),
  killRatio: Number(process.env.ENK_MEMORY_GUARD_KILL_RATIO || 0.9),
  warnRatio: Number(process.env.ENK_MEMORY_GUARD_WARN_RATIO || 0.75),
  intervalMs: Number(process.env.ENK_MEMORY_GUARD_INTERVAL_MS || 500),
  minVictimBytes: Number(process.env.ENK_MEMORY_GUARD_MIN_VICTIM_MB || 64) * MB,
  cooldownMs: 3000,
  warnEveryMs: 60_000,
  adjustEveryMs: 5000,
  maxEventsBytes: 64 * 1024,
}

function read(path) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

export function parseMemoryStat(text) {
  const stat = {}
  for (const line of text.split("\n")) {
    const [key, value] = line.split(" ")
    if (key && value) stat[key] = Number(value)
  }
  return stat
}

export function cgroupUsage(cgroup = CGROUP) {
  const max = read(`${cgroup}/memory.max`)?.trim()
  if (!max || max === "max") return
  const stat = read(`${cgroup}/memory.stat`)
  if (!stat) return
  const s = parseMemoryStat(stat)
  const used = (s.anon ?? 0) + (s.shmem ?? 0) + Math.max(0, (s.kernel ?? 0) - (s.slab_reclaimable ?? 0))
  return { used, limit: Number(max) }
}

export function parseProcStatus(text) {
  const out = {}
  for (const line of text.split("\n")) {
    const at = line.indexOf(":")
    if (at < 0) continue
    out[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return {
    ppid: Number(out.PPid),
    name: out.Name ?? "",
    anon: Number((out.RssAnon ?? "0").split(" ")[0]) * 1024 + Number((out.RssShmem ?? "0").split(" ")[0]) * 1024,
  }
}

export function listProcesses(proc = PROC) {
  const list = []
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue
    const status = read(`${proc}/${entry}/status`)
    if (!status) continue
    const cmdline = (read(`${proc}/${entry}/cmdline`) ?? "").split("\0").filter(Boolean).join(" ")
    list.push({ pid: Number(entry), ...parseProcStatus(status), cmd: cmdline })
  }
  return list
}

export function subtrees(processes, root, exclude = []) {
  const byParent = new Map()
  for (const p of processes) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, [])
    byParent.get(p.ppid).push(p)
  }
  const skip = new Set(exclude)
  const out = []
  for (const top of byParent.get(root) ?? []) {
    if (skip.has(top.pid)) continue
    const members = []
    const stack = [top]
    while (stack.length) {
      const p = stack.pop()
      if (skip.has(p.pid)) continue
      members.push(p)
      stack.push(...(byParent.get(p.pid) ?? []))
    }
    const largest = members.reduce((a, b) => (b.anon > a.anon ? b : a))
    out.push({
      pid: top.pid,
      pids: members.map((m) => m.pid),
      anon: members.reduce((sum, m) => sum + m.anon, 0),
      cmd: (largest.cmd || largest.name).slice(0, 200),
      count: members.length,
    })
  }
  return out.sort((a, b) => b.anon - a.anon)
}

export function pickVictim(trees, minBytes = config.minVictimBytes) {
  const top = trees[0]
  if (!top || top.anon < minBytes) return
  return top
}

function killTree(tree) {
  for (const pid of tree.pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

function raiseOomScore(processes, root) {
  for (const p of processes) {
    if (p.pid === root || p.pid === process.pid) continue
    const path = `${PROC}/${p.pid}/oom_score_adj`
    if (read(path)?.trim() === "1000") continue
    try {
      writeFileSync(path, "1000")
    } catch {}
  }
}

export function record(event, file = EVENTS_FILE) {
  try {
    if (statSync(file, { throwIfNoEntry: false })?.size > config.maxEventsBytes) {
      const lines = readFileSync(file, "utf8").trim().split("\n").slice(-20)
      writeFileSync(`${file}.tmp`, lines.join("\n") + "\n")
      renameSync(`${file}.tmp`, file)
    }
    appendFileSync(file, JSON.stringify(event) + "\n")
  } catch {}
}

const summary = (trees) => trees.slice(0, 3).map((t) => ({ cmd: t.cmd, mb: Math.round(t.anon / MB) }))

export function tick(state, now = Date.now()) {
  const usage = cgroupUsage()
  if (!usage) return
  const ratio = usage.used / usage.limit
  const needAdjust = now - state.adjustedAt >= config.adjustEveryMs
  if (ratio < config.warnRatio && !needAdjust) return

  const processes = listProcesses()
  if (needAdjust) {
    raiseOomScore(processes, config.root)
    state.adjustedAt = now
  }
  if (ratio < config.warnRatio) return

  const trees = subtrees(processes, config.root, [process.pid])
  const base = {
    time: now,
    usedMb: Math.round(usage.used / MB),
    limitMb: Math.round(usage.limit / MB),
  }
  if (ratio >= config.killRatio && now - state.killedAt >= config.cooldownMs) {
    const victim = pickVictim(trees)
    if (victim) {
      killTree(victim)
      state.killedAt = now
      record({ ...base, type: "kill", cmd: victim.cmd, mb: Math.round(victim.anon / MB), count: victim.count })
      return
    }
  }
  if (now - state.warnedAt >= config.warnEveryMs) {
    state.warnedAt = now
    record({ ...base, type: "warn", top: summary(trees) })
  }
}

export function start() {
  if (!cgroupUsage()) return false
  const state = { killedAt: 0, warnedAt: 0, adjustedAt: 0 }
  setInterval(() => {
    try {
      tick(state)
    } catch {}
  }, config.intervalMs)
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!start()) process.exit(0)
}
