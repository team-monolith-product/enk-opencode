// 자산이 다른 origin(CDN)에서 오면 new Worker 가 SecurityError 를 낸다. same-origin blob 모듈이 실제 워커를
// 동적 import 하고, 그 사이 들어온 메시지는 버퍼에 모았다가 다시 보낸다(정적 import 면 초기 메시지가 유실된다).
export function buildWorkerBootstrap(href: string): string {
  return [
    `const q = [];`,
    `const buf = (e) => q.push(e.data);`,
    `self.addEventListener("message", buf);`,
    `URL.revokeObjectURL(import.meta.url);`,
    `import(${JSON.stringify(href)}).then(() => {`,
    `  self.removeEventListener("message", buf);`,
    `  for (const data of q) self.dispatchEvent(new MessageEvent("message", { data }));`,
    `}).catch((error) => { setTimeout(() => { throw error }); });`,
  ].join("\n")
}

export function createWorker(url: string): Worker {
  const resolved = new URL(url, location.href)
  if (resolved.origin === location.origin) {
    return new Worker(resolved.href, { type: "module" })
  }

  const blobUrl = URL.createObjectURL(new Blob([buildWorkerBootstrap(resolved.href)], { type: "text/javascript" }))
  return new Worker(blobUrl, { type: "module" })
}
