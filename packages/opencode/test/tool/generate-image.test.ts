import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Instance } from "../../src/project/instance"
import { GenerateImage, GenerateImageTool } from "../../src/tool/generate-image"
import { SessionID, MessageID } from "../../src/session/schema"
import { ImageQuota } from "../../src/enk/image-quota"
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
  ImageQuota.reset()
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

async function run(
  params: Record<string, unknown>,
  options: { ctx?: ReturnType<typeof context>; setup?: (dir: string) => Promise<unknown> } = {},
) {
  await using dir = await tmpdir()
  await options.setup?.(dir.path)
  return await Instance.provide({
    directory: dir.path,
    fn: async () => {
      const tool = await GenerateImageTool.init()
      const result = await tool.execute(tool.parameters.parse(params), options.ctx ?? context())
      const saved = await Bun.file(path.join(dir.path, String(result.metadata.path)))
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
    const { result, saved } = await run({ prompt: "귀여운 고양이 픽셀아트", name: "cat" })

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
      path: path.join("ai-images", "cat.png"),
      url: "/ai-images/cat.png",
      mime: "image/png",
      bytes: PNG.length,
    })
  })

  test("maps the format to output_format", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })))
    await run({ prompt: "sky", name: "bg", format: "jpg", size: "1536x1024" })
    expect(requests[0].body).toMatchObject({ output_format: "jpeg", size: "1536x1024" })
  })

  test("rejects transparent background for jpeg before calling the API", async () => {
    mockFetch(() => new Response("{}"))
    await expect(run({ prompt: "icon", name: "icon", format: "jpg", background: "transparent" })).rejects.toThrow(
      "투명 배경",
    )
    expect(requests).toHaveLength(0)
  })

  test("returns a blocked result instead of throwing on moderation", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "blocked" } }), { status: 400 }),
    )
    const { result, saved } = await run({ prompt: "x", name: "x" })
    expect(result.metadata.status).toBe("blocked")
    expect(saved).toBeUndefined()
  })

  test("throws with the provider message on other errors", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
    await expect(run({ prompt: "x", name: "x" })).rejects.toThrow("rate limited")
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
    process.env["ENK_IMAGE_GENERATION_LIMIT"] = "10"
  })

  test("does nothing in a pod without an injected limit", async () => {
    delete process.env["ENK_IMAGE_GENERATION_LIMIT"]
    mockFetch(() => image())
    const { result, saved } = await run({ prompt: "cat", name: "cat" })
    expect(result.metadata.status).toBe("unavailable")
    expect(requests).toHaveLength(0)
    expect(saved).toBeUndefined()
  })

  test("confirms the slot once the image is saved", async () => {
    mockFetch((url) => (url.startsWith(RAILS) ? quota(201, { limit: 10, used: 1, remaining: 9 }) : image()))
    await run({ prompt: "cat", name: "cat" })
    expect(calls("PATCH").map((r) => r.url)).toEqual([`${RAILS}/call_1`])
    expect(calls("DELETE")).toHaveLength(0)
  })

  test("keeps the slot when OpenAI times out because it may already have billed", async () => {
    mockFetch((url) => {
      if (url.startsWith(RAILS)) return quota(201, { limit: 10, used: 1, remaining: 9 })
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" })
    })
    const { result, saved } = await run({ prompt: "cat", name: "cat" })
    expect(result.metadata.status).toBe("timeout")
    expect(calls("PATCH")).toHaveLength(1)
    expect(calls("DELETE")).toHaveLength(0)
    expect(saved).toBeUndefined()
  })

  test("finishes and saves the image even if the student stops the response", async () => {
    mockFetch((url) => (url.startsWith(RAILS) ? quota(201, { limit: 10, used: 1, remaining: 9 }) : image()))
    const controller = new AbortController()
    controller.abort()
    const { result, saved } = await run({ prompt: "cat", name: "cat" }, { ctx: context({ abort: controller.signal }) })
    expect(result.metadata.status).toBe("generated")
    expect(saved).toBeDefined()
  })

  test("reserves a slot with the call id before generating and reports what is left", async () => {
    mockFetch((url) => (url.startsWith(RAILS) ? quota(201, { limit: 10, used: 3, remaining: 7 }) : image()))
    const { result, saved } = await run({ prompt: "cat", name: "cat" })

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
    const { result, saved } = await run({ prompt: "cat", name: "cat" })

    expect(openai()).toHaveLength(0)
    expect(saved).toBeUndefined()
    expect(result.metadata.status).toBe("limited")
    expect(result.output).toContain("10장")
  })

  test("treats a limit of 0 as disabled", async () => {
    mockFetch(() => quota(409, { limit: 0, used: 0, remaining: 0 }))
    const { result } = await run({ prompt: "cat", name: "cat" })

    expect(openai()).toHaveLength(0)
    expect(result.metadata.status).toBe("disabled")
  })

  test("is unavailable for non-team workspaces", async () => {
    mockFetch(() => new Response("{}", { status: 403 }))
    const { result } = await run({ prompt: "cat", name: "cat" })

    expect(openai()).toHaveLength(0)
    expect(result.metadata.status).toBe("unavailable")
  })

  test("refuses to generate when the quota cannot be checked", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push({ url: String(input), method: "POST", body: undefined })
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    await expect(run({ prompt: "cat", name: "cat" })).rejects.toThrow("확인하지 못했습니다")
    expect(openai()).toHaveLength(0)
  })

  test("releases the slot when OpenAI fails", async () => {
    mockFetch((url) =>
      url.startsWith(RAILS)
        ? quota(201, { limit: 10, used: 1, remaining: 9 })
        : new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
    )
    await expect(run({ prompt: "cat", name: "cat" })).rejects.toThrow("boom")
    expect(calls("DELETE")).toHaveLength(1)
    expect(calls("DELETE")[0].url).toBe(`${RAILS}/call_1`)
  })

  test("releases the slot when moderation blocks the prompt", async () => {
    mockFetch((url) =>
      url.startsWith(RAILS)
        ? quota(201, { limit: 10, used: 1, remaining: 9 })
        : new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "no" } }), { status: 400 }),
    )
    const { result } = await run({ prompt: "cat", name: "cat" })
    expect(result.metadata.status).toBe("blocked")
    expect(calls("DELETE")).toHaveLength(1)
  })
})

