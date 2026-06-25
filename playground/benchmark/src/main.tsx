import {
  createComponentElement,
  createRoot,
  type ComponentElementConstructor,
} from '@lania-v/runtime';
import { createElement as createReactElement, useState } from 'react';
import { createApp, type App as VueApp } from 'vue';
import { createRoot as createReactRoot } from 'react-dom/client';
import { render as renderSolid } from 'solid-js/web';

import BenchmarkFc from './BenchmarkFc.lania.tsx';
import BenchmarkSolid from './BenchmarkSolid.solid.jsx';
import BenchmarkVue from './BenchmarkVue';
import {
  type BenchItem,
  BENCH_MIDDLE_ROW_ID,
  BENCH_MIDDLE_ROW_INDEX,
  buildBenchItems,
  describeBenchItem,
  patchBenchItems,
} from './benchmarkShared';

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

interface RunBenchSuiteOptions {
  target?: BenchTargetId;
  cases?: BenchCaseName[];
}

interface BenchMountController {
  unmount(): void;
  getQueryRoot(): ParentNode | null;
}

interface BenchTargetEntry {
  framework: BenchFramework;
  variant: string | null;
  label: string;
  mount(surface: HTMLElement): BenchMountController;
}

declare global {
  interface Navigator {
    deviceMemory?: number;
  }

  interface Window {
    runBenchSuite: (options?: RunBenchSuiteOptions) => Promise<BenchSuiteResult>;
  }
}

const DEFAULT_CASE_ORDER: BenchCaseName[] = [
  'mount',
  'text-update',
  'list-patch',
  'toggle',
  'model-input',
];

const CASE_CONFIG: Record<
  BenchCaseName,
  { sampleCount: number; warmupSamples: number; operationsPerSample: number }
> = {
  mount: { sampleCount: 12, warmupSamples: 2, operationsPerSample: 20 },
  'text-update': { sampleCount: 24, warmupSamples: 4, operationsPerSample: 120 },
  'list-patch': { sampleCount: 20, warmupSamples: 4, operationsPerSample: 60 },
  toggle: { sampleCount: 24, warmupSamples: 4, operationsPerSample: 120 },
  'model-input': { sampleCount: 24, warmupSamples: 4, operationsPerSample: 80 },
};

const roundMetric = (value: number): number => {
  return Number(value.toFixed(3));
};

