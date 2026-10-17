// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReactiveElement,
  createComponentElement,
  css,
  setDevEnvironmentOverride,
  useFormValue,
} from '@lania-v/runtime';

afterEach(() => {
  setDevEnvironmentOverride(null);
  vi.restoreAllMocks();
});

describe('form associated custom elements', () => {
  const createElementClass = (tagName: string, formAssociated: boolean) => {
    class FormHost extends ReactiveElement {
      static tagName = tagName;
      static formAssociated = formAssociated;

      protected _renderAndMount(): void {}
    }

    customElements.define(tagName, FormHost);
    return document.createElement(tagName) as FormHost & {
      _internals?: ElementInternals;
      _setFormValue: (value: unknown) => void;
    };
  };

  it('attaches ElementInternals when formAssociated is enabled', () => {
    const element = createElementClass('form-host-a', true);
    expect(element._internals).toBeDefined();
  });

  it('skips ElementInternals for regular components', () => {
    const element = createElementClass('form-host-b', false);
    expect(element._internals).toBeUndefined();
  });

  it('ignores runtimes without setFormValue support', () => {
    const element = createElementClass('form-host-c', true);

    // jsdom 只提供 attachInternals，没有 setFormValue；这里必须降级为空操作。
    expect(() => element._setFormValue('value')).not.toThrow();
  });

  it('keeps useFormValue as a compile-time only API', () => {
    expect(() => useFormValue(() => 'value')).toThrowError(/compile-time only/);
  });
});

describe('custom element registration guard', () => {
  const createWidget = (displayName: string, tagName: string) => {
    class Widget extends HTMLElement {
      static tagName = tagName;
      static displayName = displayName;
    }

    return Widget;
  };

  it('reuses the registered constructor and keeps its styles', () => {
    const tagName = 'guard-widget-a';
    const first = createWidget('FirstWidget', tagName);
    const firstStyles = css`:host { color: red; }`;
    first.styles = firstStyles;

    const created = createComponentElement(first);
    expect(customElements.get(tagName)).toBe(first);
    expect(created.constructor as unknown).toBe(first);

    const second = createWidget('SecondWidget', tagName);
    second.styles = css`:host { color: hotpink; }`;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevEnvironmentOverride(true);

    const reused = createComponentElement(second);

    expect(reused.constructor as unknown).toBe(first);
    // 关键回归：后注册的版本不能覆盖已生效构造器的样式。
    expect(first.styles).toBe(firstStyles);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`<${tagName}>`);
  });

  it('does not warn when reusing the identical constructor', () => {
    const tagName = 'guard-widget-b';
    const widget = createWidget('SameWidget', tagName);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevEnvironmentOverride(true);

    createComponentElement(widget);
    createComponentElement(widget);

    expect(warn).not.toHaveBeenCalled();
  });
});
