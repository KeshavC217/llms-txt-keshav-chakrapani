import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for OpenRouter that can reproduce the ways real providers
 * misbehave.
 *
 * Every scenario here was observed against the live API — they are not
 * invented edge cases:
 *
 *   escapedJson  Cerebras, when sent response_format: json_object, returns the
 *                object escaped INSIDE a JSON string. It never terminates and
 *                burns the whole max_tokens budget.
 *   truncated    finish_reason "length" with a half-written object.
 *   emptyContent Alibaba returned an empty content field after billing 8001
 *                completion tokens.
 *   prose        the model answers in English instead of JSON.
 *   rateLimited  HTTP 429 "temporarily rate-limited upstream".
 *   unsupported  DeepInfra rejects response_format with HTTP 405.
 *
 * None of this was reachable before: unit tests mock the whole openrouter
 * module, and the other integration tests are deliberately offline. That gap
 * is why a broken AI pass shipped looking exactly like a working one.
 */

export type Scenario = "ok" | "escapedJson" | "truncated" | "emptyContent" | "prose" | "rateLimited" | "unsupported";

export interface RecordedRequest {
  model: string;
  messages: { role: string; content: string }[];
  provider?: { sort?: string; ignore?: string[] };
  response_format?: unknown;
  max_tokens?: number;
}

export interface FakeOpenRouter {
  url: string;
  /** The parsed JSON body of every request received, in order. */
  requests: RecordedRequest[];
  /** Answer every request with this scenario. */
  setScenario(scenario: Scenario): void;
  /**
   * Fail the FIRST request carrying a given prompt with `scenario`, then
   * answer any repeat of that same prompt successfully.
   *
   * The copyedit pass fans out into one document call plus one call per
   * section chunk, so "first request overall" stopped describing anything
   * useful — a retry is per-prompt, and this is what lets a test assert that
   * each failed call individually recovered.
   */
  failFirstAttemptPerPrompt(scenario: Scenario): void;
  /** Requests grouped by their prompt, so a test can count attempts per logical call. */
  attemptsByPrompt(): RecordedRequest[][];
  close(): Promise<void>;
}

const VALID_PLAN = JSON.stringify({ sectionLabels: { Docs: "Guides" } });

function respond(scenario: Scenario, provider: string) {
  switch (scenario) {
    case "ok":
      return { status: 200, body: { provider, choices: [{ finish_reason: "stop", message: { content: VALID_PLAN } }] } };
    case "escapedJson":
      // The object, escaped as a string, then cut off at the token cap.
      return {
        status: 200,
        body: {
          provider,
          usage: { completion_tokens: 8000 },
          choices: [{ finish_reason: "length", message: { content: `"{\\"sectionLabels\\": {\\"Docs\\": \\"Gui` } }],
        },
      };
    case "truncated":
      return {
        status: 200,
        body: {
          provider,
          usage: { completion_tokens: 8000 },
          choices: [{ finish_reason: "length", message: { content: '{"sectionLabels": {"Docs": "Gui' } }],
        },
      };
    case "emptyContent":
      return {
        status: 200,
        body: { provider, usage: { completion_tokens: 8001 }, choices: [{ finish_reason: "length", message: { content: "" } }] },
      };
    case "prose":
      return { status: 200, body: { provider, choices: [{ finish_reason: "stop", message: { content: "I cannot help with that." } }] } };
    case "rateLimited":
      return { status: 429, body: { error: { message: "temporarily rate-limited upstream", code: 429 } } };
    case "unsupported":
      return { status: 405, body: { error: { message: "json_object response format is not supported", code: 405 } } };
  }
}

export async function startFakeOpenRouter(): Promise<FakeOpenRouter> {
  const requests: RecordedRequest[] = [];
  let scenario: Scenario = "ok";
  let firstAttemptOnly = false;
  const seenPrompts = new Set<string>();

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed = JSON.parse(raw) as RecordedRequest;
      requests.push(parsed);

      const prompt = parsed.messages?.[0]?.content ?? "";
      let effective = scenario;
      if (firstAttemptOnly) {
        effective = seenPrompts.has(prompt) ? "ok" : scenario;
        seenPrompts.add(prompt);
      }

      // Name the provider after the scenario, so a test can assert that a
      // retry excluded the exact provider that just failed.
      const { status, body } = respond(effective, `provider-${effective}`);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/chat/completions`,
    requests,
    setScenario(s: Scenario) {
      scenario = s;
      firstAttemptOnly = false;
      seenPrompts.clear();
      requests.length = 0;
    },
    failFirstAttemptPerPrompt(s: Scenario) {
      scenario = s;
      firstAttemptOnly = true;
      seenPrompts.clear();
      requests.length = 0;
    },
    attemptsByPrompt() {
      const groups = new Map<string, RecordedRequest[]>();
      for (const r of requests) {
        const key = r.messages?.[0]?.content ?? "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      return Array.from(groups.values());
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
