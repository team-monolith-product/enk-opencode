import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ensureSession, firstSession, getOrCreateMain, sessionLimit } from "../../src/session/ensure"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function active(path: string) {
  return Instance.provide({
    directory: path,
    fn: async () =>
      [...Session.list({ directory: path, roots: true })].filter((session) => !session.time?.archived),
  })
}

describe("getOrCreateMain ensureOneSession", () => {
  test("creates a new main session when ensureOneSession is off", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await getOrCreateMain()
        const two = await getOrCreateMain()
        expect(one.id).not.toBe(two.id)
      },
    })
  })

  test("returns existing main session when ensureOneSession is on", async () => {
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await getOrCreateMain()
        const two = await getOrCreateMain()
        expect(two.id).toBe(one.id)
        expect(await active(tmp.path)).toHaveLength(1)
      },
    })
  })

  test("concurrent getOrCreateMain creates only one main session", async () => {
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const [one, two] = await Promise.all([getOrCreateMain(), getOrCreateMain()])
        expect(one.id).toBe(two.id)
        expect(await active(tmp.path)).toHaveLength(1)
      },
    })
  })

  test("allows child session when ensureOneSession is on", async () => {
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const main = await getOrCreateMain()
        const child = await getOrCreateMain({ parentID: main.id })
        expect(child.parentID).toBe(main.id)
        expect(await active(tmp.path)).toHaveLength(1)
      },
    })
  })

  test("creates new main when only archived mains exist", async () => {
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const archived = await Session.create({})
        await Session.setArchived({ sessionID: archived.id, time: Date.now() })
        const next = await getOrCreateMain()
        expect(next.id).not.toBe(archived.id)
        expect(await active(tmp.path)).toHaveLength(1)
      },
    })
  })
})

describe("ensureSession with ensureOneSession", () => {
  test("bootstrap and client create share one session when both are on", async () => {
    await using tmp = await tmpdir({ config: { ensureSession: true, ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await ensureSession()
        await getOrCreateMain()
      },
      fn: async () => {},
    })

    const sessions = await active(tmp.path)
    expect(sessions).toHaveLength(1)
  })

  test("ensureOneSession alone does not bootstrap create", async () => {
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      init: ensureSession,
      fn: async () => {},
    })

    expect(await active(tmp.path)).toHaveLength(0)
  })
})

describe("team session limit", () => {
  afterEach(() => {
    delete process.env["ENK_SESSION_LIMIT"]
  })

  test("creates sessions up to the limit, then returns an existing one", async () => {
    process.env["ENK_SESSION_LIMIT"] = "2"
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await getOrCreateMain()
        const two = await getOrCreateMain(undefined, { fresh: true })
        const three = await getOrCreateMain(undefined, { fresh: true })
        expect(two.id).not.toBe(one.id)
        expect([one.id, two.id]).toContain(three.id)
        expect(await active(tmp.path)).toHaveLength(2)
      },
    })
  })

  test("concurrent creates never pass the limit", async () => {
    process.env["ENK_SESSION_LIMIT"] = "2"
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fresh = { fresh: true }
        await Promise.all([
          getOrCreateMain(undefined, fresh),
          getOrCreateMain(undefined, fresh),
          getOrCreateMain(undefined, fresh),
          getOrCreateMain(undefined, fresh),
        ])
        expect(await active(tmp.path)).toHaveLength(2)
      },
    })
  })

  test("a create without the fresh request reuses the open session", async () => {
    process.env["ENK_SESSION_LIMIT"] = "2"
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await getOrCreateMain()
        const two = await getOrCreateMain()
        expect(two.id).toBe(one.id)
        expect(await active(tmp.path)).toHaveLength(1)
      },
    })
  })

  test("an out-of-range limit falls back to between 1 and 3", async () => {
    process.env["ENK_SESSION_LIMIT"] = "9"
    expect(sessionLimit()).toBe(3)
    process.env["ENK_SESSION_LIMIT"] = "0"
    expect(sessionLimit()).toBe(1)
    delete process.env["ENK_SESSION_LIMIT"]
    expect(sessionLimit()).toBe(1)
  })

  test("the first session is the oldest active one", async () => {
    process.env["ENK_SESSION_LIMIT"] = "2"
    await using tmp = await tmpdir({ config: { ensureOneSession: true } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const one = await getOrCreateMain()
        await getOrCreateMain(undefined, { fresh: true })
        await Session.setTitle({ sessionID: one.id, title: "touched" })
        expect((await firstSession()).id).toBe(one.id)
      },
    })
  })
})
