import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contentTokens,
  coverage,
  humanize,
  sentences,
  similarity,
  stem,
  stripBrandSuffix,
  titleCase,
  tokenize,
} from "../lib/nlp.ts";

test("tokenize splits on punctuation and lowercases", () => {
  assert.deepEqual(tokenize("Rate Limits & Errors!"), ["rate", "limits", "errors"]);
});

test("stem collapses the plural forms that make one title look like two", () => {
  assert.equal(stem("integrations"), stem("integration"));
  assert.equal(stem("guides"), stem("guide"));
  assert.equal(stem("queries"), stem("query"));
  assert.equal(stem("boxes"), stem("box"));
  assert.equal(stem("capabilities"), stem("capability"));
  // Short words are left alone: stripping them does more harm than good.
  assert.equal(stem("api"), "api");
  assert.equal(stem("was"), "was");
});

test("stem does not relate different forms of a word", () => {
  // A documented limit rather than an aspiration: "pricing" and "price" stay
  // distinct, and titles using both read as two pages.
  assert.notEqual(stem("pricing"), stem("price"));
});

test("contentTokens drops function words", () => {
  assert.deepEqual(contentTokens("How to get the API keys"), ["api", "key"]);
});

test("similarity is 1 for identical text and 0 for disjoint", () => {
  assert.equal(similarity("Rate limits", "rate limit"), 1);
  assert.equal(similarity("Rate limits", "Billing address"), 0);
});

test("similarity sees through a possessive and a plural", () => {
  // The case that matters: these are one page written three ways.
  assert.ok(similarity("Pricing", "Our Pricing") > 0.8);
  assert.ok(similarity("Integration", "Integrations") > 0.8);
});

test("coverage is asymmetric: a note restating its title scores 1", () => {
  // Everything the note says is already in the title, though the title says more.
  assert.equal(coverage("Pricing", "Pricing plans and billing"), 1);
  assert.ok(coverage("Pricing plans and billing", "Pricing") < 0.5);
});

test("sentences splits on terminal punctuation, not on decimals", () => {
  assert.deepEqual(sentences("One thing. Then another."), ["One thing.", "Then another."]);
  assert.deepEqual(sentences("Costs 1.50 per run."), ["Costs 1.50 per run."]);
});

test("titleCase keeps acronyms and lowercases minor words after the first", () => {
  assert.equal(titleCase("agents and tools"), "Agents and Tools");
  assert.equal(titleCase("API reference"), "API Reference");
  // A minor word leading the title still gets capitalised.
  assert.equal(titleCase("the platform"), "The Platform");
});

test("humanize turns a slug into a name, pluralised acronyms included", () => {
  assert.equal(humanize("getting-started"), "Getting Started");
  assert.equal(humanize("api_reference"), "API Reference");
  assert.equal(humanize("sdks"), "SDKs");
  assert.equal(humanize("rate-limits.html"), "Rate Limits");
});

test("stripBrandSuffix keeps the page's own name, not the brand", () => {
  assert.equal(stripBrandSuffix("Pricing | Acme", "Acme"), "Pricing");
  assert.equal(stripBrandSuffix("Docs - Acme Inc", "Acme"), "Docs");
  // Nothing to split on: the title is returned as it stands.
  assert.equal(stripBrandSuffix("Acme"), "Acme");
});
