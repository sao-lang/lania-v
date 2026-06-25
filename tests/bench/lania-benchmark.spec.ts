import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

type BenchFramework = 'lania-v' | 'react' | 'vue' | 'solid';
type BenchTargetId = 'lania-fc' | 'react' | 'vue' | 'solid';
type BenchCaseName = 'mount' | 'text-update' | 'list-patch' | 'toggle' | 'model-input';

interface BenchCaseResult {
  name: BenchCaseName;
  sampleCount: number;
  warmupSamples: number;
  operationsPerSample: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  batchMeanMs: number;
  batchMedianMs: number;
  batchP95Ms: number;
  samplesMs: number[];
  sampleBatchMs: number[];
}

interface BenchSuiteResult {
  framework: BenchFramework;
  target: BenchTargetId;
  variant: string | null;
  label: string;
  generatedAt: string;
  url: string;
  userAgent: string;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  cases: BenchCaseResult[];
}

declare global {
  interface Window {
    runBenchSuite: (options?: { target?: BenchTargetId }) => Promise<BenchSuiteResult>;
  }
}

const TARGETS: BenchTargetId[] = ['lania-fc', 'react', 'vue', 'solid'];

test.describe.configure({ mode: 'serial' });

test('runs full lania benchmark suite and writes latest results', async ({ page, browserName }) => {
  const suites: BenchSuiteResult[] = [];

  for (const target of TARGETS) {
    await page.goto(`/?target=${target}`);
    const result = await page.evaluate(async (targetId) => {
      return window.runBenchSuite({
        target: targetId,
      });
    }, target);

    expect(result.target).toBe(target);
    expect(result.cases).toHaveLength(5);
    suites.push(result);
  }

  const payload = {
    framework: 'comparison',
    browser: browserName,
    generatedAt: new Date().toISOString(),
    suites,
  };

  const outputDirectory = path.resolve(process.cwd(), 'test-results/benchmark');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'latest.json'), JSON.stringify(payload, null, 2), 'utf8');

  for (const suite of suites) {
    console.log(`benchmark target: ${suite.label} (${suite.target})`);
    for (const entry of suite.cases) {
      console.log(
        [
          `  ${entry.name}`,
          `ops=${entry.operationsPerSample}`,
          `median=${entry.medianMs.toFixed(3)}ms`,
          `mean=${entry.meanMs.toFixed(3)}ms`,
          `p95=${entry.p95Ms.toFixed(3)}ms`,
        ].join(' | ')
      );
    }
  }
});
