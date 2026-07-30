import { Schema } from "effect"
import z from "zod"

import { Identifier } from "@/id/id"
import { Newtype } from "@/util/schema"

export class EnvRequestID extends Newtype<EnvRequestID>()("EnvRequestID", Schema.String) {
  static make(id: string): EnvRequestID {
    return this.makeUnsafe(id)
  }

  static ascending(id?: string): EnvRequestID {
    return this.makeUnsafe(Identifier.ascending("envRequest", id))
  }

  static readonly zod = Identifier.schema("envRequest") as unknown as z.ZodType<EnvRequestID>
}
