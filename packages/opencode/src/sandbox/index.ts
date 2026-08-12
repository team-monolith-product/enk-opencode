import { realpathSync } from "fs"
import { Global } from "../global"
import { Log } from "../util/log"
import { Process } from "../util/process"
import { lazy } from "@/util/lazy"

/**
 * 에이전트가 실행하는 셸을 OS 격리 안에서 돌린다.
 *
 * 앞선 층들(자식 환경 allowlist, 권한 가드, 부팅 environ 스크럽, 출력 마스킹)은 모두 "opencode 가
 * 스스로 지키는" 방어다. 셸이 opencode 와 **같은 uid** 로 도는 한 남는 길이 있다.
 *
 *   - `/proc/<opencode pid>/mem`, ptrace → opencode 힙에 있는 모든 값
 *   - `~/.local/share/opencode/auth.json` → 프로바이더 자격 증명
 *
 * 앞의 것은 커널이 막아 줘야 하고, 뒤의 것은 파일 접근 차단으로 닫힌다. 여기서 둘 다 시도한다.
 *
 *   - linux: bubblewrap. `--unshare-pid --proc /proc` 로 **다른 프로세스가 아예 안 보이게** 하고
 *            opencode 데이터 디렉토리는 tmpfs 로 덮는다. PID 네임스페이스가 열려야 하는데,
 *            컨테이너 기본 seccomp 가 unprivileged userns 를 막는 환경도 많아 부팅 때 실측한다.
 *   - darwin: sandbox-exec. 파일 접근만 막는다 — 프로세스 조회까지 막으면 `ps`/`lsof` 가 죽어
 *            멀쩡한 작업이 깨진다. macOS 는 로컬 개발용이라 여기까지가 균형점이다.
 *
 * 기본값은 off 다. 켜면 학생 환경의 빌드가 예상 못 한 데서 막힐 수 있어, 이게 실제로 필요한
 * 배포(도커 이미지)에서만 auto 로 켠다. `require` 는 백엔드가 없으면 도구 호출을 실패시킨다.
 */
export namespace Sandbox {
  const log = Log.create({ service: "sandbox" })

  export type Backend = "none" | "bwrap" | "sandbox-exec"
  export type Mode = "off" | "auto" | "require"

  export function mode(): Mode {
    const value = process.env["OPENCODE_SANDBOX"]?.toLowerCase()
    if (value === "auto" || value === "require") return value
    return "off"
  }

  /**
   * 셸에서 안 보여야 하는 경로. auth.json, 세션 DB, 로그가 모두 여기 있다.
   *
   * 심볼릭 링크를 푼 경로여야 한다. macOS 의 sandbox 프로파일은 해석된 경로로 매칭하므로,
   * `/var/folders/...`(→ `/private/var/folders/...`) 같은 경로를 그대로 넣으면 규칙이 조용히
   * 아무것도 안 막는다. 실패가 드러나지 않는 종류라 여기서 한 번에 정규화한다.
   */
  export function hidden() {
    // Global.Path.bin 은 cache 아래라 여기 안 걸린다 — LSP 서버 같은 설치 바이너리는 계속 쓴다.
    return [Global.Path.data].map((dir) => {
      try {
        return realpathSync(dir)
      } catch {
        return dir
      }
    })
  }

  const probe = lazy(async (): Promise<Backend> => {
    if (mode() === "off") return "none"
    const found = await detect()
    log.info("sandbox backend", { backend: found, mode: mode() })
    if (found === "none" && mode() === "require") log.error("sandbox required but no backend is usable")
    return found
  })

  async function detect(): Promise<Backend> {
    if (process.platform === "darwin") {
      const out = await Process.text(["sandbox-exec", "-p", "(version 1)(allow default)", "true"], { nothrow: true })
      return out.code === 0 ? "sandbox-exec" : "none"
    }
    if (process.platform === "linux") {
      // 실제로 쓸 옵션 그대로 띄워 본다. bwrap 이 있어도 컨테이너 seccomp 가 네임스페이스를
      // 막으면 여기서 실패하므로, "설치돼 있음" 이 아니라 "동작함" 을 본다.
      const out = await Process.text([...bwrap("/"), "true"], { nothrow: true })
      return out.code === 0 ? "bwrap" : "none"
    }
    return "none"
  }

  function bwrap(cwd: string) {
    return [
      "bwrap",
      // 파일시스템은 그대로 두고 필요한 곳만 덮는다. 학생 프로젝트의 툴체인 경로를 일일이
      // 열어 주는 방식은 빌드가 어디서 막힐지 예측할 수 없다.
      "--dev-bind",
      "/",
      "/",
      // 다른 프로세스가 안 보이면 /proc/<pid>/mem 도 ptrace 도 대상이 없다.
      "--unshare-pid",
      "--proc",
      "/proc",
      ...hidden().flatMap((dir) => ["--tmpfs", dir]),
      "--die-with-parent",
      "--chdir",
      cwd,
      "--",
    ]
  }

  function profile() {
    const deny = hidden()
      .map((dir) => `(subpath ${JSON.stringify(dir)})`)
      .join(" ")
    return `(version 1)(allow default)(deny file-read* file-write* ${deny})`
  }

  export function reset() {
    probe.reset()
  }

  export async function backend() {
    return probe()
  }

  /**
   * 셸 실행 argv 를 격리로 감싼다. 감쌀 백엔드가 없으면 undefined 를 돌려주고, 호출부는 원래대로
   * 띄운다. mode 가 require 인데 백엔드가 없으면 던진다 — 조용히 무방비로 도는 게 최악이다.
   */
  export async function wrap(input: { shell: string; command: string; cwd: string }) {
    const found = await probe()
    if (found === "none") {
      if (mode() === "require")
        throw new Error("OPENCODE_SANDBOX=require but no usable sandbox backend was found on this host")
      return
    }
    if (found === "bwrap") return [...bwrap(input.cwd), input.shell, "-c", input.command]
    return ["sandbox-exec", "-p", profile(), input.shell, "-c", input.command]
  }
}
