import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { existsSync } from "node:fs"
import { z } from "zod"
import plugin from "./storybook-plugin"

const ENV_KEYS = ["ENK_HACKATHON_RAILS_URL", "ENK_AI_USAGE_TOKEN", "GEMINI_BASE_URL", "ENK_AI_IMAGE_MODEL"] as const

const saved: Record<string, string | undefined> = {}
let calls: { method: string; url: string; body?: any }[] = []
let routes: ((method: string, url: string, body?: any) => Response | undefined)[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env["ENK_HACKATHON_RAILS_URL"] = "https://rails"
  process.env["ENK_AI_USAGE_TOKEN"] = "usage-token"
  process.env["GEMINI_BASE_URL"] = "https://gemini/v1beta"
  process.env["ENK_AI_IMAGE_MODEL"] = "google/gemini-image-model"
  calls = []
  routes = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
    for (const route of routes) {
      const res = route(method, url, body)
      if (res) return res
    }
    return Response.json({})
  }) as typeof fetch
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  globalThis.fetch = realFetch
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function pagesIndex(pages: { id: number; position: number }[]) {
  routes.push((method, url) => {
    if (method === "GET" && url.includes("/api/v1/storybook_pages?filter[mount_path]=")) {
      return json({ data: pages.map((page) => ({ id: page.id, type: "storybook_pages", attributes: page })) })
    }
    return undefined
  })
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "ses_1",
    messageID: "msg_1",
    agent: "build",
    directory: "/fsx/teams/45/project",
    abort: new AbortController().signal,
    callID: "call_1",
    ...overrides,
  } as any
}

async function tools() {
  const hooks: any = await plugin.server({ directory: "/fsx/teams/45/project" } as any)
  expect(hooks.tool).toBeDefined()
  return hooks.tool
}

describe("storybook plugin server", () => {
  test("returns no hooks when rails env is missing", async () => {
    delete process.env["ENK_HACKATHON_RAILS_URL"]
    const hooks: any = await plugin.server({ directory: "/fsx/teams/45/project" } as any)
    expect(hooks.tool).toBeUndefined()
  })

  test("exposes exactly the three storybook tools", async () => {
    expect(Object.keys(await tools()).sort()).toEqual(["delete_page", "generate_illustration", "upsert_page"])
  })

  test("tool args compose with the host zod instance", async () => {
    for (const def of Object.values<any>(await tools())) {
      const schema = z.object(def.args)
      expect(z.toJSONSchema(schema).type).toBe("object")
    }
  })
})

describe("upsert_page", () => {
  test("creates the page with mount_path when the position does not exist", async () => {
    pagesIndex([])
    const result = await (await tools()).upsert_page.execute({ position: 1, text: "옛날 옛적에" }, ctx())
    expect(result).toBe("1쪽 페이지를 만들었어요.")
    const post = calls.find((call) => call.method === "POST")!
    expect(post.url).toBe("https://rails/api/v1/storybook_pages")
    expect(post.body).toEqual({
      data: {
        type: "storybook_pages",
        attributes: { text: "옛날 옛적에", position: 1, mount_path: "/fsx/teams/45/project" },
      },
    })
  })

  test("updates only the provided fields when the position exists", async () => {
    pagesIndex([{ id: 7, position: 2 }])
    const result = await (await tools()).upsert_page.execute({ position: 2, image_prompt: "아기 거북" }, ctx())
    expect(result).toBe("2쪽 페이지를 수정했어요.")
    const put = calls.find((call) => call.method === "PUT")!
    expect(put.url).toBe("https://rails/api/v1/storybook_pages/7")
    expect(put.body.data.attributes).toEqual({ image_prompt: "아기 거북", mount_path: "/fsx/teams/45/project" })
  })

  test("surfaces the rails error detail on failure", async () => {
    pagesIndex([])
    routes.push((method) => (method === "POST" ? json({ errors: [{ detail: "position 이 중복돼요" }] }, 422) : undefined))
    const result = await (await tools()).upsert_page.execute({ position: 1, text: "x" }, ctx())
    expect(result).toContain("position 이 중복돼요")
  })
})

describe("delete_page", () => {
  test("deletes by resolved page id", async () => {
    pagesIndex([{ id: 3, position: 5 }])
    const result = await (await tools()).delete_page.execute({ position: 5 }, ctx())
    expect(result).toBe("5쪽 페이지를 삭제했어요.")
    const del = calls.find((call) => call.method === "DELETE")!
    expect(del.url).toBe("https://rails/api/v1/storybook_pages/3")
  })

  test("answers gracefully when the page is absent", async () => {
    pagesIndex([])
    const result = await (await tools()).delete_page.execute({ position: 5 }, ctx())
    expect(result).toBe("5쪽 페이지가 없어서 삭제할 것이 없어요.")
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
  })
})

