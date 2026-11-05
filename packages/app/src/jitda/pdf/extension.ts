import { Plugin } from "@opencode/plugin/gui"
import type { Entry } from "@opencode/plugin/gui/host"

// 파일 뷰의 PDF 를 V1 pdf.js 뷰어로 보여 준다. 뷰어 엔진은 PDF 를 처음 열 때 받는다.
const definition = Plugin.define({})

export default definition

export const jitdaPdf: Entry = { ...definition, id: "jitda-pdf", windowEntry: () => import("./renderer") }