const ReactBenchmarkComponent = () => {
  const initialItems = buildBenchItems();
  const [count, setCount] = useState(0);
  const [items, setItems] = useState(initialItems);
  const [patchVersion, setPatchVersion] = useState(0);
  const [toggleVisible, setToggleVisible] = useState(true);
  const [draft, setDraft] = useState('seed');
  const [middleSnapshot, setMiddleSnapshot] = useState(describeBenchItem(initialItems[BENCH_MIDDLE_ROW_INDEX]));

  const increment = () => {
    setCount((value: number) => value + 1);
  };

  const patchMiddle = () => {
    setPatchVersion((previous: number) => {
      const nextVersion = previous + 1;
      setItems((previousItems: BenchItem[]) => {
        const nextItems = patchBenchItems(previousItems, nextVersion);
        setMiddleSnapshot(describeBenchItem(nextItems[BENCH_MIDDLE_ROW_INDEX]));
        return nextItems;
      });
      return nextVersion;
    });
  };

  const toggle = () => {
    setToggleVisible((value: boolean) => !value);
  };

  return createReactElement('section', { className: 'bench-root', 'data-bench-root': 'ready', 'data-bench-ready': 'true' }, [
    createReactElement('header', { className: 'bench-header', key: 'header' }, [
      createReactElement('h2', { key: 'title' }, 'React benchmark'),
      createReactElement('p', { className: 'bench-meta', key: 'meta' }, 'list size: 1000 | middle row: 501'),
    ]),
    createReactElement('div', { className: 'bench-grid', key: 'grid' }, [
      createReactElement('div', { className: 'bench-card', key: 'count-card' }, [
        createReactElement('div', { className: 'bench-toolbar', key: 'toolbar' }, [
          createReactElement(
            'button',
            { className: 'bench-btn', 'data-bench-action': 'increment', onClick: increment, key: 'button' },
            'increment'
          ),
          createReactElement(
            'output',
            { className: 'bench-output', 'data-bench-output': 'count', key: 'output' },
            String(count)
          ),
        ]),
        createReactElement('p', { className: 'bench-note', key: 'note' }, 'state update -> text output'),
      ]),
      createReactElement('div', { className: 'bench-card', key: 'patch-card' }, [
        createReactElement('div', { className: 'bench-toolbar', key: 'toolbar' }, [
          createReactElement(
            'button',
            { className: 'bench-btn', 'data-bench-action': 'patch', onClick: patchMiddle, key: 'button' },
            'patch middle'
          ),
          createReactElement(
            'output',
            { className: 'bench-output', 'data-bench-output': 'patch-version', key: 'patch-version' },
            String(patchVersion)
          ),
          createReactElement(
            'output',
            { className: 'bench-output bench-output-wide', 'data-bench-output': 'middle-row', key: 'middle-row' },
            middleSnapshot
          ),
        ]),
        createReactElement(
          'p',
          { className: 'bench-note', key: 'note' },
          '1000-item keyed list patch + middle row verification'
        ),
        createReactElement(
          'ul',
          { className: 'bench-list', 'data-bench-list': 'patch', key: 'list' },
          items.map((item: BenchItem) =>
            createReactElement(
              'li',
              {
                className: 'bench-list-row',
                'data-bench-row-id': String(item.id),
                'data-bench-row-done': item.done ? 'true' : 'false',
                key: item.id,
              },
              describeBenchItem(item)
            )
          )
        ),
      ]),
      createReactElement('div', { className: 'bench-card', key: 'toggle-card' }, [
        createReactElement('div', { className: 'bench-toolbar', key: 'toolbar' }, [
          createReactElement(
            'button',
            { className: 'bench-btn', 'data-bench-action': 'toggle', onClick: toggle, key: 'button' },
            'toggle panel'
          ),
          createReactElement(
            'output',
            { className: 'bench-output', 'data-bench-output': 'toggle-state', key: 'output' },
            toggleVisible ? 'visible' : 'hidden'
          ),
        ]),
        toggleVisible
          ? createReactElement('section', { className: 'bench-panel', 'data-bench-output': 'toggle-panel', key: 'panel' }, [
              createReactElement('p', { className: 'bench-note', key: 'title' }, 'mounted conditional subtree'),
              createReactElement('p', { className: 'bench-meta', key: 'body' }, 'panel body: visible'),
            ])
          : null,
      ]),
      createReactElement('div', { className: 'bench-card', key: 'input-card' }, [
        createReactElement('div', { className: 'bench-toolbar', key: 'toolbar' }, [
          createReactElement('input', {
            className: 'bench-input',
            'data-bench-input': 'model',
            placeholder: 'type benchmark payload',
            value: draft,
            onInput: (event: Event) => {
              const target = event.currentTarget as HTMLInputElement | null;
              setDraft(target?.value ?? '');
            },
            key: 'input',
          }),
          createReactElement(
            'output',
            { className: 'bench-output bench-output-wide', 'data-bench-output': 'draft', key: 'output' },
            draft
          ),
        ]),
        createReactElement(
          'p',
          { className: 'bench-note', key: 'note' },
          'input event -> controlled value snapshot'
        ),
      ]),
    ]),
  ]);
};

const mountLaniaBenchmark = (
  surface: HTMLElement,
  ctor: ComponentElementConstructor<HTMLElement>
): BenchMountController => {
  surface.replaceChildren();
  const root = createRoot(surface);
  const host = createComponentElement(ctor) as HTMLElement;
  root.render(host);

  return {
    unmount() {
      root.unmount();
      surface.replaceChildren();
    },
    getQueryRoot() {
      return host.shadowRoot ?? host;
    },
  };
};

