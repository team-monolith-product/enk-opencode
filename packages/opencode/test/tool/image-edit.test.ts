import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import zlib from "zlib"
import { ImageCommandsTool, ImageEditTool } from "../../src/tool/image-edit"
import { PhotoCraft } from "../../src/enk/photocraft"
import { FileRoutes } from "../../src/server/routes/file"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { Writable } from "../../src/file/writable"

// 실제 photocraft-cli 가 있어야 하는 테스트는 그때만 돈다(로컬: OPENCODE_PHOTOCRAFT_CLI, 서버 이미지: PATH).
const withCli = test.skipIf(!PhotoCraft.available())

const ctx = {
  sessionID: SessionID.make("ses_test-image-edit"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

afterEach(async () => {
  await Instance.disposeAll()
})

const crc = (bytes: Buffer) => {
  let c = ~0
  for (const byte of bytes) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc(body))
  return Buffer.concat([head, body, tail])
}

/** 8 bit RGB PNG. pixels 는 행 우선 [r,g,b] 목록. */
function png(width: number, height: number, pixels: number[][]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const rows: number[] = []
  for (let y = 0; y < height; y++) rows.push(0, ...pixels.slice(y * width, (y + 1) * width).flat())
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** 8 bit RGB/RGBA PNG 를 [r,g,b] 목록으로 푼다(필터 0~4 모두). */
function pixelsOf(bytes: Buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let channels = 3
  const idat: Buffer[] = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : 3
    }
    if (type === "IDAT") idat.push(data)
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!
      const a = x >= channels ? out[y * stride + x - channels]! : 0
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0
      const p = a + b - c
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!
      out[y * stride + x] = (value + predictor) & 0xff
    }
  }
  return Array.from({ length: width * height }, (_, i) => [...out.subarray(i * channels, i * channels + 3)])
}

describe("tool.image_edit", () => {
  withCli("applies the commands and overwrites the image in its own format", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    fs.writeFileSync(
      file,
      png(2, 1, [
        [255, 0, 10],
        [1, 2, 3],
      ]),
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ImageEditTool.init()
        const result = await tool.execute({ path: "a.png", steps: [{ command: "image.adjustments.invert" }] }, ctx)
        expect(result.metadata).toMatchObject({ path: "a.png", completed: 1, width: 2, height: 1 })
        expect(result.metadata.failed).toBeUndefined()
        expect(pixelsOf(fs.readFileSync(file))).toEqual([
          [0, 255, 245],
          [254, 253, 252],
        ])
        expect(PhotoCraft.Lock.list()).toEqual([])
      },
    })
  })

  withCli("saves nothing when a step fails and says which one", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    const original = png(1, 1, [[10, 20, 30]])
    fs.writeFileSync(file, original)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ImageEditTool.init()
        const result = await tool.execute(
          { path: "a.png", steps: [{ command: "image.adjustments.invert" }, { command: "no.such.command" }] },
          ctx,
        )
        expect(result.metadata.failed).toMatchObject({ index: 1, command: "no.such.command" })
        expect(result.output).toContain("아무것도 저장하지 않았습니다")
        expect(fs.readFileSync(file).equals(original)).toBe(true)
        expect(PhotoCraft.Lock.list()).toEqual([])
      },
    })
  })

  withCli("refuses while another edit holds the image", async () => {
    await using tmp = await tmpdir({ git: true })
    fs.writeFileSync(path.join(tmp.path, "a.png"), png(1, 1, [[0, 0, 0]]))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const release = await PhotoCraft.Lock.acquire((await Writable.file("a.png"))!, "ses_other")
        const tool = await ImageEditTool.init()
        await expect(
          tool.execute({ path: "a.png", steps: [{ command: "image.adjustments.invert" }] }, ctx),
        ).rejects.toThrow("이미 다른 AI 편집")
        await release!()
      },
    })
  })

  test("refuses formats PhotoCraft cannot read and files outside the project", async () => {
    await using tmp = await tmpdir({ git: true })
    fs.writeFileSync(path.join(tmp.path, "a.avif"), "x")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ImageEditTool.init()
        await expect(
          tool.execute({ path: "a.avif", steps: [{ command: "image.adjustments.invert" }] }, ctx),
        ).rejects.toThrow("PhotoCraft 로 열 수 없습니다")
        await expect(
          tool.execute({ path: "missing.png", steps: [{ command: "image.adjustments.invert" }] }, ctx),
        ).rejects.toThrow("편집할 수 없습니다")
      },
    })
  })
})

