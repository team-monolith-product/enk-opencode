import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { ImageToggle } from "../../src/enk/image-toggle"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Storage.remove(["enk", "image-generation"]).catch(() => undefined)
})

describe("ImageToggle", () => {
  test("is on until someone in the team turns it off", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await ImageToggle.on()).toBe(true)
        await ImageToggle.set(false)
        expect(await ImageToggle.on()).toBe(false)
      },
    })
  })

  test("tells every open screen of the workspace when it changes", async () => {
    await using tmp = await tmpdir()
    const seen = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const events: boolean[] = []
        const unsub = Bus.subscribe(ImageToggle.Event.Updated, (evt) => {
          events.push(evt.properties.on)
        })
        await ImageToggle.set(false)
        await ImageToggle.set(true)
        unsub()
        return events
      },
    })
    expect(seen).toEqual([false, true])
    expect(await ImageToggle.on()).toBe(true)
  })
})
