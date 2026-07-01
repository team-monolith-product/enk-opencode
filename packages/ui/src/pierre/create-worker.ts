// new Worker()는 cross-origin 스크립트 URL을 same-origin 제약으로 거부한다(SecurityError).
// 자산이 CDN(OPENCODE_ASSET_BASE)에서 서빙되면 same-origin blob 모듈로 부트스트랩해 실제
// 워커를 import 한다. CDN이 CORS(ACAO *)를 허용하므로 모듈과 내부 동적 wasm 청크가 로드된다.
// 이 파일이 new Worker 를 호출하는 유일한 지점이다(create-worker.test.ts 가드로 강제).
// 전제: location 을 참조하므로 클라이언트에서만 호출한다. 현재 유일한 호출부 workerFactory 는
// getWorkerPool 의 typeof window 가드 뒤에서만 실행된다. 새 호출부도 같은 전제를 지켜야 한다.
export function createWorker(url: string): Worker {
  const resolved = new URL(url, location.href)
  if (resolved.origin === location.origin) {
    return new Worker(resolved.href, { type: "module" })
  }

  // blob 모듈은 자기 objectURL 을 revoke 한 뒤 CDN 워커를 import 한다. import 는 hoisting 되어
  // 워커가 먼저 평가되고 revoke 는 그 뒤 실행되므로 누수·타이밍 모두 안전하다(Vite inline 래퍼와 동일).
  const bootstrap = `URL.revokeObjectURL(import.meta.url);\nimport ${JSON.stringify(resolved.href)};`
  const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }))
  return new Worker(blobUrl, { type: "module" })
}
