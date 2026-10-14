// Library entry. The CLI (bin/docs-kit.mjs) is the supported interface; these
// exports exist for tests and for tools that embed docs-kit.
export { runChecks, runDecisionChecks, formatCheckReport } from './check.mjs';
export { parseDecisionRecord, validateDecisionRecord, validateDecisions, renderDecisionIndex, DECISION_STATUSES, EVIDENCE_KINDS } from './decisions.mjs';
export { runBuild, checkGeneratedSite } from './build.mjs';
export { assembleBundle, bundleDigest, bundleFromCheckout } from './bundle.mjs';
export { validateManifest, validateProducts, loadManifest } from './manifest.mjs';
export { analyzeMarkdown, githubSlug, extractSection } from './markdown.mjs';
export { createDocsServer, hubSource, repoSource, workspaceSource, searchBundles } from './mcp.mjs';
export { renderHub } from './hub.mjs';
export { EXIT_OK, EXIT_GATE, EXIT_USAGE } from './errors.mjs';
