// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  AttrSlot,
  ClassSlot,
  DirectiveSlot,
  DirectiveBindingSlot,
  ModelBindingSlot,
  ssrSerializeAttribute,
  StyleSlot,
  applyBoundValue,
  clearDirectiveRegistry,
  createModelEventHandler,
  createSignal,
  html,
  registerDirective,
  ssrRenderHtmlSlot,
  setDevEnvironmentOverride,
  UseDirectiveSlot,
} from '@lania-v/runtime';

describe('runtime directives', () => {
  it('warns in dev mode when a named use directive is missing', () => {
    clearDirectiveRegistry();
    setDevEnvironmentOverride(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const node = document.createElement('div');
    const slot = new UseDirectiveSlot(node, 0);

    slot.write({ name: 'missing', value: { content: 'x' } });

    expect(warnSpy).toHaveBeenCalledWith('[lania-v] Directive "missing" is not registered.');
    warnSpy.mockRestore();
    setDevEnvironmentOverride(null);
    clearDirectiveRegistry();
  });

  it('resolves registered use directives by name and passes binding value', () => {
    clearDirectiveRegistry();
    const node = document.createElement('div');
    const mounted = vi.fn();
    const updated = vi.fn();
    const unmounted = vi.fn();

    registerDirective('tooltip', {
      mounted,
      updated,
      unmounted,
    });

    const slot = new UseDirectiveSlot(node, 0);
    slot.write({ name: 'tooltip', value: { content: 'first' } });
    slot.write({ name: 'tooltip', value: { content: 'second' } });
    slot.destroy();

    expect(mounted).toHaveBeenCalledWith(node, { content: 'first' });
    expect(updated).toHaveBeenCalledWith(node, { content: 'second' }, { content: 'first' });
    expect(unmounted).toHaveBeenCalledWith(node);
    clearDirectiveRegistry();
  });

  it('accepts inline directive definitions on named use bindings as a compatibility path', () => {
    clearDirectiveRegistry();
    const node = document.createElement('div');
    const mounted = vi.fn();
    const updated = vi.fn();
    const unmounted = vi.fn();
    const slot = new UseDirectiveSlot(node, 0);
    const directive = {
      mounted,
      updated,
      unmounted,
    };

    slot.write({
      name: 'tooltip',
      value: directive,
    });
    slot.write({
      name: 'tooltip',
      value: directive,
    });
    slot.destroy();

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(unmounted).toHaveBeenCalledTimes(1);
    clearDirectiveRegistry();
  });

  it('warns in dev mode when an inline use directive definition has an invalid shape', () => {
    clearDirectiveRegistry();
    setDevEnvironmentOverride(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const node = document.createElement('div');
    const slot = new UseDirectiveSlot(node, 0);

    slot.write({ content: 'invalid' });

    expect(warnSpy).toHaveBeenCalledWith(
      '[lania-v] Inline use directive definition is invalid. Expected a DirectiveDef with mounted/updated/unmounted handlers.'
    );
    warnSpy.mockRestore();
    setDevEnvironmentOverride(null);
    clearDirectiveRegistry();
  });

  it('supports bind:value style property assignment', () => {
    const input = document.createElement('input');

    applyBoundValue(input, 'value', 'hello');
    expect(input.value).toBe('hello');

    applyBoundValue(input, 'value', 'world');
    expect(input.value).toBe('world');
  });

  it('supports model:value with trim and number modifiers', () => {
    const signal = createSignal<number | string>('');
    const handler = createModelEventHandler(signal, ['trim', 'number']);
    const input = document.createElement('input');

    input.value = ' 42 ';
    handler({ target: input } as Event);

    expect(signal()).toBe(42);
  });

  it('supports empty, boolean and debounce model modifiers', () => {
    vi.useFakeTimers();
    try {
      const emptyTarget = createSignal<string | undefined>('seed');
      const emptyHandler = createModelEventHandler(emptyTarget, ['empty']);
      const input = document.createElement('input');
      input.value = '   ';
      emptyHandler({ target: input } as Event);
      expect(emptyTarget()).toBe('   ');

      const trimmed = createSignal<string | undefined>('seed');
      createModelEventHandler(trimmed, ['trim', 'empty'])({ target: input } as Event);
      expect(trimmed()).toBeUndefined();

      const checkboxState = createSignal<boolean | string>('');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      createModelEventHandler(checkboxState, ['boolean'], 'checked')({ target: checkbox } as Event);
      expect(checkboxState()).toBe(true);

      const debounced = createSignal('');
      const debouncedHandler = createModelEventHandler(debounced, ['debounce'], 'value', {
        debounceMs: 30,
      });
      input.value = 'first';
      debouncedHandler({ target: input } as Event);
      input.value = 'second';
      debouncedHandler({ target: input } as Event);

      expect(debounced()).toBe('');
      vi.advanceTimersByTime(30);
      expect(debounced()).toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies debounceMs from the static model modifiers', () => {
    vi.useFakeTimers();
    try {
      const target = createSignal('');
      const input = document.createElement('input');
      const slot = new ModelBindingSlot(input, 'value', 0, ['debounce', 'debounceMs:120']);

      slot.write({ source: { get: () => '', set: target.set } });
      input.value = 'typed';
      input.dispatchEvent(new Event('input'));

      vi.advanceTimersByTime(119);
      expect(target()).toBe('');
      vi.advanceTimersByTime(1);
      expect(target()).toBe('typed');
      slot.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports object-style model bindings with source/get/set and lazy modifier', () => {
    let current = ' 42 ';
    const setValue = vi.fn((value: unknown) => {
      current = String(value);
    });
    const input = document.createElement('input');
    const slot = new ModelBindingSlot(input, 'value', 0, []);

    slot.write({
      source: {
        get: () => current,
        set: setValue,
      },
      modifiers: {
        trim: true,
        number: true,
        lazy: true,
      },
    });

    expect(input.value).toBe(' 42 ');
    input.value = ' 7 ';
    input.dispatchEvent(new Event('input'));
    expect(setValue).not.toHaveBeenCalled();
    input.dispatchEvent(new Event('change'));
    expect(setValue).toHaveBeenCalledWith(7);
    slot.destroy();
  });

  it('keeps model:value inputs in sync when the backing signal is cleared programmatically', () => {
    const draft = createSignal('hello');
    const input = document.createElement('input');
    const slot = new ModelBindingSlot(input, 'value', 0, []);

    slot.write(draft);
    expect(input.value).toBe('hello');

    draft.set('');
    slot.write(draft);
    expect(input.value).toBe('');
    slot.destroy();
  });

  it('writes html directives via HtmlResult values and clears on destroy', () => {
    const node = document.createElement('div');
    const slot = new DirectiveBindingSlot(node, 'html', 0);

    slot.write(html`<strong>ready</strong>`);
    expect(node.innerHTML).toBe('<strong>ready</strong>');

    slot.destroy();
    expect(node.innerHTML).toBe('');
  });

  it('ignores raw string html directive values and warns in dev mode', () => {
    setDevEnvironmentOverride(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const node = document.createElement('div');
    const slot = new DirectiveBindingSlot(node, 'html', 0);

    slot.write('<strong>blocked</strong>');

    expect(node.innerHTML).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      '[lania-v] The "html" directive only accepts values created by html`...`.'
    );

    warnSpy.mockRestore();
    setDevEnvironmentOverride(null);
  });

  it('renders html slot values in SSR only when they come from html tag results', () => {
    expect(ssrRenderHtmlSlot(0, html`<em>ready</em>`)).toBe('<em>ready</em>');
    setDevEnvironmentOverride(false);
    expect(ssrRenderHtmlSlot(0, '<em>blocked</em>')).toBe('');
    setDevEnvironmentOverride(null);
  });

  it('supports class and style directives through dedicated slots', () => {
    const div = document.createElement('div');
    const classSlot = new ClassSlot(div, 'active', 0);
    const styleSlot = new StyleSlot(div, 'color', 1);

    classSlot.write(true);
    styleSlot.write('red');
    expect(div.classList.contains('active')).toBe(true);
    expect(div.style.getPropertyValue('color')).toBe('red');

    classSlot.write(false);
    styleSlot.destroy();
    expect(div.classList.contains('active')).toBe(false);
    expect(div.style.getPropertyValue('color')).toBe('');
  });

  it('normalizes class attributes from string, array and object values', () => {
    const div = document.createElement('div');
    const slot = new AttrSlot(div, 'class', 0);

    slot.write(['card', { active: true, hidden: false }, ['nested', 'ready now']]);
    expect(div.getAttribute('class')).toBe('card active nested ready now');

    slot.write({
      visible: true,
      disabled: false,
      'theme-dark': 1,
    });
    expect(div.getAttribute('class')).toBe('visible theme-dark');
  });

  it('merges dynamic class attributes with static class values and restores them on destroy', () => {
    const div = document.createElement('div');
    div.setAttribute('class', 'panel');
    const slot = new AttrSlot(div, 'class', 0);

    slot.write(['active', { selected: true }]);
    expect(div.getAttribute('class')).toBe('panel active selected');

    slot.destroy();
    expect(div.getAttribute('class')).toBe('panel');
  });

  it('serializes class attributes with Vue-style normalization in SSR helpers', () => {
    expect(
      ssrSerializeAttribute('class', ['panel', { active: true, hidden: false }, ['wide']])
    ).toBe(' class="panel active wide"');
  });

  it('normalizes style attributes from string, object and array values', () => {
    const div = document.createElement('div');
    const slot = new AttrSlot(div, 'style', 0);

    slot.write([
      'color: red; width: 12px;',
      { width: '24px', display: 'block' },
      [{ color: 'blue' }],
    ]);

    expect(div.style.getPropertyValue('color')).toBe('blue');
    expect(div.style.getPropertyValue('width')).toBe('24px');
    expect(div.style.getPropertyValue('display')).toBe('block');
  });

  it('merges dynamic style attributes with static style values and restores them on destroy', () => {
    const div = document.createElement('div');
    div.setAttribute('style', 'color: red;');
    const slot = new AttrSlot(div, 'style', 0);

    slot.write([{ width: '24px' }, 'color: blue;']);
    expect(div.style.getPropertyValue('color')).toBe('blue');
    expect(div.style.getPropertyValue('width')).toBe('24px');

    slot.destroy();
    expect(div.style.getPropertyValue('color')).toBe('red');
    expect(div.style.getPropertyValue('width')).toBe('');
  });

  it('serializes style attributes with Vue-style normalization in SSR helpers', () => {
    expect(
      ssrSerializeAttribute('style', [
        'color: red;',
        { width: '24px', display: 'block' },
        [{ color: 'blue' }],
      ])
    ).toBe(' style="color: blue; width: 24px; display: block;"');
  });

  it('runs custom directive lifecycle hooks in mounted -> updated -> unmounted order', () => {
    const node = document.createElement('div');
    const mounted = vi.fn();
    const updated = vi.fn();
    const unmounted = vi.fn();
    const slot = new DirectiveSlot(
      node,
      {
        mounted,
        updated,
        unmounted,
      },
      0
    );

    slot.write('first');
    slot.write('second');
    slot.destroy();

    expect(mounted).toHaveBeenCalledWith(node, 'first');
    expect(updated).toHaveBeenCalledWith(node, 'second', 'first');
    expect(unmounted).toHaveBeenCalledWith(node);
  });
});
