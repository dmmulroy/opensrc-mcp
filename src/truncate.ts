const MAX_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;

/**
 * Truncate content to stay within token limits.
 * Includes guidance message when truncated.
 */
export function truncate(content: unknown): string {
  const text =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);

  const maxChars = MAX_TOKENS * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  return `${text.slice(0, maxChars)}

--- TRUNCATED ---
Response was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}).
Use opensrc.files() to find specific files, then opensrc.read() for targeted content.`;
}
