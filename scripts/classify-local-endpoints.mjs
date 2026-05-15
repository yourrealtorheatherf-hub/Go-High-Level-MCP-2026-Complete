#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const coveragePath = join(repoRoot, 'docs', 'ghl-api-coverage.json');
const outPath = join(repoRoot, 'docs', 'GHL-LOCAL-ENDPOINT-CLASSIFICATION.md');
const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));

const buckets = {
  dynamicOrTemplated: [],
  changelogOnlyNotes: [],
  legacyPrivateInternal: [],
  compatibilityWrappers: [],
  needsReview: [],
};

for (const endpoint of coverage.comparison.localOnly) {
  if (endpoint.path.startsWith('/notes')) buckets.changelogOnlyNotes.push(endpoint);
  else if (/oauth|login|firebase|integrations|internal|marketplace|workflow|trigger|social-media-posting|saas|snapshots|phone|voice-ai|proposals|custom-menus/i.test(endpoint.path)) buckets.legacyPrivateInternal.push(endpoint);
  else if (/campaigns|emails|templates|scheduled|messages|reporting|apps|builder/i.test(endpoint.path)) buckets.compatibilityWrappers.push(endpoint);
  else if (/[{}]|\{param\}/.test(endpoint.path)) buckets.dynamicOrTemplated.push(endpoint);
  else buckets.needsReview.push(endpoint);
}

const report = `# GHL Local-Only Endpoint Classification

Generated from \`docs/ghl-api-coverage.json\`.

## Summary

- Total local-only endpoint references: ${coverage.comparison.localOnly.length}
- Changelog-only Notes endpoints: ${buckets.changelogOnlyNotes.length}
- Legacy/private/internal endpoints: ${buckets.legacyPrivateInternal.length}
- Compatibility wrappers: ${buckets.compatibilityWrappers.length}
- Dynamic or templated endpoints needing manual mapping: ${buckets.dynamicOrTemplated.length}
- Needs manual review: ${buckets.needsReview.length}

## Changelog-Only Notes

${format(buckets.changelogOnlyNotes)}

## Legacy/Private/Internal

${format(buckets.legacyPrivateInternal)}

## Compatibility Wrappers

${format(buckets.compatibilityWrappers)}

## Dynamic Or Templated

These are not assumed official. The scanner normalized template expressions to \`{param}\`, so each should be checked against the official OpenAPI path names before keeping, aliasing, or retiring it.

${format(buckets.dynamicOrTemplated)}

## Needs Manual Review

${format(buckets.needsReview)}
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report);
console.log(`Wrote ${outPath}`);

function format(items) {
  if (!items.length) return '- None';
  return items.map((item) => `- \`${item.method} ${item.path}\` (${item.sourceFile})`).join('\n');
}
