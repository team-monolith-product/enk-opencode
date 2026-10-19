import { describe, expect, test } from "bun:test"
import { AiUsage } from "../src/ai-usage"

const DIR = "/home/jovyan/fs/teams/45/project-directory"
const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 0 } }

function recorder() {
  const records: Array<{ record: AiUsage.Attributes; key?: string }> = []
  const reporter: AiUsage.Reporter = {
    enqueue: (record, key) => void records.push({ record, key }),
    flush: () => Promise.resolve(),
  }
  return { records, reporter }
}

const event = (type: string, data: Record<string, unknown>, directory: string | null = DIR) => ({
  type,
  ...(directory === null ? {} : { location: { directory } }),
  data: { sessionID: "ses_1", ...data },
})

describe("AiUsage tracker", () => {
  test("reports start, every step under the turn's first message, and final", () => {
    const { records, reporter } = recorder()
    let clock = 1_000
    const observe = AiUsage.createTracker(reporter, DIR, () => clock++)
    const model = { id: "gemini-3.5-flash", providerID: "google" }
    observe(event("session.created", {}))
    observe(event("session.execution.started", {}, null))
    observe(event("session.step.started", { assistantMessageID: "msg_a", model, started: 500 }))
    observe(event("session.step.ended", { assistantMessageID: "msg_a", cost: 0.01, tokens }))
    observe(event("session.step.started", { assistantMessageID: "msg_b", model, started: 600 }))
    observe(event("session.step.failed", { assistantMessageID: "msg_b", cost: 0.02, tokens }))
    observe(event("session.execution.succeeded", {}, null))

    expect(records.map(({ record }) => [record.phase, record.message_id, record.step_index, record.cost])).toEqual([
      ["start", "msg_a", -1, 0],
      ["step", "msg_a", 0, 0.01],
      ["step", "msg_a", 1, 0.02],
      ["final", "msg_a", -1, 0],
    ])
    expect(records[0].record.used_at).toBe(new Date(500).toISOString())
    expect(records[1].record).toMatchObject({
      mount_path: DIR,
      model_id: "gemini-3.5-flash",
      tokens: 117,
      input: 10,
      output: 5,
      reasoning: 2,
      cache_read: 100,
      cache_write: 0,
    })
  })

  test("ignores events from other directories and failed steps without usage", () => {
    const { records, reporter } = recorder()
    const observe = AiUsage.createTracker(reporter, DIR)
    observe(event("session.step.started", { assistantMessageID: "msg_a", model: { id: "m" } }, "/other"))
    observe(event("session.step.failed", { assistantMessageID: "msg_a" }))
    observe(event("session.execution.succeeded", {}, null))
    expect(records).toEqual([])
  })

  test("closes interrupted turns and reports compaction usage as a step", () => {
    const { records, reporter } = recorder()
    const observe = AiUsage.createTracker(reporter, DIR, () => 2_000)
    observe(event("session.step.started", { assistantMessageID: "msg_a", model: { id: "m" } }))
    observe(event("session.execution.interrupted", { reason: "user" }, null))
    observe(event("session.compaction.ended", { model: { id: "c" }, cost: 0.5, tokens }))
    expect(records.map(({ record }) => [record.phase, record.model_id, record.cost])).toEqual([
      ["start", "m", 0],
      ["final", "m", 0],
      ["step", "c", 0.5],
    ])
  })
})

describe("AiUsage reporter", () => {
  test("batches records into one do_many request with the usage token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const reporter = AiUsage.createReporter({
      url: "https://hackathon.example/",
      token: "tok",
      delay: () => Promise.resolve(),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(null, { status: 201 })
      }) as typeof fetch,
    })
    reporter.enqueue(AiUsage.startAttributes(DIR, "m", "msg_a", 0))
    reporter.enqueue(AiUsage.startAttributes(DIR, "m", "msg_a", 0))
    reporter.enqueue(AiUsage.finalAttributes(DIR, "m", "msg_a", 0))
    await reporter.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://hackathon.example/api/v1/ai_usages/do_many")
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("token tok")
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.data_to_create.map((item: any) => [item.type, item.attributes.phase])).toEqual([
      ["ai-usages", "start"],
      ["ai-usages", "final"],
    ])
  })

  test("retries server errors and drops client errors", async () => {
    const statuses = [500, 201, 422]
    let calls = 0
    const logs: string[] = []
    const reporter = AiUsage.createReporter({
      url: "https://hackathon.example",
      token: "tok",
      delay: () => Promise.resolve(),
      log: (message) => void logs.push(message),
      fetch: (async () => new Response(null, { status: statuses[calls++] })) as unknown as typeof fetch,
    })
    reporter.enqueue(AiUsage.startAttributes(DIR, "m", "msg_a", 0))
    await reporter.flush()
    expect(calls).toBe(2)
    reporter.enqueue(AiUsage.startAttributes(DIR, "m", "msg_b", 0))
    await reporter.flush()
    expect(calls).toBe(3)
    expect(logs).toEqual(["rejected"])
  })

  test("remember keeps the newest keys within the cap", () => {
    const set = new Set<string>()
    for (const key of ["a", "b", "c", "d"]) AiUsage.remember(set, key, 3)
    expect([...set]).toEqual(["b", "c", "d"])
  })
})
