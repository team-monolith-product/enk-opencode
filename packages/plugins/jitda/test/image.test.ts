import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Reporter } from "../src/ai-usage"
import { Image } from "../src/image"

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ENV_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "ENK_HACKATHON_RAILS_URL",
  "ENK_AI_USAGE_TOKEN",
  "ENK_IMAGE_GENERATION_LIMIT",
  "ENK_IMAGE_GENERATION_PHASE",
]
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const originalFetch = globalThis.fetch

type Call = { url: string; method: string; body: any; auth?: string }
let requests: Call[] = []
let directory = ""

function mockFetch(respond: (url: string, method: string, body: any) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({
      url: String(input),
      method,
      body,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    })
    return respond(String(input), method, body)
  }) as unknown as typeof fetch
}

const openai = (usage?: Image.Usage) =>
  Response.json({
    data: [{ b64_json: PNG.toString("base64") }],
    usage: usage ?? { input_tokens: 10, output_tokens: 100 },
  })

function harness(options: { imageGeneration?: boolean; parentID?: string; reporter?: Reporter } = {}) {
  const storage = new Map<string, unknown>()
  const emitted: unknown[] = []
  let tool: any
  let handlers: any
  const asks: unknown[] = []
  const ctx = {
    location: { directory },
    storage: {
      get: async (key: string) => storage.get(key) as any,
      set: async (key: string, value: unknown) => void storage.set(key, value),
    },
    session: {
      get: async () => ({ id: "ses_1", parentID: options.parentID }),
      context: async () => [
        {
          type: "user",
          metadata: options.imageGeneration === undefined ? undefined : { imageGeneration: options.imageGeneration },
        },
        { type: "assistant" },
      ],
    },
    permission: { assert: async (input: unknown) => void asks.push(input) },
    rpc: {
      register: async (_definition: unknown, value: unknown) => {
        handlers = value
        return {
          events: { emit: async (_name: string, data: unknown) => void emitted.push(data) },
          dispose: async () => {},
        }
      },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (value: unknown) => (tool = value) })
        return { dispose: async () => {} }
      },
    },
  }
  return {
    storage,
    emitted,
    asks,
    start: () => Image.start(ctx as any, options.reporter),
    execute: (input: Record<string, unknown>) =>
      tool.execute(input, {
        sessionID: "ses_1",
        agent: "build",
        messageID: "msg_assistant",
        id: "call_1",
        signal: AbortSignal.any([]),
        progress: async () => {},
      }),
    rpc: () => handlers,
  }
}

async function run(input: Record<string, unknown>, options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ imageGeneration: true, ...options })
  await h.start()
  const result = await h.execute(input)
  const saved = await Bun.file(path.join(directory, String(result.metadata.path)))
    .bytes()
    .catch(() => undefined)
  return { result, saved, h }
}

function team(limit = "3") {
  process.env.ENK_HACKATHON_RAILS_URL = "https://hackathon.test"
  process.env.ENK_AI_USAGE_TOKEN = "team-token"
  process.env.ENK_IMAGE_GENERATION_LIMIT = limit
}

const quotaBody = (used: number, limit = 3) => ({ limit, used, remaining: Math.max(limit - used, 0) })

beforeEach(async () => {
  requests = []
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENAI_BASE_URL = "http://proxy/openai/v1/"
  directory = await mkdtemp(path.join(tmpdir(), "jitda-image-"))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  await rm(directory, { recursive: true, force: true })
})