const mountReactBenchmark = (surface: HTMLElement): BenchMountController => {
  surface.replaceChildren();
  const root = createReactRoot(surface);
  root.render(createReactElement(ReactBenchmarkComponent, {}));

  return {
    unmount() {
      root.unmount();
      surface.replaceChildren();
    },
    getQueryRoot() {
      return surface;
    },
  };
};

const mountVueBenchmark = (surface: HTMLElement): BenchMountController => {
  surface.replaceChildren();
  const app: VueApp = createApp(BenchmarkVue);
  app.mount(surface);

  return {
    unmount() {
      app.unmount();
      surface.replaceChildren();
    },
    getQueryRoot() {
      return surface;
    },
  };
};

const mountSolidBenchmark = (surface: HTMLElement): BenchMountController => {
  surface.replaceChildren();
  const dispose = renderSolid(() => BenchmarkSolid(), surface);

  return {
    unmount() {
      dispose();
      surface.replaceChildren();
    },
    getQueryRoot() {
      return surface;
    },
  };
};

const targetRegistry: Record<BenchTargetId, BenchTargetEntry> = {
  'lania-fc': {
    framework: 'lania-v',
    variant: 'fc',
    label: 'Lania FC',
    mount(surface) {
      return mountLaniaBenchmark(surface, BenchmarkFc);
    },
  },
  react: {
    framework: 'react',
    variant: null,
    label: 'React',
    mount: mountReactBenchmark,
  },
  vue: {
    framework: 'vue',
    variant: null,
    label: 'Vue',
    mount: mountVueBenchmark,
  },
  solid: {
    framework: 'solid',
    variant: null,
    label: 'Solid',
    mount: mountSolidBenchmark,
  },
};

const app = document.querySelector('#app');

if (!app) {
  throw new Error('Benchmark playground root container was not found.');
}

