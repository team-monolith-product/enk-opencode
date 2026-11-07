#!/bin/sh
# 에이전트가 학생 앱을 브라우저로 한 번에 점검하는 명령.
#
#   browser-check [-s] [URL] [대기ms] [-- 동작 ...]
#     URL     기본 http://localhost:3000
#     대기ms  접속(load) 뒤, 그리고 동작 뒤 늦게 나는 콘솔/에러를 기다리는 시간, 기본 300
#     -s      화면 구조(클릭·입력 가능한 요소와 ref)도 함께 출력
#     동작    접속한 뒤 차례로 실행할 agent-browser 명령. 예:
#             browser-check http://localhost:3000 -- "find placeholder 이메일 fill a@b.c" "find role button click --name '로그인'"
#
# 접속부터 조회까지 agent-browser batch 한 번으로 끝낸다. 에이전트 셸이 격리(bwrap --unshare-pid)
# 안에서 돌면 명령이 끝날 때 agent-browser 데몬과 브라우저도 함께 죽어서, 따로따로 부르면 앞에서
# 쌓인 콘솔/에러가 사라지기 때문이다.
#
# 브라우저는 닫지 않는다. 격리가 없으면 다음 점검이 떠 있는 브라우저를 그대로 써서 빠르고(약 0.4초,
# 새로 띄우면 약 1.1초), 쓰지 않으면 AGENT_BROWSER_IDLE_TIMEOUT_MS 뒤에 내려간다. 대신 앞 점검의 기록이
# 남아 있으므로 접속 전 기록을 먼저 받아 두고 그 뒤에 생긴 것만 보여 준다.
#   - 에러/콘솔: 기록은 뒤에 덧붙기만 한다. 접속 전 개수 이후만 자른다. (0.39.4 는 `errors --clear`
#     가 에러 기록을 비우지 못해서 비우기 대신 이렇게 한다.)
#   - 요청: 비우기가 믿을 만하지 않아 접속 전에 있던 요청 ID 를 뺀다. 브라우저 캐시 때문에 두 번째
#     점검부터는 favicon 같은 캐시된 요청의 404 가 다시 나오지 않을 수 있다.
#
# 결과는 --json 으로 받아 jq 로 추린다. agent-browser 0.39.4 의 errors 텍스트 출력은 잡힌 에러를
# 빈 줄로 찍는 버그가 있고, JSON 에는 실행 상태(lifecycle)와 요청 헤더 전체가 섞여 있어 그대로
# 보여 주면 길기만 하다.
set -eu

snapshot=0
url="http://localhost:3000"
wait_ms=300
n=0
while [ $# -gt 0 ]; do
  case "$1" in
    -s) snapshot=1 ;;
    --)
      shift
      break
      ;;
    *)
      [ "$n" = 0 ] && url="$1"
      [ "$n" = 1 ] && wait_ms="$1"
      n=$((n + 1))
      ;;
  esac
  shift
done
# 여기서 남은 "$@" 가 동작 단계다.
actions=$#

dir="${TMPDIR:-/tmp}/browser-check"
mkdir -p "$dir"
shot="$dir/$(date +%Y%m%d-%H%M%S).png"

# 앞의 세 단계가 접속 전 기록, 뒤의 같은 이름 단계가 접속(과 동작) 후 기록이다.
# 브라우저를 닫는 `close` 는 넣지 않는다. batch 안에서 close 하면 데몬이 내려가 뒤 단계가 다 실패한다.
# 단계 하나라도 실패하면(서버가 안 떠 있는 경우, 요소를 못 찾은 경우 등) batch 는 1 로 끝나지만,
# 실패 내용은 JSON 에 들어 있으므로 멈추지 않고 그대로 보여 준다.
set -- "errors" "console" "network requests" "open $url" "wait $wait_ms" "$@"
if [ "$actions" -gt 0 ]; then
  set -- "$@" "wait $wait_ms"
fi
set -- "$@" "errors" "console" "network requests" "screenshot $shot"
if [ "$snapshot" = 1 ]; then
  set -- "$@" "snapshot -i -c"
fi
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

# 동작 단계는 batch 의 6번째(접속 전 기록 3 + open + wait 다음)부터 $actions 개다.
printf '%s' "$out" | jq -r --argjson actions "$actions" '
  def before(name): (map(select(.command[0] == name)) | first | .result) // {};
  def result(name): (map(select(.command[0] == name)) | last | .result) // {};
  .[5:5 + $actions] as $acts
  | (.[0:5] + .[5 + $actions:] | map(select(.success | not)) | map("실패: \(.command | join(" ")) → \(.error)")) as $failed
  | (result("errors").errors // [])[((before("errors").errors // []) | length):] as $errors
  | (result("console").messages // [])[((before("console").messages // []) | length):] as $console
  | ((before("network").requests // []) | map(.requestId)) as $seen
  | ((result("network").requests // [])
      | map(select((.requestId as $id | $seen | any(.[]; . == $id) | not)
          and ((.status // 0) >= 400 or .failed == true)))) as $bad
  | [
      "페이지: \(result("open").title // "-") (\(result("open").url // "-"))",
      ($failed[]),
      (if ($acts | length) > 0 then "", "## 동작" else empty end),
      ($acts[] | if .success
        then "- \(.command | join(" ")) → \(.result | del(.lifecycle) | tostring | .[0:300])"
        else "- \(.command | join(" ")) → 실패: \(.error)" end),
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
