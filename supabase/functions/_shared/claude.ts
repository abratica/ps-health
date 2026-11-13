const MODEL = "claude-sonnet-5-5";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export async function askClaude(system: string, content: Block[], maxTokens = 1500): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}

// Pull the first JSON object out of a reply.
export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON in model reply");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function askClaudeJson<T>(system: string, content: Block[], maxTokens = 1500): Promise<T> {
  const text = await askClaude(system + "\n\nReply with a single JSON object only, no prose, no code fences.", content, maxTokens);
  return parseJson<T>(text);
}