app.innerHTML = `
  <style>
    .bench-shell {
      max-width: 1320px;
      margin: 0 auto;
      padding: 24px;
    }

    .bench-page-header {
      margin-bottom: 18px;
    }

    .bench-page-header h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0.3px;
    }

    .bench-page-header p {
      margin: 0;
      color: rgba(255, 255, 255, 0.72);
      max-width: 960px;
    }

    .bench-page-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin: 18px 0;
    }

    .bench-target-group,
    .bench-action-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 8px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 14px 44px rgba(0, 0, 0, 0.2);
    }

    .bench-chip,
    .bench-page-btn {
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.92);
      padding: 8px 12px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      transition: background 140ms ease, border-color 140ms ease, transform 70ms ease;
    }

    .bench-page-btn {
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95));
      box-shadow: 0 10px 26px rgba(124, 58, 237, 0.22);
    }

    .bench-chip[aria-pressed="true"] {
      background: rgba(139, 92, 246, 0.18);
      border-color: rgba(139, 92, 246, 0.55);
    }

    .bench-chip:hover,
    .bench-page-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .bench-page-btn:hover {
      filter: brightness(1.05);
    }

    .bench-chip:active,
    .bench-page-btn:active {
      transform: translateY(1px);
    }

    .bench-chip:disabled,
    .bench-page-btn:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
    }

    .bench-status {
      min-height: 20px;
      color: rgba(255, 255, 255, 0.72);
      font-size: 13px;
      margin: 0 0 18px;
    }

    .bench-surface-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(360px, 0.95fr);
      gap: 18px;
      align-items: start;
    }

    .bench-surface-card {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.05));
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 14px 44px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px);
    }

    .bench-surface-card h2 {
      margin: 0 0 8px;
      font-size: 16px;
    }

    .bench-surface-card p {
      margin: 0 0 12px;
      color: rgba(255, 255, 255, 0.66);
      font-size: 13px;
    }

    .bench-mount-surface {
      min-height: 640px;
      border-radius: 16px;
      padding: 14px;
      background: rgba(3, 7, 18, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .bench-results {
      margin: 0;
      border-radius: 14px;
      background: rgba(3, 7, 18, 0.38);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 14px;
      min-height: 640px;
      overflow: auto;
      color: rgba(255, 255, 255, 0.9);
      font-size: 12px;
      line-height: 1.45;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
        "Courier New", monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .bench-root {
      display: block;
      color: rgba(255, 255, 255, 0.92);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .bench-header h2,
    .bench-meta,
    .bench-note,
    .bench-panel {
      margin: 0;
    }

    .bench-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }

    .bench-card {
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      padding: 12px;
    }

    .bench-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .bench-btn {
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95));
      color: rgba(255, 255, 255, 0.92);
      padding: 8px 12px;
      border-radius: 12px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }

    .bench-output {
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 7px 10px;
      font-size: 12px;
      min-width: 56px;
    }

    .bench-output-wide {
      min-width: 180px;
    }

    .bench-input {
      min-width: 200px;
      flex: 1;
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.04);
      color: rgba(255, 255, 255, 0.92);
      font: inherit;
    }

    .bench-note,
    .bench-panel {
      margin-top: 10px;
      color: rgba(255, 255, 255, 0.72);
      font-size: 12px;
    }

    @media (max-width: 1080px) {
      .bench-surface-grid,
      .bench-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
  <main class="bench-shell">
    <header class="bench-page-header">
      <h1>Framework Benchmark</h1>
      <p>
        这套 benchmark 在真实浏览器里用同一套 runner 比较 Lania TSX、React、Vue、Solid。
        所有实现共享同样的操作序列、同样的数据量和同样的结果 schema。
      </p>
    </header>

    <div class="bench-page-toolbar">
      <div class="bench-target-group" aria-label="target selector">
        <button class="bench-chip" data-page-target="lania-fc" type="button">Lania TSX</button>
        <button class="bench-chip" data-page-target="react" type="button">React</button>
        <button class="bench-chip" data-page-target="vue" type="button">Vue</button>
        <button class="bench-chip" data-page-target="solid" type="button">Solid</button>
      </div>
      <div class="bench-action-group">
        <button class="bench-page-btn" data-page-action="remount" type="button">Remount Current</button>
        <button class="bench-page-btn" data-page-action="run-suite" type="button">Run Current Suite</button>
      </div>
    </div>

    <p class="bench-status" data-page-status="idle">Ready.</p>

    <section class="bench-surface-grid">
      <article class="bench-surface-card">
        <h2>Mounted Target</h2>
        <p>当前面板会挂载真实 benchmark 组件，runner 会直接在这里执行 DOM 操作。</p>
        <div class="bench-mount-surface" data-page-mount></div>
      </article>

      <article class="bench-surface-card">
        <h2>Latest Result</h2>
        <p>Playwright runner 会把综合结果写入 <code>test-results/benchmark/latest.json</code>。</p>
        <pre class="bench-results" data-page-results>No benchmark run yet.</pre>
      </article>
    </section>
  </main>
`;

const mountSurface = app.querySelector('[data-page-mount]') as HTMLElement | null;
const statusNode = app.querySelector('[data-page-status]') as HTMLElement | null;
const resultsNode = app.querySelector('[data-page-results]') as HTMLElement | null;
const targetButtons = Array.from(app.querySelectorAll<HTMLButtonElement>('[data-page-target]'));
const runButton = app.querySelector<HTMLButtonElement>('[data-page-action="run-suite"]');
const remountButton = app.querySelector<HTMLButtonElement>('[data-page-action="remount"]');

if (!mountSurface || !statusNode || !resultsNode || !runButton || !remountButton) {
  throw new Error('Benchmark playground UI failed to initialize.');
}

let currentTarget: BenchTargetId = resolveTarget(new URLSearchParams(window.location.search).get('target'));
let currentMount: BenchMountController | null = null;
let running = false;

