/**
 * The runner's decision tools: the ones a turn ends on.
 *
 * Each of them is a **value** the runner reads, not a sentence it has to parse
 * out of prose: the triage's `work` or `skip`, the scope's `fits` or `split`,
 * the related issues to batch, the review's verdict. The tool is described
 * once, here, and the engine's object over it is built from that description.
 *
 * - `issue.ts` — the triage turn's decision.
 * - `scope.ts` — the scope turn's decision.
 * - `related.ts` — the related-issues turn's decision.
 * - `verdict.ts` — the review's verdict.
 */

export * from "./issue.js";
export * from "./related.js";
export * from "./scope.js";
export * from "./verdict.js";
