// PhotoCraft 0.7.0 웹 빌드(storytold/photocraft, MIT OR Apache-2.0)의 index.html 인라인 부트 스크립트를
// 그대로 옮긴 파일이다. opencode 서버가 HTML 에 붙이는 CSP 가 인라인 스크립트를 막아서 외부 파일로 뺐다.
import init, * as bindings from "./photocraft-web-effbf20fc7ec283d.js"

const wasm = await init({ module_or_path: "./photocraft-web-effbf20fc7ec283d_bg.wasm" })

window.wasmBindings = bindings

dispatchEvent(new CustomEvent("TrunkApplicationStarted", { detail: { wasm } }))
