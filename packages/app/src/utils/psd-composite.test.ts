import { describe, expect, test } from "bun:test"
import { readPsdComposite } from "./psd-composite"

type Options = {
  width: number
  height: number
  /** 채널별 평면 바이트(8 bit 면 한 픽셀 1바이트, 16 bit 면 2바이트). */
  planes: number[][]
  mode?: number
  depth?: number
  version?: 1 | 2
  /** 생략하면 Layer and Mask 섹션이 비어 있다. */
  layerCount?: number
  compression?: 0 | 1
}

// PackBits 로 한 행을 리터럴 하나로만 싼다(디코더는 리터럴·반복 둘 다 받으므로 반복은 따로 시험).
const literalRow = (row: number[]) => [row.length - 1, ...row]

function makePsd(options: Options) {
  const version = options.version ?? 1
  const psb = version === 2
  const depth = options.depth ?? 8
  const bytes: number[] = []
  const u16 = (value: number) => bytes.push((value >> 8) & 255, value & 255)
  const u32 = (value: number) =>
    bytes.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
  const len = (value: number) => (psb ? (u32(0), u32(value)) : u32(value))

  bytes.push(0x38, 0x42, 0x50, 0x53)
  u16(version)
  bytes.push(0, 0, 0, 0, 0, 0)
  u16(options.planes.length)
  u32(options.height)
  u32(options.width)
  u16(depth)
  u16(options.mode ?? 3)
  u32(0) // color mode data
  u32(0) // image resources
  if (options.layerCount === undefined) len(0)
  else {
    // layer info 길이 + 레이어 수(int16) 만. 디코더는 레이어 수의 부호만 본다.
    len((psb ? 8 : 4) + 2)
    len(2)
    u16(options.layerCount & 0xffff)
  }

  const compression = options.compression ?? 0
  u16(compression)
  const rowBytes = options.width * (depth / 8)
  if (compression === 0) {
    for (const plane of options.planes) bytes.push(...plane)
  } else {
    const rows = options.planes.flatMap((plane) =>
      Array.from({ length: options.height }, (_, y) => literalRow(plane.slice(y * rowBytes, (y + 1) * rowBytes))),
    )
    for (const row of rows) (psb ? u32 : u16)(row.length)
    for (const row of rows) bytes.push(...row)
  }
  return new Uint8Array(bytes)
}

const pixels = (data: Uint8ClampedArray) =>
  Array.from({ length: data.length / 4 }, (_, i) => [...data.slice(i * 4, i * 4 + 4)])

describe("readPsdComposite", () => {
  test("reads an opaque 8-bit RGB composite", () => {
    const psd = makePsd({
      width: 2,
      height: 1,
      planes: [
        [255, 1],
        [0, 2],
        [10, 3],
      ],
    })
    const result = readPsdComposite(psd)
    expect(result.width).toBe(2)
    expect(result.height).toBe(1)
    expect(pixels(result.data)).toEqual([
      [255, 0, 10, 255],
      [1, 2, 3, 255],
    ])
  })

  // PhotoCraft 0.7.0 이 투명 픽셀이 있는 4×1 이미지를 저장했을 때의 실제 합성 값(흰 바탕에 얹힘)이다.
  test("removes the white matte when the composite carries transparency", () => {
    const psd = makePsd({
      width: 4,
      height: 1,
      layerCount: -1,
      compression: 1,
      planes: [
        [255, 127, 0, 255],
        [0, 127, 255, 255],
        [0, 255, 0, 255],
        [255, 128, 255, 0],
      ],
    })
    expect(pixels(readPsdComposite(psd).data)).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 128],
      [0, 255, 0, 255],
      [0, 0, 0, 0],
    ])
  })

  test("treats an extra channel as a saved selection, not transparency, when the layer count is positive", () => {
    const psd = makePsd({ width: 1, height: 1, layerCount: 1, planes: [[9], [8], [7], [0]] })
    expect(pixels(readPsdComposite(psd).data)).toEqual([[9, 8, 7, 255]])
  })

  test("decodes PackBits repeat runs", () => {
    const psd = makePsd({ width: 3, height: 1, planes: [[0], [0], [0]], compression: 0 })
    // 직접 RLE 본문을 만든다: 각 채널 한 행 = [-2(반복 3회), 값].
    const header = psd.subarray(0, psd.length - 3 - 2)
    const body = [0, 1, 0, 2, 0, 2, 0, 2, 0xfe, 40, 0xfe, 50, 0xfe, 60]
    const rle = new Uint8Array([...header, ...body])
    // 헤더의 width 는 1 로 만들어졌으므로 3 으로 고친다.
    new DataView(rle.buffer).setUint32(18, 3)
    expect(pixels(readPsdComposite(rle).data)).toEqual([
      [40, 50, 60, 255],
      [40, 50, 60, 255],
      [40, 50, 60, 255],
    ])
  })

  test("reads 16-bit samples by their high byte", () => {
    const psd = makePsd({
      width: 1,
      height: 1,
      depth: 16,
      planes: [
        [0x12, 0x34],
        [0xab, 0xcd],
        [0xff, 0x00],
      ],
    })
    expect(pixels(readPsdComposite(psd).data)).toEqual([[0x12, 0xab, 0xff, 255]])
  })

  test("expands grayscale to RGB", () => {
    const psd = makePsd({ width: 1, height: 1, mode: 1, planes: [[77]] })
    expect(pixels(readPsdComposite(psd).data)).toEqual([[77, 77, 77, 255]])
  })

  test("reads PSB (large document) lengths", () => {
    const psd = makePsd({
      width: 1,
      height: 1,
      version: 2,
      layerCount: -1,
      compression: 1,
      planes: [[1], [2], [3], [255]],
    })
    expect(pixels(readPsdComposite(psd).data)).toEqual([[1, 2, 3, 255]])
  })

  test("rejects what it cannot decode", () => {
    expect(() => readPsdComposite(new TextEncoder().encode("not a psd at all, just text"))).toThrow("not a PSD")
    expect(() => readPsdComposite(makePsd({ width: 1, height: 1, mode: 4, planes: [[0], [0], [0], [0]] }))).toThrow(
      "color mode 4",
    )
    expect(() => readPsdComposite(makePsd({ width: 1, height: 1, depth: 32, planes: [[0, 0, 0, 0]] }))).toThrow(
      "32-bit",
    )
  })
})