const setStatus = (message: string) => {
  statusNode.textContent = message;
};

const setButtonsDisabled = (disabled: boolean) => {
  running = disabled;
  runButton.disabled = disabled;
  remountButton.disabled = disabled;
  targetButtons.forEach((button) => {
    button.disabled = disabled;
  });
};

const syncTargetUi = () => {
  targetButtons.forEach((button) => {
    const active = button.dataset.pageTarget === currentTarget;
    button.setAttribute('aria-pressed', String(active));
  });
};

const updateUrl = () => {
  const url = new URL(window.location.href);
  url.searchParams.set('target', currentTarget);
  window.history.replaceState({}, '', url);
};

const teardownCurrentMount = () => {
  currentMount?.unmount();
  currentMount = null;
  mountSurface.replaceChildren();
};

const mountCurrentTarget = (): BenchMountController => {
  teardownCurrentMount();
  currentMount = targetRegistry[currentTarget].mount(mountSurface);
  return currentMount;
};

const getBenchContainer = (): ParentNode | null => {
  return currentMount?.getQueryRoot() ?? null;
};

const nextTick = async (): Promise<void> => {
  await new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
};

async function waitFor<T>(
  read: () => T | null | undefined | false,
  label: string,
  timeoutMs = 5_000
): Promise<T> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const value = read();
    if (value) {
      return value;
    }
    await nextTick();
  }

  throw new Error(`Timed out while waiting for ${label}.`);
}

function queryBench<T extends Element = Element>(selector: string): T | null {
  return (getBenchContainer()?.querySelector(selector) as T | null) ?? null;
}

const readText = (selector: string): string => {
  return queryBench(selector)?.textContent?.trim() ?? '';
};

const hasBenchNode = (selector: string): boolean => {
  return Boolean(queryBench(selector));
};

const ensureMounted = async (): Promise<void> => {
  if (!currentMount) {
    mountCurrentTarget();
  }

  await waitFor(() => getBenchContainer(), 'component render container');
  await waitFor(
    () =>
      queryBench('[data-bench-root="ready"]') ??
      queryBench('.bench-root') ??
      queryBench('[data-bench-output="patch-version"]'),
    'bench root'
  );
};

const clickBenchAction = (name: 'increment' | 'patch' | 'toggle') => {
  const button = queryBench<HTMLButtonElement>(`[data-bench-action="${name}"]`);
  if (!button) {
    throw new Error(`Benchmark action button "${name}" was not found.`);
  }
  button.click();
};

const setModelInputValue = (value: string) => {
  const input = queryBench<HTMLInputElement>('[data-bench-input="model"]');
  if (!input) {
    throw new Error('Benchmark model input was not found.');
  }

  input.value = value;
  input.dispatchEvent(
    new Event('input', {
      bubbles: true,
      composed: true,
    })
  );
};

const runMountSample = async (operationsPerSample: number): Promise<number> => {
  let totalMs = 0;

  for (let index = 0; index < operationsPerSample; index += 1) {
    teardownCurrentMount();
    const start = performance.now();
    mountCurrentTarget();
    await ensureMounted();
    totalMs += performance.now() - start;
  }

  return totalMs;
};

const runTextUpdateSample = async (operationsPerSample: number): Promise<number> => {
  await ensureMounted();
  const startValue = Number(readText('[data-bench-output="count"]'));
  const expectedValue = startValue + operationsPerSample;
  const start = performance.now();

  for (let index = 0; index < operationsPerSample; index += 1) {
    clickBenchAction('increment');
  }

  await waitFor(
    () => (readText('[data-bench-output="count"]') === String(expectedValue) ? true : null),
    'text update'
  );
  return performance.now() - start;
};

