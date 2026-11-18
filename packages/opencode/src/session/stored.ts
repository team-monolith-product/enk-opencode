export namespace SessionStored {
  export type Ref = `media:${string}`

  const REF = /^media:[0-9a-f]{64}$/

  export const isRef = (url: unknown): url is Ref => typeof url === "string" && REF.test(url)

  export const refHash = (ref: Ref) => ref.slice("media:".length)

  export const ref = (hash: string): Ref => `media:${hash}`
}
