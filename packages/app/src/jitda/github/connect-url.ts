const BANA = /(^|\.)bana\.build$/

function hostOrigin(): string | undefined {
  const ancestor = globalThis.location?.ancestorOrigins?.[0]
  if (ancestor) return ancestor
  const referrer = globalThis.document?.referrer
  if (!referrer) return
  return new URL(referrer).origin
}

export function connectUrlFor(connectUrl: string, host = hostOrigin()) {
  if (!host) return connectUrl
  const target = new URL(connectUrl)
  const embedder = new URL(host)
  if (embedder.origin === target.origin || !BANA.test(embedder.hostname)) return connectUrl
  return new URL(`${target.pathname}${target.search}`, embedder.origin).toString()
}
