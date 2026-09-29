import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { GenerateImage, GenerateImageTool } from "../../src/tool/generate-image"
import { SessionID, MessageID } from "../../src/session/schema"
import { ImageRequest } from "../../src/image-request"
import { tmpdir } from "../fixture/fixture"

let seq = 0
function userMessage(imageRequest: boolean) {
  const id = `msg_user_${++seq}`
  return {
    info: { id, role: "user" },
    parts: [{ type: "text", text: "그려 줘", metadata: imageRequest ? { imageRequest: true } : undefined }],
  }
}

function context(options: { messages?: unknown[]; abort?: AbortSignal } = {}) {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("message"),
    callID: "call_1",
    agent: "build",
    abort: options.abort ?? AbortSignal.any([]),
    messages: (options.messages ?? [userMessage(true)]) as never,
    metadata: () => {},
    ask: async () => {},
  }
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

let requests: { url: string; method: string; body: any; auth?: string }[] = []
const originalFetch = globalThis.fetch
const ENV_KEYS = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "ENK_HACKATHON_RAILS_URL", "ENK_AI_USAGE_TOKEN"]
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function mockFetch(respond: (url: string, method: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    requests.push({
      url: String(input),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>)["Authorization"],
    })
    return respond(String(input), method)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  requests = []
  for (const key of ENV_KEYS) delete process.env[key]
  process.env["OPENAI_BASE_URL"] = "http://proxy/openai/v1/"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

type Answer = (request: ImageRequest.Request) => Promise<unknown>

async function waitForRequest() {
  for (let i = 0; i < 100; i++) {
    const [request] = await ImageRequest.list()
    if (request) return request
    await Bun.sleep(10)
  }
  throw new Error("no image request was asked")
}

async function run(
  params: Record<string, unknown>,
  options: { ctx?: ReturnType<typeof context>; answer?: Answer } = {},
) {
  await using dir = await tmpdir()
  return Instance.provide({
    directory: dir.path,
    fn: async () => {
      const tool = await GenerateImageTool.init()
      const execution = tool.execute(tool.parameters.parse(params), options.ctx ?? context())
      if (options.answer) await options.answer(await waitForRequest())
      const result = await execution
      const saved = await Bun.file(path.join(dir.path, String(params.path)))
        .bytes()
        .catch(() => undefined)
      return { result, saved }
    },
  })
}

describe("tool.generate_image", () => {
  test("calls the images endpoint through the proxy and saves the file", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: PNG.toString("base64") }],
            usage: {
              input_tokens: 50,
              output_tokens: 1056,
              input_tokens_details: { text_tokens: 50, image_tokens: 0 },
            },
          }),
        ),
    )
    const { result, saved } = await run({ prompt: "귀여운 고양이 픽셀아트", path: "public/images/cat.png" })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("http://proxy/openai/v1/images/generations")
    expect(requests[0].auth).toBe("Bearer proxy-auth")
    expect(requests[0].body).toMatchObject({
      model: "gpt-image-1-mini",
      size: "1024x1024",
      quality: "medium",
      background: "auto",
      output_format: "png",
      n: 1,
    })
    expect(Buffer.from(saved!)).toEqual(PNG)
    expect(result.metadata).toMatchObject({
      status: "generated",
      path: path.join("public", "images", "cat.png"),
      mime: "image/png",
      bytes: PNG.length,
    })
  })

  test("maps the extension to output_format", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })))
    await run({ prompt: "sky", path: "bg.jpg", size: "1536x1024" })
    expect(requests[0].body).toMatchObject({ output_format: "jpeg", size: "1536x1024" })
  })

  test("rejects transparent background for jpeg before calling the API", async () => {
    mockFetch(() => new Response("{}"))
    await expect(run({ prompt: "icon", path: "icon.jpg", background: "transparent" })).rejects.toThrow("투명 배경")
    expect(requests).toHaveLength(0)
  })

  test("rejects unsupported extensions", async () => {
    mockFetch(() => new Response("{}"))
    await expect(run({ prompt: "icon", path: "icon.gif" })).rejects.toThrow("지원하지 않는 확장자")
  })

  test("returns a blocked result instead of throwing on moderation", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "blocked" } }), { status: 400 }),
    )
    const { result, saved } = await run({ prompt: "x", path: "x.png" })
    expect(result.metadata.status).toBe("blocked")
    expect(saved).toBeUndefined()
  })

  test("throws with the provider message on other errors", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
    await expect(run({ prompt: "x", path: "x.png" })).rejects.toThrow("rate limited")
  })
})