const runListPatchSample = async (operationsPerSample: number): Promise<number> => {
  await ensureMounted();
  const startVersion = Number(readText('[data-bench-output="patch-version"]'));
  const expectedVersion = startVersion + operationsPerSample;
  const expectedMiddleText = `Item ${BENCH_MIDDLE_ROW_ID} v${expectedVersion}|${expectedVersion % 2 === 1 ? '1' : '0'}`;
  const start = performance.now();

  for (let index = 0; index < operationsPerSample; index += 1) {
    clickBenchAction('patch');
  }

  await waitFor(
    () => {
      const versionReady = readText('[data-bench-output="patch-version"]') === String(expectedVersion);
      const middleSnapshot = readText('[data-bench-output="middle-row"]');
      const middleRowText = readText(`[data-bench-row-id="${BENCH_MIDDLE_ROW_ID}"]`);
      return versionReady &&
        middleSnapshot === expectedMiddleText &&
        middleRowText === expectedMiddleText
        ? true
        : null;
    },
    'list patch'
  );
  return performance.now() - start;
};

const runToggleSample = async (operationsPerSample: number): Promise<number> => {
  await ensureMounted();
  const startState = readText('[data-bench-output="toggle-state"]');
  const expectedState = operationsPerSample % 2 === 0 ? startState : startState === 'visible' ? 'hidden' : 'visible';
  const start = performance.now();

  for (let index = 0; index < operationsPerSample; index += 1) {
    clickBenchAction('toggle');
  }

  await waitFor(
    () => {
      const stateReady = readText('[data-bench-output="toggle-state"]') === expectedState;
      const panelVisible = hasBenchNode('[data-bench-output="toggle-panel"]');
      return stateReady && panelVisible === (expectedState === 'visible') ? true : null;
    },
    'toggle state'
  );
  return performance.now() - start;
};

const runModelInputSample = async (sampleIndex: number, operationsPerSample: number): Promise<number> => {
  await ensureMounted();
  const lastValue = `payload-${sampleIndex}-${operationsPerSample - 1}`;
  const start = performance.now();

  for (let index = 0; index < operationsPerSample; index += 1) {
    setModelInputValue(`payload-${sampleIndex}-${index}`);
  }

  await waitFor(
    () => (readText('[data-bench-output="draft"]') === lastValue ? true : null),
    'model input sync'
  );
  return performance.now() - start;
};

const summarizeSamples = (
  name: BenchCaseName,
  sampleCount: number,
  warmupSamples: number,
  operationsPerSample: number,
  batchSamples: number[]
): BenchCaseResult => {
  const perOperationSamples = batchSamples.map((value) => value / operationsPerSample);
  const sortedPerOp = [...perOperationSamples].sort((left, right) => left - right);
  const sortedBatch = [...batchSamples].sort((left, right) => left - right);
  const perOpTotal = perOperationSamples.reduce((sum, value) => sum + value, 0);
  const batchTotal = batchSamples.reduce((sum, value) => sum + value, 0);

  const pickP95 = (values: number[]) => values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;

  return {
    name,
    sampleCount,
    warmupSamples,
    operationsPerSample,
    minMs: roundMetric(sortedPerOp[0] ?? 0),
    maxMs: roundMetric(sortedPerOp[sortedPerOp.length - 1] ?? 0),
    meanMs: roundMetric(perOpTotal / Math.max(1, perOperationSamples.length)),
    medianMs: roundMetric(sortedPerOp[Math.floor(sortedPerOp.length / 2)] ?? 0),
    p95Ms: roundMetric(pickP95(sortedPerOp)),
    batchMeanMs: roundMetric(batchTotal / Math.max(1, batchSamples.length)),
    batchMedianMs: roundMetric(sortedBatch[Math.floor(sortedBatch.length / 2)] ?? 0),
    batchP95Ms: roundMetric(pickP95(sortedBatch)),
    samplesMs: perOperationSamples.map(roundMetric),
    sampleBatchMs: batchSamples.map(roundMetric),
  };
};

