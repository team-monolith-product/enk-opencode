import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Storage } from "@/storage/storage"

// 입력창의 '이미지 만들기'는 팀 작업 공간 하나에 값 하나다. 누가 바꾸든 같은 작업 공간의 모든 화면이 따라간다.
export namespace ImageToggle {
  const KEY = ["enk", "image-generation"]

  export const Event = {
    Updated: BusEvent.define("image.generation.updated", z.object({ on: z.boolean() })),
  }

  export async function on() {
    return Storage.read<{ on: boolean }>(KEY).then(
      (x) => x.on,
      () => true,
    )
  }

  export async function set(on: boolean) {
    await Storage.write(KEY, { on })
    await Bus.publish(Event.Updated, { on })
    return on
  }
}
