import { plugin } from "bun"

// bun test 전용. solid-js 의 jsx-runtime 은 타입만 있고 jsx/jsxDEV 를 내보내지 않는다.
// Bun 1.4 부터 .tsx 를 불러오는 순간 그 이름이 없다며 죽으므로, 테스트에서는 .tsx 를
// 실제 함수가 있는 solid-js/h 런타임으로 변환한다. 앱 빌드는 vite-plugin-solid 가 하므로 무관하다.
const transpiler = new Bun.Transpiler({
  loader: "tsx",
  // 파일 단위 변환이라 타입만 쓰는 import(예: { Icon, IconProps })를 지워 줘야 한다.
  trimUnusedImports: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "solid-js/h" } },
})

plugin({
  name: "solid-jsx-runtime-for-bun-test",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: transpiler.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
