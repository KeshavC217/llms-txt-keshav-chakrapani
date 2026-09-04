import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractJsonObject, requestJson } from "../../lib/openrouter";

describe("extractJsonObject", () => {
  it("returns a bare JSON object unchanged", () => {
    expect(extractJsonObject('{"a": 1}')).toBe('{"a": 1}');
  });

  it("unwraps markdown code fences", () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(extractJsonObject('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it("survives prose before and after the object", () => {
    expect(extractJsonObject('Sure! Here is the JSON:\n{"a": 1}\nLet me know if you need changes.')).toBe('{"a": 1}');
  });

  it("keeps nested objects intact", () => {
    const json = '{"pageEdits": {"https://a.test": {"title": "X"}}, "optionalUrls": []}';
    expect(extractJsonObject(`noise ${json} noise`)).toBe(json);
  });

  it("does not miscount braces that appear inside strings", () => {
    const json = '{"description": "Use {{ handlebars }} or \\"quotes\\" here."}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it("returns null when there is no object at all", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeNull();
    expect(extractJsonObject('{"unterminated": ')).toBeNull();
  });
});

interface OutboundBody {
  model: string;
  response_format?: unknown;
  provider: { sort: string; ignore?: string[] };
}

describe("requestJson provider handling", () => {
  const KEY = "OPENROUTER_API_KEY";
  let realFetch: typeof globalThis.fetch;
  let bodies: OutboundBody[];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    bodies = [];
    process.env[KEY] = "test-key";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env[KEY];
  });

  function mockOnce(responses: unknown[]) {
    let i = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as OutboundBody);
      const body = responses[Math.min(i++, responses.length - 1)];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;
  }

  it("never sends response_format, which breaks several providers for our model", async () => {
    // Regression guard. Setting it made DeepInfra reject the request (HTTP
    // 405) and made Cerebras emit the object escaped inside a JSON string,
    // which never terminates and exhausts max_tokens. The symptom was an AI
    // pass that silently produced byte-identical output.
    mockOnce([{ provider: "X", choices: [{ finish_reason: "stop", message: { content: '{"ok":1}' } }] }]);
    await requestJson("hi");
    expect(bodies[0]).not.toHaveProperty("response_format");
  });

  it("excludes a provider that returned an unusable reply when it retries", async () => {
    // Throughput sorting is deterministic, so retrying without excluding the
    // failed provider lands on the same one and reproduces the failure.
    mockOnce([
      { provider: "Cerebras", usage: { completion_tokens: 8000 }, choices: [{ finish_reason: "length", message: { content: "{\"a\": " } }] },
      { provider: "Novita", choices: [{ finish_reason: "stop", message: { content: '{"ok":1}' } }] },
    ]);

    const result = await requestJson<{ ok: number }>("hi");
    expect(result).toEqual({ ok: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].provider.ignore).toBeUndefined();
    expect(bodies[1].provider.ignore).toEqual(["Cerebras"]);
  });

  it("gives up without retrying when the model returns prose instead of JSON", async () => {
    mockOnce([{ provider: "X", choices: [{ finish_reason: "stop", message: { content: "I cannot help." } }] }]);
    expect(await requestJson("hi")).toBeNull();
    expect(bodies).toHaveLength(1);
  });
});

