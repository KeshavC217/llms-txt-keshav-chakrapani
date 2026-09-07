import { type Extraction, render } from "../naiveExtractor.ts";
import { validateLlmsTxt } from "../spec.ts";
import { type Transport, openRouter } from "./openrouter.ts";
import { type SieveReport, applyProposals, emptyReport } from "./sieve.ts";
import { runAnnotation } from "./annotate.ts";
import { runGuide } from "./guide.ts";
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

const BUDGET_MS = 20_000;

export interface EnhanceResult {
  llmsTxt: string;
  enhanced: boolean;
  report: SieveReport & { guideModel: string; workerModel: string; reason?: string };
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
    const proposals = await runGuide(extraction, guideTransport, controller.signal).catch(() => ({}));
    const { notes, failed } = await runAnnotation(extraction, workerTransport, controller.signal);
    report.chunksFailed = failed;

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
      report: { ...report, ...models, reason: changed ? undefined : "nothing-accepted" },
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
