// SHA-256 hex digest. crypto.subtle only exists in a secure context (https or localhost); when the
// app is opened over plain http on a LAN address it is missing, so a small pure-JS version stands in.
// The server compares this value with its own hash, so a random fallback is not good enough here.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** Pure-JS SHA-256 of `bytes`, as lowercase hex. */
export function sha256Sync(bytes: Uint8Array) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  // Message + 0x80 + zero padding + 64-bit big-endian bit length, to a multiple of 64 bytes.
  const total = Math.ceil((bytes.length + 9) / 64) * 64
  const tail = new Uint8Array(total - Math.floor(bytes.length / 64) * 64)
  const full = bytes.length - (bytes.length % 64)
  tail.set(bytes.subarray(full))
  tail[bytes.length - full] = 0x80
  const view = new DataView(tail.buffer)
  const bits = bytes.length * 8
  view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(tail.length - 4, bits >>> 0)

  const block = (data: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!
      const b = w[i - 2]!
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (hh! + s1 + ch + K[i]! + w[i]!) | 0
      const s0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (s0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d! + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0]! += a!
    h[1]! += b!
    h[2]! += c!
    h[3]! += d!
    h[4]! += e!
    h[5]! += f!
    h[6]! += g!
    h[7]! += hh!
  }

  for (let offset = 0; offset < full; offset += 64) block(bytes, offset)
  for (let offset = 0; offset < tail.length; offset += 64) block(tail, offset)
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("")
}

/** SHA-256 of a blob as lowercase hex, using crypto.subtle when the page has it. */
export async function sha256(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return sha256Sync(new Uint8Array(buffer))
  const digest = await subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
