import { describe, expect, test } from "bun:test"
import { PlanDoc } from "../../src/enk/plan-doc"
import type { MessageV2 } from "../../src/session/message-v2"

function userMessage(texts: { text: string; synthetic?: boolean; ignored?: boolean }[]): MessageV2.WithParts {
  return {
    info: { role: "user", time: { created: 1 } },
    parts: texts.map((t) => ({ type: "text", ...t })),
  } as unknown as MessageV2.WithParts
}

function assistantMessage(parts: unknown[], info: Record<string, unknown> = {}): MessageV2.WithParts {
  return {
    info: { role: "assistant", time: { created: 1, completed: 2 }, ...info },
    parts,
  } as unknown as MessageV2.WithParts
}

function toolPart(tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>) {
  return { type: "tool", tool, state: { status: "completed", input, metadata } }
}

describe("PlanDoc.serialize", () => {
  test("keeps user text, drops synthetic and ignored", () => {
    const result = PlanDoc.serialize([
      userMessage([
        { text: "투두앱 만들어줘" },
        { text: "plan reminder", synthetic: true },
        { text: "숨김", ignored: true },
      ]),
    ])
    expect(result.transcript).toBe("[user] 투두앱 만들어줘")
  })

  test("excludes assistant text, includes filediff and bash exit", () => {
    const result = PlanDoc.serialize(
      [
        userMessage([{ text: "시작" }]),
        assistantMessage([
          { type: "text", text: "고쳤습니다" },
          toolPart("write", {}, { filediff: { file: "/ws/src/app.py", additions: 10, deletions: 0, status: "added" } }),
          toolPart("edit", {}, { filediff: { file: "/ws/src/app.py", additions: 3, deletions: 2 } }),
          toolPart("bash", { description: "서버 실행" }, { exit: 0 }),
        ]),
      ],
      "/ws",
    )
    expect(result.transcript).not.toContain("고쳤습니다")
    expect(result.transcript).toContain("[write] src/app.py +10 -0 (added)")
    expect(result.transcript).toContain("[edit] src/app.py +3 -2")
    expect(result.transcript).toContain("[bash] 서버 실행 exit=0")
    expect(result.degraded).toBe(false)
  })

  test("marks degraded when no tool events", () => {
    const result = PlanDoc.serialize([userMessage([{ text: "안녕" }])])
    expect(result.degraded).toBe(true)
  })

  test("skips incomplete tool parts", () => {
    const result = PlanDoc.serialize([
      assistantMessage([{ type: "tool", tool: "bash", state: { status: "running", input: {} } }]),
    ])
    expect(result.degraded).toBe(true)
  })
})

