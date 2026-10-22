import { createSignal, For } from 'solid-js';

import {
  BENCH_MIDDLE_ROW_INDEX,
  buildBenchItems,
  describeBenchItem,
  patchBenchItems,
} from './benchmarkShared';

export default function BenchmarkSolid() {
  const [count, setCount] = createSignal(0);
  const [items, setItems] = createSignal(buildBenchItems());
  const [patchVersion, setPatchVersion] = createSignal(0);
  const [toggleVisible, setToggleVisible] = createSignal(true);
  const [draft, setDraft] = createSignal('seed');
  const [middleSnapshot, setMiddleSnapshot] = createSignal(
    describeBenchItem(items()[BENCH_MIDDLE_ROW_INDEX])
  );

  const increment = () => {
    setCount((value) => value + 1);
  };

  const patchMiddle = () => {
    const nextVersion = patchVersion() + 1;
    const nextItems = patchBenchItems(items(), nextVersion);
    setItems(nextItems);
    setPatchVersion(nextVersion);
    setMiddleSnapshot(describeBenchItem(nextItems[BENCH_MIDDLE_ROW_INDEX]));
  };

  const toggle = () => {
    setToggleVisible((value) => !value);
  };

  return (
    <section class="bench-root" data-bench-root="ready" data-bench-ready="true">
      <header class="bench-header">
        <h2>Solid benchmark</h2>
        <p class="bench-meta">list size: 1000 | middle row: 501</p>
      </header>

      <div class="bench-grid">
        <div class="bench-card">
          <div class="bench-toolbar">
            <button
              class="bench-btn"
              data-bench-action="increment"
              onClick={increment}
            >
              increment
            </button>
            <output class="bench-output" data-bench-output="count">
              {String(count())}
            </output>
          </div>
          <p class="bench-note">signal update -&gt; text output</p>
        </div>

        <div class="bench-card">
          <div class="bench-toolbar">
            <button
              class="bench-btn"
              data-bench-action="patch"
              onClick={patchMiddle}
            >
              patch middle
            </button>
            <output class="bench-output" data-bench-output="patch-version">
              {String(patchVersion())}
            </output>
            <output
              class="bench-output bench-output-wide"
              data-bench-output="middle-row"
            >
              {middleSnapshot()}
            </output>
          </div>
          <ul class="bench-list" data-bench-list="patch">
            <For each={items()}>
              {(item) => (
                <li
                  class="bench-list-row"
                  data-bench-row-id={String(item.id)}
                  data-bench-row-done={item.done ? 'true' : 'false'}
                >
                  {describeBenchItem(item)}
                </li>
              )}
            </For>
          </ul>
          <p class="bench-note">
            1000-item keyed list patch + middle row verification
          </p>
        </div>

        <div class="bench-card">
          <div class="bench-toolbar">
            <button
              class="bench-btn"
              data-bench-action="toggle"
              onClick={toggle}
            >
              toggle panel
            </button>
            <output class="bench-output" data-bench-output="toggle-state">
              {toggleVisible() ? 'visible' : 'hidden'}
            </output>
          </div>
          {toggleVisible() ? (
            <section class="bench-panel" data-bench-output="toggle-panel">
              <p class="bench-note">mounted conditional subtree</p>
              <p class="bench-meta">panel body: visible</p>
            </section>
          ) : null}
        </div>

        <div class="bench-card">
          <div class="bench-toolbar">
            <input
              class="bench-input"
              data-bench-input="model"
              placeholder="type benchmark payload"
              value={draft()}
              onInput={(event) => {
                const target = event.currentTarget;
                setDraft(target?.value ?? '');
              }}
            />
            <output
              class="bench-output bench-output-wide"
              data-bench-output="draft"
            >
              {draft()}
            </output>
          </div>
          <p class="bench-note">input event -&gt; signal snapshot</p>
        </div>
      </div>
    </section>
  );
}