describe("generate_image", () => {
  test("calls the images endpoint through the proxy and saves the file", async () => {
    mockFetch(() => openai())
    const { result, saved, h } = await run({ prompt: "고양이", name: "hero-cat" })
    expect(requests[0]).toMatchObject({
      url: "http://proxy/openai/v1/images/generations",
      method: "POST",
      auth: "Bearer proxy-auth",
      body: {
        model: "gpt-image-1-mini",
        prompt: "고양이",
        n: 1,
        size: "1024x1024",
        quality: "medium",
        output_format: "png",
      },
    })
    expect(result.metadata).toMatchObject({
      status: "generated",
      path: "ai-images/hero-cat.png",
      url: "/ai-images/hero-cat.png",
    })
    expect(Buffer.from(saved!)).toEqual(PNG)
    expect(h.asks).toHaveLength(1)
  })

  test("maps the format to output_format", async () => {
    mockFetch(() => openai())
    const { result } = await run({ prompt: "p", name: "a", format: "jpg" })
    expect(requests[0].body.output_format).toBe("jpeg")
    expect(result.metadata.path).toBe("ai-images/a.jpg")
  })

  test("rejects transparent background for jpeg before calling the API", async () => {
    mockFetch(() => openai())
    const h = harness({ imageGeneration: true })
    await h.start()
    await expect(h.execute({ prompt: "p", name: "a", format: "jpg", background: "transparent" })).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  test("returns a blocked result instead of throwing on moderation", async () => {
    mockFetch(() => Response.json({ error: { code: "moderation_blocked", message: "nope" } }, { status: 400 }))
    const { result, saved } = await run({ prompt: "p", name: "a" })
    expect(result.metadata).toMatchObject({ status: "blocked", reason: "nope" })
    expect(saved).toBeUndefined()
  })

  test("throws with the provider message on other errors", async () => {
    mockFetch(() => Response.json({ error: { message: "boom" } }, { status: 500 }))
    const h = harness({ imageGeneration: true })
    await h.start()
    await expect(h.execute({ prompt: "p", name: "a" })).rejects.toThrow("boom")
  })

  test("does not draw inside a subagent", async () => {
    mockFetch(() => openai())
    const { result } = await run({ prompt: "p", name: "a" }, { parentID: "ses_parent" })
    expect(result.metadata.status).toBe("subagent")
    expect(requests).toHaveLength(0)
  })

  test("draws nothing in a message where the student turned image generation off", async () => {
    mockFetch(() => openai())
    for (const imageGeneration of [false, undefined]) {
      const h = harness({ imageGeneration })
      await h.start()
      expect((await h.execute({ prompt: "p", name: "a" })).metadata.status).toBe("off")
    }
    expect(requests).toHaveLength(0)
  })

  test("reports the image cost under its own model id", async () => {
    mockFetch(() => openai({ input_tokens: 40, output_tokens: 1000, input_tokens_details: { text_tokens: 40 } }))
    const records: unknown[] = []
    const reporter: Reporter = { enqueue: (record, key) => void records.push({ record, key }), flush: async () => {} }
    await run({ prompt: "p", name: "a" }, { reporter })
    expect(records).toEqual([
      {
        key: "msg_assistant:call_1:tool",
        record: expect.objectContaining({ model_id: "gpt-image-1-mini", step_index: -2, phase: "step", tokens: 1040 }),
      },
    ])
  })
})

describe("generate_image quota", () => {
  test("reserves with the call id, confirms the slot, and reports what is left", async () => {
    team()
    mockFetch((url, method) => {
      if (url.includes("/images/generations")) return openai()
      if (method === "POST") return Response.json(quotaBody(1), { status: 201 })
      return Response.json(quotaBody(1))
    })
    const { result } = await run({ prompt: "p", name: "a" })
    expect(requests.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://hackathon.test/api/v1/opencode/image_generations",
      "POST http://proxy/openai/v1/images/generations",
      "PATCH https://hackathon.test/api/v1/opencode/image_generations/call_1",
    ])
    expect(requests[0]).toMatchObject({ body: { call_id: "call_1" }, auth: "token team-token" })
    expect(result.content).toContain("2장")
  })

  test("says the images are used up without calling OpenAI", async () => {
    team()
    mockFetch(() => Response.json(quotaBody(3), { status: 409 }))
    const { result } = await run({ prompt: "p", name: "a" })
    expect(result.metadata.status).toBe("limited")
    expect(requests.some((call) => call.url.includes("/images/generations"))).toBe(false)
  })

  test("answers from the stored count before asking rails again", async () => {
    team("1")
    mockFetch((url, method) => {
      if (url.includes("/images/generations")) return openai()
      return Response.json(quotaBody(1, 1), { status: method === "POST" ? 201 : 200 })
    })
    const h = harness({ imageGeneration: true })
    await h.start()
    await h.execute({ prompt: "p", name: "a" })
    requests = []
    expect((await h.execute({ prompt: "p", name: "b" })).metadata.status).toBe("limited")
    expect(requests).toHaveLength(0)
  })

  test("counts the tutorial and the main event apart", async () => {
    team("1")
    process.env.ENK_IMAGE_GENERATION_PHASE = "tutorial"
    mockFetch((url, method) => {
      if (url.includes("/images/generations")) return openai()
      return Response.json({ ...quotaBody(1, 1), phase: "tutorial" }, { status: method === "POST" ? 201 : 200 })
    })
    const h = harness({ imageGeneration: true })
    await h.start()
    await h.execute({ prompt: "p", name: "a" })
    expect((await h.rpc().get({})).quota).toMatchObject({ used: 1, remaining: 0 })
    process.env.ENK_IMAGE_GENERATION_PHASE = "main_event"
    expect((await h.rpc().get({})).quota).toMatchObject({ used: 0, remaining: 1 })
  })

  test("treats a limit of 0 as disabled and a missing limit as unavailable", async () => {
    mockFetch(() => openai())
    team("0")
    expect((await run({ prompt: "p", name: "a" })).result.metadata.status).toBe("disabled")
    delete process.env.ENK_IMAGE_GENERATION_LIMIT
    expect((await run({ prompt: "p", name: "a" })).result.metadata.status).toBe("unavailable")
    expect(requests).toHaveLength(0)
  })

  test("is unavailable for non-team workspaces", async () => {
    team()
    mockFetch(() => new Response(null, { status: 403 }))
    expect((await run({ prompt: "p", name: "a" })).result.metadata.status).toBe("unavailable")
  })

  test("refuses to generate when the quota cannot be checked", async () => {
    team()
    mockFetch((url) => {
      if (url.includes("/images/generations")) return openai()
      throw new Error("down")
    })
    const h = harness({ imageGeneration: true })
    await h.start()
    await expect(h.execute({ prompt: "p", name: "a" })).rejects.toThrow("확인하지 못했습니다")
    expect(requests.some((call) => call.url.includes("/images/generations"))).toBe(false)
  })

  test("releases the slot when OpenAI fails or moderation blocks", async () => {
    team()
    for (const failure of [
      () => Response.json({ error: { message: "boom" } }, { status: 500 }),
      () => Response.json({ error: { code: "moderation_blocked" } }, { status: 400 }),
    ]) {
      requests = []
      mockFetch((url, method) => {
        if (url.includes("/images/generations")) return failure()
        return Response.json(quotaBody(1), { status: method === "POST" ? 201 : 200 })
      })
      const h = harness({ imageGeneration: true })
      await h.start()
      await h.execute({ prompt: "p", name: "a" }).catch(() => undefined)
      expect(requests.at(-1)?.method).toBe("DELETE")
    }
  })
})

describe("generate_image folder", () => {
  test("saves under public/ai-images when the project serves public/", async () => {
    mockFetch(() => openai())
    await mkdir(path.join(directory, "public"))
    expect((await run({ prompt: "p", name: "a" })).result.metadata).toMatchObject({
      path: "public/ai-images/a.png",
      url: "/ai-images/a.png",
    })
  })

  test("saves under static/ai-images for frameworks that serve static/", async () => {
    mockFetch(() => openai())
    await mkdir(path.join(directory, "static"))
    expect((await run({ prompt: "p", name: "a" })).result.metadata).toMatchObject({
      path: "static/ai-images/a.png",
      url: "/static/ai-images/a.png",
    })
  })

  test("saves into the public/ of a single nested app", async () => {
    mockFetch(() => openai())
    await mkdir(path.join(directory, "web", "public"), { recursive: true })
    await writeFile(path.join(directory, "web", "package.json"), "{}")
    expect((await run({ prompt: "p", name: "a" })).result.metadata.path).toBe("web/public/ai-images/a.png")
  })

  test("never overwrites an earlier image and keeps only the file name", async () => {
    mockFetch(() => openai())
    await run({ prompt: "p", name: "../../etc/hero cat.png" })
    expect((await run({ prompt: "p", name: "hero cat" })).result.metadata.path).toBe("ai-images/hero-cat-2.png")
  })

  test("gives parallel calls with the same name different files", async () => {
    mockFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return openai()
    })
    const h = harness({ imageGeneration: true })
    await h.start()
    const results = await Promise.all([h.execute({ prompt: "p", name: "a" }), h.execute({ prompt: "p", name: "a" })])
    expect(new Set(results.map((result: any) => result.metadata.path)).size).toBe(2)
  })
})

