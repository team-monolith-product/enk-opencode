#!/bin/sh
# 에이전트가 학생 앱을 브라우저로 한 번에 점검하는 명령.
#
#   browser-check [-s] [URL] [대기ms]
#     URL     기본 http://localhost:3000
#     대기ms  접속(load) 뒤 늦게 나는 콘솔/에러를 기다리는 시간, 기본 300
#     -s      화면 구조(클릭·입력 가능한 요소와 ref)도 함께 출력
#
# 접속부터 조회까지 agent-browser batch 한 번으로 끝낸다. 에이전트 셸이 격리(bwrap --unshare-pid)
# 안에서 돌면 명령이 끝날 때 agent-browser 데몬과 브라우저도 함께 죽어서, 따로따로 부르면 앞에서
# 쌓인 콘솔/에러가 사라지기 때문이다.
#
# 결과는 --json 으로 받아 jq 로 추린다. agent-browser 0.39.4 의 errors 텍스트 출력은 잡힌 에러를
# 빈 줄로 찍는 버그가 있고, JSON 에는 실행 상태(lifecycle)와 요청 헤더 전체가 섞여 있어 그대로
# 보여 주면 길기만 하다.
set -eu

snapshot=0
if [ "${1:-}" = "-s" ]; then
  snapshot=1
  shift
fi
url="${1:-http://localhost:3000}"
wait_ms="${2:-300}"

dir="${TMPDIR:-/tmp}/browser-check"
mkdir -p "$dir"
shot="$dir/$(date +%Y%m%d-%H%M%S).png"

# 끝에 브라우저를 닫는다. 격리가 없으면 데몬이 명령 사이에 살아남아 앞 호출의 기록이 쌓이는데,
# 0.39.4 는 `errors --clear` 가 에러 기록을 비우지 못한다. 매번 새 브라우저로 시작해야 이번 접속의
# 결과만 보이고, 학생 컨테이너에 Chrome 이 남아 메모리를 잡고 있지도 않는다.
#
# 단계 하나라도 실패하면(서버가 안 떠 있는 경우 등) batch 는 1 로 끝나지만, 실패 내용은 JSON 에
# 들어 있으므로 멈추지 않고 그대로 보여 준다.
set -- "open $url" "wait $wait_ms" "errors" "console" "network requests" "screenshot $shot"
if [ "$snapshot" = 1 ]; then
  set -- "$@" "snapshot -i -c"
fi
set -- "$@" "close"
run() { agent-browser batch --json "$@" 2>&1 || true; }
is_result() { printf '%s' "$1" | jq -e 'type == "array"' > /dev/null 2>&1; }

out=$(run "$@")
# 닫히는 중이거나 막 죽은 데몬에 붙으면 결과 대신 오류 객체(outcome_unknown)가 온다. 새 데몬이
# 뜨도록 잠깐 두고 한 번만 다시 부른다.
if ! is_result "$out"; then
  sleep 1
  out=$(run "$@")
fi
if ! is_result "$out"; then
  echo "browser-check: agent-browser 실행 실패. 'agent-browser doctor' 로 확인하세요." >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

printf '%s' "$out" | jq -r '
  def result(name): (map(select(.command[0] == name)) | last | .result) // {};
  (map(select((.success | not) and .command[0] != "close")) | map("실패: \(.command | join(" ")) → \(.error)")) as $failed
  | (result("errors").errors // []) as $errors
  | (result("console").messages // []) as $console
  | ((result("network").requests // []) | map(select((.status // 0) >= 400 or .failed == true))) as $bad
  | [
      "페이지: \(result("open").title // "-") (\(result("open").url // "-"))",
      ($failed[]),
      "",
      "## 에러 \($errors | length)건",
      ($errors[] | "- \(.text)"),
      "",
      "## 콘솔 \($console | length)건",
      ($console[] | "[\(.type)] \(.text)"),
      "",
      "## 실패한 요청 \($bad | length)건",
      ($bad[] | "- \(.method) \(.url) → \(.status // "응답 없음")"),
      "",
      (if result("screenshot").path then "스크린샷: \(result("screenshot").path)" else empty end),
      (if result("snapshot") != {} then "", "## 화면 구조", (result("snapshot").snapshot // result("snapshot") | tostring) else empty end)
    ]
  | .[]
'
