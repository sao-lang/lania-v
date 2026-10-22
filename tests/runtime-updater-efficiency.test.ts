// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  EffectUpdater,
  ReactiveElement,
  Scheduler,
  SimpleUpdater,
  TextSlot,
  createSignal,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

describe('updater scheduling efficiency', () => {
  it('runs a signal-driven updater exactly once per change', async () => {
    const scheduler = new Scheduler();
    const value = createSignal(0, scheduler);
    const slot = new TextSlot(document.createTextNode(''), 0);
    let computes = 0;

    const updater = new SimpleUpdater(
      () => {
        computes += 1;
        return value.value;
      },
      slot,
      'normal',
      scheduler
    );

    updater.deps.add(value);
    updater.attach();
    updater.run();
    expect(computes).toBe(1);

    value.set(1);
    await flushMicrotasks();

    // 同一次 signal.set 不应该产生第二次求值。
    expect(computes).toBe(2);
    updater.detach();
  });

  it('skips slot writes when the computed value is unchanged', () => {
    const slot = new TextSlot(document.createTextNode(''), 0);
    const updater = new SimpleUpdater(() => 'same', slot);
    let writes = 0;
    const originalWrite = slot.write.bind(slot);
    slot.write = (next: unknown) => {
      writes += 1;
      originalWrite(next);
    };

    updater.run();
    updater.run();

    expect(writes).toBe(1);
  });

  it('never short-circuits effects, which have no meaningful return value', () => {
    let runs = 0;
    const effect = new EffectUpdater(() => {
      runs += 1;
    });

    effect.run();
    effect.run();

    expect(runs).toBe(2);
  });

  it('does not double-run component updaters through the component flush path', async () => {
    class EfficiencyElement extends ReactiveElement {
      static tagName = 'efficiency-element';

      readonly value = createSignal(0);

      computes = 0;

      protected _renderAndMount(): void {
        const slot = this.registerSlot(
          new TextSlot(document.createTextNode(''), 0)
        );
        const updater = new SimpleUpdater(
          () => {
            this.computes += 1;
            return this.value.value;
          },
          slot,
          'normal',
          this._scheduler,
          this._slotTable
        );
        updater.deps.add(this.value);
        this.registerRuntimeUpdater(updater);
        updater.run();
      }
    }

    customElements.define('efficiency-element', EfficiencyElement);

    const element = document.createElement(
      'efficiency-element'
    ) as EfficiencyElement;
    document.body.appendChild(element);
    await flushMicrotasks();

    expect(element.computes).toBe(1);

    element.value.set(1);
    await flushMicrotasks();

    // 修复前：signal 直接驱动 + 组件级 requestUpdate 会各自执行一次。
    expect(element.computes).toBe(2);

    element.value.set(2);
    await flushMicrotasks();
    expect(element.computes).toBe(3);

    element.remove();
  });
});
