import { createHash } from "node:crypto"
import { Flag } from "../flag/flag"

declare const OPENCODE_ASSET_ORIGIN: string
const ASSET_ORIGIN = typeof OPENCODE_ASSET_ORIGIN === "string" ? OPENCODE_ASSET_ORIGIN : ""

const SERVE_URL = Flag.OPENCODE_SERVE_DOMAIN ?? ""
const SERVE_WILDCARD = SERVE_URL ? `https://*.${SERVE_URL}` : ""
const PREVIEW_HOST = SERVE_URL && Flag.JUPYTERHUB_USER ? `https://${Flag.JUPYTERHUB_USER}.${SERVE_URL}` : ""
// `user.` is a literal subdomain (user-rails OAuth gate), unrelated to JUPYTERHUB_USER.
const USER_RAILS_HOST = SERVE_URL ? `https://user.${SERVE_URL}` : ""
// Sentry envelope ingest 엔드포인트. org ID(o1200796)는 고정이라 정확한 host 로 좁혀둔다.
const SENTRY_INGEST = "https://o1200796.ingest.us.sentry.io"

const origins = (...parts: string[]) => parts.filter(Boolean).join(" ")

// Both hosts required: preview iframe redirects through user-rails OAuth and frame-src is
// checked at every navigation step. Narrowing to just the pod broke auth in 410f7fe.
const FRAME_SRC = origins("'self'", PREVIEW_HOST, USER_RAILS_HOST)
// Wildcard kept until the previewReady fetch chain is measured in a browser Network tab.
const CONNECT_SRC = origins("'self'", "data:", SERVE_WILDCARD, SENTRY_INGEST, ASSET_ORIGIN)
const FRAME_ANCESTORS = origins("'self'", SERVE_URL)
const SCRIPT_SRC = origins("'self'", "'wasm-unsafe-eval'", ASSET_ORIGIN)
const STYLE_SRC = origins("'self'", "'unsafe-inline'", ASSET_ORIGIN)
const FONT_SRC = origins("'self'", "data:", ASSET_ORIGIN)
const MEDIA_SRC = origins("'self'", "data:", ASSET_ORIGIN)
// CDN 자산은 cross-origin 이라 워커를 same-origin blob 모듈로 부트스트랩한다(create-worker.ts).
// worker-src 미지정 시 default-src 'self' 로 폴백되어 blob 워커가 막히므로 명시한다.
// ASSET_ORIGIN 은 넣지 않는다. worker-src 는 최상위 blob 스크립트만 관장하고, blob 내부의
// CDN 워커 모듈 import 는 script-src(ASSET_ORIGIN 포함)가 관장하기 때문이다.
const WORKER_SRC = origins("'self'", "blob:")

const buildCsp = (hash = "") =>
  `frame-ancestors ${FRAME_ANCESTORS}; default-src 'self'; frame-src ${FRAME_SRC}; script-src ${SCRIPT_SRC}${hash ? ` 'sha256-${hash}'` : ""}; style-src ${STYLE_SRC}; img-src 'self' data: blob: https:; font-src ${FONT_SRC}; media-src ${MEDIA_SRC}; worker-src ${WORKER_SRC}; connect-src ${CONNECT_SRC}`

export const DEFAULT_CSP = buildCsp()
export const csp = (hash = "") => buildCsp(hash)

// 테마 프리로드 스크립트는 FOUC 를 막으려고 빌드 시 인라인된다(app/vite.js). script-src 에
// 'unsafe-inline' 이 없으므로 내용의 sha256 을 CSP 에 실어야 실행된다. 임베디드/프록시 양쪽
// HTML 응답이 같은 규칙을 써야 해서 여기서 공유한다. src 가 있으면 외부 스크립트라 해시 불필요.
export const themePreloadHash = (html: string) => {
  const match = html.match(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
  )
  return match ? createHash("sha256").update(match[2]).digest("base64") : ""
}