describe("generate_illustration", () => {
  function gemini(body: unknown, status = 200) {
    routes.push((method, url) => {
      if (method === "POST" && url === "https://gemini/v1beta/models/gemini-image-model:generateContent") {
        return json(body, status)
      }
      return undefined
    })
  }

  const image = {
    candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGk=" } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290, totalTokenCount: 1300 },
  }

  test("two-step upsert: generating first, then succeeded with the base64 image", async () => {
    pagesIndex([{ id: 9, position: 1 }])
    gemini(image)
    const result = await (await tools()).generate_illustration.execute({ position: 1, image_prompt: "아기 거북" }, ctx())
    expect(result).toBe("1쪽 삽화를 완성했어요.")
    const puts = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/storybook_pages/9"))
    expect(puts[0].body.data.attributes).toEqual({
      image_prompt: "아기 거북",
      image_status: "generating",
      mount_path: "/fsx/teams/45/project",
    })
    expect(puts[1].body.data.attributes).toEqual({
      image_status: "succeeded",
      image_base64: "aGk=",
      mount_path: "/fsx/teams/45/project",
    })
  })

  test("creates the page first when the position does not exist yet", async () => {
    pagesIndex([])
    routes.push((method, url) =>
      method === "POST" && url === "https://rails/api/v1/storybook_pages"
        ? json({ data: { id: 11, type: "storybook_pages", attributes: { position: 4 } } })
        : undefined,
    )
    gemini(image)
    const result = await (await tools()).generate_illustration.execute({ position: 4, image_prompt: "숲속" }, ctx())
    expect(result).toBe("4쪽 삽화를 완성했어요.")
    expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/storybook_pages/11"))).toBe(true)
  })

  test("sends the strictest safety settings to gemini", async () => {
    pagesIndex([{ id: 9, position: 1 }])
    gemini(image)
    await (await tools()).generate_illustration.execute({ position: 1, image_prompt: "아기 거북" }, ctx())
    const call = calls.find((item) => item.url.includes(":generateContent"))!
    expect(call.body.generationConfig.responseModalities).toContain("IMAGE")
    for (const setting of call.body.safetySettings) expect(setting.threshold).toBe("BLOCK_LOW_AND_ABOVE")
  })

  test("marks blocked and explains kindly on safety block", async () => {
    pagesIndex([{ id: 9, position: 1 }])
    gemini({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })
    const result = await (await tools()).generate_illustration.execute({ position: 1, image_prompt: "무서운 것" }, ctx())
    expect(result).toContain("동화에 알맞지 않다고")
    const last = calls.filter((call) => call.method === "PUT").at(-1)!
    expect(last.body.data.attributes.image_status).toBe("blocked")
  })

  test("marks failed and relays the quota message when rails rejects the upload", async () => {
    pagesIndex([{ id: 9, position: 1 }])
    gemini(image)
    routes.push((method, url, body) =>
      method === "PUT" && body?.data?.attributes?.image_base64
        ? json({ errors: [{ detail: "팀 이미지 생성 한도를 초과했어요" }] }, 422)
        : undefined,
    )
    const result = await (await tools()).generate_illustration.execute({ position: 1, image_prompt: "아기 거북" }, ctx())
    expect(result).toContain("한도")
    expect(result).toContain("팀 이미지 생성 한도를 초과했어요")
    const last = calls.filter((call) => call.method === "PUT").at(-1)!
    expect(last.body.data.attributes.image_status).toBe("failed")
  })

  test("reports image usage with the image model id and a collision-free message id", async () => {
    pagesIndex([{ id: 9, position: 1 }])
    gemini(image)
    await (await tools()).generate_illustration.execute({ position: 1, image_prompt: "아기 거북" }, ctx())
    const usage = calls.find((call) => call.url.endsWith("/api/v1/ai_usages/do_many"))!
    const attributes = usage.body.data_to_create[0].attributes
    expect(attributes.model_id).toBe("gemini-image-model")
    expect(attributes.message_id).toBe("msg_1:img:call_1")
    expect(attributes.phase).toBe("step")
    expect(attributes.tokens).toBe(1300)
    expect(attributes.mount_path).toBe("/fsx/teams/45/project")
  })

  test("marks failed when gemini errors", async () => {
    pagesIndex([{ id: 9, position: 1 }])
    gemini({ error: { message: "boom" } }, 500)
    const result = await (await tools()).generate_illustration.execute({ position: 1, image_prompt: "아기 거북" }, ctx())
    expect(result).toContain("실패")
    const last = calls.filter((call) => call.method === "PUT").at(-1)!
    expect(last.body.data.attributes.image_status).toBe("failed")
  })
})

describe("built artifact (docker/storybook-plugin.js)", () => {
  const artifact = path.resolve(import.meta.dir, "../../../../docker/storybook-plugin.js")

  test("exists, exposes the v1 plugin shape, and its bundled zod schemas compose with the host zod", async () => {
    expect(existsSync(artifact)).toBe(true)
    const mod = await import(artifact)
    expect(mod.default.id).toBe("enk-storybook")
    const hooks = await mod.default.server({ directory: "/fsx/teams/45/project" })
    expect(Object.keys(hooks.tool).sort()).toEqual(["delete_page", "generate_illustration", "upsert_page"])
    for (const def of Object.values<any>(hooks.tool)) {
      const schema = z.object(def.args)
      const jsonSchema = z.toJSONSchema(schema)
      expect(jsonSchema.type).toBe("object")
      expect(Object.keys(jsonSchema.properties ?? {})).toContain("position")
    }
  })
})
