// SVG <use> 외부 참조는 cross-origin 이 브라우저 정책으로 차단된다(worker 와 동일한 부류).
// 자산이 CDN(OPENCODE_ASSET_BASE)에서 서빙되면 스프라이트 URL 이 cross-origin 이 되어 아이콘이
// 렌더되지 않는다. blob/data URL 은 <use> 에서 신뢰성이 없고, 주입 방식은 심볼 내부 그라디언트를
// 깨뜨리므로, pod 가 동일 자산을 basePath 하위로 서빙한다는 점을 이용해 same-origin URL 로 바꾼다.
export function sameOriginAssetUrl(url: string): string {
  if (typeof document === "undefined") return url
  const resolved = new URL(url, document.baseURI)
  if (resolved.origin === location.origin) return resolved.href
  return new URL(resolved.pathname.replace(/^\//, ""), document.baseURI).href
}
