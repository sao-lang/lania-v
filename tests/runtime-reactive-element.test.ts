// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  type ChangedProps,
  ReactiveElement,
} from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime';
import {
  AttrSlot,
  ClassSlot,
  StyleSlot,
  TextSlot,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 2): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

class CounterElement extends ReactiveElement {
  static observedAttributes = ['data-label'];

  readonly count = createSignal(0);
  readonly active = createSignal(false);
  private textSlot!: TextSlot;
  private attrSlot!: AttrSlot;
  private styleSlot!: StyleSlot;
  private classSlot!: ClassSlot;
  readonly lifecycle: string[] = [];
  readonly changedPropsLog: Array<Record<string, unknown>> = [];

  protected _renderAndMount(): void {
    const container = document.createElement('div');
    const text = document.createTextNode('');

    this.textSlot = new TextSlot(text, 0);
    this.attrSlot = new AttrSlot(container, 'data-count', 1);
    this.styleSlot = new StyleSlot(container, 'width', 2, 'px');
    this.classSlot = new ClassSlot(container, 'active', 3);
    this.trackSignal(this.count);
    this.trackSignal(this.active);
    this.registerUpdater(() => {
      this.textSlot.write(this.count());
      this.attrSlot.write(this.count());
      this.styleSlot.write(this.count() * 10);
      this.classSlot.write(this.active());
    });

    container.appendChild(text);
    this.renderRoot.appendChild(container);
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    this.requestUpdate(name, oldValue, newValue);
  }

  protected willUpdate(changedProps: ChangedProps): void {
    this.lifecycle.push('willUpdate');
    this.changedPropsLog.push({
      phase: 'willUpdate',
      label: changedProps.get('data-label'),
    });
  }

  protected updated(changedProps: ChangedProps): void {
    this.lifecycle.push('updated');
    this.changedPropsLog.push({
      phase: 'updated',
      label: changedProps.get('data-label'),
    });
  }

  protected firstUpdated(changedProps: ChangedProps): void {
    this.lifecycle.push('firstUpdated');
    this.changedPropsLog.push({
      phase: 'firstUpdated',
      label: changedProps.get('data-label'),
    });
  }
}

if (!customElements.get('x-counter-test')) {
  customElements.define('x-counter-test', CounterElement);
}

describe('ReactiveElement', () => {
  it('mounts once and updates text through the scheduler pipeline', async () => {
    const element = document.createElement('x-counter-test') as CounterElement;

    document.body.appendChild(element);
    await flushMicrotasks();

    expect(element.shadowRoot?.textContent).toBe('0');

    element.count.set(3);
    await flushMicrotasks();

    expect(element.shadowRoot?.textContent).toBe('3');
    const host = element.shadowRoot?.querySelector('div');
    expect(host?.getAttribute('data-count')).toBe('3');
    expect((host as HTMLDivElement | null)?.style.getPropertyValue('width')).toBe(
      '30px'
    );
    expect(element.lifecycle).toEqual([
      'willUpdate',
      'updated',
      'firstUpdated',
      'willUpdate',
      'updated',
    ]);
  });

  it('stops committing DOM updates after disconnect', async () => {
    const element = document.createElement('x-counter-test') as CounterElement;

    document.body.appendChild(element);
    await flushMicrotasks();
    document.body.removeChild(element);

    element.count.set(7);
    await flushMicrotasks();

    expect(element.shadowRoot?.textContent).toBe('0');
  });

  it('records changedProps with previous and current values', async () => {
    const element = document.createElement('x-counter-test') as CounterElement;

    document.body.appendChild(element);
    await flushMicrotasks();
    element.setAttribute('data-label', 'alpha');
    element.setAttribute('data-label', 'beta');
    await flushMicrotasks();

    const willUpdate = element.changedPropsLog.find(
      (entry) => entry.phase === 'willUpdate' && entry.label
    ) as
      | { label?: { previous: unknown; current: unknown } }
      | undefined;

    expect(willUpdate?.label).toEqual({
      previous: null,
      current: 'beta',
    });
  });

  it('toggles class slot through the update pipeline', async () => {
    const element = document.createElement('x-counter-test') as CounterElement;

    document.body.appendChild(element);
    await flushMicrotasks();
    element.active.set(true);
    await flushMicrotasks();

    expect(
      element.shadowRoot?.querySelector('div')?.classList.contains('active')
    ).toBe(true);
  });
});
