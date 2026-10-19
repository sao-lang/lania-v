// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  ReactiveElement,
  SimpleUpdater,
  Slot,
  TextSlot,
  bindSlots,
  createSelector,
  createEffect,
  createMemo,
  createScope,
  createSignal,
  createStore,
  createUniqueId,
  defineComponent,
  emitDevtoolsEvent,
  produce,
  renderToStream,
  renderToString,
  startTransition,
  tick,
  transitionPending,
} from '@lania-v/runtime';
import { jsx } from '../packages/runtime/src/entry/jsx-runtime';
import { installDevtoolsOverlay } from '../packages/runtime/src/core/devtools';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

describe('runtime primitives', () => {
  it('discovers signal dependencies on the first updater run', async () => {
    class DynamicDepsElement extends ReactiveElement {
      static tagName = 'dynamic-deps-element';

      readonly count = (() => createSignal(0))();

      protected _renderAndMount(): void {
        const node = document.createTextNode('');
        this.renderRoot.appendChild(node);
        const slot = this.registerSlot(new TextSlot(node, 0));
        const updater = new SimpleUpdater(
          () => String(this.count()),
          slot,
          'normal',
          this._scheduler,
          this._slotTable
        );
        // 故意不调用 deps.add：模拟 composable 返回的 signal，
        // 依赖由首轮 run 的动态追踪补齐。
        this.registerRuntimeUpdater(updater);
        updater.run();
      }
    }

    customElements.define('dynamic-deps-element', DynamicDepsElement);
    const element = document.createElement('dynamic-deps-element') as DynamicDepsElement;
    document.body.appendChild(element);
    await flush();
    expect(element.shadowRoot?.textContent).toBe('0');

    element.count.set(1);
    await flush();
    expect(element.shadowRoot?.textContent).toBe('1');
    element.remove();
  });

  it('createSelector only flips the keys whose selection changed', async () => {
    const selected = createSignal('a');
    const isSelected = createSelector(selected);

    expect(isSelected('a')).toBe(true);
    expect(isSelected('b')).toBe(false);

    selected.set('b');
    await tick();
    await flush();

    expect(isSelected('a')).toBe(false);
    expect(isSelected('b')).toBe(true);
    isSelected.dispose();
  });

  it('startTransition exposes pending until the low-priority update flushes', async () => {
    expect(transitionPending()).toBe(false);
    const value = createSignal(0);

    startTransition(() => value.set(1));
    expect(transitionPending()).toBe(true);

    await tick();
    await flush();

    expect(value()).toBe(1);
    expect(transitionPending()).toBe(false);
  });

  it('produce applies mutable updates to a store', () => {
    const state = createStore({ list: [1, 2] });

    produce(state, (draft) => {
      draft.list.push(3);
    });

    expect(state.list).toEqual([1, 2, 3]);
  });

  it('passes scoped slot args through Slot', () => {
    const Child = defineComponent(() => Slot({ args: 'row-1' }));

    expect(jsx(Child, { children: (value: string) => `render:${value}` })).toBe(
      'render:row-1'
    );
  });

  it('passes scoped slot args through bindSlots().renderDefault()', () => {
    const Child = defineComponent(() => {
      const slots = bindSlots();
      return slots.renderDefault('fallback', 'row-2');
    });

    expect(jsx(Child, { children: (value: string) => `render:${value}` })).toBe(
      'render:row-2'
    );
  });

  it('createScope disposes effects and memos created inside it', async () => {
    const value = createSignal(0);
    let effectRuns = 0;
    const scope = createScope(() => {
      createEffect(() => {
        value();
        effectRuns += 1;
      });
      createMemo(() => value() * 2);
      return value;
    });

    expect(effectRuns).toBe(1);
    scope.dispose();

    value.set(1);
    await tick();
    await flush();

    expect(effectRuns).toBe(1);
  });

  it('devtools overlay highlights slot writes', () => {
    const dispose = installDevtoolsOverlay({ durationMs: 10 });
    const element = document.createElement('div');
    document.body.appendChild(element);

    emitDevtoolsEvent('slot-write', { node: element });
    expect(element.hasAttribute('data-lania-update')).toBe(true);

    dispose();
    element.remove();
  });

  it('createUniqueId returns stable unique ids', () => {
    const first = createUniqueId();
    const second = createUniqueId('field');

    expect(first).not.toBe(second);
    expect(second.startsWith('field-')).toBe(true);
  });

  it('renders compiled-style static SSR methods', async () => {
    class Demo {
      static render(props: Record<string, unknown> = {}): string {
        return `<h1>${String(props.title)}</h1>`;
      }

      static async *renderStream(
        props: Record<string, unknown> = {}
      ): AsyncGenerator<string, void, void> {
        yield '<h1>';
        yield String(props.title);
        yield '</h1>';
      }
    }

    expect(renderToString(Demo, { title: 'hello' })).toBe('<h1>hello</h1>');

    const chunks: string[] = [];
    for await (const chunk of renderToStream(Demo, { title: 'hello' })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('<h1>hello</h1>');
  });
});
