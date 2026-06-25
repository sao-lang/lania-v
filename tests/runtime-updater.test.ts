// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { Scheduler } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime';
import { SlotTable } from '@lania-v/runtime';
import { IfSlot, TextSlot } from '@lania-v/runtime';
import {
  ConditionUpdater,
  EffectUpdater,
  MultiSlotUpdater,
  SimpleUpdater,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 1): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

describe('SimpleUpdater', () => {
  it('writes computed output into its slot', () => {
    const slot = new TextSlot(document.createTextNode(''), 0);
    const updater = new SimpleUpdater(() => 'value', slot);

    updater.run();

    expect(slot.node.data).toBe('value');
  });

  it('attaches to signals and reacts through the scheduler', async () => {
    const scheduler = new Scheduler();
    const signal = createSignal(1, scheduler);
    const slot = new TextSlot(document.createTextNode(''), 0);
    const updater = new SimpleUpdater(() => signal(), slot);

    updater.deps.add(signal);
    updater.attach();
    signal.set(5);
    await flushMicrotasks();

    expect(slot.node.data).toBe('5');

    updater.detach();
    signal.set(9);
    await flushMicrotasks();

    expect(slot.node.data).toBe('5');
  });

  it('tracks dirty bits with slot table and clears them after run', async () => {
    const scheduler = new Scheduler();
    const signal = createSignal(1, scheduler);
    const slot = new TextSlot(document.createTextNode(''), 0);
    const slotTable = new SlotTable();
    slotTable.register(slot);
    const updater = new SimpleUpdater(() => signal(), slot, 'normal', scheduler, slotTable);

    updater.deps.add(signal);
    updater.attach();
    signal.set(2);
    await flushMicrotasks();

    expect(slot.node.data).toBe('2');
    expect(updater.dirty).toBe(false);
    expect(slotTable.isDirty(0)).toBe(false);
  });
});

describe('MultiSlotUpdater', () => {
  it('writes one computed value into multiple slots', () => {
    const first = new TextSlot(document.createTextNode(''), 0);
    const second = new TextSlot(document.createTextNode(''), 1);
    const updater = new MultiSlotUpdater(() => 'shared', [first, second]);

    updater.run();

    expect(first.node.data).toBe('shared');
    expect(second.node.data).toBe('shared');
  });
});

describe('ConditionUpdater', () => {
  it('commits boolean conditions into IfSlot', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('if');
    host.appendChild(anchor);
    const slot = new IfSlot(
      anchor,
      () => {
        const span = document.createElement('span');
        span.textContent = 'Ready';
        return span;
      },
      0
    );
    const updater = new ConditionUpdater(() => true, slot);

    updater.run();
    expect(host.textContent).toBe('Ready');
  });
});

describe('EffectUpdater', () => {
  it('runs as an effect-tail updater through scheduler', async () => {
    const scheduler = new Scheduler();
    const calls: string[] = [];
    const signal = createSignal(0, scheduler);
    const updater = new EffectUpdater(() => {
      calls.push(`effect:${signal()}`);
    }, 'low', scheduler);

    updater.deps.add(signal);
    updater.attach();
    signal.set(3);
    await flushMicrotasks();

    expect(calls).toEqual(['effect:3']);
  });
});