describe("tool.generate_image quota", () => {
  const RAILS = "http://rails/api/v1/opencode/image_generations"
  const image = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  const quota = (status: number, body: Record<string, number>) => new Response(JSON.stringify(body), { status })
  const calls = (method: string, url = RAILS) => requests.filter((r) => r.method === method && r.url.startsWith(url))
  const openai = () => requests.filter((r) => r.url.includes("/images/generations"))

  beforeEach(() => {
    process.env["ENK_HACKATHON_RAILS_URL"] = "http://rails/"
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  })

  test("reserves a slot with the call id before generating and reports what is left", async () => {
    mockFetch((url) => (url.startsWith(RAILS) ? quota(201, { limit: 10, used: 3, remaining: 7 }) : image()))
    const { result, saved } = await run({ prompt: "cat", path: "cat.png" })

    expect(requests[0]).toMatchObject({
      url: RAILS,
      method: "POST",
      body: { call_id: "call_1" },
      auth: "token team-token",
    })
    expect(openai()).toHaveLength(1)
    expect(saved).toBeDefined()
    expect(result.metadata.quota).toEqual({ limit: 10, used: 3, remaining: 7 })
    expect(result.output).toContain("7장")
  })

  test("does not call OpenAI once the team used up its images", async () => {
    mockFetch(() => quota(409, { limit: 10, used: 10, remaining: 0 }))
    const { result, saved } = await run({ prompt: "cat", path: "cat.png" })

    expect(openai()).toHaveLength(0)
    expect(saved).toBeUndefined()
    expect(result.metadata.status).toBe("limited")
    expect(result.output).toContain("10장")
  })

  test("treats a limit of 0 as disabled", async () => {
    mockFetch(() => quota(409, { limit: 0, used: 0, remaining: 0 }))
    const { result } = await run({ prompt: "cat", path: "cat.png" })

    expect(openai()).toHaveLength(0)
    expect(result.metadata.status).toBe("disabled")
  })

  test("is unavailable for non-team workspaces", async () => {
    mockFetch(() => new Response("{}", { status: 403 }))
    const { result } = await run({ prompt: "cat", path: "cat.png" })

    expect(openai()).toHaveLength(0)
    expect(result.metadata.status).toBe("unavailable")
  })

  test("refuses to generate when the quota cannot be checked", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push({ url: String(input), method: "POST", body: undefined })
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    await expect(run({ prompt: "cat", path: "cat.png" })).rejects.toThrow("확인하지 못했습니다")
    expect(openai()).toHaveLength(0)
  })

  test("releases the slot when OpenAI fails", async () => {
    mockFetch((url) =>
      url.startsWith(RAILS)
        ? quota(201, { limit: 10, used: 1, remaining: 9 })
        : new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
    )
    await expect(run({ prompt: "cat", path: "cat.png" })).rejects.toThrow("boom")
    expect(calls("DELETE")).toHaveLength(1)
    expect(calls("DELETE")[0].url).toBe(`${RAILS}/call_1`)
  })

  test("releases the slot when moderation blocks the prompt", async () => {
    mockFetch((url) =>
      url.startsWith(RAILS)
        ? quota(201, { limit: 10, used: 1, remaining: 9 })
        : new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "no" } }), { status: 400 }),
    )
    const { result } = await run({ prompt: "cat", path: "cat.png" })
    expect(result.metadata.status).toBe("blocked")
    expect(calls("DELETE")).toHaveLength(1)
  })
})

