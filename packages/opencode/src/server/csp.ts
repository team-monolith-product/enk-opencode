import { Flag } from "../flag/flag"

// 빌드 시 OPENCODE_ASSET_BASE 에서 주입되는 에셋 CDN 오리진. 임베드된 index.html 이
// 참조하는 S3/CloudFront 도메인이며, 미설정 빌드(로컬·테스트)에선 빈 문자열이라 CSP 가 그대로 유지된다.
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

const buildCsp = (hash = "") =>
  `frame-ancestors ${FRAME_ANCESTORS}; default-src 'self'; frame-src ${FRAME_SRC}; script-src ${SCRIPT_SRC}${hash ? ` 'sha256-${hash}'` : ""}; style-src ${STYLE_SRC}; img-src 'self' data: blob: https:; font-src ${FONT_SRC}; media-src 'self' data:; connect-src ${CONNECT_SRC}`

export const DEFAULT_CSP = buildCsp()
export const csp = (hash = "") => buildCsp(hash)
