import path from "node:path"
import z from "zod"
import type { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"

export namespace PlanDoc {
  export const Shape = z.object({
    title: z.string().max(40),
    tagline: z.string().max(80),
    problem: z.string().max(400),
    targetUsers: z.array(z.string().max(120)).max(4),
    userStories: z.array(z.string().max(140)).max(5),
    features: z
      .array(
        z.object({
          name: z.string().max(40),
          status: z.enum(["works", "planned", "unfinished"]),
        }),
      )
      .max(6),
    screens: z.array(z.string().max(80)).max(6),
    tech: z.object({ overview: z.string().max(240), data: z.string().max(240) }),
    changelog: z
      .array(
        z.object({
          kind: z.enum(["add", "fix", "rollback", "pivot"]),
          milestone: z.string().max(80),
          keptInFinal: z.boolean(),
        }),
      )
      .max(12),
    narrative: z.string(),
    caveats: z.array(z.string().max(140)),
    manualSlots: z.array(z.string().max(60)),
  })
  export type Shape = z.infer<typeof Shape>

  export const Result = z
    .object({
      title: z.string(),
      tagline: z.string(),
      body: z.string(),
      bodyNarrative: z.string(),
      manualSlots: z.string().array(),
      caveats: z.string().array(),
      sparse: z.boolean(),
    })
    .meta({ ref: "PlanDoc" })
  export type Result = z.infer<typeof Result>

  export const BLOCKS = [
    "title",
    "tagline",
    "problem",
    "targetUsers",
    "userStories",
    "features",
    "screens",
    "tech",
    "changelog",
    "narrative",
  ] as const
  export type Block = (typeof BLOCKS)[number]

  const CORE_BLOCKS: Block[] = ["problem", "userStories", "features"]

  const USER_TURN_CAP = 2_000
  const TRANSCRIPT_BUDGET = 100_000

  export function isBusy(messages: MessageV2.WithParts[]): boolean {
    const last = messages.at(-1)
    if (!last) return false
    const info = last.info
    return info.role === "assistant" && !info.time.completed && !info.error
  }

  export function selectPrimary(candidates: { id: string; userCount: number; updated: number }[]): string | undefined {
    let best: (typeof candidates)[number] | undefined
    for (const item of candidates) {
      if (
        !best ||
        item.userCount > best.userCount ||
        (item.userCount === best.userCount && item.updated > best.updated)
      )
        best = item
    }
    return best?.id
  }

  function relativize(file: string, root?: string) {
    if (root && path.isAbsolute(file)) {
      const rel = path.relative(root, file)
      if (rel && !rel.startsWith("..")) return rel
    }
    return file
  }

  export interface Serialized {
    transcript: string
    userCount: number
    toolEventCount: number
    degraded: boolean
  }

  export function serialize(messages: MessageV2.WithParts[], root?: string): Serialized {
    const lines: string[] = []
    let userCount = 0
    let toolEventCount = 0

    for (const msg of messages) {
      if (msg.info.role === "user") {
        const text = msg.parts
          .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => p.text)
          .join("\n")
          .trim()
        if (!text) continue
        userCount++
        lines.push(`[user] ${text.length > USER_TURN_CAP ? text.slice(0, USER_TURN_CAP) + "…" : text}`)
        continue
      }
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const metadata = part.state.metadata
        if ((part.tool === "write" || part.tool === "edit") && metadata["filediff"]) {
          const fd = metadata["filediff"] as Snapshot.FileDiff
          const status = fd.status ? ` (${fd.status})` : ""
          lines.push(`[${part.tool}] ${relativize(fd.file, root)} +${fd.additions} -${fd.deletions}${status}`)
          toolEventCount++
          continue
        }
        if (part.tool === "bash") {
          const input = part.state.input
          const label = String(input["description"] ?? input["command"] ?? "").slice(0, 200)
          lines.push(`[bash] ${label} exit=${metadata["exit"] ?? "?"}`)
          toolEventCount++
        }
      }
    }

    return {
      transcript: capTranscript(lines, TRANSCRIPT_BUDGET),
      userCount,
      toolEventCount,
      degraded: toolEventCount === 0,
    }
  }

  export function capTranscript(lines: string[], budget: number): string {
    const total = lines.reduce((sum, line) => sum + line.length + 2, 0)
    if (total <= budget) return lines.join("\n\n")

    const tail: string[] = []
    let used = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = lines[i].length + 2
      if (used + cost > budget * 0.7) break
      tail.unshift(lines[i])
      used += cost
    }
    const head: string[] = []
    for (let i = 0; i < lines.length - tail.length; i++) {
      const cost = lines[i].length + 2
      if (used + cost > budget) break
      head.push(lines[i])
      used += cost
    }
    if (head.length + tail.length === lines.length) return [...head, ...tail].join("\n\n")
    return [...head, "... (중략) ...", ...tail].join("\n\n")
  }

  export function renderNetDiff(diffs: Snapshot.FileDiff[], root?: string): string {
    if (diffs.length === 0) return ""
    const lines = diffs.map((d) => {
      const status = d.status ?? "modified"
      return `${relativize(d.file, root)} [${status}] +${d.additions} -${d.deletions}`
    })
    return ["세션 순변경(최종 잔존 파일 — 중간에 되돌린 변경은 여기 없음):", ...lines].join("\n")
  }

  export function bannedTerms(input: { files: string[]; dependencies: string[] }): string[] {
    const terms = new Set<string>()
    for (const file of input.files) {
      const base = path.basename(file)
      if (base.length >= 3) terms.add(base)
    }
    for (const dep of input.dependencies) {
      if (dep.length >= 3) terms.add(dep)
    }
    return [...terms]
  }

  const NUMERIC_PATTERNS = [/\d[\d,.]*\s*(%|퍼센트)/, /\d[\d,.]*\s*배/, /\d[\d,.]*\s*명/]
  const SUPERLATIVES = ["최고", "혁신", "완벽", "최초", "압도적"]
  const AI_CLAIM = /(AI|인공지능)\s*(가|이|은|는)?\s*(분석|추천|설계|학습)/

  function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function termPattern(term: string) {
    return new RegExp(`(?<![\\w.@/-])${escapeRegExp(term)}(?![\\w.@/-])`, "i")
  }

  export function checkText(text: string, terms: string[]): string | undefined {
    for (const pattern of NUMERIC_PATTERNS) {
      if (pattern.test(text)) return "근거 없는 수치"
    }
    for (const word of SUPERLATIVES) {
      if (text.includes(word)) return `최상급 표현("${word}")`
    }
    if (AI_CLAIM.test(text)) return "AI 동작 원리 단정"
    for (const term of terms) {
      if (termPattern(term).test(text)) return `기술 용어("${term}")`
    }
    return undefined
  }

  export function splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?…])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  export interface Violation {
    block: Block
    text: string
    reason: string
  }

  export function findViolations(shape: Shape, terms: string[]): Violation[] {
    const out: Violation[] = []
    const check = (block: Block, text: string) => {
      for (const sentence of splitSentences(text)) {
        const reason = checkText(sentence, terms)
        if (reason) out.push({ block, text: sentence, reason })
      }
    }
    check("title", shape.title)
    check("tagline", shape.tagline)
    check("problem", shape.problem)
    for (const item of shape.targetUsers) check("targetUsers", item)
    for (const item of shape.userStories) check("userStories", item)
    for (const item of shape.features) check("features", item.name)
    for (const item of shape.screens) check("screens", item)
    check("tech", shape.tech.overview)
    check("tech", shape.tech.data)
    for (const item of shape.changelog) check("changelog", item.milestone)
    check("narrative", shape.narrative)
    return out
  }

  function stripProse(text: string, terms: string[]): { text: string; removed: number } {
    let removed = 0
    const kept = text
      .split("\n")
      .map((line) =>
        line
          .split(/(?<=[.!?…])\s+/)
          .filter((sentence) => {
            if (!sentence.trim()) return true
            if (checkText(sentence, terms)) {
              removed++
              return false
            }
            return true
          })
          .join(" "),
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
    return { text: kept.trim(), removed }
  }

  export function stripViolations(shape: Shape, terms: string[]): { shape: Shape; caveats: string[] } {
    const caveats: string[] = []
    let removed = 0
    const next: Shape = structuredClone(shape)

    if (checkText(next.title, terms)) {
      next.title = ""
      removed++
    }
    if (checkText(next.tagline, terms)) {
      next.tagline = ""
      removed++
    }

    for (const key of ["problem", "narrative"] as const) {
      const result = stripProse(next[key], terms)
      next[key] = result.text
      removed += result.removed
    }
    for (const key of ["overview", "data"] as const) {
      const result = stripProse(next.tech[key], terms)
      next.tech[key] = result.text
      removed += result.removed
    }

    const keepItem = (text: string) => {
      if (checkText(text, terms)) {
        removed++
        return false
      }
      return true
    }
    next.targetUsers = next.targetUsers.filter(keepItem)
    next.userStories = next.userStories.filter(keepItem)
    next.features = next.features.filter((f) => keepItem(f.name))
    next.screens = next.screens.filter(keepItem)
    next.changelog = next.changelog.filter((c) => keepItem(c.milestone))

    if (removed > 0) caveats.push(`검증 규칙에 걸린 문장 ${removed}건을 자동으로 뺐어요. 직접 확인해 주세요.`)
    return { shape: next, caveats }
  }

  export function normalizeSlots(slots: string[]): string[] {
    const known = new Set<string>(BLOCKS)
    return [...new Set(slots.filter((slot) => known.has(slot)))]
  }

  export function computeSparse(slots: string[]): boolean {
    return CORE_BLOCKS.some((block) => slots.includes(block))
  }

  const SLOT_PLACEHOLDER = "_(여기에 직접 적어주세요)_"

  function emptySlots(shape: Shape): Block[] {
    const slots: Block[] = []
    if (!shape.title.trim()) slots.push("title")
    if (!shape.tagline.trim()) slots.push("tagline")
    if (!shape.problem.trim()) slots.push("problem")
    if (shape.targetUsers.length === 0) slots.push("targetUsers")
    if (shape.userStories.length === 0) slots.push("userStories")
    if (shape.features.length === 0) slots.push("features")
    if (shape.screens.length === 0) slots.push("screens")
    if (!shape.tech.overview.trim() && !shape.tech.data.trim()) slots.push("tech")
    if (shape.changelog.length === 0) slots.push("changelog")
    if (!shape.narrative.trim()) slots.push("narrative")
    return slots
  }

  const FEATURE_STATUS: Record<Shape["features"][number]["status"], string> = {
    works: "동작",
    planned: "계획",
    unfinished: "미완",
  }

  const CHANGELOG_KIND: Record<Shape["changelog"][number]["kind"], string> = {
    add: "추가",
    fix: "수정",
    rollback: "철회",
    pivot: "방향 전환",
  }

  export function render(shape: Shape, slots: string[]): string {
    const has = (block: Block) => !slots.includes(block)
    const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n")

    const sections: string[] = []
    sections.push("## 1. 유저 스토리 기획서")
    sections.push("### 풀고 싶은 문제")
    sections.push(has("problem") ? shape.problem : SLOT_PLACEHOLDER)
    sections.push("### 타겟 사용자")
    sections.push(has("targetUsers") ? list(shape.targetUsers) : SLOT_PLACEHOLDER)
    sections.push("### 유저 스토리")
    sections.push(has("userStories") ? list(shape.userStories) : SLOT_PLACEHOLDER)
    sections.push("### 주요 기능")
    sections.push(
      has("features")
        ? shape.features.map((f) => `- ${f.name} (${FEATURE_STATUS[f.status]})`).join("\n")
        : SLOT_PLACEHOLDER,
    )
    sections.push("### 화면 구성")
    sections.push(has("screens") ? list(shape.screens) : SLOT_PLACEHOLDER)

    sections.push("## 2. 기술 구조")
    sections.push("### 구조 개요")
    sections.push(has("tech") && shape.tech.overview.trim() ? shape.tech.overview : SLOT_PLACEHOLDER)
    sections.push("### 데이터")
    sections.push(has("tech") && shape.tech.data.trim() ? shape.tech.data : SLOT_PLACEHOLDER)

    sections.push("## 3. 변경 이력")
    sections.push(
      has("changelog")
        ? shape.changelog
            .map((c) => `- [${CHANGELOG_KIND[c.kind]}] ${c.milestone}${c.kind === "rollback" ? " (시도 후 철회)" : ""}`)
            .join("\n")
        : SLOT_PLACEHOLDER,
    )

    return sections.join("\n\n") + "\n"
  }

  export function finalize(shape: Shape, extraCaveats: string[] = []): Result {
    const slots = [...new Set([...normalizeSlots(shape.manualSlots), ...emptySlots(shape)])]
    const caveats = [...new Set([...shape.caveats, ...extraCaveats])]
    const narrative = slots.includes("narrative") ? SLOT_PLACEHOLDER : shape.narrative
    return {
      title: shape.title,
      tagline: shape.tagline,
      body: render(shape, slots),
      bodyNarrative: narrative,
      manualSlots: slots,
      caveats,
      sparse: computeSparse(slots),
    }
  }

  export function empty(): Shape {
    return {
      title: "",
      tagline: "",
      problem: "",
      targetUsers: [],
      userStories: [],
      features: [],
      screens: [],
      tech: { overview: "", data: "" },
      changelog: [],
      narrative: "",
      caveats: [],
      manualSlots: [],
    }
  }

  export function skeleton(caveat: string): Result {
    const shape = empty()
    shape.caveats = [caveat]
    return finalize(shape)
  }
}
