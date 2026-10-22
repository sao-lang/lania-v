import { createSignal, defineComponent } from '@lania-v/runtime';
import { Each, When } from '@lania-v/advanced';

import {
  type BenchItem,
  BENCH_MIDDLE_ROW_INDEX,
  buildBenchItems,
  describeBenchItem,
  patchBenchItems,
} from './benchmarkShared';

export default defineComponent(function BenchmarkFc() {
  const eachItemKey = ((item: BenchItem) => item.id) as never;
  const count = createSignal(0);
  const items = createSignal(buildBenchItems());
  const patchVersion = createSignal(0);
  const toggleVisible = createSignal(true);
  const draft = createSignal('seed');
  const middleSnapshot = createSignal(
    describeBenchItem(items.value[BENCH_MIDDLE_ROW_INDEX])
  );

  const increment = () => {
    count.set((value) => value + 1);
  };

  const patchMiddle = () => {
    const nextVersion = patchVersion.value + 1;
    const nextItems = patchBenchItems(items.value, nextVersion);
    const middle = nextItems[BENCH_MIDDLE_ROW_INDEX];

    items.set(nextItems);
    patchVersion.set(nextVersion);
    middleSnapshot.set(describeBenchItem(middle));
  };

  const toggle = () => {
    toggleVisible.set((value) => !value);
  };

  return (
    <section
      className="bench-root"
      data-bench-root="ready"
      data-bench-ready="true"
    >
      <header className="bench-header">
        <h2>lania-v FC benchmark</h2>
        <p className="bench-meta">list size: 1000 | middle row: 501</p>
      </header>

      <div className="bench-grid">
        <div className="bench-card">
          <div className="bench-toolbar">
            <button
              className="bench-btn"
              data-bench-action="increment"
              onClick={increment}
            >
              increment
            </button>
            <output className="bench-output" data-bench-output="count">
              {String(count.value)}
            </output>
          </div>
          <p className="bench-note">signal update to text slot</p>
        </div>

        <div className="bench-card">
          <div className="bench-toolbar">
            <button
              className="bench-btn"
              data-bench-action="patch"
              onClick={patchMiddle}
            >
              patch middle
            </button>
            <output className="bench-output" data-bench-output="patch-version">
              {String(patchVersion.value)}
            </output>
            <output
              className="bench-output bench-output-wide"
              data-bench-output="middle-row"
            >
              {middleSnapshot.value}
            </output>
          </div>
          <ul className="bench-list" data-bench-list="patch">
            <Each value={items.value} key={eachItemKey}>
              {(item): any => (
                <li
                  className="bench-list-row"
                  data-bench-row-id={String(item.id)}
                  data-bench-row-done={item.done ? 'true' : 'false'}
                >
                  {describeBenchItem(item)}
                </li>
              )}
            </Each>
          </ul>
          <p className="bench-note">
            1000-item keyed list patch + middle row verification
          </p>
        </div>

        <div className="bench-card">
          <div className="bench-toolbar">
            <button
              className="bench-btn"
              data-bench-action="toggle"
              onClick={toggle}
            >
              toggle panel
            </button>
            <output className="bench-output" data-bench-output="toggle-state">
              {toggleVisible.value ? 'visible' : 'hidden'}
            </output>
          </div>
          <When value={toggleVisible.value}>
            <section className="bench-panel" data-bench-output="toggle-panel">
              <p className="bench-note">mounted conditional subtree</p>
              <p className="bench-meta">panel body: visible</p>
            </section>
          </When>
        </div>

        <div className="bench-card">
          <div className="bench-toolbar">
            <input
              className="bench-input"
              data-bench-input="model"
              model={{ target: draft }}
              placeholder="type benchmark payload"
            />
            <output
              className="bench-output bench-output-wide"
              data-bench-output="draft"
            >
              {draft.value}
            </output>
          </div>
          <p className="bench-note">
            input event to model binding to text slot
          </p>
        </div>
      </div>
    </section>
  );
});
