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
    expect(result.userCount).toBe(1)
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
    expect(result.toolEventCount).toBe(3)
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
    expect(result.toolEventCount).toBe(0)
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

describe("PlanDoc.isBusy", () => {
  test("true when last message is incomplete assistant", () => {
    const msgs = [userMessage([{ text: "hi" }]), assistantMessage([], { time: { created: 1 } })]
    expect(PlanDoc.isBusy(msgs)).toBe(true)
  })

  test("false when completed, errored, user-last or empty", () => {
    expect(PlanDoc.isBusy([assistantMessage([], { time: { created: 1, completed: 2 } })])).toBe(false)
    expect(PlanDoc.isBusy([assistantMessage([], { time: { created: 1 }, error: { name: "UnknownError" } })])).toBe(
      false,
    )
    expect(PlanDoc.isBusy([userMessage([{ text: "hi" }])])).toBe(false)
    expect(PlanDoc.isBusy([])).toBe(false)
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

describe("PlanDoc.checkText", () => {
  test("detects unfounded numbers", () => {
    expect(PlanDoc.checkText("정확도를 30% 올렸다", [])).toBe("근거 없는 수치")
    expect(PlanDoc.checkText("속도가 2배 빨라졌다", [])).toBe("근거 없는 수치")
    expect(PlanDoc.checkText("사용자 100명이 쓴다", [])).toBe("근거 없는 수치")
    expect(PlanDoc.checkText("3명의 팀원", [])).toBeDefined()
  })

  test("detects superlatives and AI claims", () => {
    expect(PlanDoc.checkText("최고의 앱", [])).toContain("최상급")
    expect(PlanDoc.checkText("AI가 분석해서 알려준다", [])).toBe("AI 동작 원리 단정")
    expect(PlanDoc.checkText("인공지능이 학습한 결과", [])).toBe("AI 동작 원리 단정")
  })

  test("detects banned terms with word boundaries", () => {
    const terms = ["react", "App.tsx"]
    expect(PlanDoc.checkText("react로 만든 화면", terms)).toContain("react")
    expect(PlanDoc.checkText("App.tsx 파일을 수정", terms)).toContain("App.tsx")
    expect(PlanDoc.checkText("reaction이 좋았다", terms)).toBeUndefined()
    expect(PlanDoc.checkText("문제를 푸는 서비스", terms)).toBeUndefined()
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

    expect(clamped.tech.overview.length).toBeLessThanOrEqual(PlanDoc.LIMITS.tech)
    expect(clamped.tech.data.length).toBeLessThanOrEqual(PlanDoc.LIMITS.tech)
  })

  test("slices over-long lists to their limits", () => {
    const shape = {
      ...baseShape(),
      features: Array.from({ length: 12 }, (_, i) => ({ name: `기능 ${i}`, status: "works" as const })),
      screens: Array.from({ length: 12 }, (_, i) => `화면 ${i}`),
    }
    const clamped = PlanDoc.clamp(shape)

    expect(clamped.features).toHaveLength(PlanDoc.LIMITS.features)
    expect(clamped.screens).toHaveLength(PlanDoc.LIMITS.screens)
  })

  test("accepts output that the previous hard schema rejected", () => {
    const shape = { ...baseShape(), tech: { overview: "가".repeat(420), data: "나".repeat(420) } }

    expect(() => PlanDoc.Shape.parse(shape)).not.toThrow()
    expect(PlanDoc.clamp(shape).tech.overview.length).toBeLessThanOrEqual(PlanDoc.LIMITS.tech)
  })
})

describe("PlanDoc.findViolations / stripViolations", () => {
  test("finds violations per block", () => {
    const shape = baseShape()
    shape.problem = "소식이 흩어져 있다. 우리 앱이 만족도를 90% 올린다."
    shape.userStories = ["주민은 소식을 본다", "최고의 경험을 한다"]
    const violations = PlanDoc.findViolations(shape, [])
    expect(violations.map((v) => v.block)).toEqual(["problem", "userStories"])
  })

  test("strips violating sentences and items, adds caveat", () => {
    const shape = baseShape()
    shape.problem = "소식이 흩어져 있다. 만족도를 90% 올린다."
    shape.userStories = ["주민은 소식을 본다", "완벽한 경험을 한다"]
    shape.narrative = "문제를 정의했다. react로 화면을 만들었다."
    const { shape: next, caveats } = PlanDoc.stripViolations(shape, ["react"])
    expect(next.problem).toBe("소식이 흩어져 있다.")
    expect(next.userStories).toEqual(["주민은 소식을 본다"])
    expect(next.narrative).toBe("문제를 정의했다.")
    expect(caveats.length).toBe(1)
    expect(PlanDoc.findViolations(next, ["react"]).length).toBe(0)
  })
})

describe("PlanDoc.render / finalize", () => {
  test("renders three parts with status and rollback markers", () => {
    const body = PlanDoc.render(baseShape(), [])
    expect(body).toContain("## 1. 유저 스토리 기획서")
    expect(body).toContain("## 2. 기술 구조")
    expect(body).toContain("## 3. 변경 이력")
    expect(body).toContain("- 소식 모아보기 (동작)")
    expect(body).toContain("- 알림 (계획)")
    expect(body).toContain("- [철회] 지도 붙이기 시도 (시도 후 철회)")
  })

  test("renders placeholders for slot blocks", () => {
    const body = PlanDoc.render(baseShape(), ["problem"])
    expect(body).toContain("### 풀고 싶은 문제\n\n_(여기에 직접 적어주세요)_")
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
    expect(result.bodyNarrative).toBe("_(여기에 직접 적어주세요)_")
  })

  test("normalizeSlots keeps known block keys only", () => {
    expect(PlanDoc.normalizeSlots(["problem", "problem", "무언가", "tech"])).toEqual(["problem", "tech"])
  })

  test("skeleton returns full-slot sparse result", () => {
    const result = PlanDoc.skeleton("자료 부족")
    expect(result.sparse).toBe(true)
    expect(result.manualSlots).toEqual([...PlanDoc.BLOCKS])
    expect(result.caveats).toEqual(["자료 부족"])
    expect(result.body).toContain("_(여기에 직접 적어주세요)_")
    expect(result.title).toBe("")
  })
})
