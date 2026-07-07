# @opencode-ai/result-preview

**로컬 dev 검증용 예제** — AI 결과물(프레임워크 dev 서버)을 흉내 낸 SolidJS + Vite 앱.

실제 미리보기 파이프라인에서는 AI 가 만든 결과물이 iframe 으로 임베드되고 [`@opencode-ai/preview-bridge`](../preview-bridge) 가 그 안에서 부모 앱과 통신한다. 이 패키지는 그 "결과물" 자리에 놓을 **고정된 데모**로, 자식 브릿지를 모듈로 직접 포함해 미리보기 통신을 손쉽게 검증하기 위한 것이다.

> ⚠️ 제품이 아니라 **개발 검증용 목업**이다. 배포 대상이 아니며, 브릿지의 각 기능을 눌러볼 버튼·폼·라우트를 모아둔 테스트 하네스다.

## 어떻게 브릿지를 포함하나

`src/index.tsx` 가 앱 렌더 전에 브릿지를 가장 먼저 import 한다 — 결과물 HTML 에 주입되는 `<script src="/__preview-bridge.js">` 와 동일한 역할:

```ts
// import 즉시 boot() 되어 부모(앱)와 penpal 연결을 시도한다.
import "@opencode-ai/preview-bridge/bridge"
```

## 데모가 시험하는 것

`src/app.tsx` 의 각 섹션이 브릿지 기능에 1:1 대응한다:

- **콘솔 / 에러 중계** — `console.log/warn/error`, `throw`, `Promise.reject` 버튼 → `onConsole` / `onError`
- **요소 선택** — 부모가 픽 모드를 켜고 요소 클릭 → `setPickMode` / `onElementPicked`
- **DOM / 폼 스냅샷** — 이름·이메일·메모 폼 → `queryDom`
- **네비게이션** — `/about` 로 풀 리로드 이동 → `navigate` + 브릿지 재연결
- **스크롤** — 긴 콘텐츠 + `#bottom-section` → `scrollTo`

## 실행

```bash
bun run dev       # vite dev, http://localhost:4400
bun run build
bun run preview
```

포트는 **4400 으로 고정**(`strictPort`)이라 앱(5000)과 분리된다 → 실제와 같은 cross-origin 시나리오를 그대로 검증한다. vite dev 는 CORS 를 허용하므로 앱의 `previewReady` fetch(`mode: "cors"`)가 통과한다.

## 앱에서 가리키기

앱을 `VITE_PREVIEW_URL=http://localhost:4400` 로 실행하면 이 데모가 미리보기 iframe 으로 뜨고, 브릿지 통신(캡처·조회·제어·이벤트 중계)을 눈으로 확인할 수 있다.
