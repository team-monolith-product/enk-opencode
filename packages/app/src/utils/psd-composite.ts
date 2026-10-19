/**
 * PSD/PSB 파일에서 합성 이미지(Image Data section, "merged image")만 꺼내 RGBA 로 돌려준다.
 *
 * PhotoCraft 의 저장(⌘S)은 언제나 PSD 를 내려받는다. 원본 PNG/JPEG 를 덮어쓰려면 레이어를 다
 * 합친 결과가 필요한데, PSD 는 그 결과를 파일 끝 Image Data 에 따로 담아 두므로 레이어를 다시
 * 합성할 필요 없이 그 부분만 읽으면 된다. 스펙: Adobe Photoshop File Formats Specification.
 *
 * 지원 범위: RGB·Grayscale, 8/16 bit, raw·RLE 압축. 그 밖(CMYK, Lab, 인덱스, 32 bit)은 예외를 던진다.
 */

export type PsdComposite = {
  width: number
  height: number
  /** straight(비 premultiplied) RGBA, 행 우선. */
  data: Uint8ClampedArray<ArrayBuffer>
}

const COLOR_MODE_GRAYSCALE = 1
const COLOR_MODE_RGB = 3

export function readPsdComposite(bytes: Uint8Array): PsdComposite {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fail = (reason: string): never => {
    throw new Error(`Unsupported PSD: ${reason}`)
  }
  if (bytes.byteLength < 26 || view.getUint32(0) !== 0x38425053) fail("not a PSD file") // "8BPS"

  const version = view.getUint16(4)
  if (version !== 1 && version !== 2) fail(`version ${version}`)
  const psb = version === 2
  const channels = view.getUint16(12)
  const height = view.getUint32(14)
  const width = view.getUint32(18)
  const depth = view.getUint16(22)
  const mode = view.getUint16(24)
  if (depth !== 8 && depth !== 16) fail(`${depth}-bit depth`)
  if (mode !== COLOR_MODE_RGB && mode !== COLOR_MODE_GRAYSCALE) fail(`color mode ${mode}`)

  const color = mode === COLOR_MODE_RGB ? 3 : 1
  if (channels < color) fail(`${channels} channels`)

  let offset = 26
  const length64 = (at: number) => view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4)
  const skip = () => {
    const size = view.getUint32(offset)
    offset += 4 + size
  }
  skip() // Color Mode Data
  skip() // Image Resources

  // Layer and Mask Information. 레이어 수가 음수면 "첫 알파 채널이 합성 결과의 투명도"라는 뜻이고,
  // 그때만 색 다음 채널을 투명도로 읽는다(아니면 그 채널은 저장된 선택 영역 같은 별도 알파다).
  const sectionSize = psb ? length64(offset) : view.getUint32(offset)
  const sectionStart = offset + (psb ? 8 : 4)
  let mergedAlpha = false
  if (sectionSize > 0) {
    const layerInfoSize = psb ? length64(sectionStart) : view.getUint32(sectionStart)
    if (layerInfoSize > 0) mergedAlpha = view.getInt16(sectionStart + (psb ? 8 : 4)) < 0
  }
  offset = sectionStart + sectionSize
  const alpha = mergedAlpha && channels > color

  const compression = view.getUint16(offset)
  offset += 2
  const sample = depth / 8
  const rowBytes = width * sample
  const planes = color + (alpha ? 1 : 0)
  const plane = (index: number) => new Uint8Array(height * rowBytes).fill(index === color ? 255 : 0)
  const decoded = Array.from({ length: planes }, (_, index) => plane(index))

  if (compression === 0) {
    for (let channel = 0; channel < planes; channel++) {
      const start = offset + channel * height * rowBytes
      if (start + height * rowBytes > bytes.byteLength) fail("truncated image data")
      decoded[channel]!.set(bytes.subarray(start, start + height * rowBytes))
    }
  } else if (compression === 1) {
    // 모든 채널의 행 길이 표가 먼저 오고(PSD 는 2바이트, PSB 는 4바이트), 그 뒤에 PackBits 행들이 이어진다.
    const countSize = psb ? 4 : 2
    const counts = (index: number) =>
      psb ? view.getUint32(offset + index * countSize) : view.getUint16(offset + index * countSize)
    let data = offset + channels * height * countSize
    for (let channel = 0; channel < channels; channel++) {
      for (let row = 0; row < height; row++) {
        const size = counts(channel * height + row)
        if (channel < planes) unpackBits(bytes, data, size, decoded[channel]!, row * rowBytes, rowBytes, fail)
        data += size
      }
      if (channel >= planes - 1) break
    }
  } else {
    fail(`compression ${compression}`)
  }

  const data = new Uint8ClampedArray(width * height * 4)
  const read = (channel: number, pixel: number) => decoded[channel]![pixel * sample]! // 16 bit 은 상위 바이트
  for (let pixel = 0; pixel < width * height; pixel++) {
    const a = alpha ? read(color, pixel) : 255
    for (let c = 0; c < 3; c++) {
      const matted = read(color === 3 ? c : 0, pixel)
      // 투명도가 있으면 합성 색은 흰 바탕에 얹힌 값이다: matted = c·a + 255·(1 − a). 이를 되돌린다.
      data[pixel * 4 + c] = a === 255 ? matted : a === 0 ? 0 : Math.round(((matted - 255 + a) * 255) / a)
    }
    data[pixel * 4 + 3] = a
  }
  return { width, height, data }
}

function unpackBits(
  source: Uint8Array,
  start: number,
  size: number,
  target: Uint8Array,
  at: number,
  length: number,
  fail: (reason: string) => never,
) {
  const end = start + size
  if (end > source.byteLength) fail("truncated image data")
  let read = start
  let write = at
  const limit = at + length
  while (read < end && write < limit) {
    const header = (source[read++]! << 24) >> 24 // signed
    if (header >= 0) {
      const count = Math.min(header + 1, limit - write, end - read)
      target.set(source.subarray(read, read + count), write)
      read += header + 1
      write += count
    } else if (header !== -128) {
      const count = Math.min(1 - header, limit - write)
      target.fill(source[read++]!, write, write + count)
      write += count
    }
  }
}
