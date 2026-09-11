import { test } from "node:test";
import assert from "node:assert/strict";

import { Deadline, REQUEST_BUDGET_MS } from "../lib/deadline.ts";

test("what is left counts down and stops at nothing", () => {
  const clock = new Deadline(10_000, 0);
  assert.equal(clock.remaining(0), 10_000);
  assert.equal(clock.remaining(4_000), 6_000);
  assert.equal(clock.remaining(10_000), 0);
  assert.equal(clock.remaining(99_000), 0, "never negative, so arithmetic on it stays sane");
  assert.equal(clock.expired(9_999), false);
  assert.equal(clock.expired(10_000), true);
});

test("a step is refused when it could not finish, not when time has already gone", () => {
  // The distinction the crawler got wrong. Asking "has the budget elapsed"
  // let a worker start a page with a tenth of a second left and run for
  // another twelve seconds; asking "can this finish" is what bounds it.
  const clock = new Deadline(10_000, 0);
  assert.equal(clock.allows(8_000, 0), true, "8s of work with 10s left");
  assert.equal(clock.allows(8_000, 2_001), false, "8s of work with 7.999s left");
  assert.equal(clock.allows(0, 10_000), false, "nothing is affordable once the clock is out");
});

test("a step waits for its own cap or for what is left, whichever is sooner", () => {
  const clock = new Deadline(10_000, 0);

  // The signal is what actually enforces this, and AbortSignal.timeout gives
  // no way to read its delay back, so the choice is asserted on the same
  // arithmetic the call site uses.
  const chosen = (capMs: number, now: number) => Math.min(capMs, clock.remaining(now));
  assert.equal(chosen(4_000, 0), 4_000, "a cap shorter than the request wins");
  assert.equal(chosen(30_000, 0), 10_000, "a cap longer than the request does not");
  assert.equal(chosen(4_000, 8_000), 2_000, "and it shrinks as the request is spent");

  assert.ok(clock.signal(1_000) instanceof AbortSignal);
});

test("a nested clock never outlives the one it came from", () => {
  const request = new Deadline(10_000, 0);

  // The crawl's own valve is longer than the request has left, so the request
  // is what binds - which is the case that used to overrun the function.
  assert.equal(request.limit(20_000, 0).remaining(0), 10_000);

  // And the other way round: a short valve inside a long request.
  assert.equal(request.limit(3_000, 0).remaining(0), 3_000);

  // Started late, so it gets what remains rather than its full allowance.
  assert.equal(request.limit(20_000, 6_000).remaining(6_000), 4_000);
});

test("the request budget leaves the function room to answer", () => {
  // maxDuration on /api/generate, which the platform enforces by killing
  // rather than returning. The margin covers a cold start before the handler
  // and serialising a file that can be tens of kilobytes after it.
  const CEILING_MS = 300_000;

  assert.ok(REQUEST_BUDGET_MS < CEILING_MS, "a budget at the ceiling would still be killed");
  assert.ok(CEILING_MS - REQUEST_BUDGET_MS >= 5_000, "and the margin has to be worth having");
});

test("the caps a step may ask for still add up to more than one request", () => {
  /*
   * This is the arithmetic that made the bug, kept as a test so it cannot
   * quietly come back. Every step's own cap is deliberately generous, because
   * on a fast site there is room for it; what was missing is that nothing
   * compared their sum to the function's limit. The deadline is the thing that
   * makes generous caps safe, so if these ever fell below the budget on their
   * own, the deadline would have stopped earning its place rather than started.
   */
  const caps = {
    seedPage: 10_000,
    render: 25_000,
    published: 5_000 * 2,
    robots: 4_000,
    sitemap: 8_000,
    crawl: 60_000,
    models: 35_000,
  };

  const total = Object.values(caps).reduce((a, b) => a + b, 0);
  assert.ok(total > REQUEST_BUDGET_MS, `caps sum to ${total}ms, which is why one clock has to bound them`);
});
