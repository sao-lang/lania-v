// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  EventSlot,
  disableEventDelegation,
  enableEventDelegation,
  parseEventBindingName,
  withEventHint,
  withEventModifiers,
} from '@lania-v/runtime';

describe('runtime events', () => {
  it('parses DOM events, component events, and modifiers', () => {
    expect(parseEventBindingName('click.stop.prevent')).toEqual({
      kind: 'dom-event',
      sourceName: 'click.stop.prevent',
      eventName: 'click',
      modifiers: ['stop', 'prevent'],
    });

    expect(parseEventBindingName('keydown.enter')).toEqual({
      kind: 'dom-event',
      sourceName: 'keydown.enter',
      eventName: 'keydown',
      modifiers: ['enter'],
    });

    expect(parseEventBindingName('scroll.passive')).toEqual({
      kind: 'dom-event',
      sourceName: 'scroll.passive',
      eventName: 'scroll',
      modifiers: ['passive'],
    });

    expect(parseEventBindingName('keypress.escape.ctrl')).toEqual({
      kind: 'dom-event',
      sourceName: 'keypress.escape.ctrl',
      eventName: 'keypress',
      modifiers: ['key:escape', 'system:ctrl'],
    });

    expect(parseEventBindingName('on:change')).toEqual({
      kind: 'component-event',
      sourceName: 'on:change',
      eventName: 'change',
      modifiers: [],
    });
  });

  it('keeps reserved modifiers off the keyboard-key fallback', () => {
    // 键盘事件上的普通词会被当作键位，但 once/immediate/鼠标键等必须保持原义。
    expect(parseEventBindingName('keydown.immediate')?.modifiers).toEqual(['immediate']);
    expect(parseEventBindingName('keydown.passive')?.modifiers).toEqual(['passive']);
    expect(parseEventBindingName('keydown.right')?.modifiers).toEqual(['button:right']);
    expect(parseEventBindingName('pointerdown.right')?.modifiers).toEqual(['button:right']);
  });

  it('applies stop and prevent modifiers before invoking the handler', () => {
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const handler = vi.fn();
    const event = {
      stopPropagation,
      preventDefault,
    } as unknown as MouseEvent;

    const wrapped = withEventModifiers(handler, ['stop', 'prevent']);
    wrapped?.(event);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('guards key handlers with the enter modifier', () => {
    const handler = vi.fn();
    const wrapped = withEventModifiers(handler, ['enter']);

    wrapped?.(new KeyboardEvent('keydown', { key: 'Escape' }));
    wrapped?.(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBeInstanceOf(KeyboardEvent);
  });

  it('supports self and keyboard/system modifiers in object-style event lowering output', () => {
    const selfHandler = vi.fn();
    const selfWrapped = withEventModifiers(selfHandler, ['self']);
    const currentTarget = document.createElement('button');
    selfWrapped?.({ target: document.createElement('span'), currentTarget } as unknown as Event);
    selfWrapped?.({ target: currentTarget, currentTarget } as unknown as Event);

    const keyHandler = vi.fn();
    const keyWrapped = withEventModifiers(keyHandler, ['key:enter', 'system:ctrl']);
    keyWrapped?.(new KeyboardEvent('keydown', { key: 'Enter' }));
    keyWrapped?.(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true }));
    keyWrapped?.(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));

    expect(selfHandler).toHaveBeenCalledTimes(1);
    expect(keyHandler).toHaveBeenCalledTimes(1);
  });

  it('supports generic key modifiers across all keyboard events', () => {
    const handler = vi.fn();
    const wrapped = withEventModifiers(handler, ['key:escape', 'system:ctrl']);

    wrapped?.(new KeyboardEvent('keypress', { key: 'Enter', ctrlKey: true }));
    wrapped?.(new KeyboardEvent('keypress', { key: 'Escape' }));
    wrapped?.(new KeyboardEvent('keypress', { key: 'Escape', ctrlKey: true }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes listener options through EventSlot', () => {
    const node = document.createElement('button');
    const addSpy = vi.spyOn(node, 'addEventListener');
    const slot = new EventSlot(node, 'click', 3, { once: true, passive: true });

    slot.write(vi.fn());

    expect(addSpy).toHaveBeenCalledWith(
      'click',
      expect.any(Function),
      { once: true, passive: true }
    );

    slot.destroy();
    addSpy.mockRestore();
  });

  it('keeps one stable DOM listener while allowing handler replacement and cleanup', () => {
    const node = document.createElement('button');
    const slot = new EventSlot(node, 'click', 0);
    const first = vi.fn();
    const second = vi.fn();

    slot.write(first);
    node.click();
    slot.write(second);
    node.click();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    slot.destroy();
    node.click();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('supports optional event delegation at the root boundary', () => {
    const host = document.createElement('div');
    const button = document.createElement('button');
    host.appendChild(button);
    document.body.appendChild(host);
    enableEventDelegation(host);

    const slot = new EventSlot(button, 'click', 1);
    const first = vi.fn();
    const second = vi.fn();

    slot.write(first);
    button.click();
    slot.write(second);
    button.click();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    slot.destroy();
    button.click();
    expect(second).toHaveBeenCalledTimes(1);

    disableEventDelegation(host);
    host.remove();
  });

  it('falls back to direct listeners when delegation-compatible options are required', () => {
    const host = document.createElement('div');
    const button = document.createElement('button');
    host.appendChild(button);
    enableEventDelegation(host);

    const addSpy = vi.spyOn(button, 'addEventListener');
    const slot = new EventSlot(button, 'click', 2, { capture: true });
    const handler = vi.fn();

    slot.write(handler);
    button.click();

    expect(addSpy).toHaveBeenCalledWith('click', expect.any(Function), { capture: true });
    expect(handler).toHaveBeenCalledTimes(1);

    slot.destroy();
    disableEventDelegation(host);
    addSpy.mockRestore();
  });

  it('supports once modifiers through the object-style listener options', () => {
    const host = document.createElement('div');
    const button = document.createElement('button');
    host.appendChild(button);

    const handler = vi.fn();
    const slot = new EventSlot(button, 'click', 0, { once: true });
    slot.write(withEventModifiers(handler, []));

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(handler).toHaveBeenCalledTimes(1);
    slot.destroy();
  });

  it('guards prevent with self and immediate scopes', () => {
    const preventAny = vi.fn();
    const preventSelf = vi.fn();
    const immediatePrevent = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const handler = vi.fn();
    const button = document.createElement('button');

    withEventModifiers(handler, ['prevent:immediate'])?.({
      target: button,
      currentTarget: button,
      preventDefault: immediatePrevent,
      stopImmediatePropagation,
    } as unknown as Event);
    expect(immediatePrevent).toHaveBeenCalledTimes(1);
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);

    // 单独的 `prevent` 保持原有行为：任何来源都阻止默认行为。
    withEventModifiers(handler, ['prevent'])?.({
      target: document.createElement('span'),
      currentTarget: button,
      preventDefault: preventAny,
    } as unknown as Event);
    expect(preventAny).toHaveBeenCalledTimes(1);

    // `prevent:self` 只阻止“自己触发”的默认行为；内部元素冒泡上来时不阻止，但仍会调用 handler。
    const selfWrapped = withEventModifiers(handler, ['prevent:self']);
    selfWrapped?.({
      target: document.createElement('span'),
      currentTarget: button,
      preventDefault: preventSelf,
    } as unknown as Event);
    expect(preventSelf).not.toHaveBeenCalled();

    selfWrapped?.({
      target: button,
      currentTarget: button,
      preventDefault: preventSelf,
    } as unknown as Event);
    expect(preventSelf).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('stops the current listener chain with the immediate modifier', () => {
    const order: string[] = [];
    const button = document.createElement('button');
    const stopImmediate = vi.spyOn(button, 'addEventListener');

    const first = withEventModifiers(() => order.push('first'), ['immediate']);
    const second = () => order.push('second');

    button.addEventListener('click', first!);
    button.addEventListener('click', second);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(order).toEqual(['first']);
    stopImmediate.mockRestore();
  });

  it('filters mouse button modifiers', () => {
    const handler = vi.fn();
    const element = document.createElement('button');
    const wrapped = withEventModifiers(handler, ['button:right']);

    wrapped?.(new MouseEvent('contextmenu', { button: 0, bubbles: true }));
    wrapped?.(new MouseEvent('contextmenu', { button: 2, bubbles: true }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(element).toBeTruthy();
  });

  it('debounces and throttles handlers through withEventHint', async () => {
    vi.useFakeTimers();
    try {
      const debounced = vi.fn();
      const debouncedHandler = withEventHint(debounced, 'debounce', [], { debounceMs: 20 })!;
      debouncedHandler(new MouseEvent('input'));
      debouncedHandler(new MouseEvent('input'));
      vi.advanceTimersByTime(20);
      expect(debounced).toHaveBeenCalledTimes(1);

      const throttled = vi.fn();
      const throttledHandler = withEventHint(throttled, 'throttle', [], { throttleMs: 20 })!;
      throttledHandler(new MouseEvent('input'));
      throttledHandler(new MouseEvent('input'));
      expect(throttled).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20);
      expect(throttled).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps modifier filtering active for hinted handlers', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const wrapped = withEventHint(handler, 'debounce', ['prevent'], { debounceMs: 10 })!;
      const preventDefault = vi.fn();

      wrapped({ preventDefault } as unknown as Event);
      vi.advanceTimersByTime(10);

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
