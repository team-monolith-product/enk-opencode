import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "../../src/provider/error"
import { ProviderID } from "../../src/provider/schema"

function classify(message: string) {
  return ProviderError.parseAPICallError({
    providerID: ProviderID.make("test"),
    error: new APICallError({
      message,
      url: "https://example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    }),
  }).type
}

describe("ProviderError.parseAPICallError - context overflow", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "prompt is too long",
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    for (const message of messages) {
      expect([message, classify(message)]).toEqual([message, "context_overflow"])
    }
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    for (const message of messages) {
      expect([message, classify(message)]).toEqual([message, "api_error"])
    }
  })
})
