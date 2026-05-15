#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const docsRepoUrl = 'https://github.com/GoHighLevel/highlevel-api-docs.git';
const defaultDocsDir = join(repoRoot, 'tmp', 'highlevel-api-docs');
const defaultReportPath = join(repoRoot, 'docs', 'GHL-API-COVERAGE-REPORT.md');
const defaultJsonPath = join(repoRoot, 'docs', 'ghl-api-coverage.json');
const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);

const args = parseArgs(process.argv.slice(2));
const docsDir = args['docs-dir'] ? resolveFromRoot(args['docs-dir']) : defaultDocsDir;
const reportPath = args.out ? resolveFromRoot(args.out) : defaultReportPath;
const jsonPath = args.json ? resolveFromRoot(args.json) : defaultJsonPath;

ensureDocsRepo(docsDir, args.refresh === true);

const official = extractOfficialEndpoints(docsDir);
const local = extractLocalEndpoints(join(repoRoot, 'src'));
const changelogFindings = [
  {
    date: '2026-04-28',
    area: 'Users',
    change: 'GET /users/ endpoint deprecated',
    source: 'https://marketplace.gohighlevel.com/docs/Changelog/index.html',
  },
  {
    date: '2026-04-21',
    area: 'Notes',
    change: 'Top-level Notes endpoints added: POST /notes/, POST /notes/search, DELETE /notes/{id}, GET /notes/{id}, PUT /notes/{id}, PATCH /notes/{id}/attachments, PUT /notes/{id}/relations, POST /notes/{id}/restore',
    source: 'https://marketplace.gohighlevel.com/docs/Changelog/index.html',
  },
  {
    date: '2026-04-15',
    area: 'Users/Scopes',
    change: 'New user scope enum values added for audit logs, location management, and payments settings',
    source: 'https://marketplace.gohighlevel.com/docs/Changelog/index.html',
  },
  {
    date: 'Recent product changelog',
    area: 'Emails',
    change: 'Email Campaign V2 APIs introduced; future email campaign improvements focus on V2 endpoints',
    source: 'https://ideas.gohighlevel.com/changelog/new-improved-email-marketing-public-apis',
  },
];

const comparison = compareEndpoints(official.endpoints, local.endpoints);
const report = buildReport({ official, local, comparison, changelogFindings, docsDir });

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, report);
writeFileSync(jsonPath, JSON.stringify({ official, local, comparison, changelogFindings }, null, 2));

console.log(`Wrote ${relative(repoRoot, reportPath)}`);
console.log(`Wrote ${relative(repoRoot, jsonPath)}`);
console.log(`Official endpoints: ${official.endpoints.length}`);
console.log(`Local endpoint references: ${local.endpoints.length}`);
console.log(`Likely missing official endpoints: ${comparison.missingOfficial.length}`);
console.log(`Potential local-only endpoints: ${comparison.localOnly.length}`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function resolveFromRoot(path) {
  return path.startsWith('/') ? path : join(repoRoot, path);
}

function runGit(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function ensureDocsRepo(dir, refresh) {
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    runGit(['clone', '--depth', '1', docsRepoUrl, dir]);
    return;
  }

  if (refresh) {
    runGit(['fetch', '--depth', '1', 'origin', 'main'], dir);
    runGit(['checkout', 'FETCH_HEAD'], dir);
  }
}

function extractOfficialEndpoints(dir) {
  const appsDir = join(dir, 'apps');
  const endpoints = [];

  for (const file of readdirSync(appsDir).filter((name) => name.endsWith('.json')).sort()) {
    const appName = file.replace(/\.json$/, '');
    const spec = JSON.parse(readFileSync(join(appsDir, file), 'utf8'));
    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations ?? {})) {
        if (!httpMethods.has(method.toLowerCase())) continue;
        endpoints.push({
          key: makeKey(method, path),
          method: method.toUpperCase(),
          path,
          normalizedPath: normalizePath(path),
          app: appName,
          operationId: operation.operationId ?? '',
          summary: operation.summary ?? '',
          versions: extractVersions(operation),
          scopes: extractScopes(operation),
          sourceFile: `apps/${file}`,
        });
      }
    }
  }

  const commit = runGit(['rev-parse', 'HEAD'], dir);
  const tag = safeGit(['describe', '--tags', '--always'], dir);
  return { repo: docsRepoUrl, commit, tag, endpoints };
}

