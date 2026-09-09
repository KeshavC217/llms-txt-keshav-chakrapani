import { type Extraction, render } from "../naiveExtractor.ts";
import { validateLlmsTxt } from "../spec.ts";
import { type Transport, openRouter } from "./openrouter.ts";
import { type SieveReport, applyProposals, emptyReport } from "./sieve.ts";
import { runAnnotation } from "./annotate.ts";
import { runGuide } from "./guide.ts";
import { type FailureKind, ModelError, isFatal } from "./errors.ts";
import { guideModel, workerModel } from "./models.ts";

/**
 * The whole sieve, end to end: guide, then annotate, then keep only what
 * survives, then check the result still parses as an llms.txt.
 *
 * The contract is that this cannot make the output worse. Every failure path -
 * no key, a model that is down, a reply that is nonsense, a deadline missed,
 * a file that no longer conforms - ends with the deterministic file being
 * returned. The AI is an improvement or it is nothing.
 */

/**
 * Kept well inside maxDuration = 60. Was 20s, which a retry could push a chunk
 * past: a live run lost a chunk of docs.exa.ai to the deadline rather than to
 * any failure, and its links silently kept no note. Waiting is cheaper than
 * losing them, and the abort still stops a slow model from holding the request
 * open past the function's own limit.
 */
const BUDGET_MS = 35_000;

export interface EnhanceResult {
  llmsTxt: string;
  enhanced: boolean;
  report: SieveReport & {
    guideModel: string;
    workerModel: string;
    reason?: string;
    /** Failures by kind, so a rate limit does not read as a slow model. */
    failures?: Partial<Record<FailureKind, number>>;
  };
  /**
   * Set when the account itself is the problem - out of credits, or a key that
   * is not accepted. The route turns this into a status code, because no amount
   * of retrying or waiting will produce a better file.
   */
  fatal?: ModelError;
}

export async function enhance(
  extraction: Extraction,
  url: string,
  transports?: { guide: Transport; worker: Transport },
): Promise<EnhanceResult> {
  const deterministic = render(extraction, url);
  const report = emptyReport();
  const models = { guideModel: guideModel().id, workerModel: workerModel().id };

  const guideTransport = transports?.guide ?? openRouter(700);
  const workerTransport = transports?.worker ?? openRouter(900);

  // One deadline for both stages: whatever has arrived by then is used, and
  // the rest is dropped. The abort is what stops a slow model from holding the
  // request open past the function's own limit.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), BUDGET_MS);

  try {
    // The guide runs first because its summary is context for every chunk.
    // The guide runs first because its summary is context for every chunk. If
    // it fails on the account rather than the request, the chunks would each
    // fail the same way, so there is no point starting them.
    let guideFatal: ModelError | undefined;
    const proposals = await runGuide(extraction, guideTransport, controller.signal).catch((error) => {
      if (error instanceof ModelError && isFatal(error.kind)) guideFatal = error;
      return {};
    });

    if (guideFatal) {
      return {
        llmsTxt: deterministic,
        enhanced: false,
        report: { ...report, ...models, reason: guideFatal.kind },
        fatal: guideFatal,
      };
    }

    const { notes, failed, failures, fatal } = await runAnnotation(extraction, workerTransport, controller.signal);
    report.chunksFailed = failed;
    report.failures = failures;

    const improved = applyProposals(extraction, { ...proposals, notes }, report);
    const llmsTxt = render(improved, url);

    // The last gate. A model cannot be trusted to have left the file parseable,
    // so it is parsed. If it did not, the deterministic file is what ships.
    if (validateLlmsTxt(llmsTxt).length > 0) {
      return { llmsTxt: deterministic, enhanced: false, report: { ...report, ...models, reason: "not-conforming" } };
    }

    const changed = report.notesAccepted > 0 || report.summaryReplaced || report.sectionsRenamed > 0;
    return {
      llmsTxt: changed ? llmsTxt : deterministic,
      enhanced: changed,
      report: { ...report, ...models, reason: changed ? undefined : fatal?.kind ?? "nothing-accepted" },
      fatal,
    };
  } catch (err) {
    return {
      llmsTxt: deterministic,
      enhanced: false,
      report: { ...report, ...models, reason: err instanceof Error ? err.message.slice(0, 120) : "failed" },
    };
  } finally {
    clearTimeout(deadline);
  }
}