describe("tool.image_commands", () => {
  withCli("finds commands with their params", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ImageCommandsTool.init()
        const result = await tool.execute({ filter: "gaussianBlur" }, ctx)
        expect(result.output).toContain("filter.blur.gaussianBlur")
      },
    })
  })
})

describe("PhotoCraft.Lock", () => {
  test("locks one editor at a time, lists it, and blocks saves until released", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    fs.writeFileSync(file, "old")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const release = await PhotoCraft.Lock.acquire((await Writable.file("a.png"))!, "ses_a")
        expect(release).toBeDefined()
        expect(await PhotoCraft.Lock.acquire((await Writable.file("a.png"))!, "ses_b")).toBeUndefined()

        const listed = await FileRoutes().request("/file/lock")
        expect(await listed.json()).toMatchObject([{ path: "a.png", sessionID: "ses_a" }])

        const put = () =>
          FileRoutes().request(`/file/content?path=a.png`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: "new",
          })
        expect((await put()).status).toBe(409)
        expect(fs.readFileSync(file, "utf8")).toBe("old")

        await release!()
        expect(PhotoCraft.Lock.list()).toEqual([])
        expect((await put()).status).toBe(200)
      },
    })
  })

  test("rechecks the lock and the expected hash after a slow upload, right before replacing", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    fs.writeFileSync(file, "old")
    const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // 업로드가 끝나기 전에 AI 편집이 잠그면, 처음 확인을 통과했어도 교체하지 않는다.
        const slow = () => {
          let finish!: () => void
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("ne"))
              finish = () => {
                controller.enqueue(new TextEncoder().encode("w"))
                controller.close()
              }
            },
          })
          return { body, finish: () => finish() }
        }
        const put = (body: BodyInit) =>
          FileRoutes().request(`/file/content?path=a.png&expected=${hash("old")}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body,
            // @ts-expect-error Bun 은 스트림 본문에 duplex 가 필요하다
            duplex: "half",
          })

        const first = slow()
        const pending = put(first.body)
        await Bun.sleep(20)
        const release = await PhotoCraft.Lock.acquire((await Writable.file("a.png"))!, "ses_a")
        first.finish()
        expect((await pending).status).toBe(409)
        expect(fs.readFileSync(file, "utf8")).toBe("old")
        await release!()

        // 같은 원본에서 시작한 두 저장은 하나만 들어가고 나머지는 409.
        const statuses = await Promise.all([put("one"), put("two")]).then((r) => r.map((x) => x.status).sort())
        expect(statuses).toEqual([200, 409])
        expect(["one", "two"]).toContain(fs.readFileSync(file, "utf8"))
        expect(fs.readdirSync(tmp.path).filter((name) => name.endsWith(".tmp"))).toEqual([])
      },
    })
  })

  test("locks the file itself, so another name for it (a symlink) is locked too", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "a.png")
    fs.writeFileSync(file, "old")
    fs.symlinkSync("a.png", path.join(tmp.path, "link.png"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const release = await PhotoCraft.Lock.acquire((await Writable.file("link.png"))!, "ses_a")
        expect(release).toBeDefined()
        expect(await PhotoCraft.Lock.acquire((await Writable.file("a.png"))!, "ses_b")).toBeUndefined()
        expect(PhotoCraft.Lock.list()).toMatchObject([{ path: "link.png", sessionID: "ses_a" }])

        const put = await FileRoutes().request(`/file/content?path=a.png`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: "new",
        })
        expect(put.status).toBe(409)
        expect(fs.readFileSync(file, "utf8")).toBe("old")
        await release!()
      },
    })
  })

  test("shares the lock with an instance opened at a subfolder of the same repository", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "sub")
    fs.mkdirSync(sub)
    const file = path.join(sub, "a.png")
    fs.writeFileSync(file, "old")

    const release = await Instance.provide({
      directory: tmp.path,
      fn: async () => PhotoCraft.Lock.acquire((await Writable.file("sub/a.png"))!, "ses_a"),
    })
    expect(release).toBeDefined()
    try {
      await Instance.provide({
        directory: sub,
        fn: async () => {
          expect(PhotoCraft.Lock.list()).toMatchObject([{ path: "a.png", sessionID: "ses_a" }])
          expect(await PhotoCraft.Lock.acquire((await Writable.file("a.png"))!, "ses_b")).toBeUndefined()
          const put = await FileRoutes().request(`/file/content?path=a.png`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: "new",
          })
          expect(put.status).toBe(409)
          expect(fs.readFileSync(file, "utf8")).toBe("old")
        },
      })
    } finally {
      await Instance.provide({ directory: tmp.path, fn: () => release!() })
    }
  })
})