function extractVersions(operation) {
  const versions = new Set();
  for (const param of operation.parameters ?? []) {
    if (param.name === 'Version') {
      for (const value of param.schema?.enum ?? []) versions.add(String(value));
      if (param.schema?.example) versions.add(String(param.schema.example));
    }
  }
  return [...versions].sort();
}

function extractScopes(operation) {
  const scopes = new Set();
  for (const security of operation.security ?? []) {
    for (const values of Object.values(security)) {
      for (const scope of values ?? []) scopes.add(scope);
    }
  }
  return [...scopes].sort();
}

function extractLocalEndpoints(srcDir) {
  const files = listFiles(srcDir).filter((file) => file.endsWith('.ts') && !file.includes('/ui/'));
  const endpoints = [];

  const makeRequestRegex = /makeRequest\(\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  const axiosRegex = /axiosInstance\.(get|post|put|patch|delete)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(makeRequestRegex)) {
      addLocalEndpoint(endpoints, file, match[1], match[2], 'makeRequest');
    }
    for (const match of text.matchAll(axiosRegex)) {
      addLocalEndpoint(endpoints, file, match[1], match[2], 'axiosInstance');
    }
  }

  endpoints.push(...extractGeneratedOfficialSpecEndpoints(join(srcDir, 'tools', 'official-spec-endpoints.json')));

  return {
    endpoints,
    filesScanned: files.length,
  };
}

function extractGeneratedOfficialSpecEndpoints(file) {
  if (!existsSync(file)) return [];
  try {
    const endpoints = JSON.parse(readFileSync(file, 'utf8'));
    return endpoints.map((endpoint) => ({
      key: makeKey(endpoint.method, endpoint.path),
      method: endpoint.method,
      path: endpoint.path,
      normalizedPath: normalizePath(endpoint.path),
      sourceFile: relative(repoRoot, file),
      caller: 'official-spec-generated',
    }));
  } catch {
    return [];
  }
}

function addLocalEndpoint(endpoints, file, method, rawPath, caller) {
  const path = cleanLocalPath(rawPath);
  if (!path.startsWith('/')) return;
  endpoints.push({
    key: makeKey(method, path),
    method: method.toUpperCase(),
    path,
    normalizedPath: normalizePath(path),
    sourceFile: relative(repoRoot, file),
    caller,
  });
}

function cleanLocalPath(rawPath) {
  let value = rawPath.slice(1, -1);
  value = value.replace(/\$\{[^}]+\}/g, '{param}');
  value = value.replace(/\?.*$/, '');
  value = value.replace(/\/+/g, '/');
  return value;
}

