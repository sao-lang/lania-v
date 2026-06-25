// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  AttrSlot,
  ComponentSlot,
  EventSlot,
  PropSlot,
  ReactiveElement,
  RefSlot,
  SimpleUpdater,
  createContext,
  createRef,
  createSignal,
  provideContext,
  consumeContext,
  setRef,
  type Signal,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 2): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const CommunicationChildElement = (() => {
  const existing = customElements.get('x-communication-child');

  if (existing) {
    return existing as typeof ReactiveElement;
  }

  class CommunicationChildElementImpl extends ReactiveElement {
    static observedAttributes = ['label', 'count'];
    private readonly _label = createSignal('');
    private readonly _count = createSignal(0);

    get label(): Signal<string> {
      return this._label;
    }

    set label(value: unknown) {
      this._label.set(value == null ? '' : String(value));
    }

    get count(): Signal<number> {
      return this._count;
    }

    set count(value: unknown) {
      this._count.set(typeof value === 'number' ? value : Number(value ?? 0));
    }

    attributeChangedCallback(
      name: string,
      _oldValue: string | null,
      newValue: string | null
    ): void {
      if (name === 'label') {
        this.label = newValue ?? '';
        return;
      }

      if (name === 'count') {
        this.count = newValue === null ? 0 : Number(newValue);
      }
    }

    protected _renderAndMount(): void {
      this.renderRoot.appendChild(document.createElement('div'));
    }

    notify(): void {
      this.emit('toggle', {
        label: this.label(),
        count: this.count(),
      });
    }
  }

  customElements.define('x-communication-child', CommunicationChildElementImpl);
  return CommunicationChildElementImpl;
})();

describe('communication runtime', () => {
  it('supports static and dynamic props from parent to child', async () => {
    expect(customElements.get('x-communication-child')).toBe(
      CommunicationChildElement
    );

    const container = document.createElement('div');
    const anchor = document.createComment('component');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const slot = new ComponentSlot(
      anchor,
      () =>
        document.createElement(
          'x-communication-child'
        ) as InstanceType<typeof CommunicationChildElement>,
      0
    );

    slot.write({
      label: 'static-label',
      count: 1,
    });
    await flushMicrotasks();

    expect(slot.instance?.label()).toBe('static-label');
    expect(slot.instance?.count()).toBe(1);

    const labelSignal = createSignal('dynamic-a');
    const countSignal = createSignal(2);
    const updater = new SimpleUpdater(
      () => ({
        label: labelSignal(),
        count: countSignal(),
      }),
      slot
    );

    updater.deps.add(labelSignal);
    updater.deps.add(countSignal);
    updater.attach();
    updater.run();

    expect(slot.instance?.label()).toBe('dynamic-a');
    expect(slot.instance?.count()).toBe(2);

    labelSignal.set('dynamic-b');
    countSignal.set(3);
    await flushMicrotasks();

    expect(slot.instance?.label()).toBe('dynamic-b');
    expect(slot.instance?.count()).toBe(3);
  });

  it('maps attributes to child properties and signalized props', async () => {
    const child = document.createElement(
      'x-communication-child'
    ) as InstanceType<typeof CommunicationChildElement>;

    document.body.appendChild(child);
    await flushMicrotasks();

    const propSlot = new PropSlot(child, 'label', 0);
    propSlot.write('from-prop-slot');
    expect(child.label()).toBe('from-prop-slot');

    const attrSlot = new AttrSlot(child, 'count', 1);
    attrSlot.write(9);
    expect(child.count()).toBe(9);
  });

  it('supports custom event emit and parent listeners', async () => {
    const wrapper = document.createElement('div');
    const child = document.createElement(
      'x-communication-child'
    ) as InstanceType<typeof CommunicationChildElement>;
    const received: Array<{ label: string; count: number }> = [];
    const bubbled: Event[] = [];

    wrapper.addEventListener('toggle', (event) => {
      bubbled.push(event);
    });
    wrapper.appendChild(child);
    document.body.appendChild(wrapper);
    await flushMicrotasks();

    child.label.set('ready');
    child.count.set(7);

    const eventSlot = new EventSlot(child, 'toggle', 0);
    eventSlot.write((event) => {
      const customEvent = event as CustomEvent<{ label: string; count: number }>;
      received.push(customEvent.detail);
    });

    child.notify();

    expect(received).toEqual([{ label: 'ready', count: 7 }]);
    expect(bubbled).toHaveLength(1);
    expect((bubbled[0] as CustomEvent).bubbles).toBe(true);
    expect((bubbled[0] as CustomEvent).composed).toBe(true);
  });

  it('supports context lookup and ref binding', async () => {
    const themeContext = createContext('light', 'theme');
    const provider = document.createElement('section');
    const child = document.createElement('div');
    const domRef = createRef<HTMLDivElement>();
    const componentRef =
      createRef<InstanceType<typeof CommunicationChildElement>>();

    provider.appendChild(child);
    document.body.appendChild(provider);

    const cleanup = provideContext(provider, themeContext, 'dark');
    expect(consumeContext(child, themeContext)()).toBe('dark');
    cleanup();
    expect(consumeContext(child, themeContext)()).toBe('light');

    const domRefSlot = new RefSlot<HTMLDivElement>(child, 0);
    domRefSlot.write(domRef);
    await flushMicrotasks();
    expect(domRef.current).toBe(child);

    const component = document.createElement(
      'x-communication-child'
    ) as InstanceType<typeof CommunicationChildElement>;
    document.body.appendChild(component);
    await flushMicrotasks();

    const componentRefSlot = new RefSlot<InstanceType<typeof CommunicationChildElement>>(
      component,
      1
    );
    componentRefSlot.write(componentRef);
    await flushMicrotasks();
    expect(componentRef.current).toBe(component);

    componentRefSlot.destroy();
    domRefSlot.destroy();
    await flushMicrotasks();
    expect(componentRef.current).toBeNull();
    expect(domRef.current).toBeNull();
  });

  it('supports generic handle refs for non-DOM targets', () => {
    const handleRef = createRef<{ focus(): string }>();
    const handle = {
      focus() {
        return 'focused';
      },
    };

    setRef(handleRef, handle);
    expect(handleRef.current?.focus()).toBe('focused');

    setRef(handleRef, null);
    expect(handleRef.current).toBeNull();
  });
});
