/**
 * Max characters (Unicode code points) allowed in a doc-mode prompt.
 *
 * Roughly two A4 pages of Korean text — enough for a long, detailed prompt while
 * keeping a single doc bounded. Counted on the doc's plain text via the code-point
 * length signal exposed by `createPromptDoc()` (`.length`), so emoji and surrogate
 * pairs count as one character rather than two.
 */
export const MAX_PROMPT_DOC_CHARS = 8000