function normalizePath(path) {
  return path
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]+\}/g, '{param}')
    .replace(/\{[^}/]+\}/g, '{}')
    .replace(/:[^/]+/g, '{}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function makeKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function listFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function compareEndpoints(officialEndpoints, localEndpoints) {
  const officialByKey = groupBy(officialEndpoints, (endpoint) => endpoint.key);
  const localByKey = groupBy(localEndpoints, (endpoint) => endpoint.key);
  const officialKeys = new Set(officialByKey.keys());
  const localKeys = new Set(localByKey.keys());

  const covered = [...officialKeys].filter((key) => localKeys.has(key)).sort();
  const missingOfficial = [...officialKeys]
    .filter((key) => !localKeys.has(key))
    .sort()
    .map((key) => officialByKey.get(key)[0]);
  const localOnly = [...localKeys]
    .filter((key) => !officialKeys.has(key))
    .sort()
    .map((key) => localByKey.get(key)[0]);

  const byApp = {};
  for (const endpoint of officialEndpoints) {
    byApp[endpoint.app] ??= { official: 0, covered: 0, missing: 0 };
    byApp[endpoint.app].official += 1;
    if (localKeys.has(endpoint.key)) byApp[endpoint.app].covered += 1;
    else byApp[endpoint.app].missing += 1;
  }

  return {
    coveredCount: covered.length,
    officialUniqueCount: officialKeys.size,
    localUniqueCount: localKeys.size,
    coveragePercent: officialKeys.size === 0 ? 0 : Math.round((covered.length / officialKeys.size) * 1000) / 10,
    missingOfficial,
    localOnly,
    byApp,
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function safeGit(args, cwd) {
  try {
    return runGit(args, cwd);
  } catch {
    return '';
  }
}

function buildReport({ official, local, comparison, changelogFindings, docsDir }) {
  const now = new Date().toISOString();
  const highPriorityApps = new Set(['users', 'emails', 'campaigns', 'contacts', 'calendars', 'marketplace']);
  const missingHighPriority = comparison.missingOfficial
    .filter((endpoint) => highPriorityApps.has(endpoint.app))
    .slice(0, 80);
  const localOnlyHighRisk = comparison.localOnly
    .filter((endpoint) => !endpoint.path.startsWith('/notes'))
    .filter((endpoint) => /\/users\/?$|\/campaigns|\/emails/.test(endpoint.path))
    .slice(0, 80);
  const appRows = Object.entries(comparison.byApp)
    .sort(([, a], [, b]) => b.missing - a.missing || b.official - a.official)
    .map(([app, stats]) => `| ${app} | ${stats.official} | ${stats.covered} | ${stats.missing} |`)
    .join('\n');

  return `# GHL API Coverage Report

Generated: ${now}

## Source Snapshot

- Official docs repo: ${official.repo}
- Docs checkout: \`${relative(repoRoot, docsDir)}\`
- Docs commit: \`${official.commit}\`
- Docs tag/description: \`${official.tag}\`
- Official endpoint references parsed: ${official.endpoints.length}
- Local endpoint references parsed: ${local.endpoints.length}
- Local TypeScript files scanned: ${local.filesScanned}

## Coverage Summary

- Unique official endpoints: ${comparison.officialUniqueCount}
- Unique local endpoints: ${comparison.localUniqueCount}
- Official endpoints with an exact method/path match locally: ${comparison.coveredCount}
- Exact-match coverage: ${comparison.coveragePercent}%
- Likely missing official endpoints: ${comparison.missingOfficial.length}
- Potential local-only/deprecated/private endpoints: ${comparison.localOnly.length}

Exact matching is intentionally conservative. Dynamic path generation, aliases, and compatibility wrappers may create false positives, but this gives us a repeatable first-pass map.

## Changelog-Only Findings To Plan Around

${changelogFindings.map((item) => `- ${item.date} — ${item.area}: ${item.change} (${item.source})`).join('\n')}

## Coverage By Official App Area

| App area | Official endpoints | Exact local matches | Missing |
| --- | ---: | ---: | ---: |
${appRows}

## High-Priority Missing Official Endpoints

${formatEndpointList(missingHighPriority)}

## Potential Local-Only High-Risk Endpoints

These deserve manual review because they may be legacy, private, renamed, or simply not matched by the scanner.

${formatEndpointList(localOnlyHighRisk)}

## Recommended Update Plan

1. Add a CI-friendly version of this scanner so API drift is visible after every docs refresh.
2. Make \`GHL_API_VERSION\` configurable in all server entry points and keep endpoint-specific overrides for APIs that still require older version headers.
3. Review \`users-tools.ts\` against the latest official users spec and retire or alias deprecated \`GET /users/\` behavior.
4. Keep the first-class top-level Notes module in place for the 2026-04-21 changelog endpoints, and reconcile it against the official spec once those endpoints land in the docs repo.
5. Upgrade \`email-tools.ts\` and \`campaigns-tools.ts\` toward the Email Campaign V2 endpoints under \`/emails/*\`; preserve old tool names as compatibility aliases where practical.
6. Update OAuth/private-integration scope documentation for new audit-log, location-management, and payment-settings scopes.
7. Manually inspect local-only campaign, workflow, OAuth, and trigger endpoints. If they are internal/private APIs, mark them clearly in tool descriptions and README so users know their stability profile.
8. Add targeted tests for each migrated module using the current official path, method, version header, and required query/body fields.

## Full Machine-Readable Output

See \`${relative(repoRoot, jsonPath)}\` for the complete parsed endpoint lists.
`;
}

function formatEndpointList(endpoints) {
  if (endpoints.length === 0) return '- None found.';
  return endpoints
    .map((endpoint) => {
      const source = endpoint.sourceFile ?? endpoint.sourceFile;
      const extra = endpoint.summary || endpoint.operationId || endpoint.caller || '';
      return `- \`${endpoint.method} ${endpoint.path}\` — ${endpoint.app ?? endpoint.sourceFile}${extra ? ` — ${extra}` : ''}${source && endpoint.app ? ` (\`${source}\`)` : ''}`;
    })
    .join('\n');
}
