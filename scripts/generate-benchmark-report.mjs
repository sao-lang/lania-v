import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resultsDir = new URL('../test-results/benchmark/', import.meta.url);
const inputPath = new URL('./latest.json', resultsDir);
const outputPath = new URL('./latest.md', resultsDir);

const source = await readFile(inputPath, 'utf8');
const report = JSON.parse(source);

const suites = Array.isArray(report.suites) ? report.suites : [];
const caseNames = Array.from(
  new Set(
    suites.flatMap((suite) =>
      Array.isArray(suite.cases) ? suite.cases.map((entry) => entry.name) : []
    )
  )
);

const formatMs = (value) => `${Number(value ?? 0).toFixed(3)} ms`;
const formatNumber = (value) => String(value ?? '-');
const formatLabel = (suite) => {
  return suite.variant ? `${suite.label} (${suite.variant})` : suite.label;
};

const makeTable = (headers, rows) => {
  const head = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [head, divider, body].filter(Boolean).join('\n');
};

const summaryHeaders = [
  'Target',
  'Framework',
  'Mount',
  'Text',
  'List Patch',
  'Toggle',
  'Model',
];
const summaryRows = suites.map((suite) => {
  const byName = new Map(
    (suite.cases ?? []).map((entry) => [entry.name, entry])
  );
  return [
    formatLabel(suite),
    suite.framework,
    formatMs(byName.get('mount')?.medianMs),
    formatMs(byName.get('text-update')?.medianMs),
    formatMs(byName.get('list-patch')?.medianMs),
    formatMs(byName.get('toggle')?.medianMs),
    formatMs(byName.get('model-input')?.medianMs),
  ];
});

const winnerRows = caseNames.map((caseName) => {
  const ranked = suites
    .map((suite) => ({
      suite,
      caseResult: (suite.cases ?? []).find((entry) => entry.name === caseName),
    }))
    .filter((entry) => entry.caseResult)
    .sort(
      (left, right) => left.caseResult.medianMs - right.caseResult.medianMs
    );

  const winner = ranked[0];
  return [
    caseName,
    winner ? formatLabel(winner.suite) : '-',
    winner ? formatMs(winner.caseResult.medianMs) : '-',
    winner ? formatMs(winner.caseResult.p95Ms) : '-',
    winner ? formatNumber(winner.caseResult.operationsPerSample) : '-',
  ];
});

const detailSections = caseNames.map((caseName) => {
  const ranked = suites
    .map((suite) => ({
      suite,
      caseResult: (suite.cases ?? []).find((entry) => entry.name === caseName),
    }))
    .filter((entry) => entry.caseResult)
    .sort(
      (left, right) => left.caseResult.medianMs - right.caseResult.medianMs
    );

  const rows = ranked.map(({ suite, caseResult }) => [
    formatLabel(suite),
    suite.framework,
    formatMs(caseResult.medianMs),
    formatMs(caseResult.meanMs),
    formatMs(caseResult.p95Ms),
    formatMs(caseResult.batchMedianMs),
    formatNumber(caseResult.operationsPerSample),
    formatNumber(caseResult.sampleCount),
  ]);

  return [
    `## ${caseName}`,
    makeTable(
      [
        'Target',
        'Framework',
        'Median',
        'Mean',
        'P95',
        'Batch Median',
        'Ops/Sample',
        'Samples',
      ],
      rows
    ),
  ].join('\n\n');
});

const noteLines = [
  '- 本报告按 `medianMs` 升序比较每个 case。',
  '- `medianMs` / `p95Ms` 是单操作折算后的耗时，`batchMedianMs` 是整批操作耗时。',
  '- 跨提交比较时，请固定浏览器版本和硬件环境。',
];

const markdown = [
  '# Benchmark Report',
  '',
  `- Generated At: ${report.generatedAt ?? '-'}`,
  `- Browser: ${report.browser ?? '-'}`,
  `- Source: [latest.json](file://${path.resolve(fileURLToPath(inputPath))})`,
  '',
  '## Overview',
  '',
  makeTable(summaryHeaders, summaryRows),
  '',
  '## Winners',
  '',
  makeTable(['Case', 'Winner', 'Median', 'P95', 'Ops/Sample'], winnerRows),
  '',
  ...detailSections.flatMap((section) => ['', section]),
  '',
  '## Notes',
  ...noteLines,
  '',
].join('\n');

await mkdir(path.dirname(fileURLToPath(outputPath)), { recursive: true });
await writeFile(outputPath, markdown, 'utf8');

console.log(`Benchmark report written to ${fileURLToPath(outputPath)}`);
