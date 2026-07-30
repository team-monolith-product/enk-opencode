import path from "node:path"
import z from "zod"
import type { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"

export namespace PlanDoc {
  // 길이·개수 상한은 스키마에 걸지 않는다. 상한을 걸면 초과분 한 곳 때문에
  // generateObject 가 응답 전체를 거부해 생성이 실패한다. 생성 후 clamp 로 다듬는다.
  export const Shape = z.object({
    title: z.string(),
    tagline: z.string(),
    problem: z.string(),
    targetUsers: z.array(z.string()),
    userStories: z.array(z.string()),
    features: z.array(
      z.object({
        name: z.string(),
        status: z.enum(["works", "planned", "unfinished"]),
      }),
    ),
    screens: z.array(z.string()),
    tech: z.object({ overview: z.string(), data: z.string() }),
    changelog: z.array(
      z.object({
        kind: z.enum(["add", "fix", "rollback", "pivot"]),
        milestone: z.string(),
        keptInFinal: z.boolean(),
      }),
    ),
    narrative: z.string(),
    caveats: z.array(z.string()),
  })
  export type Shape = z.infer<typeof Shape>

  // chars 는 항목 하나의 글자 수, count 는 목록 길이 상한.
  export const LIMITS = {
    title: { chars: 60 },
    tagline: { chars: 120 },
    problem: { chars: 600 },
    targetUsers: { chars: 160, count: 5 },
    userStories: { chars: 200, count: 6 },
    features: { chars: 60, count: 8 },
    screens: { chars: 120, count: 8 },
    tech: { chars: 600 },
    changelog: { chars: 120, count: 16 },
    caveats: { chars: 240, count: 8 },
    manualSlots: { count: 10 },
  } as const

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
  export const PLAN_FILE_BUDGET = 20_000

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
    degraded: boolean
  }

  export function serialize(messages: MessageV2.WithParts[], root?: string): Serialized {
    const lines: string[] = []
    let toolEventCount = 0

    for (const msg of messages) {
      if (msg.info.role === "user") {
        const text = msg.parts
          .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => p.text)
          .join("\n")
          .trim()
        if (!text) continue
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

  export function capText(text: string, budget: number): string {
    if (text.length <= budget) return text
    return text.slice(0, budget) + "\n... (중략) ..."
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
  const AI_CLAIM = /(AI|인공지능)\s*(가|이|은|는)?\s*(분석|추천|설계|학습)/i

  function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  export interface Gate {
    check(text: string): string | undefined
  }

  // 금지 용어는 파일·의존성 이름 수백 개라, 문장마다 새 RegExp 를 만들면 비용이 크다.
  // 한 번만 교차 패턴으로 합쳐 두고 문장마다 재사용한다.
  export function gate(terms: string[]): Gate {
    const sorted = [...terms].sort((a, b) => b.length - a.length)
    const pattern =
      sorted.length > 0
        ? new RegExp(`(?<![\\w.@/-])(?:${sorted.map(escapeRegExp).join("|")})(?![\\w.@/-])`, "i")
        : undefined
    return {
      check(text: string) {
        for (const numeric of NUMERIC_PATTERNS) {
          if (numeric.test(text)) return "근거 없는 수치"
        }
        for (const word of SUPERLATIVES) {
          if (text.includes(word)) return `최상급 표현("${word}")`
        }
        if (AI_CLAIM.test(text)) return "AI 동작 원리 단정"
        const hit = pattern?.exec(text)
        if (hit) return `기술 용어("${hit[0]}")`
        return undefined
      },
    }
  }

  export function splitSentences(text: string): string[] {
    return text
      .split(/(?<=[.!?…])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  // 문장 경계에서 자르고, 첫 문장부터 넘치면 단어 경계에서 자른 뒤 말줄임을 붙인다.
  export function truncate(text: string, limit: number): string {
    const trimmed = text.trim()
    if (trimmed.length <= limit) return trimmed

    const kept: string[] = []
    for (const sentence of splitSentences(trimmed)) {
      if ([...kept, sentence].join(" ").length > limit) break
      kept.push(sentence)
    }
    if (kept.length > 0) return kept.join(" ")

    const head = trimmed.slice(0, limit - 1)
    if (/\s/.test(trimmed.charAt(limit - 1))) return `${head.trimEnd()}…`

    const boundary = head.lastIndexOf(" ")
    return `${(boundary > limit / 2 ? head.slice(0, boundary) : head).trimEnd()}…`
  }

  export function clamp(shape: Shape): Shape {
    return {
      title: truncate(shape.title, LIMITS.title.chars),
      tagline: truncate(shape.tagline, LIMITS.tagline.chars),
      problem: truncate(shape.problem, LIMITS.problem.chars),
      targetUsers: shape.targetUsers
        .slice(0, LIMITS.targetUsers.count)
        .map((t) => truncate(t, LIMITS.targetUsers.chars)),
      userStories: shape.userStories
        .slice(0, LIMITS.userStories.count)
        .map((s) => truncate(s, LIMITS.userStories.chars)),
      features: shape.features
        .slice(0, LIMITS.features.count)
        .map((f) => ({ ...f, name: truncate(f.name, LIMITS.features.chars) })),
      screens: shape.screens.slice(0, LIMITS.screens.count).map((s) => truncate(s, LIMITS.screens.chars)),
      tech: {
        overview: truncate(shape.tech.overview, LIMITS.tech.chars),
        data: truncate(shape.tech.data, LIMITS.tech.chars),
      },
      changelog: shape.changelog
        .slice(0, LIMITS.changelog.count)
        .map((c) => ({ ...c, milestone: truncate(c.milestone, LIMITS.changelog.chars) })),
      narrative: shape.narrative.trim(),
      caveats: shape.caveats.slice(0, LIMITS.caveats.count).map((c) => truncate(c, LIMITS.caveats.chars)),
    }
  }

  export type GateField = Block | "caveats"

  export interface Removed {
    block: GateField
    text: string
    reason: string
  }

  export function strip(shape: Shape, gate: Gate): { shape: Shape; removed: Removed[] } {
    const removed: Removed[] = []
    const next: Shape = structuredClone(shape)

    const keep = (block: GateField, text: string) => {
      const reason = gate.check(text)
      if (!reason) return true
      removed.push({ block, text, reason })
      return false
    }
    // 위반이 없으면 원문을 그대로 돌려준다. 문장 재조립은 서사의 문단 구분을 지우므로
    // 실제로 뺀 문장이 있을 때만 감수한다.
    const scrub = (block: GateField, text: string) => {
      const kept: string[] = []
      let hit = false
      for (const sentence of splitSentences(text)) {
        if (keep(block, sentence)) kept.push(sentence)
        else hit = true
      }
      return hit ? kept.join(" ") : text
    }

    if (!keep("title", next.title)) next.title = ""
    if (!keep("tagline", next.tagline)) next.tagline = ""
    next.problem = scrub("problem", next.problem)
    next.narrative = scrub("narrative", next.narrative)
    next.tech.overview = scrub("tech", next.tech.overview)
    next.tech.data = scrub("tech", next.tech.data)
    next.targetUsers = next.targetUsers.filter((item) => keep("targetUsers", item))
    next.userStories = next.userStories.filter((item) => keep("userStories", item))
    next.features = next.features.filter((item) => keep("features", item.name))
    next.screens = next.screens.filter((item) => keep("screens", item))
    next.changelog = next.changelog.filter((item) => keep("changelog", item.milestone))
    next.caveats = next.caveats.filter((item) => keep("caveats", item))

    return { shape: next, removed }
  }

  export function computeSparse(slots: string[]): boolean {
    return CORE_BLOCKS.some((block) => slots.includes(block))
  }

  const SLOT_LABEL: Record<Block, string> = {
    title: "제목",
    tagline: "한 줄 소개",
    problem: "풀고 싶은 문제",
    targetUsers: "타겟 사용자",
    userStories: "유저 스토리",
    features: "핵심 기능",
    screens: "화면 흐름",
    tech: "기술 구조",
    changelog: "변경 이력",
    narrative: "만든 이야기",
  }

  export function slotMarker(block: Block): string {
    return `[[빈칸: ${SLOT_LABEL[block]}]]`
  }

  export function emptySlots(shape: Shape): Block[] {
    const slots: Block[] = []
    if (!shape.title.trim()) slots.push("title")
    if (!shape.tagline.trim()) slots.push("tagline")
    if (!shape.problem.trim()) slots.push("problem")
    if (shape.targetUsers.length === 0) slots.push("targetUsers")
    if (shape.userStories.length === 0) slots.push("userStories")
    if (shape.features.length === 0) slots.push("features")
    if (shape.screens.length === 0) slots.push("screens")
    if (!shape.tech.overview.trim() || !shape.tech.data.trim()) slots.push("tech")
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

  export function render(shape: Shape): string {
    const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n")

    const sections: string[] = []
    sections.push("## 1. 유저 스토리 기획서")
    sections.push("### 풀고 싶은 문제")
    sections.push(shape.problem.trim() ? shape.problem : slotMarker("problem"))
    sections.push("### 타겟 사용자")
    sections.push(shape.targetUsers.length > 0 ? list(shape.targetUsers) : slotMarker("targetUsers"))
    sections.push("### 유저 스토리")
    sections.push(shape.userStories.length > 0 ? list(shape.userStories) : slotMarker("userStories"))
    sections.push("### 핵심 기능")
    sections.push(
      shape.features.length > 0
        ? shape.features.map((f) => `- ${f.name} (${FEATURE_STATUS[f.status]})`).join("\n")
        : slotMarker("features"),
    )
    sections.push("### 화면 흐름")
    sections.push(shape.screens.length > 0 ? list(shape.screens) : slotMarker("screens"))

    sections.push("## 2. 기술 구조")
    sections.push("### 구조 개요")
    sections.push(shape.tech.overview.trim() ? shape.tech.overview : slotMarker("tech"))
    sections.push("### 데이터")
    sections.push(shape.tech.data.trim() ? shape.tech.data : slotMarker("tech"))

    sections.push("## 3. 변경 이력")
    sections.push(
      shape.changelog.length > 0
        ? shape.changelog
            .map((c) => `- [${CHANGELOG_KIND[c.kind]}] ${c.milestone}${c.kind === "rollback" ? " (시도 후 철회)" : ""}`)
            .join("\n")
        : slotMarker("changelog"),
    )

    return sections.join("\n\n") + "\n"
  }

  // 주의사항은 응답 필드로만 두면 문서를 그대로 옮겨 쓰는 곳에서 사라진다. 본문 끝에도 함께 적는다.
  export function withCaveats(body: string, caveats: string[]): string {
    if (caveats.length === 0) return body
    return `${body}\n## 한계\n\n${caveats.map((c) => `- ${c}`).join("\n")}\n`
  }

  export function finalize(shape: Shape, extraCaveats: string[] = []): Result {
    const slots = emptySlots(shape).slice(0, LIMITS.manualSlots.count)
    const caveats = [...new Set([...shape.caveats, ...extraCaveats])].slice(0, LIMITS.caveats.count)
    const narrative = shape.narrative.trim() ? shape.narrative : slotMarker("narrative")
    return {
      title: shape.title,
      tagline: shape.tagline,
      body: withCaveats(render(shape), caveats),
      bodyNarrative: withCaveats(narrative, caveats),
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
    }
  }

  export function skeleton(caveat: string): Result {
    const shape = empty()
    shape.caveats = [caveat]
    return finalize(shape)
  }
}