const runCase = async (name: BenchCaseName): Promise<BenchCaseResult> => {
  const config = CASE_CONFIG[name];
  const batchSamples: number[] = [];
  setStatus(
    `Running ${targetRegistry[currentTarget].label} / ${name} (warmup ${config.warmupSamples}, samples ${config.sampleCount}, ops ${config.operationsPerSample})`
  );

  for (let sampleIndex = 0; sampleIndex < config.warmupSamples; sampleIndex += 1) {
    if (name === 'mount') {
      await runMountSample(config.operationsPerSample);
    } else if (name === 'text-update') {
      await runTextUpdateSample(config.operationsPerSample);
    } else if (name === 'list-patch') {
      await runListPatchSample(config.operationsPerSample);
    } else if (name === 'toggle') {
      await runToggleSample(config.operationsPerSample);
    } else {
      await runModelInputSample(sampleIndex, config.operationsPerSample);
    }
  }

  for (let sampleIndex = 0; sampleIndex < config.sampleCount; sampleIndex += 1) {
    let batchMs = 0;
    if (name === 'mount') {
      batchMs = await runMountSample(config.operationsPerSample);
    } else if (name === 'text-update') {
      batchMs = await runTextUpdateSample(config.operationsPerSample);
    } else if (name === 'list-patch') {
      batchMs = await runListPatchSample(config.operationsPerSample);
    } else if (name === 'toggle') {
      batchMs = await runToggleSample(config.operationsPerSample);
    } else {
      batchMs = await runModelInputSample(sampleIndex + config.warmupSamples, config.operationsPerSample);
    }
    batchSamples.push(batchMs);
  }

  return summarizeSamples(
    name,
    config.sampleCount,
    config.warmupSamples,
    config.operationsPerSample,
    batchSamples
  );
};

const runBenchSuite = async (options: RunBenchSuiteOptions = {}): Promise<BenchSuiteResult> => {
  const target = resolveTarget(options.target ?? currentTarget);
  if (target !== currentTarget) {
    currentTarget = target;
    syncTargetUi();
    updateUrl();
  }

  setButtonsDisabled(true);
  try {
    mountCurrentTarget();
    await ensureMounted();

    const cases = options.cases?.length ? options.cases : DEFAULT_CASE_ORDER;
    const results: BenchCaseResult[] = [];

    for (const name of cases) {
      results.push(await runCase(name));
    }

    const meta = targetRegistry[currentTarget];
    const payload: BenchSuiteResult = {
      framework: meta.framework,
      target: currentTarget,
      variant: meta.variant,
      label: meta.label,
      generatedAt: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: navigator.deviceMemory ?? null,
      cases: results,
    };

    resultsNode.textContent = JSON.stringify(payload, null, 2);
    setStatus(`Completed ${meta.label} benchmark.`);
    return payload;
  } finally {
    setButtonsDisabled(false);
  }
};

window.runBenchSuite = runBenchSuite;

targetButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    if (running) {
      return;
    }

    currentTarget = resolveTarget(button.dataset.pageTarget);
    syncTargetUi();
    updateUrl();
    mountCurrentTarget();
    await ensureMounted();
    setStatus(`Mounted ${targetRegistry[currentTarget].label} benchmark component.`);
  });
});

remountButton.addEventListener('click', async () => {
  if (running) {
    return;
  }

  mountCurrentTarget();
  await ensureMounted();
  setStatus(`Remounted ${targetRegistry[currentTarget].label} benchmark component.`);
});

runButton.addEventListener('click', async () => {
  if (running) {
    return;
  }

  const payload = await runBenchSuite({ target: currentTarget });
  console.log('[framework-benchmark]', payload);
});

syncTargetUi();
mountCurrentTarget();
void ensureMounted().then(() => {
  setStatus(`Mounted ${targetRegistry[currentTarget].label} benchmark component.`);
});

function resolveTarget(value: string | null | undefined): BenchTargetId {
  switch (value) {
    case 'react':
    case 'vue':
    case 'solid':
      return value;
    default:
      return 'lania-fc';
  }
}
