import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { Newtype } from "@/util/schema"

export class ImageRequestID extends Newtype<ImageRequestID>()("ImageRequestID", Schema.String) {
  static make(id: string): ImageRequestID {
    return this.makeUnsafe(id)
  }

  static ascending(id?: string): ImageRequestID {
    return this.makeUnsafe(Identifier.ascending("imageRequest", id))
  }

  static readonly zod = Identifier.schema("imageRequest") as unknown as z.ZodType<ImageRequestID>
}
