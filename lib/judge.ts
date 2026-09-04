import { requestJson } from "./openrouter";

export interface JudgeVerdict {
  qualityScore: number;
  similarityScore: number;
  issues: string[];
}

/**
 * Asks a cheap LLM to compare our generated llms.txt against a site's own
 * real, published llms.txt for the same site. Used as an eval signal (see
 * tests/eval/single-site.test.ts), not as a build gate: the two files
 * are free to organize the same site differently and both be "correct", so
 * this reports two separate numbers rather than conflating them —
 * qualityScore judges "ours" on its own merits (is it accurate, coherent,
 * free of scraping/copyedit artifacts), while similarityScore is a much
 * looser "would these look like the same kind of document" comparison.
 */
export async function judgeLlmsTxt(siteLabel: string, ours: string, reference: string): Promise<JudgeVerdict | null> {
  const prompt = [
    `You are evaluating an auto-generated llms.txt file for "${siteLabel}" against`,
    "that same site's own real, published llms.txt.",
    "",
    "The two files are allowed to organize the site differently — different",
    "section names, different depth, different pages included — since there is",
    "no single correct taxonomy for a site. Do not penalize GENERATED just for",
    "covering different pages or using different section names than REFERENCE.",
    "",
    "Score two things independently, each 1 (bad) to 10 (excellent):",
    '- "qualityScore": judge GENERATED entirely on its own merits — is each',
    "  title/description accurate, non-redundant, free of leftover scraping",
    "  artifacts (run-on words, duplicated brand names, un-stripped marketing",
    "  filler, broken markdown), and genuinely useful for an LLM reading it?",
    '- "similarityScore": how similar in spirit/quality/organization is',
    "  GENERATED to REFERENCE, treating REFERENCE as one reasonable example of",
    "  a good llms.txt for this site (not the only correct answer).",
    "",
    'Also list up to 5 concrete "issues" found in GENERATED (empty array if',
    "none) — specific defects, not general commentary. Example of a specific",
    'issue: "Title \'X : X\' repeats the brand name twice." Not specific enough:',
    '"could be better organized."',
    "",
    "Reply with ONLY a JSON object of this exact shape, no markdown fences, no",
    "commentary:",
    '{"qualityScore": <number>, "similarityScore": <number>, "issues": ["..."]}',
    "",
    "=== GENERATED ===",
    ours,
    "",
    "=== REFERENCE ===",
    reference,
  ].join("\n");

  const verdict = await requestJson<JudgeVerdict>(prompt);
  if (!verdict || typeof verdict.qualityScore !== "number" || typeof verdict.similarityScore !== "number") {
    return null;
  }
  return {
    qualityScore: verdict.qualityScore,
    similarityScore: verdict.similarityScore,
    issues: Array.isArray(verdict.issues) ? verdict.issues.filter((i) => typeof i === "string") : [],
  };
}
