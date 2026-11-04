import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { CostQuota } from "../../src/enk/cost-quota"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const ORIGINAL_ENV = process.env["ENK_PROJECT_DIRECTORY"]

afterEach(async () => {
  CostQuota.reset()
  if (ORIGINAL_ENV === undefined) delete process.env["ENK_PROJECT_DIRECTORY"]
  else process.env["ENK_PROJECT_DIRECTORY"] = ORIGINAL_ENV
  delete process.env["ENK_HACKATHON_RAILS_URL"]
  delete process.env["ENK_AI_USAGE_TOKEN"]
  await Storage.remove(["enk", "initial-plan"]).catch(() => undefined)
  await Instance.disposeAll()
  await resetDatabase()
})

function chat(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function serve(status: string) {
  const results: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/chat/completions")) return chat("계획")
      if (url.pathname === "/api/v1/opencode/initial_plan") return Response.json({ status, planning_id: 3 })
      if (url.pathname === "/api/v1/opencode/initial_plan/claim")
        return Response.json({ claimed: true, planning_id: 3, claim_token: "tok-1", prompt: "# 최초 기획" })
      if (url.pathname === "/api/v1/opencode/initial_plan/result") {
        const body = await req.json()
        if (!body.claim_token) return Response.json({ errors: [{ title: "InvalidResult" }] }, { status: 422 })
        results.push(body)
        return Response.json({ status: body.status, applied: true })
      }
      return new Response("not found", { status: 404 })
    },
  })
  process.env["ENK_HACKATHON_RAILS_URL"] = server.url.origin
  process.env["ENK_AI_USAGE_TOKEN"] = "team-token"
  return { server, results, [Symbol.asyncDispose]: () => server.stop(true) }
}

const deliver = (directory: string) =>
  Server.Default().request("/enk/initial-plan/deliver", {
    method: "POST",
    headers: { "x-opencode-directory": directory },
  })

describe("POST /enk/initial-plan/deliver", () => {
  test("answers 503 when rails is not configured", async () => {
    await using tmp = await tmpdir()
    delete process.env["ENK_PROJECT_DIRECTORY"]

    const res = await deliver(tmp.path)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: expect.any(String) })
  })

  test("reports not_finalized before the team finalizes", async () => {
    await using rails = serve("none")
    await using tmp = await tmpdir()
    delete process.env["ENK_PROJECT_DIRECTORY"]

    const res = await deliver(tmp.path)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: "not_finalized" })
    expect(rails.results).toEqual([])
  })

  test("lands in the main event project even when asked from the tutorial", async () => {
    await using rails = serve("pending")
    await using root = await tmpdir({ git: true })
    const project = path.join(root.path, "project-directory")
    const tutorial = path.join(root.path, "tutorial-directory")
    const config = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "k", baseURL: `${rails.server.url.origin}/v1` } } },
      agent: { plan: { model: "alibaba/qwen-plus" } },
      ensureOneSession: true,
    })
    await Bun.write(path.join(project, "opencode.json"), config)
    await Bun.write(path.join(tutorial, "opencode.json"), config)
    process.env["ENK_PROJECT_DIRECTORY"] = project

    const res = await deliver(tutorial)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: "delivered" })

    const [result] = rails.results as { status: string; session_id: string }[]
    expect(result.status).toBe("delivered")
    const session = await Instance.provide({ directory: project, fn: () => Session.get(result.session_id as never) })
    expect(session.directory).toBe(project)
  })
})
