// new Worker()는 cross-origin 스크립트 URL을 same-origin 제약으로 거부한다(SecurityError).
// 자산이 CDN(OPENCODE_ASSET_BASE)에서 서빙되면 same-origin blob 모듈로 부트스트랩해 실제
// 워커를 import 한다. CDN이 CORS(ACAO *)를 허용하므로 모듈과 내부 동적 wasm 청크가 로드된다.
// 이 파일이 new Worker 를 호출하는 유일한 지점이다(create-worker.test.ts 가드로 강제).
// 전제: location 을 참조하므로 클라이언트에서만 호출한다. 현재 유일한 호출부 workerFactory 는
// getWorkerPool 의 typeof window 가드 뒤에서만 실행된다. 새 호출부도 같은 전제를 지켜야 한다.
// blob 모듈은 CDN 워커를 "동적" import 하고, 그 사이 도착한 메시지를 버퍼링했다가 재전송한다.
// 정적 import 로 하면(hoisting) blob 모듈 본문에 동기 message 리스너가 남지 않는다. 그러면 워커 포트가
// CDN 워커의 네트워크 로드보다 먼저 enable 되는 순간, 그 틈에 온 메시지가 리스너 없이 버려진다.
// WorkerPoolManager 는 워커 생성 직후 곧바로 initialize 를 postMessage 하므로(재전송 없음) 이 메시지가
// 유실되어 워커가 영영 초기화되지 않는다 → 하이라이트가 멈춰 파일 내용이 백지로 남는다. same-origin
// 직접 워커(new Worker(url))는 브라우저가 조기 메시지를 버퍼링하므로 이 문제가 없고, CDN(cross-origin)
// blob 부트스트랩에서만 재현된다(INF-336 후속). 동기 버퍼가 조기 메시지를 큐잉하고, CDN 워커 로드가
// 끝나면 그 워커가 등록한 리스너로 되돌려 재-디스패치한다.
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
