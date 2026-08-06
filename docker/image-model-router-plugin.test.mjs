// image-model-router-plugin 유닛 테스트 (bun test).
// 가짜 opencode client 로 chat.message 훅의 모델 전환 로직을 검증한다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import plugin, { isMedia, parseModelRef, resolveTarget, supportsMediaInput } from "./image-model-router-plugin.js"

const imageModelRouterPlugin = plugin.server

/** /provider 응답 형태(Provider.Info 배열)를 흉내낸 가짜 client */
function fakeClient(providers, calls = { count: 0 }) {
  return {
    provider: {
      list: async () => {
        calls.count++
        return { data: { all: providers, default: {}, connected: [] } }
      },
    },
  }
}

const PROVIDERS = [
  {
    id: "deepseek",
    models: {
      "deepseek-v4-pro": { id: "deepseek-v4-pro", capabilities: { attachment: false, input: { image: false } } },
    },
  },
  {
    id: "anthropic",
    models: {
      "claude-sonnet-5": { id: "claude-sonnet-5", capabilities: { attachment: true, input: { image: true } } },
    },
  },
  {
    id: "minimax",
    models: {
      "MiniMax-M3": {
        id: "MiniMax-M3",
        capabilities: { attachment: false, input: { image: false } },
        variants: { adaptive: { thinking: { type: "adaptive" } } },
      },
    },
  },
]

const OPTIONS = { model: "minimax/MiniMax-M3", variant: "adaptive" }

