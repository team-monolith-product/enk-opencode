import { describe, expect, test } from "bun:test"
import { Vision } from "../../src/jitda/vision"

describe("Vision", () => {
  test("routes only media messages on models that cannot read images", () => {
    const image = { files: [{ mime: "image/png" }] }
    const pdf = { files: [{ mime: "application/pdf" }] }
    const text = { files: [{ mime: "text/plain" }] }
    expect(Vision.wanted(image, ["text"])).toBe(true)
    expect(Vision.wanted(pdf, ["text"])).toBe(true)
    expect(Vision.wanted(text, ["text"])).toBe(false)
    expect(Vision.wanted(undefined, ["text"])).toBe(false)
    expect(Vision.wanted(image, ["text", "image"])).toBe(false)
  })

  test("targets the deployment image model, else MiniMax-M3 with adaptive", () => {
    expect(Vision.target({})).toEqual({ providerID: "minimax", modelID: "MiniMax-M3", variant: "adaptive" })
    expect(Vision.target({ ENK_AI_IMAGE_MODEL: "google/g" })).toEqual({
      providerID: "google",
      modelID: "g",
      variant: undefined,
    })
    expect(Vision.target({ ENK_AI_IMAGE_MODEL: "google/g", ENK_AI_IMAGE_MODEL_VARIANT: "high" })?.variant).toBe("high")
    expect(Vision.target({ ENK_AI_IMAGE_MODEL: "bad" })).toBeUndefined()
  })
})
