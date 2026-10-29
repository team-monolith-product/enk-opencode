import { Extension } from "@opencode/gui-extensions/sdk"

// 파일 뷰의 PDF 를 V1 pdf.js 뷰어로 보여 준다. 뷰어 엔진은 PDF 를 처음 열 때 받는다.
const definition = Extension.define({ id: "jitda-pdf" })

export default definition

export const jitdaPdf = { ...definition, renderer: () => import("./renderer") }