describe("image toggle", () => {
  test("defaults on, persists, and tells every screen", async () => {
    const h = harness()
    await h.start()
    expect(await h.rpc().get({})).toMatchObject({ enabled: true, on: true })
    expect(await h.rpc().toggle({ on: false })).toMatchObject({ on: false })
    expect(h.emitted).toEqual([{ on: false }])
    expect(await h.rpc().get({})).toMatchObject({ on: false })
  })

  test("is not enabled without any OpenAI configuration", async () => {
    delete process.env.OPENAI_BASE_URL
    const h = harness()
    await h.start()
    expect(await h.rpc().get({})).toMatchObject({ enabled: false })
  })
})

describe("Image helpers", () => {
  test("cost follows gpt-image-1-mini token prices", () => {
    expect(
      Image.cost({
        input_tokens: 100,
        output_tokens: 1000,
        input_tokens_details: { text_tokens: 60, image_tokens: 40 },
      }),
    ).toBeCloseTo((60 * 2 + 40 * 2.5 + 1000 * 8) / 1_000_000)
    expect(Image.cost({ input_tokens: 10, output_tokens: 0 })).toBeCloseTo((10 * 2) / 1_000_000)
  })

  test("uses the public API directly when only an API key is set", () => {
    expect(Image.endpoint({ OPENAI_API_KEY: "sk" })).toEqual({
      url: "https://api.openai.com/v1/images/generations",
      key: "sk",
    })
    expect(Image.endpoint({})).toBeUndefined()
  })
})