describe("tool.generate_image approval", () => {
  const RAILS = "http://rails/api/v1/opencode/image_generations"
  const image = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const openai = () => requests.filter((r) => r.url.includes("/images/generations"))
  const ask = () => context({ messages: [userMessage(false)] })

  beforeEach(() => {
    process.env["ENK_HACKATHON_RAILS_URL"] = "http://rails/"
    process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  })

  test("asks the student with the remaining count and draws the prompt they approved", async () => {
    mockFetch((url, method) => {
      if (!url.startsWith(RAILS)) return image()
      return method === "GET"
        ? json(200, { limit: 10, used: 3, remaining: 7 })
        : json(201, { limit: 10, used: 4, remaining: 6 })
    })
    let asked: ImageRequest.Request | undefined
    const { result, saved } = await run(
      { prompt: "cat", path: "cat.png" },
      {
        ctx: ask(),
        answer: async (request) => {
          asked = request
          await ImageRequest.approve({ requestID: request.id, prompt: "주황 고양이" })
        },
      },
    )

    expect(asked).toMatchObject({ prompt: "cat", path: "cat.png", quota: { remaining: 7 }, tool: { callID: "call_1" } })
    expect(openai()[0].body.prompt).toBe("주황 고양이")
    expect(saved).toBeDefined()
    expect(result.metadata).toMatchObject({ status: "generated", prompt: "주황 고양이" })
  })

  test("spends nothing when the student skips", async () => {
    mockFetch((url) => (url.startsWith(RAILS) ? json(200, { limit: 10, used: 3, remaining: 7 }) : image()))
    const { result, saved } = await run(
      { prompt: "cat", path: "cat.png" },
      { ctx: ask(), answer: (request) => ImageRequest.skip(request.id) },
    )

    expect(result.metadata.status).toBe("skipped")
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)
    expect(saved).toBeUndefined()
  })

  test("does not open a card when nothing is left", async () => {
    mockFetch(() => json(200, { limit: 10, used: 10, remaining: 0 }))
    const { result } = await run({ prompt: "cat", path: "cat.png" }, { ctx: ask() })

    expect(result.metadata.status).toBe("limited")
    expect(openai()).toHaveLength(0)
  })

  test("closes the card when the turn is aborted", async () => {
    mockFetch(() => json(200, { limit: 10, used: 3, remaining: 7 }))
    const controller = new AbortController()
    const { result } = await run(
      { prompt: "cat", path: "cat.png" },
      {
        ctx: context({ messages: [userMessage(false)], abort: controller.signal }),
        answer: async () => controller.abort(),
      },
    )

    expect(result.metadata.status).toBe("canceled")
    expect(openai()).toHaveLength(0)
  })

  test("the image button approves only one image per message", async () => {
    mockFetch((url) => (url.startsWith(RAILS) ? json(201, { limit: 10, used: 1, remaining: 9 }) : image()))
    const messages = [userMessage(true)]

    const first = await run({ prompt: "cat", path: "cat.png" }, { ctx: context({ messages }) })
    expect(first.result.metadata.status).toBe("generated")

    const second = await run(
      { prompt: "dog", path: "dog.png" },
      { ctx: context({ messages }), answer: (request) => ImageRequest.skip(request.id) },
    )
    expect(second.result.metadata.status).toBe("skipped")
  })
})

describe("GenerateImage", () => {
  test("cost follows gpt-image-1-mini token prices", () => {
    const cost = GenerateImage.cost({
      input_tokens: 1_000_000,
      input_tokens_details: { text_tokens: 600_000, image_tokens: 400_000 },
      output_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.6 * 2 + 0.4 * 2.5 + 8)
  })

  test("cost falls back to text tokens when details are missing", () => {
    expect(GenerateImage.cost({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(2)
    expect(GenerateImage.cost(undefined)).toBe(0)
  })

  test("uses the public API directly when only an API key is set", () => {
    delete process.env["OPENAI_BASE_URL"]
    process.env["OPENAI_API_KEY"] = "sk-test"
    expect(GenerateImage.endpoint()).toEqual({ url: "https://api.openai.com/v1/images/generations", key: "sk-test" })
  })

  test("is unavailable without any OpenAI configuration", () => {
    delete process.env["OPENAI_BASE_URL"]
    expect(GenerateImage.available()).toBe(false)
  })
})
