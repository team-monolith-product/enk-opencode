# @opencode-ai/preview-bridge

미리보기 결과물(iframe) 안에서 실행되어 **부모 앱과 [penpal](https://github.com/Aaronius/penpal) 로 통신하는 자식측 브릿지**.

AI 가 만든 결과물(프레임워크 dev 서버)이 미리보기 iframe 으로 임베드될 때, 이 브릿지가 결과물 HTML 에 주입되어 부모(앱)가 iframe 내부를 제어·관찰할 수 있게 한다. cross-origin iframe 이라 부모가 직접 DOM 에 접근할 수 없으므로, 브릿지가 iframe 안에서 penpal RPC 로 다리를 놓는다.

## 구성 (`src/`)

| 파일 | 역할 | 빌드 산출물 |
| --- | --- | --- |
| `bridge.ts` | iframe **안**에서 실행되는 자식측 통신 브릿지. penpal 로 부모와 핸드셰이크하고, 부모가 호출할 메서드를 노출하며 console/error/라우팅 이벤트를 부모로 중계한다. | `docker/preview-bridge.js` (penpal 포함 단일 IIFE) |
| `plugin.ts` | opencode **자가치유 플러그인**. 응답이 끝날 때(`session.idle`)마다 결과물 디렉토리에 브릿지 번들을 배치하고 엔트리 HTML 에 `<script>` 태그를 멱등하게 주입한다. | `docker/preview-bridge-plugin.js` (node ESM) |

프로토콜 타입(`ChildMethods` / `ParentMethods` 등)은 [`packages/app/src/lib/preview-bridge-protocol.ts`](../app/src/lib/preview-bridge-protocol.ts) 에 정의되어 부모/자식이 공유하며, 빌드 시 bun 이 번들에 함께 포함한다.

## bridge.ts — 부모↔자식 RPC

**부모가 호출하는 자식 메서드** (`childMethods`):

- `navigate(url)` / `reload()` — 풀 페이지 이동·새로고침
- `routeTo(path)` / `back()` / `forward()` — 리로드 없는 소프트 라우팅(history + 합성 popstate)
- `scrollTo(target)` — 좌표 또는 selector 로 스크롤
- `setPickMode(on)` — 요소 선택(인스펙트) 모드 토글
- `queryDom(query?)` — DOM/폼/localStorage 스냅샷
- `capture(options?)` — 현재 뷰포트 화면 캡처(cross-origin taint 회피용으로 iframe 내부에서 수행)

**자식이 부모로 중계하는 이벤트** (`ParentMethods` 호출):

- `onConsole` / `onError` — console·에러·unhandledrejection 후킹
- `onLocationChange` — pushState/replaceState/popstate/hashchange 및 재연결 시 위치 보고(주소창·뒤로/앞으로 동기화)
- `onElementPicked` — 픽 모드에서 클릭한 요소의 selector·속성·rect

**견고성 설계:**

- **자동 재연결** — 부모가 연결을 destroy 하면(suspend·리로드·teardown) 자식도 끊긴다. `RECONNECT_INTERVAL_MS`(3s) 마다 재핸드셰이크를 시도한다.
- **reject 스톰 차단** — 끊긴 연결에서의 부모 호출은 `emit()` 래퍼로 감싸 reject 를 삼킨다. 안 그러면 `unhandledrejection → onError → 재호출 → 또 reject` 무한 루프가 된다.
- **전체 페이지 이동 판별** — MPA·`location.assign`·뒤로/앞으로는 문서가 새로 로드돼 popstate 가 아닌 재연결로만 감지된다. Navigation Timing 으로 push/replace/pop 을 구분해 부모 미러가 어긋나지 않게 한다.
- **중복 주입 방어** — `__previewBridgeLoaded__` 플래그로 브릿지가 두 번 로드돼도 한 번만 부팅한다.

## plugin.ts — 자가치유 주입

AI 가 `AGENTS.md` 지침대로 브릿지를 이미 넣었으면 그대로 두고, **빠뜨린 경우에만 보강**하는 opencode 플러그인이다.

- `session.idle` 마다 결과물 디렉토리를 점검한다.
- 브릿지 번들(`__preview-bridge.js`)을 `.` / `public` / `static` 중 존재하는 디렉토리에 배치.
- 엔트리 HTML(`index.html`, `public/index.html`, `src/index.html`)의 `<body>` 끝에 `<script src="/__preview-bridge.js" data-preview-bridge>` 를 주입. 정규식이 아니라 `node-html-parser` 로 파싱해 처리한다.
- **멱등성** — 내용이 바뀌지 않으면 절대 다시 쓰지 않는다(파일 watcher 리로드 루프 방지). `dist/` 는 빌드 산출물이라 제외.

## 빌드

```bash
# 이 패키지 디렉토리에서
bun run build:preview-bridge   # bridge + plugin 둘 다
bun run build:bridge           # → docker/preview-bridge.js
bun run build:plugin           # → docker/preview-bridge-plugin.js
```

산출물은 `docker/` 에 놓여 컨테이너 런타임이 별도 의존성 없이 그대로 사용한다.

## 로컬 검증

[`packages/result-preview`](../result-preview) 가 이 브릿지를 모듈로 포함한 데모 결과물이다. 앱에서 `VITE_PREVIEW_URL` 로 가리켜 미리보기 통신(캡처·조회·제어·이벤트 중계)을 실제 cross-origin 시나리오로 검증할 수 있다.