describe("PlanDoc.capTranscript", () => {
  test("joins as-is under budget", () => {
    expect(PlanDoc.capTranscript(["a", "b"], 100)).toBe("a\n\nb")
  })

  test("keeps head and tail with marker over budget", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-${"x".repeat(50)}`)
    const result = PlanDoc.capTranscript(lines, 1000)
    expect(result).toContain("... (중략) ...")
    expect(result).toContain("line-99")
    expect(result.length).toBeLessThan(1500)
  })
})

describe("PlanDoc.capText", () => {
  test("passes through under budget and marks truncation over it", () => {
    expect(PlanDoc.capText("짧은 계획", 100)).toBe("짧은 계획")
    const capped = PlanDoc.capText("가".repeat(200), 50)
    expect(capped.startsWith("가".repeat(50))).toBe(true)
    expect(capped).toContain("... (중략) ...")
  })
})

describe("PlanDoc.selectPrimary", () => {
  test("picks max user count, breaks tie by recency", () => {
    expect(
      PlanDoc.selectPrimary([
        { id: "a", userCount: 3, updated: 100 },
        { id: "b", userCount: 10, updated: 50 },
        { id: "c", userCount: 3, updated: 200 },
      ]),
    ).toBe("b")
    expect(
      PlanDoc.selectPrimary([
        { id: "a", userCount: 3, updated: 100 },
        { id: "c", userCount: 3, updated: 200 },
      ]),
    ).toBe("c")
    expect(PlanDoc.selectPrimary([])).toBeUndefined()
  })
})

describe("PlanDoc.bannedTerms", () => {
  test("collects basenames and dependency names of length >= 3", () => {
    const terms = PlanDoc.bannedTerms({
      files: ["src/App.tsx", "src/ab"],
      dependencies: ["react", "ai", "zod"],
    })
    expect(terms).toContain("App.tsx")
    expect(terms).toContain("react")
    expect(terms).toContain("zod")
    expect(terms).not.toContain("ai")
    expect(terms).not.toContain("ab")
  })
})

describe("PlanDoc.gate", () => {
  test("detects unfounded numbers", () => {
    expect(PlanDoc.gate([]).check("정확도를 30% 올렸다")).toBe("근거 없는 수치")
    expect(PlanDoc.gate([]).check("속도가 2배 빨라졌다")).toBe("근거 없는 수치")
    expect(PlanDoc.gate([]).check("사용자 100명이 쓴다")).toBe("근거 없는 수치")
    expect(PlanDoc.gate([]).check("3명의 팀원")).toBeDefined()
  })

  test("detects superlatives and AI claims", () => {
    expect(PlanDoc.gate([]).check("최고의 앱")).toContain("최상급")
    expect(PlanDoc.gate([]).check("AI가 분석해서 알려준다")).toBe("AI 동작 원리 단정")
    expect(PlanDoc.gate([]).check("인공지능이 학습한 결과")).toBe("AI 동작 원리 단정")
  })

  test("detects banned terms with word boundaries", () => {
    const terms = ["react", "App.tsx"]
    expect(PlanDoc.gate(terms).check("react로 만든 화면")).toContain("react")
    expect(PlanDoc.gate(terms).check("App.tsx 파일을 수정")).toContain("App.tsx")
    expect(PlanDoc.gate(terms).check("reaction이 좋았다")).toBeUndefined()
    expect(PlanDoc.gate(terms).check("문제를 푸는 서비스")).toBeUndefined()
  })
})

function baseShape(): PlanDoc.Shape {
  return {
    ...PlanDoc.empty(),
    title: "우리 동네 알리미",
    tagline: "동네 소식을 모아 보여준다",
    problem: "소식이 흩어져 있어 찾기 어렵다.",
    targetUsers: ["동네 주민"],
    userStories: ["주민은 소식을 한곳에서 본다"],
    features: [
      { name: "소식 모아보기", status: "works" as const },
      { name: "알림", status: "planned" as const },
    ],
    screens: ["홈 화면"],
    tech: { overview: "화면과 저장소로 나뉜다.", data: "소식 목록을 저장한다." },
    changelog: [
      { kind: "add" as const, milestone: "소식 목록 첫 화면", keptInFinal: true },
      { kind: "rollback" as const, milestone: "지도 붙이기 시도", keptInFinal: false },
    ],
    narrative: "처음에는 문제를 정의했다.\n\n그 다음 화면을 만들었다.",
  }
}

describe("PlanDoc.truncate / clamp", () => {
  test("keeps text within the limit untouched", () => {
    expect(PlanDoc.truncate("짧은 문장이다.", 60)).toBe("짧은 문장이다.")
  })

  test("cuts at a sentence boundary when possible", () => {
    const text = "첫 문장이다. 두 번째 문장은 길어서 상한을 넘긴다."
    expect(PlanDoc.truncate(text, 20)).toBe("첫 문장이다.")
  })

  test("falls back to a word boundary with an ellipsis", () => {
    const result = PlanDoc.truncate("aaaa bbbb cccc dddd eeee ffff", 20)
    expect(result.length).toBeLessThanOrEqual(20)
    expect(result.endsWith("…")).toBe(true)
    expect(result).toBe("aaaa bbbb cccc dddd…")
  })

  test("clamps over-long prose instead of failing", () => {
    const long = `${"가".repeat(400)}. ${"나".repeat(400)}.`
    const shape = { ...baseShape(), tech: { overview: long, data: long } }
    const clamped = PlanDoc.clamp(shape)

    expect(clamped.tech.overview.length).toBeLessThanOrEqual(PlanDoc.LIMITS.tech.chars)
    expect(clamped.tech.data.length).toBeLessThanOrEqual(PlanDoc.LIMITS.tech.chars)
  })

  test("slices over-long lists to their limits", () => {
    const shape = {
      ...baseShape(),
      features: Array.from({ length: 12 }, (_, i) => ({ name: `기능 ${i}`, status: "works" as const })),
      screens: Array.from({ length: 12 }, (_, i) => `화면 ${i}`),
    }
    const clamped = PlanDoc.clamp(shape)

    expect(clamped.features).toHaveLength(PlanDoc.LIMITS.features.count)
    expect(clamped.screens).toHaveLength(PlanDoc.LIMITS.screens.count)
  })

  test("accepts output that the previous hard schema rejected", () => {
    const shape = { ...baseShape(), tech: { overview: "가".repeat(420), data: "나".repeat(420) } }

    expect(() => PlanDoc.Shape.parse(shape)).not.toThrow()
    expect(PlanDoc.clamp(shape).tech.overview.length).toBeLessThanOrEqual(PlanDoc.LIMITS.tech.chars)
  })
})

describe("PlanDoc.strip", () => {
  test("reports removals per block in one pass", () => {
    const shape = baseShape()
    shape.problem = "소식이 흩어져 있다. 우리 앱이 만족도를 90% 올린다."
    shape.userStories = ["주민은 소식을 본다", "최고의 경험을 한다"]
    const { removed } = PlanDoc.strip(shape, PlanDoc.gate([]))
    expect(removed.map((item) => item.block)).toEqual(["problem", "userStories"])
    expect(removed[0].text).toBe("우리 앱이 만족도를 90% 올린다.")
  })

  test("strips violating sentences and items", () => {
    const shape = baseShape()
    shape.problem = "소식이 흩어져 있다. 만족도를 90% 올린다."
    shape.userStories = ["주민은 소식을 본다", "완벽한 경험을 한다"]
    shape.narrative = "문제를 정의했다. react로 화면을 만들었다."
    const gate = PlanDoc.gate(["react"])
    const { shape: next, removed } = PlanDoc.strip(shape, gate)
    expect(next.problem).toBe("소식이 흩어져 있다.")
    expect(next.userStories).toEqual(["주민은 소식을 본다"])
    expect(next.narrative).toBe("문제를 정의했다.")
    expect(removed.length).toBe(3)
    expect(PlanDoc.strip(next, gate).removed.length).toBe(0)
  })

  test("keeps prose untouched when nothing is removed", () => {
    const shape = baseShape()
    const { shape: next } = PlanDoc.strip(shape, PlanDoc.gate([]))
    expect(next.narrative).toBe(shape.narrative)
  })

  test("gates caveats too", () => {
    const shape = baseShape()
    shape.caveats = ["알림은 아직 미완성이다", "react 버전 문제가 남아 있다"]
    const { shape: next, removed } = PlanDoc.strip(shape, PlanDoc.gate(["react"]))
    expect(next.caveats).toEqual(["알림은 아직 미완성이다"])
    expect(removed.map((item) => item.block)).toEqual(["caveats"])
  })

  test("clears title and tagline that violate", () => {
    const shape = baseShape()
    shape.title = "최고의 알리미"
    const { shape: next, removed } = PlanDoc.strip(shape, PlanDoc.gate([]))
    expect(next.title).toBe("")
    expect(removed.map((item) => item.block)).toEqual(["title"])
  })
})

describe("PlanDoc.render / finalize", () => {
  test("renders three parts with status and rollback markers", () => {
    const body = PlanDoc.render(baseShape())
    expect(body).toContain("## 1. 유저 스토리 기획서")
    expect(body).toContain("## 2. 기술 구조")
    expect(body).toContain("## 3. 변경 이력")
    expect(body).toContain("- 소식 모아보기 (동작)")
    expect(body).toContain("- 알림 (계획)")
    expect(body).toContain("- [철회] 지도 붙이기 시도 (시도 후 철회)")
    expect(body).not.toContain("[[빈칸:")
  })

  test("renders inline slot markers for empty blocks", () => {
    const shape = baseShape()
    shape.problem = ""
    expect(PlanDoc.render(shape)).toContain("### 풀고 싶은 문제\n\n[[빈칸: 풀고 싶은 문제]]")
  })

  test("marks tech slot per subsection", () => {
    const shape = baseShape()
    shape.tech = { overview: "화면과 저장소로 나뉜다.", data: "" }
    expect(PlanDoc.emptySlots(shape)).toContain("tech")
    const body = PlanDoc.render(shape)
    expect(body).toContain("### 구조 개요\n\n화면과 저장소로 나뉜다.")
    expect(body).toContain("### 데이터\n\n[[빈칸: 기술 구조]]")
  })

  test("finalize fills slots for empty blocks and computes sparse", () => {
    const full = PlanDoc.finalize(baseShape())
    expect(full.sparse).toBe(false)
    expect(full.manualSlots).toEqual([])
    expect(full.bodyNarrative).toContain("문제를 정의했다")

    const shape = baseShape()
    shape.problem = ""
    shape.narrative = ""
    const result = PlanDoc.finalize(shape, ["주의"])
    expect(result.manualSlots).toContain("problem")
    expect(result.manualSlots).toContain("narrative")
    expect(result.sparse).toBe(true)
    expect(result.caveats).toContain("주의")
    expect(result.bodyNarrative).toContain("[[빈칸: 만든 이야기]]")
  })

  test("renders caveats into both bodies as a trailing section", () => {
    const shape = baseShape()
    shape.caveats = ["알림은 아직 미완성이다"]
    const result = PlanDoc.finalize(shape, ["대화 기록만으로 작성했다"])
    for (const body of [result.body, result.bodyNarrative]) {
      expect(body).toContain("## 한계")
      expect(body).toContain("- 알림은 아직 미완성이다")
      expect(body).toContain("- 대화 기록만으로 작성했다")
    }
    expect(PlanDoc.finalize(baseShape()).body).not.toContain("## 한계")
  })

  test("skeleton returns full-slot sparse result", () => {
    const result = PlanDoc.skeleton("자료 부족")
    expect(result.sparse).toBe(true)
    expect(result.manualSlots).toEqual([...PlanDoc.BLOCKS])
    expect(result.caveats).toEqual(["자료 부족"])
    expect(result.body).toContain("[[빈칸: 풀고 싶은 문제]]")
    expect(result.body).toContain("## 한계")
    expect(result.title).toBe("")
  })
})
