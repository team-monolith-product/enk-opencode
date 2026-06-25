import { afterEach, describe, expect, test } from "bun:test"
import { EnvRoutes } from "../../src/server/routes/env"

describe("EnvRoutes", () => {
  const prevModel = process.env["ENK_AI_MODEL"]
  const prevVariant = process.env["ENK_AI_MODEL_VARIANT"]

  afterEach(() => {
    if (prevModel === undefined) delete process.env["ENK_AI_MODEL"]
    else process.env["ENK_AI_MODEL"] = prevModel
    if (prevVariant === undefined) delete process.env["ENK_AI_MODEL_VARIANT"]
    else process.env["ENK_AI_MODEL_VARIANT"] = prevVariant
  })

  test("returns ENK ai model fields", async () => {
    process.env["ENK_AI_MODEL"] = "google/gemini-3.5-flash"
    process.env["ENK_AI_MODEL_VARIANT"] = "high"

    const res = await EnvRoutes().request("/")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      aiModel: "google/gemini-3.5-flash",
      aiModelVariant: "high",
    })
  })

  test("omits ENK fields when unset", async () => {
    delete process.env["ENK_AI_MODEL"]
    delete process.env["ENK_AI_MODEL_VARIANT"]

    const res = await EnvRoutes().request("/")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.aiModel).toBeUndefined()
    expect(body.aiModelVariant).toBeUndefined()
  })
})
