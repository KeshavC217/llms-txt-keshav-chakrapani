import { test } from "node:test";
import assert from "node:assert/strict";

import { describeRenderFailure, renderConfigured } from "../lib/render.ts";

/*
 * These cover the reporting rather than the rendering. Driving a real browser
 * in a unit suite would make the suite depend on a Chromium being installed
 * and on a network, which is what tests/fixtures.ts exists to avoid - but the
 * reason a render failed is the part that was missing, and it is pure.
 */

test("every way of failing says something different", () => {
  const said = [
    describeRenderFailure({ reason: "no-browser" }),
    describeRenderFailure({ reason: "timeout", ms: 24_600 }),
    describeRenderFailure({ reason: "challenged", detail: "The site answered with a verification page." }),
    describeRenderFailure({ reason: "error", detail: "Protocol error: Target closed" }),
  ];

  assert.equal(new Set(said).size, said.length, `these must be distinguishable: ${JSON.stringify(said)}`);
  for (const line of said) assert.ok(line.length > 0);
});

test("a timeout says how long it waited, in seconds a person reads", () => {
  // The number is the point: 25s means the cap was hit, 4s means something
  // else went wrong and the cap is not the thing to raise.
  assert.match(describeRenderFailure({ reason: "timeout", ms: 24_600 }), /25s/);
  assert.match(describeRenderFailure({ reason: "timeout", ms: 3_100 }), /3s/);
});

test("rendering is on unless it is switched off", () => {
  // A capability that has to be remembered is one that is not there: the
  // previous version was an endpoint nobody configured, so it never ran.
  const before = process.env.DISABLE_RENDER;
  try {
    delete process.env.DISABLE_RENDER;
    assert.equal(renderConfigured(), true);
    process.env.DISABLE_RENDER = "1";
    assert.equal(renderConfigured(), false);
  } finally {
    if (before === undefined) delete process.env.DISABLE_RENDER;
    else process.env.DISABLE_RENDER = before;
  }
});