describe("tool.generate_image folder", () => {
  const image = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }))

  test("saves under public/ai-images when the project serves public/", async () => {
    mockFetch(image)
    const { result, saved } = await run(
      { prompt: "cat", name: "Hero Cat!" },
      { setup: (dir) => mkdir(path.join(dir, "public"), { recursive: true }) },
    )
    expect(result.metadata).toMatchObject({
      path: path.join("public", "ai-images", "Hero-Cat.png"),
      url: "/ai-images/Hero-Cat.png",
    })
    expect(saved).toBeDefined()
    expect(result.output).toContain('"/ai-images/Hero-Cat.png"')
  })

  test("saves under static/ai-images for frameworks that serve static/", async () => {
    mockFetch(image)
    const { result } = await run(
      { prompt: "cat", name: "cat" },
      { setup: (dir) => mkdir(path.join(dir, "static"), { recursive: true }) },
    )
    expect(result.metadata).toMatchObject({
      path: path.join("static", "ai-images", "cat.png"),
      url: "/static/ai-images/cat.png",
    })
  })

  test("saves into the public/ of a single nested app", async () => {
    mockFetch(image)
    const { result } = await run(
      { prompt: "cat", name: "cat" },
      {
        setup: async (dir) => {
          await mkdir(path.join(dir, "my-app", "public"), { recursive: true })
          await Bun.write(path.join(dir, "my-app", "package.json"), "{}")
        },
      },
    )
    expect(result.metadata).toMatchObject({
      path: path.join("my-app", "public", "ai-images", "cat.png"),
      url: "/ai-images/cat.png",
    })
  })

  test("never overwrites an earlier image", async () => {
    mockFetch(image)
    const { result } = await run(
      { prompt: "cat", name: "cat" },
      {
        setup: async (dir) => {
          await mkdir(path.join(dir, "ai-images"), { recursive: true })
          await Bun.write(path.join(dir, "ai-images", "cat.png"), "old")
        },
      },
    )
    expect(result.metadata.path).toBe(path.join("ai-images", "cat-2.png"))
  })

  test("keeps only the file name the model passes", () => {
    expect(GenerateImage.slug("../../etc/passwd")).toBe("passwd")
    expect(GenerateImage.slug("고양이 캐릭터.png")).toBe("고양이-캐릭터")
    expect(GenerateImage.slug("///")).toBe("image")
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
