import { For } from "solid-js"
import { Skeleton } from "@opencode-ai/ui/skeleton"

/**
 * 메시지가 도착하기 전 대화 영역을 채우는 자리표시자.
 *
 * 폭/여백은 message-timeline 의 본문 컨테이너와 맞춰 두었다. 스켈레톤에서 실제 타임라인으로
 * 넘어갈 때 좌우 정렬이 튀지 않게 하려는 것.
 */
export function MessageTimelineSkeleton(props: { centered?: boolean }) {
  const turns = [
    { user: "38%", lines: ["92%", "78%", "54%"] },
    { user: "56%", lines: ["86%", "63%"] },
    { user: "30%", lines: ["90%", "74%", "42%"] },
  ]

  return (
    <div
      data-component="session-timeline-skeleton"
      class="relative w-full h-full min-w-0 overflow-hidden pointer-events-none"
    >
      <div
        classList={{
          "w-full pt-6 pl-2 pr-3 md:pl-4 md:pr-3": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <For each={turns}>
          {(turn, index) => (
            <div class="flex flex-col pb-10">
              <Skeleton shape="block" class="ml-auto" width={turn.user} height={38} delay={index() * 0.2} />
              <div class="flex flex-col gap-2 pt-6">
                <For each={turn.lines}>
                  {(width, line) => <Skeleton width={width} delay={index() * 0.2 + line() * 0.1} />}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