const imagePart = { type: "file", mime: "image/png", url: "data:image/png;base64,xxx" }
const pdfPart = { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,xxx" }
const textFilePart = { type: "file", mime: "text/plain", url: "data:text/plain;base64,xxx" }
const textPart = { type: "text", text: "안녕" }

function userMessage(providerID, modelID, variant) {
  return { role: "user", model: { providerID, modelID }, variant }
}

async function run(plugin, message, parts) {
  const output = { message, parts }
  await plugin["chat.message"]({}, output)
  return output.message
}

describe("모듈 형식", () => {
  // 레거시 형식(default 함수)이면 로더(getLegacyPlugins)가 named export 헬퍼까지
  // 플러그인으로 취급해 서버가 죽는다. 반드시 v1 형식({ id, server })이어야 한다.
  test("v1 플러그인 형식({ id, server })을 유지한다", () => {
    expect(typeof plugin).toBe("object")
    expect(typeof plugin.id).toBe("string")
    expect(typeof plugin.server).toBe("function")
  })
})

describe("parseModelRef", () => {
  test("providerID/modelID 분리 (modelID 의 추가 슬래시 유지)", () => {
    expect(parseModelRef("minimax/MiniMax-M3")).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(parseModelRef("openrouter/deepseek/deepseek-chat")).toEqual({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-chat",
    })
  })
  test("잘못된 형식은 undefined", () => {
    expect(parseModelRef("minimax")).toBeUndefined()
    expect(parseModelRef("/x")).toBeUndefined()
    expect(parseModelRef("x/")).toBeUndefined()
    expect(parseModelRef(undefined)).toBeUndefined()
  })
})

describe("supportsMediaInput", () => {
  test("capabilities.attachment / input.image / 레거시 attachment 모두 인식", () => {
    expect(supportsMediaInput({ capabilities: { attachment: true } })).toBe(true)
    expect(supportsMediaInput({ capabilities: { attachment: false, input: { image: true } } })).toBe(true)
    expect(supportsMediaInput({ capabilities: { attachment: false, input: { image: false } } })).toBe(false)
    expect(supportsMediaInput({ attachment: true })).toBe(true)
    expect(supportsMediaInput({ attachment: false })).toBe(false)
  })
})

describe("isMedia", () => {
  // MessageV2.isMedia(packages/opencode/src/session/message-v2.ts)와 같은 집합이어야 한다.
  test("이미지와 PDF 는 미디어, 나머지는 아니다", () => {
    expect(isMedia("image/png")).toBe(true)
    expect(isMedia("image/svg+xml")).toBe(true)
    expect(isMedia("application/pdf")).toBe(true)
    expect(isMedia("text/plain")).toBe(false)
    expect(isMedia("application/x-directory")).toBe(false)
    expect(isMedia(undefined)).toBe(false)
  })
})

describe("chat.message 모델 전환", () => {
  test("이미지 + 비전 미지원 모델 → 대상 모델로 전환, variant 적용", async () => {
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, OPTIONS)
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [textPart, imagePart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(message.variant).toBe("adaptive")
  })

  // 라우터가 image/* 만 보던 시절, PDF 는 이 훅을 그대로 통과해 비전 미지원 모델에서
  // 조용히 프롬프트에서 빠졌다(message-v2 의 isMedia 는 PDF 를 미디어로 센다).
  test("PDF + 비전 미지원 모델 → 대상 모델로 전환", async () => {
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, OPTIONS)
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [textPart, pdfPart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(message.variant).toBe("adaptive")
  })

  test("이미지 + PDF 혼합도 한 번만 전환한다", async () => {
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, OPTIONS)
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [imagePart, pdfPart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
  })

  test("미디어가 없으면 전환하지 않는다", async () => {
    const calls = { count: 0 }
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS, calls) }, OPTIONS)
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [textPart])
    expect(message.model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-pro" })
    expect(calls.count).toBe(0) // 미디어 없으면 provider 조회도 없다
  })

  // 텍스트 첨부는 프롬프트에 텍스트로 실려 어느 모델이든 읽는다. 전환할 이유가 없다.
  test("텍스트 파일 첨부는 미디어가 아니다", async () => {
    const calls = { count: 0 }
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS, calls) }, OPTIONS)
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [textFilePart])
    expect(message.model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-pro" })
    expect(calls.count).toBe(0)
  })

  test("비전 지원 모델은 전환하지 않는다", async () => {
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, OPTIONS)
    const message = await run(plugin, userMessage("anthropic", "claude-sonnet-5"), [imagePart])
    expect(message.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5" })
  })

  test("이미 대상 모델이면 그대로 둔다", async () => {
    const calls = { count: 0 }
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS, calls) }, OPTIONS)
    const message = await run(plugin, userMessage("minimax", "MiniMax-M3", "adaptive"), [imagePart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(message.variant).toBe("adaptive")
    expect(calls.count).toBe(0)
  })

  test("대상 모델이 배포에 없으면 전환하지 않는다", async () => {
    const withoutMinimax = PROVIDERS.filter((p) => p.id !== "minimax")
    const plugin = await imageModelRouterPlugin({ client: fakeClient(withoutMinimax) }, OPTIONS)
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [imagePart])
    expect(message.model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-pro" })
  })

  test("현재 모델 정보를 못 찾으면 전환하지 않는다", async () => {
    const plugin = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, OPTIONS)
    const message = await run(plugin, userMessage("unknown", "mystery-model"), [imagePart])
    expect(message.model).toEqual({ providerID: "unknown", modelID: "mystery-model" })
  })

  test("대상 모델에 없는 variant 는 버린다", async () => {
    const plugin = await imageModelRouterPlugin(
      { client: fakeClient(PROVIDERS) },
      { model: "minimax/MiniMax-M3", variant: "high" },
    )
    const message = await run(plugin, userMessage("deepseek", "deepseek-v4-pro", "high"), [imagePart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(message.variant).toBeUndefined()
  })

  test("provider 조회 실패 시 원래 모델을 유지하고 다음 호출에서 재시도한다", async () => {
    let fail = true
    let calls = 0
    const client = {
      provider: {
        list: async () => {
          calls++
          if (fail) throw new Error("boom")
          return { data: { all: PROVIDERS, default: {}, connected: [] } }
        },
      },
    }
    const plugin = await imageModelRouterPlugin({ client }, OPTIONS)
    const first = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [imagePart])
    expect(first.model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-pro" })

    fail = false
    const second = await run(plugin, userMessage("deepseek", "deepseek-v4-pro"), [imagePart])
    expect(second.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(calls).toBe(2)
  })

  test("잘못된 model 옵션은 내장 기본값(minimax/MiniMax-M3)으로 강등된다", async () => {
    const hooks = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, { model: "nope" })
    const message = await run(hooks, userMessage("deepseek", "deepseek-v4-pro"), [imagePart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
  })
})

describe("env 우선순위 (ENK_AI_IMAGE_MODEL)", () => {
  const ENV_KEYS = ["ENK_AI_IMAGE_MODEL", "ENK_AI_IMAGE_MODEL_VARIANT"]
  let saved

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  })
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  test("resolveTarget: env > 옵션 > 기본값", () => {
    expect(resolveTarget({ model: "a/b" }, {})).toEqual({ providerID: "a", modelID: "b" })
    expect(resolveTarget({ model: "a/b" }, { ENK_AI_IMAGE_MODEL: "c/d" })).toEqual({ providerID: "c", modelID: "d" })
    expect(resolveTarget({}, {})).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    // 잘못된 env 는 무시하고 옵션으로 강등
    expect(resolveTarget({ model: "a/b" }, { ENK_AI_IMAGE_MODEL: "broken" })).toEqual({
      providerID: "a",
      modelID: "b",
    })
    // 빈 env 는 미설정과 동일
    expect(resolveTarget({ model: "a/b" }, { ENK_AI_IMAGE_MODEL: "" })).toEqual({ providerID: "a", modelID: "b" })
  })

  test("env 가 플러그인 옵션보다 우선한다 (variant 포함)", async () => {
    process.env.ENK_AI_IMAGE_MODEL = "minimax/MiniMax-M3"
    process.env.ENK_AI_IMAGE_MODEL_VARIANT = "adaptive"
    const hooks = await imageModelRouterPlugin({ client: fakeClient(PROVIDERS) }, { model: "anthropic/claude-sonnet-5" })
    const message = await run(hooks, userMessage("deepseek", "deepseek-v4-pro"), [imagePart])
    expect(message.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(message.variant).toBe("adaptive")
  })
})
