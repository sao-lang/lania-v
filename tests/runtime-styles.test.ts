// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReactiveElement,
  adoptStyles,
  applyCSSVariables,
  css,
  consumeStyleVariables,
  getStyleText,
  isCSSResult,
  provideStyleVariables,
  StyleObjectSlot,
  StyleSlot,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 2): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const SingleStyleElement = (() => {
  const existing = customElements.get('x-single-style');

  if (existing) {
    return existing as typeof ReactiveElement;
  }

  class SingleStyleElementImpl extends ReactiveElement {
    static styles = css`
      :host {
        display: block;
      }
    `;

    protected _renderAndMount(): void {
      this.renderRoot.appendChild(document.createElement('div'));
    }
  }

  customElements.define('x-single-style', SingleStyleElementImpl);
  return SingleStyleElementImpl;
})();

const ArrayStyleElement = (() => {
  const existing = customElements.get('x-array-style');

  if (existing) {
    return existing as typeof ReactiveElement;
  }

  class ArrayStyleElementImpl extends ReactiveElement {
    static styles = [
      css`
        :host {
          color: red;
        }
      `,
      css`
        .item {
          font-weight: 600;
        }
      `,
    ];

    protected _renderAndMount(): void {
      const div = document.createElement('div');
      div.className = 'item';
      this.renderRoot.appendChild(div);
    }
  }

  customElements.define('x-array-style', ArrayStyleElementImpl);
  return ArrayStyleElementImpl;
})();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runtime styles', () => {
  it('creates style values that preserve css text', () => {
    const style = css`
      :host {
        display: block;
      }
    `;

    expect(getStyleText(style)).toContain('display: block;');
    expect(isCSSResult(style) || style instanceof CSSStyleSheet).toBe(true);
  });

  it('falls back to style tags and avoids duplicate injections', () => {
    const root = document.createElement('div');
    const style = css`
      .demo {
        color: red;
      }
    `;

    adoptStyles(root, style);
    adoptStyles(root, style);

    const styleElements = root.querySelectorAll('style');
    expect(styleElements).toHaveLength(1);
    expect(styleElements[0]?.textContent).toContain('color: red;');
  });

  it('prefers adoptedStyleSheets when constructable stylesheets are available', () => {
    class FakeStyleSheet {
      cssText = '';

      replaceSync(next: string): void {
        this.cssText = next;
      }
    }

    vi.stubGlobal('CSSStyleSheet', FakeStyleSheet);

    const root = {
      adoptedStyleSheets: [] as FakeStyleSheet[],
      appendChild: vi.fn(),
    } as unknown as ShadowRoot & { adoptedStyleSheets: FakeStyleSheet[] };

    const style = css`
      :host {
        color: blue;
      }
    `;

    adoptStyles(root, style);

    expect(root.adoptedStyleSheets).toHaveLength(1);
    expect(root.adoptedStyleSheets[0]?.cssText).toContain('color: blue;');
    expect(
      root.appendChild as unknown as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
  });

  it('auto-adopts single and array static styles on ReactiveElement', async () => {
    expect(customElements.get('x-single-style')).toBe(SingleStyleElement);
    expect(customElements.get('x-array-style')).toBe(ArrayStyleElement);

    const single = document.createElement('x-single-style') as InstanceType<
      typeof SingleStyleElement
    >;
    const multi = document.createElement('x-array-style') as InstanceType<
      typeof ArrayStyleElement
    >;

    document.body.append(single, multi);
    await flushMicrotasks();

    expect(single.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
    expect(single.shadowRoot?.querySelector('style')?.textContent).toContain(
      'display: block;'
    );
    expect(multi.shadowRoot?.querySelectorAll('style')).toHaveLength(2);
    expect(multi.shadowRoot?.querySelector('.item')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(
      multi.shadowRoot?.querySelectorAll('style')[1]?.textContent
    ).toContain('font-weight: 600;');
  });

  it('supports dynamic style object updates and style directives with units', () => {
    const node = document.createElement('div');
    const styleObjectSlot = new StyleObjectSlot(node, 0);
    const widthSlot = new StyleSlot(node, 'width', 1, 'px');

    styleObjectSlot.write({
      backgroundColor: 'red',
      opacity: 0.5,
    });
    widthSlot.write(24);

    expect(node.style.getPropertyValue('background-color')).toBe('red');
    expect(node.style.getPropertyValue('opacity')).toBe('0.5');
    expect(node.style.getPropertyValue('width')).toBe('24px');

    styleObjectSlot.write({
      opacity: 1,
      '--card-gap': '12px',
    });

    expect(node.style.getPropertyValue('background-color')).toBe('');
    expect(node.style.getPropertyValue('opacity')).toBe('1');
    expect(node.style.getPropertyValue('--card-gap')).toBe('12px');
  });

  it('supports style variables and inheritance through context', () => {
    const host = document.createElement('section');
    const child = document.createElement('div');

    host.appendChild(child);
    document.body.appendChild(host);

    const cleanup = provideStyleVariables(host, {
      primaryColor: '#2563eb',
      spacingMd: '16px',
    });

    expect(host.style.getPropertyValue('--primary-color')).toBe('#2563eb');
    expect(host.style.getPropertyValue('--spacing-md')).toBe('16px');
    expect(consumeStyleVariables(child)).toEqual({
      primaryColor: '#2563eb',
      spacingMd: '16px',
    });

    applyCSSVariables(
      host,
      {
        primaryColor: '#7c3aed',
      },
      {
        primaryColor: '#2563eb',
        spacingMd: '16px',
      }
    );

    expect(host.style.getPropertyValue('--primary-color')).toBe('#7c3aed');
    expect(host.style.getPropertyValue('--spacing-md')).toBe('');
    cleanup();
  });
});
