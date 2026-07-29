import { describe, expect, test } from "bun:test"
import { Storybook } from "./storybook"

describe("Storybook.railsEnv", () => {
  test("requires both url and token", () => {
    expect(Storybook.railsEnv({})).toBeUndefined()
    expect(Storybook.railsEnv({ ENK_HACKATHON_RAILS_URL: "https://rails" })).toBeUndefined()
    expect(Storybook.railsEnv({ ENK_AI_USAGE_TOKEN: "t" })).toBeUndefined()
  })

  test("strips trailing slashes from the base url", () => {
    const env = Storybook.railsEnv({ ENK_HACKATHON_RAILS_URL: "https://rails//", ENK_AI_USAGE_TOKEN: "t" })
    expect(env).toEqual({ railsUrl: "https://rails", token: "t" })
  })
})

describe("Storybook.geminiEnv", () => {
  test("requires both base url and model", () => {
    expect(Storybook.geminiEnv({})).toBeUndefined()
    expect(Storybook.geminiEnv({ GEMINI_BASE_URL: "https://gemini/v1beta" })).toBeUndefined()
  })

  test("keeps only the model id from provider/model", () => {
    const env = Storybook.geminiEnv({
      GEMINI_BASE_URL: "https://gemini/v1beta/",
      ENK_AI_IMAGE_MODEL: "google/gemini-2.5-flash-image",
    })
    expect(env).toEqual({ geminiUrl: "https://gemini/v1beta", model: "gemini-2.5-flash-image" })
  })

  test("accepts a bare model id", () => {
    expect(Storybook.parseImageModelId("gemini-2.5-flash-image")).toBe("gemini-2.5-flash-image")
  })
})

describe("Storybook.pageFromResource", () => {
  test("maps a JSON:API resource to a page", () => {
    const page = Storybook.pageFromResource({
      id: 7,
      type: "storybook_pages",
      attributes: { position: 2, text: "옛날 옛적에", image_status: "succeeded" },
    })
    expect(page).toEqual({ id: "7", position: 2, text: "옛날 옛적에", image_prompt: undefined, image_status: "succeeded" })
  })

  test("rejects resources without id or integer position", () => {
    expect(Storybook.pageFromResource({ attributes: { position: 1 } })).toBeUndefined()
    expect(Storybook.pageFromResource({ id: 1, attributes: { position: "x" } })).toBeUndefined()
  })
})

describe("Storybook.errorDetail", () => {
  test("joins JSON:API error details", () => {
    const body = { errors: [{ detail: "팀 한도 초과" }, { title: "quota" }] }
    expect(Storybook.errorDetail(body)).toBe("팀 한도 초과 / quota")
  })

  test("returns undefined for non JSON:API bodies", () => {
    expect(Storybook.errorDetail(undefined)).toBeUndefined()
    expect(Storybook.errorDetail({ error: "nope" })).toBeUndefined()
    expect(Storybook.errorDetail({ errors: [{}] })).toBeUndefined()
  })
})

describe("Storybook.buildImageRequest", () => {
  test("asks for image output and applies the strictest safety threshold on every category", () => {
    const body = Storybook.buildImageRequest("바닷가의 아기 거북")
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "바닷가의 아기 거북" }] }])
    expect(body.generationConfig.responseModalities).toContain("IMAGE")
    expect(body.safetySettings).toHaveLength(Storybook.SAFETY_CATEGORIES.length)
    for (const setting of body.safetySettings) {
      expect(setting.threshold).toBe("BLOCK_LOW_AND_ABOVE")
    }
  })
})

describe("Storybook.parseImageResponse", () => {
  const usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 1290, totalTokenCount: 1302 }

  test("extracts inline base64 image data", () => {
    const result = Storybook.parseImageResponse({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: "설명" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
        },
      ],
      usageMetadata,
    })
    expect(result).toEqual({
      kind: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
      usage: { input: 12, output: 1290, reasoning: 0, total: 1302 },
    })
  })

  test("reports prompt-level safety blocks", () => {
    const result = Storybook.parseImageResponse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })
    expect(result.kind).toBe("blocked")
  })

  test("reports candidate-level safety blocks", () => {
    for (const finishReason of ["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT"]) {
      const result = Storybook.parseImageResponse({ candidates: [{ finishReason }] })
      expect(result.kind).toBe("blocked")
    }
  })

  test("reports empty when no image part came back", () => {
    const result = Storybook.parseImageResponse({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "그림 없이 설명만" }] } }],
    })
    expect(result.kind).toBe("empty")
  })
})

describe("Storybook.buildImageUsageRecord", () => {
  const input = {
    mountPath: "/fsx/teams/45/project-directory",
    modelId: "gemini-2.5-flash-image",
    messageId: "msg_1",
    callId: "call_1",
    usage: { input: 10, output: 1290, reasoning: 0, total: 1300 },
    at: 1_717_864_414_977,
  }

  test("mirrors the ai-usage step attribute shape", () => {
    const record = Storybook.buildImageUsageRecord(input)
    expect(record).toEqual({
      mount_path: "/fsx/teams/45/project-directory",
      model_id: "gemini-2.5-flash-image",
      message_id: "msg_1:img:call_1",
      step_index: 0,
      phase: "step",
      tokens: 1300,
      input: 10,
      output: 1290,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      used_at: new Date(1_717_864_414_977).toISOString(),
    })
  })

  test("suffixes message_id so it can never collide with chat step records", () => {
    const record = Storybook.buildImageUsageRecord(input)
    expect(record.message_id).not.toBe(input.messageId)
    expect(record.message_id.startsWith("msg_1:img:")).toBe(true)
  })

  test("falls back to summing counts when total is missing", () => {
    const record = Storybook.buildImageUsageRecord({ ...input, usage: { input: 1, output: 2, reasoning: 3, total: 0 } })
    expect(record.tokens).toBe(6)
  })
})
