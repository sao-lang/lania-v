// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  EventSlot,
  disableEventDelegation,
  enableEventDelegation,
  parseEventBindingName,
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
});
