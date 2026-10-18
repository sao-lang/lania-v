// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { Await, Virtual } from '../packages/runtime/src/component/enhanced-components';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

describe('Await and Virtual enhanced components', () => {
  it('renders fallback then resolves into children content', async () => {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((next) => {
      resolve = next;
    });

    const host = Await({
      value: promise,
      fallback: 'loading',
      children: (value: unknown) => `done:${String(value)}`,
    }) as HTMLElement;

    expect(host.textContent).toBe('loading');
    resolve('ok');
    await flush();
    expect(host.textContent).toBe('done:ok');
  });

  it('renders the error branch when the promise rejects', async () => {
    const host = Await({
      value: Promise.reject(new Error('boom')),
      fallback: 'loading',
      error: (error: unknown) => `failed:${(error as Error).message}`,
    }) as HTMLElement;

    await flush();
    expect(host.textContent).toBe('failed:boom');
  });

  it('windows a long list and re-renders on scroll', () => {
    const items = Array.from({ length: 100 }, (_, index) => index);
    const host = Virtual({
      items,
      itemHeight: 20,
      height: 60,
      overscan: 1,
      children: (item: unknown) => `item-${String(item)}`,
    }) as HTMLElement;

    expect(host.style.height).toBe('60px');
    expect(host.textContent).toContain('item-0');
    expect(host.textContent).toContain('item-4');
    expect(host.textContent).not.toContain('item-5');

    host.scrollTop = 200;
    host.dispatchEvent(new Event('scroll'));
    expect(host.textContent).toContain('item-9');
    expect(host.textContent).not.toContain('item-0');
  });
});
