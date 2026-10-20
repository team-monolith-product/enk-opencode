import type { dict as en } from "./i18n.en"

export const dict: Partial<Record<keyof typeof en, string>> = {
  "ui.pdfViewer.skip": "PDF 본문으로 건너뛰기",
  "ui.pdfViewer.zoom": "배율 변경",
  "ui.pdfViewer.zoomLevel": "{{percent}}%",
  "ui.pdfViewer.fitWidth": "폭맞춤하기",
  "ui.pdfViewer.fitHeight": "쪽맞춤하기",
  "ui.pdfViewer.slideshow": "전체보기",
  "ui.pdfViewer.thumbnails.open": "썸네일 열기",
  "ui.pdfViewer.thumbnails.close": "썸네일 닫기",
  "ui.pdfViewer.previous": "이전",
  "ui.pdfViewer.next": "다음",
  "ui.pdfViewer.pageInput": "페이지 번호",
  "ui.pdfViewer.pageLabel": "페이지 {{page}}",
  "ui.pdfViewer.pageError": "페이지를 불러오지 못했어요.",
  "ui.pdfViewer.loading": "불러오는 중입니다.",
  "ui.pdfViewer.error.title": "파일을 불러오지 못했어요.",
  "ui.pdfViewer.error.description": "새로고침 후 다시 시도해주세요.",
  "ui.fileMedia.kind.pdf": "PDF",
}
