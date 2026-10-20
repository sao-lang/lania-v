// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

// These slot behavior tests should validate the current runtime implementation
// directly. The published package entry can lag behind source when dist is stale,
// and that packaging concern is covered separately by bundling/build checks.
import {
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  AttrSlot,
  BoundarySlot,
  ClassSlot,
  DynamicSlot,
  DirectiveBindingSlot,
  IfSlot,
  ForSlot,
  KeepAliveSlot,
  SlotTable,
  StyleSlot,
  TeleportSlot,
  TextSlot,
  PropSlot,
  clearSlotPool,
  createStaticTemplate,
  getSlotPoolStats,
  hasHydrationSlot,
  mountStaticTemplate,
  readHydrationSlotNodes,
  resolveSlotAnchor,
  ssrRenderBlockSlot,
  ssrRenderEnhancedBoundary,
} from '../packages/runtime/src/index';
import {
  ErrorBoundary,
  KeepAlive,
  TransitionGroup,
  When,
} from '../packages/advanced/src/index';
import { withContextHost } from '../packages/runtime/src/component/host/function-component';
import { resetRuntimeTestState } from '../packages/runtime/src/entry/testing';
import { resolveBlockPayload } from '../packages/runtime/src/component/lifecycle/keepalive-registry';

const flushMicrotasks = async (times = 1): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const createKeepAliveCachePayload = (options: {
  slotIndex: number;
  scope?: string;
  cacheKey?: PropertyKey | null;
  include?: readonly string[];
  exclude?: readonly string[];
  max?: number;
  metadata?: Record<string, unknown>;
  html?: string;
}) => ({
  protocol: ENHANCED_CONTRACT_PROTOCOL,
  version: ENHANCED_CONTRACT_VERSION,
  payloadKind: 'cache' as const,
  component: 'KeepAlive' as const,
  irKind: 'KeepAliveIR' as const,
  slotIndex: options.slotIndex,
  template: options.html ? { html: options.html } : {},
  cache: {
    scope: options.scope,
    key: options.cacheKey,
    include: options.include,
    exclude: options.exclude,
    max: options.max,
  },
  metadata: options.metadata,
});

const createKeepAliveBlockPayload = <TBinding>(
  options: {
    slotIndex: number;
    scope?: string;
    cacheKey?: PropertyKey | null;
    include?: readonly string[];
    exclude?: readonly string[];
    max?: number;
    metadata?: Record<string, unknown>;
    html?: string;
  },
  bindings: readonly TBinding[] = []
) => ({
  __lania_keepalive: 'block' as const,
  payload: createKeepAliveCachePayload(options),
  bindings,
});

beforeEach(() => {
  resetRuntimeTestState();
});

describe('TextSlot', () => {
  it('preserves empty text-node placeholders for inline dynamic text slots', () => {
    const template = createStaticTemplate(
      '<p>prefix__LANIA_SLOT_0__<span>__LANIA_SLOT_1__</span></p>'
    );
    const fragment = template.clone();
    const paragraph = fragment.firstChild as HTMLParagraphElement | null;

    expect(paragraph).not.toBeNull();
    expect(paragraph?.childNodes).toHaveLength(3);
    expect(paragraph?.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(paragraph?.childNodes[0]?.textContent).toBe('prefix');
    expect(paragraph?.childNodes[1]?.nodeType).toBe(Node.TEXT_NODE);
    expect(paragraph?.childNodes[1]?.textContent).toBe('');
    expect(paragraph?.childNodes[2]?.nodeName).toBe('SPAN');
    expect(paragraph?.childNodes[2]?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(paragraph?.childNodes[2]?.firstChild?.textContent).toBe('');
  });

  it('returns dynamic slot buffers back to the slot pool on destroy', () => {
    clearSlotPool();
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<span></span>'),
      99
    );

    expect(getSlotPoolStats().availableNodeBuffers).toBe(0);
    slot.write({
      component: 'section',
      props: {},
    });
    slot.destroy();

    expect(getSlotPoolStats().availableNodeBuffers).toBe(1);
  });

  it('passes compiled function children to dynamic components as scoped slots', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->'),
      100
    );

    const Child = (props: { children?: unknown }) => {
      const node = document.createElement('div');
      const children = props.children;
      if (typeof children === 'function') {
        node.append(children('item'));
      }
      return node;
    };

    slot.write({
      __lania_dynamic: 'block',
      component: Child,
      props: {},
      childBindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0],
          evaluate: () => (item: string) =>
            document.createTextNode(`scoped:${item}`),
        },
      ],
    } as never);

    expect(host.textContent).toBe('scoped:item');
  });

  it('writes stringified values into the text node', () => {
    const node = document.createTextNode('');
    const slot = new TextSlot(node, 0);

    slot.write(42);
    expect(node.data).toBe('42');

    slot.write(null);
    expect(node.data).toBe('');
  });

  it('clears the node on destroy', () => {
    const node = document.createTextNode('ready');
    const slot = new TextSlot(node, 0);

    slot.destroy();

    expect(node.data).toBe('');
  });

  it('injects node values written into a text slot and restores text afterwards', () => {
    const host = document.createElement('div');
    const textNode = document.createTextNode('placeholder');
    host.appendChild(textNode);
    const slot = new TextSlot(textNode, 0);

    const element = document.createElement('strong');
    element.textContent = 'node';
    slot.write(element);

    expect(textNode.data).toBe('');
    expect(host.firstChild).toBe(textNode);
    expect(host.querySelector('strong')).toBe(element);

    slot.write('plain text');
    expect(host.querySelector('strong')).toBeNull();
    expect(textNode.data).toBe('plain text');

    const first = document.createElement('i');
    first.textContent = '1';
    const second = document.createElement('b');
    second.textContent = '2';
    slot.write([first, second]);
    expect([...host.children].map((node) => node.tagName)).toEqual(['I', 'B']);

    slot.destroy();
    expect(host.children).toHaveLength(0);
    expect(textNode.data).toBe('');
  });

  it('writes and clears HTML attributes', () => {
    const node = document.createElement('div');
    const slot = new AttrSlot(node, 'data-state', 1);

    slot.write('ready');
    expect(node.getAttribute('data-state')).toBe('ready');

    slot.write(false);
    expect(node.hasAttribute('data-state')).toBe(false);
  });

  it('uses DOM property fast path for common form attributes', () => {
    const input = document.createElement('input');
    const slot = new AttrSlot(input, 'value', 11);

    slot.write('ready');
    expect(input.value).toBe('ready');
    expect(input.getAttribute('value')).toBeNull();

    slot.destroy();
    expect(input.value).toBe('');
  });

  it('writes and clears inline styles', () => {
    const node = document.createElement('div');
    const slot = new StyleSlot(node, 'width', 2, 'px');

    slot.write(24);
    expect(node.style.getPropertyValue('width')).toBe('24px');

    slot.destroy();
    expect(node.style.getPropertyValue('width')).toBe('');
  });

  it('toggles classes', () => {
    const node = document.createElement('div');
    const slot = new ClassSlot(node, 'active', 3);

    slot.write(true);
    expect(node.classList.contains('active')).toBe(true);

    slot.write(false);
    expect(node.classList.contains('active')).toBe(false);
  });

  it('writes property and directive values', () => {
    const input = document.createElement('input');
    const propSlot = new PropSlot(input, 'value', 4);
    const directiveSlot = new DirectiveBindingSlot(input, 'model', 5);

    propSlot.write('hello');
    expect((input as HTMLInputElement).value).toBe('hello');

    directiveSlot.write('world');
    expect((input as HTMLInputElement).value).toBe('world');
  });

  it('renders and clears list nodes through ForSlot', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 4);

    slot.write(['A', 'B']);
    expect(host.textContent).toBe('AB');

    slot.write(['C']);
    expect(host.textContent).toBe('C');

    slot.destroy();
    expect(host.textContent).toBe('');
  });

  it('reuses keyed list nodes through ForSlot', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 9);

    const a = { id: 'a', label: 'A' };
    const b = { id: 'b', label: 'B' };

    slot.write({
      __lania_for: 'keyed',
      items: [a, b],
      key: (item: any) => item.id,
      render: (item: any) => {
        const el = document.createElement('span');
        el.textContent = item.label;
        return el;
      },
    });

    const first = [...host.querySelectorAll('span')];
    expect(first.map((n) => n.textContent)).toEqual(['A', 'B']);

    // Reorder: should move the same DOM nodes, not recreate.
    slot.write({
      __lania_for: 'keyed',
      items: [b, a],
      key: (item: any) => item.id,
      render: (item: any) => {
        const el = document.createElement('span');
        el.textContent = item.label;
        return el;
      },
    });

    const second = [...host.querySelectorAll('span')];
    expect(second.map((n) => n.textContent)).toEqual(['B', 'A']);
    expect(second[0]).toBe(first[1]);
    expect(second[1]).toBe(first[0]);
  });

  it('updates keyed list items without recreating nodes when using keyed-slots payload', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 10);

    const template = createStaticTemplate('<span>__LANIA_SLOT_0__</span>');

    const a1 = { id: 'a', label: 'A' };
    slot.write({
      __lania_for: 'keyed-slots',
      items: [a1],
      key: (item: any) => item.id,
      template,
      bindings: [
        {
          slotIndex: 0,
          path: [0, 0],
          evaluate: (item: any) => item.label,
        },
      ],
    });

    const first = host.querySelector('span');
    expect(first?.textContent).toBe('A');

    const a2 = { id: 'a', label: 'A2' };
    slot.write({
      __lania_for: 'keyed-slots',
      items: [a2],
      key: (item: any) => item.id,
      template,
      bindings: [
        {
          slotIndex: 0,
          path: [0, 0],
          evaluate: (item: any) => item.label,
        },
      ],
    });

    const second = host.querySelector('span');
    expect(second).toBe(first);
    expect(second?.textContent).toBe('A2');
  });

  it('updates keyed list item attributes without recreating nodes when using keyed-slots payload', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 11);

    const template = createStaticTemplate('<span></span>');

    slot.write({
      __lania_for: 'keyed-slots',
      items: [{ id: 'a', label: 'A' }],
      key: (item: any) => item.id,
      template,
      bindings: [
        {
          kind: 'attr',
          slotIndex: 0,
          path: [0],
          name: 'data-label',
          evaluate: (item: any) => item.label,
        },
      ],
    });

    const first = host.querySelector('span');
    expect(first?.getAttribute('data-label')).toBe('A');

    slot.write({
      __lania_for: 'keyed-slots',
      items: [{ id: 'a', label: 'A2' }],
      key: (item: any) => item.id,
      template,
      bindings: [
        {
          kind: 'attr',
          slotIndex: 0,
          path: [0],
          name: 'data-label',
          evaluate: (item: any) => item.label,
        },
      ],
    });

    const second = host.querySelector('span');
    expect(second).toBe(first);
    expect(second?.getAttribute('data-label')).toBe('A2');
  });

  it('renders element-anchored keyed blocks without per-item comment anchors', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 61);

    const template = createStaticTemplate('<li>__LANIA_SLOT_0__</li>');
    const createPayload = (items: Array<{ id: string; label: string }>) => ({
      __lania_for: 'keyed-slots' as const,
      items,
      key: (item: { id: string }) => item.id,
      template,
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: (item: { label: string }) => item.label,
        },
      ],
    });

    slot.write(
      createPayload([
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ])
    );

    const children = [...host.childNodes];
    // 只有 ForSlot 自己的锚点注释，条目本身不再产生 start/end 注释。
    expect(
      children.filter((node) => node.nodeType === Node.COMMENT_NODE)
    ).toHaveLength(1);
    expect(
      children.filter((node) => node instanceof HTMLLIElement)
    ).toHaveLength(2);

    const firstItems = [...host.querySelectorAll('li')];
    expect(firstItems.map((node) => node.textContent)).toEqual(['A', 'B']);

    slot.write(
      createPayload([
        { id: 'b', label: 'B' },
        { id: 'a', label: 'A' },
      ])
    );

    const reordered = [...host.querySelectorAll('li')];
    expect(reordered.map((node) => node.textContent)).toEqual(['B', 'A']);
    // 重排复用同一批元素，不重建节点。
    expect(reordered[0]).toBe(firstItems[1]);
    expect(reordered[1]).toBe(firstItems[0]);

    slot.write(createPayload([{ id: 'a', label: 'A' }]));

    const remaining = [...host.querySelectorAll('li')];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(firstItems[0]);
    expect(
      [...host.childNodes].filter((node) => node.nodeType === Node.COMMENT_NODE)
    ).toHaveLength(1);
  });

  it('renders non-keyed slot payload items with nested text bindings', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 12);
    const template = createStaticTemplate('<li>__LANIA_SLOT_0__</li>');

    slot.write({
      __lania_for: 'slots',
      items: [{ name: 'A' }, { name: 'B' }],
      template,
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0],
          evaluate: (item: any) => item.name,
        },
      ],
    });

    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.textContent).toBe('AB');

    slot.write({
      __lania_for: 'slots',
      items: [{ name: 'C' }],
      template,
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0],
          evaluate: (item: any) => item.name,
        },
      ],
    });

    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.textContent).toBe('C');
  });

  it('renders and clears conditional nodes through IfSlot', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('if');
    host.appendChild(anchor);
    const slot = new IfSlot(
      anchor,
      createStaticTemplate('<span>Visible</span>'),
      5
    );

    slot.write(true);
    expect(host.textContent).toBe('Visible');

    slot.write(false);
    expect(host.textContent).toBe('');
  });

  it('renders fallback nodes for empty ForSlot collections', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 6, () => {
      const empty = document.createElement('p');
      empty.textContent = 'Empty';
      return empty;
    });

    slot.write([]);
    expect(host.textContent).toBe('Empty');

    slot.write(['Ready']);
    expect(host.textContent).toBe('Ready');
  });

  it('switches between truthy and fallback branches in IfSlot', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('if');
    host.appendChild(anchor);
    const slot = new IfSlot(
      anchor,
      createStaticTemplate('<span>Visible</span>'),
      7,
      createStaticTemplate('<span>Hidden</span>')
    );

    slot.write(false);
    expect(host.textContent).toBe('Hidden');

    slot.write(true);
    expect(host.textContent).toBe('Visible');
  });

  it('removes nested IfSlot nodes when switching outer branches', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('if-nested');
    host.appendChild(anchor);

    let outer = false;
    let inner = true;

    const slot = new IfSlot(
      anchor,
      createStaticTemplate('<span>Truth</span>'),
      8,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->')
    );

    const write = () =>
      slot.write({
        __lania_if: 'block',
        when: outer,
        truthyBindings: [],
        falsyBindings: [
          {
            kind: 'if',
            slotIndex: 0,
            path: [0],
            template: createStaticTemplate('<span>Inner</span>'),
            fallbackTemplate: createStaticTemplate('<span>Default</span>'),
            evaluate: () => ({ __lania_if: 'block', when: inner }),
          },
        ],
      });

    write();
    expect(host.textContent).toBe('Inner');

    outer = true;
    inner = false;
    write();
    expect(host.textContent).toBe('Truth');
  });

  it('removes the previous KeepAlive branch when cached content contains nested When blocks', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive');
    host.appendChild(anchor);

    let currentPage: 'page-a' | 'page-b' = 'page-a';
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate('__LANIA_SLOT_0____LANIA_SLOT_1__'),
      73
    );
    const createPayload = (page: 'page-a' | 'page-b') =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 73,
          cacheKey: page,
          scope: 'runtime-slot-keepalive',
          max: 2,
          metadata: {
            onActivate: () => {},
            onDeactivate: () => {},
            onCache: () => {},
            onEvict: () => {},
          },
        },
        [
          {
            kind: 'if' as const,
            slotIndex: 0,
            path: [0],
            template: createStaticTemplate(
              '<div data-key="page-a"><input placeholder="type in Page A"></input></div>'
            ),
            evaluate: () => ({
              __lania_if: 'block' as const,
              when: currentPage === 'page-a',
            }),
          },
          {
            kind: 'if' as const,
            slotIndex: 1,
            path: [1],
            template: createStaticTemplate(
              '<div data-key="page-b"><input placeholder="type in Page B"></input></div>'
            ),
            evaluate: () => ({
              __lania_if: 'block' as const,
              when: currentPage === 'page-b',
            }),
          },
        ]
      );

    slot.write(createPayload('page-a'));
    expect(host.querySelector('[data-key="page-a"]')).not.toBeNull();
    expect(host.querySelector('[data-key="page-b"]')).toBeNull();
    expect(host.querySelectorAll('[data-key]')).toHaveLength(1);

    currentPage = 'page-b';
    slot.write(createPayload('page-b'));
    expect(host.querySelector('[data-key="page-a"]')).toBeNull();
    expect(host.querySelector('[data-key="page-b"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-key]')).toHaveLength(1);

    currentPage = 'page-a';
    slot.write(createPayload('page-a'));
    expect(host.querySelector('[data-key="page-a"]')).not.toBeNull();
    expect(host.querySelector('[data-key="page-b"]')).toBeNull();
    expect(host.querySelectorAll('[data-key]')).toHaveLength(1);
  });

  it('restores visible LazyLoad boundary children from KeepAlive slot cache after key switches', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-lazy-boundary');
    host.appendChild(anchor);

    let callback: IntersectionObserverCallback | null = null;
    class MockIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="keepalive-boundary-shell"><!--__LANIA_SLOT_0__--></section>'
      ),
      2010
    );
    const createPayload = (page: 'page-a' | 'page-b') =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 2010,
          cacheKey: page,
          scope: 'runtime-slot-keepalive-boundary-combo',
          max: 2,
          metadata: {
            onActivate: () => {},
            onDeactivate: () => {},
            onCache: () => {},
            onEvict: () => {},
          },
        },
        [
          {
            kind: 'boundary' as const,
            slotIndex: 0,
            path: [0, 0],
            template:
              page === 'page-a'
                ? createStaticTemplate('<input data-pane="lazy-a"></input>')
                : createStaticTemplate('<div data-pane="lazy-b">Page B</div>'),
            fallbackTemplate:
              page === 'page-a'
                ? createStaticTemplate(
                    '<span data-pane="lazy-a-fallback">loading-a</span>'
                  )
                : undefined,
            evaluate: () => ({
              __lania_boundary: 'block' as const,
              payload: {
                protocol: ENHANCED_CONTRACT_PROTOCOL,
                version: ENHANCED_CONTRACT_VERSION,
                payloadKind: 'boundary' as const,
                component: 'LazyLoad' as const,
                irKind: 'BoundaryIR' as const,
                boundaryIndex: page === 'page-a' ? 10 : 11,
                initialState:
                  page === 'page-a' ? ('inactive' as const) : ('idle' as const),
                childrenTemplate: {},
                fallbackTemplate: page === 'page-a' ? {} : undefined,
                metadata:
                  page === 'page-a'
                    ? {
                        lazyKey: 'slot-keepalive-lazy-page-a',
                        once: true,
                      }
                    : {
                        lazyKey: 'slot-keepalive-lazy-page-b',
                        observe: false,
                      },
              },
              bindings: [],
            }),
          },
        ]
      );

    slot.write(createPayload('page-a'));
    expect(host.textContent).toContain('loading-a');
    expect(host.querySelector('[data-pane="lazy-a"]')).toBeNull();

    callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );

    const visibleInput = host.querySelector(
      '[data-pane="lazy-a"]'
    ) as HTMLInputElement | null;
    expect(visibleInput).not.toBeNull();
    if (!visibleInput) {
      throw new Error('expected visible KeepAliveSlot LazyLoad input');
    }

    visibleInput.value = 'draft';

    slot.write(createPayload('page-b'));
    expect(host.querySelector('[data-pane="lazy-a"]')).toBeNull();
    expect(host.querySelector('[data-pane="lazy-b"]')?.textContent).toBe(
      'Page B'
    );

    slot.write(createPayload('page-a'));
    const restoredInput = host.querySelector(
      '[data-pane="lazy-a"]'
    ) as HTMLInputElement | null;
    expect(restoredInput).toBe(visibleInput);
    expect(restoredInput?.value).toBe('draft');
    expect(host.querySelector('[data-pane="lazy-a-fallback"]')).toBeNull();

    vi.unstubAllGlobals();
  });

  it('restores resolved Suspense boundary children from KeepAlive slot cache after key switches', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-suspense');
    host.appendChild(anchor);

    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });

    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="keepalive-suspense-shell"><!--__LANIA_SLOT_0__--></section>'
      ),
      2011
    );

    const createPayload = (page: 'page-a' | 'page-b') =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 2011,
          cacheKey: page,
          scope: 'runtime-slot-keepalive-suspense-combo',
          max: 2,
          metadata: {
            onActivate: () => {},
            onDeactivate: () => {},
            onCache: () => {},
            onEvict: () => {},
          },
        },
        [
          {
            kind: 'boundary' as const,
            slotIndex: 0,
            path: [0, 0],
            template:
              page === 'page-a'
                ? createStaticTemplate('<input data-pane="suspense-a"></input>')
                : createStaticTemplate(
                    '<div data-pane="suspense-b">Page B</div>'
                  ),
            fallbackTemplate:
              page === 'page-a'
                ? createStaticTemplate(
                    '<span data-pane="suspense-a-fallback">loading-a</span>'
                  )
                : undefined,
            evaluate: () => ({
              __lania_boundary: 'block' as const,
              payload: {
                protocol: ENHANCED_CONTRACT_PROTOCOL,
                version: ENHANCED_CONTRACT_VERSION,
                payloadKind: 'boundary' as const,
                component: 'Suspense' as const,
                irKind: 'BoundaryIR' as const,
                boundaryIndex: page === 'page-a' ? 12 : 13,
                initialState: 'idle' as const,
                childrenTemplate: {},
                fallbackTemplate: page === 'page-a' ? {} : undefined,
                metadata: {
                  suspenseKey:
                    page === 'page-a'
                      ? 'slot-keepalive-suspense-page-a'
                      : 'slot-keepalive-suspense-page-b',
                },
              },
              bindings:
                page === 'page-a'
                  ? ([
                      {
                        kind: 'prop' as const,
                        slotIndex: 0,
                        path: [0],
                        name: 'value',
                        evaluate: () => {
                          if (!resolved) {
                            throw pending;
                          }
                          return 'ready';
                        },
                      },
                    ] as const)
                  : ([] as const),
            }),
          },
        ]
      );

    slot.write(createPayload('page-a'));
    expect(host.textContent).toContain('loading-a');
    expect(host.querySelector('[data-pane="suspense-a"]')).toBeNull();

    release();
    await pending;
    await flushMicrotasks(3);

    const input = host.querySelector(
      '[data-pane="suspense-a"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (!input) {
      throw new Error(
        'expected KeepAliveSlot Suspense child input after resolution'
      );
    }
    expect(input.value).toBe('ready');
    input.dataset.memo = 'draft';

    slot.write(createPayload('page-b'));
    expect(host.querySelector('[data-pane="suspense-a"]')).toBeNull();
    expect(host.querySelector('[data-pane="suspense-b"]')?.textContent).toBe(
      'Page B'
    );

    slot.write(createPayload('page-a'));
    const restoredInput = host.querySelector(
      '[data-pane="suspense-a"]'
    ) as HTMLInputElement | null;
    expect(restoredInput).toBe(input);
    expect(restoredInput?.dataset.memo).toBe('draft');
    expect(host.querySelector('[data-pane="suspense-a-fallback"]')).toBeNull();
  });

  it('does not share the implicit default KeepAlive scope between slot and component paths', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-default-scope');
    host.appendChild(anchor);

    const slotEvents: string[] = [];
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate('<span>slot</span>'),
      2001
    );
    const createSlotPayload = (cacheKey: 'page-a' | 'page-b') =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 2001,
          cacheKey,
          max: 10,
          metadata: {
            onActivate: (
              _value: readonly Node[],
              key: string,
              reused: boolean
            ) => slotEvents.push(`slot:${key}:${reused}`),
            onDeactivate: () => {},
            onCache: () => {},
            onEvict: () => {},
          },
        },
        []
      );

    // Slot path uses default scope `slot:default` when scope is absent.
    slot.write(createSlotPayload('page-a'));
    slot.write(createSlotPayload('page-b'));
    slot.write(createSlotPayload('page-a'));
    expect(slotEvents).toEqual([
      'slot:page-a:false',
      'slot:page-b:false',
      'slot:page-a:true',
    ]);

    const componentEvents: string[] = [];

    // Component path uses default scope `component:default` when scope is absent.
    KeepAlive({
      payload: createKeepAliveCachePayload({
        slotIndex: 0,
        cacheKey: 'page-a',
        max: 10,
        metadata: {
          onActivate: (_value: unknown, key: string, reused: boolean) =>
            componentEvents.push(`component:${key}:${reused}`),
        },
      }),
      children: document.createTextNode('component-a'),
    });
    KeepAlive({
      payload: createKeepAliveCachePayload({
        slotIndex: 0,
        cacheKey: 'page-b',
        max: 10,
        metadata: {
          onActivate: (_value: unknown, key: string, reused: boolean) =>
            componentEvents.push(`component:${key}:${reused}`),
        },
      }),
      children: document.createTextNode('component-b'),
    });
    KeepAlive({
      payload: createKeepAliveCachePayload({
        slotIndex: 0,
        cacheKey: 'page-a',
        max: 10,
        metadata: {
          onActivate: (_value: unknown, key: string, reused: boolean) =>
            componentEvents.push(`component:${key}:${reused}`),
        },
      }),
      children: document.createTextNode('component-a'),
    });

    // If the default scope were shared, the first component activation for page-a would be reused=true
    // because the slot path already cached it.
    expect(componentEvents).toEqual([
      'component:page-a:false',
      'component:page-b:false',
      'component:page-a:true',
    ]);
  });

  it('accepts KeepAlive block payloads that carry shared cache contract data', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-contract');
    host.appendChild(anchor);

    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="contract">__LANIA_SLOT_0__</section>'
      ),
      74
    );

    slot.write({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 74,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'runtime-slot-contract',
          key: 'pane-a',
          max: 2,
        },
        metadata: {
          onActivate: vi.fn(),
          onDeactivate: vi.fn(),
          onCache: vi.fn(),
          onEvict: vi.fn(),
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'Contract payload',
        },
      ],
    });

    expect(host.querySelector('[data-pane="contract"]')?.textContent).toBe(
      'Contract payload'
    );
  });

  it('treats KeepAlive block payload contract cache and metadata as separate formal sources', () => {
    const onActivateFromMetadata = vi.fn();
    const onDeactivateFromMetadata = vi.fn();
    const onCacheFromMetadata = vi.fn();
    const onEvictFromMetadata = vi.fn();
    const resolved = resolveBlockPayload<DocumentFragment, never>({
      __lania_keepalive: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<div></div>',
        },
        cache: {
          scope: 'contract-scope',
          key: 'contract-key',
          include: ['contract-key'],
          exclude: ['contract-exclude'],
          max: 3,
        },
        metadata: {
          scope: 'metadata-scope',
          key: 'metadata-key',
          include: ['metadata-key'],
          exclude: ['metadata-exclude'],
          max: 5,
          onActivate: onActivateFromMetadata,
          onDeactivate: onDeactivateFromMetadata,
          onCache: onCacheFromMetadata,
          onEvict: onEvictFromMetadata,
        },
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.runtimeSourceKind).toBe('contract');
    expect(resolved?.runtimeOptions.scope).toBe('contract-scope');
    expect(resolved?.runtimeOptions.key).toBe('contract-key');
    expect(resolved?.runtimeOptions.include).toEqual(['contract-key']);
    expect(resolved?.runtimeOptions.exclude).toEqual(['contract-exclude']);
    expect(resolved?.runtimeOptions.max).toBe(3);
    expect(resolved?.runtimeOptions.onActivate).toBe(onActivateFromMetadata);
    expect(resolved?.runtimeOptions.onDeactivate).toBe(
      onDeactivateFromMetadata
    );
    expect(resolved?.runtimeOptions.onCache).toBe(onCacheFromMetadata);
    expect(resolved?.runtimeOptions.onEvict).toBe(onEvictFromMetadata);
  });

  it('rejects KeepAlive block payloads without contract source', () => {
    const resolved = resolveBlockPayload<DocumentFragment, never>({
      __lania_keepalive: 'block',
      bindings: [],
    });

    expect(resolved).toBeNull();
  });

  it('uses KeepAlive shared contract cache and metadata as the only runtime source', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-contract-precedence');
    host.appendChild(anchor);

    const onActivateFromMetadata = vi.fn();
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="precedence">__LANIA_SLOT_0__</section>'
      ),
      78
    );

    slot.write({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 78,
        template: {
          html: '<section data-pane="precedence">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-scope',
          key: 'contract-key',
          include: ['contract-key'],
          max: 2,
        },
        metadata: {
          onActivate: onActivateFromMetadata,
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'Contract wins',
        },
      ],
    });

    expect(host.querySelector('[data-pane="precedence"]')?.textContent).toBe(
      'Contract wins'
    );
    expect(onActivateFromMetadata).toHaveBeenCalledTimes(1);
    expect(onActivateFromMetadata).toHaveBeenCalledWith(
      expect.any(Array),
      'contract-key',
      false
    );
  });

  it('accepts payload-only KeepAlive blocks with contract metadata hooks', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-legacy-fallback');
    host.appendChild(anchor);

    const onActivate = vi.fn();
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="legacy-fallback">__LANIA_SLOT_0__</section>'
      ),
      80
    );

    slot.write(
      createKeepAliveBlockPayload(
        {
          slotIndex: 80,
          cacheKey: 'payload-only-key',
          scope: 'payload-only-scope',
          include: ['payload-only-key'],
          max: 1,
          metadata: {
            onActivate,
          },
          html: '<section data-pane="legacy-fallback">__LANIA_SLOT_0__</section>',
        },
        [
          {
            kind: 'text' as const,
            slotIndex: 0,
            path: [0, 0],
            evaluate: () => 'Legacy fallback',
          },
        ]
      )
    );

    expect(
      host.querySelector('[data-pane="legacy-fallback"]')?.textContent
    ).toBe('Legacy fallback');
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(
      expect.any(Array),
      'payload-only-key',
      false
    );
  });

  it('does not invent KeepAlive hook fallbacks when contract metadata omits them', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-contract-cache-only');
    host.appendChild(anchor);

    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="contract-cache-only">__LANIA_SLOT_0__</section>'
      ),
      98
    );

    slot.write({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 98,
        template: {
          html: '<section data-pane="contract-cache-only">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-cache-only-scope',
          key: 'contract-cache-only-key',
          include: ['contract-cache-only-key'],
          max: 2,
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'Contract cache only',
        },
      ],
    });

    expect(
      host.querySelector('[data-pane="contract-cache-only"]')?.textContent
    ).toBe('Contract cache only');
    expect(
      host.querySelector('[data-pane="contract-cache-only"]')
    ).not.toBeNull();
  });

  it('keeps compiler-style payload-only KeepAlive blocks independent from legacy flat fields', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-payload-only');
    host.appendChild(anchor);

    const onActivate = vi.fn();
    let label = 'Compiler payload';
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="payload-only">__LANIA_SLOT_0__</section>'
      ),
      97
    );
    const createPayload = () => ({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 97,
        template: {
          html: '<section data-pane="payload-only">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'payload-only-scope',
          key: 'payload-only-key',
          max: 2,
          include: ['payload-only-key'],
        },
        metadata: {
          onActivate,
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => label,
        },
      ],
    });

    slot.write(createPayload());
    expect(host.querySelector('[data-pane="payload-only"]')?.textContent).toBe(
      'Compiler payload'
    );

    label = 'Compiler payload updated';
    slot.write(createPayload());
    expect(host.querySelector('[data-pane="payload-only"]')?.textContent).toBe(
      'Compiler payload updated'
    );
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(
      expect.any(Array),
      'payload-only-key',
      false
    );
  });

  it('accepts KeepAlive block payloads without explicit bindings', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-empty-bindings');
    host.appendChild(anchor);

    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="empty-bindings">Stable</section>'
      ),
      79
    );

    slot.write(
      createKeepAliveBlockPayload({
        slotIndex: 79,
        cacheKey: 'empty-bindings',
        scope: 'runtime-slot-keepalive-empty-bindings',
        html: '<section data-pane="empty-bindings">Stable</section>',
      })
    );

    expect(
      host.querySelector('[data-pane="empty-bindings"]')?.textContent
    ).toBe('Stable');
  });

  it('rehydrates KeepAlive slot content and reuses the hydrated nodes after cache switches', () => {
    const host = document.createElement('div');
    host.innerHTML = `<main>${ssrRenderBlockSlot(
      0,
      '<section data-pane="hydrated">Page A</section>',
      'keepalive'
    )}</main>`;
    const mounted = mountStaticTemplate(
      host,
      createStaticTemplate('<main><!--__LANIA_SLOT_0__--></main>'),
      { hydrate: true }
    );
    const anchor = resolveSlotAnchor(mounted, 0, [0, 0]);
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="hydrated">__LANIA_SLOT_0__</section>'
      ),
      99
    );

    if (hasHydrationSlot(mounted, 0)) {
      slot.hydrate(readHydrationSlotNodes(mounted, 0));
    }

    const hydratedPane = host.querySelector('[data-pane="hydrated"]');
    expect(hydratedPane?.textContent).toBe('Page A');

    slot.write({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 99,
        template: {
          html: '<section data-pane="hydrated">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'hydrated-keepalive-slot',
          key: 'page-a',
          max: 2,
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'Page A updated',
        },
      ],
    });

    expect(host.querySelectorAll('[data-pane="hydrated"]')).toHaveLength(1);
    expect(host.querySelector('[data-pane="hydrated"]')).toBe(hydratedPane);
    expect(host.querySelector('[data-pane="hydrated"]')?.textContent).toBe(
      'Page A updated'
    );

    slot.write({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 99,
        template: {
          html: '<section data-pane="hydrated">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'hydrated-keepalive-slot',
          key: 'page-b',
          max: 2,
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'Page B',
        },
      ],
    });

    const pageBPane = host.querySelector('[data-pane="hydrated"]');
    expect(pageBPane).not.toBe(hydratedPane);
    expect(pageBPane?.textContent).toBe('Page B');

    slot.write({
      __lania_keepalive: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 99,
        template: {
          html: '<section data-pane="hydrated">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'hydrated-keepalive-slot',
          key: 'page-a',
          max: 2,
        },
      },
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'Page A updated again',
        },
      ],
    });

    expect(host.querySelectorAll('[data-pane="hydrated"]')).toHaveLength(1);
    expect(host.querySelector('[data-pane="hydrated"]')).toBe(hydratedPane);
    expect(host.querySelector('[data-pane="hydrated"]')?.textContent).toBe(
      'Page A updated'
    );
  });

  it('rehydrates KeepAlive slot branches with nested When content and restores the hydrated branch after key switches', () => {
    const host = document.createElement('div');
    host.innerHTML = `<main>${ssrRenderBlockSlot(
      0,
      '<div data-key="page-a"><input data-pane="hydrated-when" value="draft"></div>',
      'keepalive'
    )}</main>`;
    const mounted = mountStaticTemplate(
      host,
      createStaticTemplate('<main><!--__LANIA_SLOT_0__--></main>'),
      { hydrate: true }
    );
    const anchor = resolveSlotAnchor(mounted, 0, [0, 0]);
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate('__LANIA_SLOT_0____LANIA_SLOT_1__'),
      100
    );
    let currentPage: 'page-a' | 'page-b' = 'page-a';
    const createPayload = (cacheKey: 'page-a' | 'page-b') =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 100,
          cacheKey,
          scope: 'hydrated-keepalive-when-slot',
          max: 2,
          html: '__LANIA_SLOT_0____LANIA_SLOT_1__',
        },
        [
          {
            kind: 'if' as const,
            slotIndex: 0,
            path: [0],
            template: createStaticTemplate(
              '<div data-key="page-a"><input data-pane="hydrated-when"></input></div>'
            ),
            evaluate: () => ({
              __lania_if: 'block' as const,
              when: currentPage === 'page-a',
            }),
          },
          {
            kind: 'if' as const,
            slotIndex: 1,
            path: [1],
            template: createStaticTemplate(
              '<div data-key="page-b">Page B</div>'
            ),
            evaluate: () => ({
              __lania_if: 'block' as const,
              when: currentPage === 'page-b',
            }),
          },
        ]
      );

    if (hasHydrationSlot(mounted, 0)) {
      slot.hydrate(readHydrationSlotNodes(mounted, 0));
    }

    const hydratedInput = host.querySelector(
      '[data-pane="hydrated-when"]'
    ) as HTMLInputElement | null;
    expect(hydratedInput?.value).toBe('draft');
    expect(host.querySelector('[data-key="page-b"]')).toBeNull();

    slot.write(createPayload('page-a'));
    expect(host.querySelector('[data-pane="hydrated-when"]')).toBe(
      hydratedInput
    );
    expect(
      (
        host.querySelector(
          '[data-pane="hydrated-when"]'
        ) as HTMLInputElement | null
      )?.value
    ).toBe('draft');

    currentPage = 'page-b';
    slot.write(createPayload('page-b'));
    expect(host.querySelector('[data-pane="hydrated-when"]')).toBeNull();
    expect(host.querySelector('[data-key="page-b"]')?.textContent).toBe(
      'Page B'
    );

    currentPage = 'page-a';
    slot.write(createPayload('page-a'));
    const restoredInput = host.querySelector(
      '[data-pane="hydrated-when"]'
    ) as HTMLInputElement | null;
    expect(restoredInput).toBe(hydratedInput);
    expect(restoredInput?.value).toBe('draft');
    expect(host.querySelector('[data-key="page-b"]')).toBeNull();
  });

  it('preserves Each-style keyed-slots content across KeepAlive key switches when nested under TransitionGroup', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-transition-group');
    host.appendChild(anchor);

    const runtimeHost = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      const slot = new KeepAliveSlot(
        anchor,
        createStaticTemplate(
          '<section data-pane="ka-tg"><!--__LANIA_SLOT_0__--></section>'
        ),
        101
      );

      const dynamicChildTemplate = createStaticTemplate(
        '<!--__LANIA_SLOT_0__-->'
      );
      const itemTemplate = createStaticTemplate(
        '<li data-key="" data-page="">__LANIA_SLOT_0__</li>'
      );

      let currentPage: 'page-a' | 'page-b' = 'page-a';
      let items: Array<{ id: string; label: string }> = [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ];

      const writePage = (cacheKey: 'page-a' | 'page-b') => {
        withContextHost(runtimeHost, () => {
          slot.write(
            createKeepAliveBlockPayload(
              {
                slotIndex: 101,
                cacheKey,
                scope: 'runtime-slot-keepalive-transition-group-each',
                max: 2,
                metadata: {
                  onActivate: () => {},
                  onDeactivate: () => {},
                  onCache: () => {},
                  onEvict: () => {},
                },
              },
              [
                {
                  kind: 'dynamic' as const,
                  slotIndex: 0,
                  path: [0, 0],
                  template: dynamicChildTemplate,
                  evaluate: () => ({
                    __lania_dynamic: 'block' as const,
                    component: TransitionGroup,
                    props: {
                      groupKey: cacheKey,
                      keys: items.map((item) => item.id),
                      payload: {
                        protocol: ENHANCED_CONTRACT_PROTOCOL,
                        version: ENHANCED_CONTRACT_VERSION,
                        payloadKind: 'transition' as const,
                        component: 'TransitionGroup' as const,
                        irKind: 'TransitionIR' as const,
                        transitionIndex: 0,
                        transition: {
                          name: 'list',
                          phases: ['appear', 'enter', 'move', 'leave'] as const,
                          keyProp: 'groupKey' as const,
                          key: cacheKey,
                          hooks: {},
                        },
                      },
                    },
                    childBindings: [
                      {
                        kind: 'for' as const,
                        slotIndex: 0,
                        path: [0],
                        evaluate: () => ({
                          __lania_for: 'keyed-slots' as const,
                          items,
                          key: (item: { id: string }) => item.id,
                          template: itemTemplate,
                          bindings: [
                            {
                              kind: 'attr' as const,
                              slotIndex: 0,
                              path: [0],
                              name: 'data-key',
                              evaluate: (item: { id: string }) => item.id,
                            },
                            {
                              kind: 'attr' as const,
                              slotIndex: 2,
                              path: [0],
                              name: 'data-page',
                              evaluate: () => currentPage,
                            },
                            {
                              kind: 'text' as const,
                              slotIndex: 1,
                              path: [0, 0],
                              evaluate: (item: { label: string }) => item.label,
                            },
                          ],
                        }),
                      },
                    ],
                  }),
                },
              ]
            )
          );
        });
      };

      currentPage = 'page-a';
      items = [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ];
      writePage('page-a');
      await flushMicrotasks(3);

      const firstAItems = Array.from(
        host.querySelectorAll('li')
      ) as HTMLLIElement[];
      expect(firstAItems.map((node) => node.getAttribute('data-key'))).toEqual([
        'a',
        'b',
      ]);
      expect(host.querySelectorAll('li[data-page="page-a"]')).toHaveLength(2);

      currentPage = 'page-b';
      items = [
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ];
      writePage('page-b');
      await flushMicrotasks(3);

      const pageBItems = Array.from(
        host.querySelectorAll('li')
      ) as HTMLLIElement[];
      expect(pageBItems.map((node) => node.getAttribute('data-key'))).toEqual([
        'c',
        'd',
      ]);
      expect(host.querySelectorAll('li[data-page="page-b"]')).toHaveLength(2);
      expect(host.querySelector('li[data-page="page-a"]')).toBeNull();

      currentPage = 'page-a';
      items = [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ];
      writePage('page-a');
      await flushMicrotasks(3);

      const restoredAItems = Array.from(
        host.querySelectorAll('li')
      ) as HTMLLIElement[];
      expect(
        restoredAItems.map((node) => node.getAttribute('data-key'))
      ).toEqual(['a', 'b']);
      expect(restoredAItems[0]).toBe(firstAItems[0]);
      expect(restoredAItems[1]).toBe(firstAItems[1]);
      expect(host.querySelectorAll('li[data-page="page-a"]')).toHaveLength(2);
      expect(host.querySelector('li[data-page="page-b"]')).toBeNull();
    } finally {
      globalThis.requestAnimationFrame = previousRaf;
    }
  });

  it('updates and remounts the active KeepAlive entry when the same key is written again', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-same-key');
    host.appendChild(anchor);

    let label = 'First';
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="same-key">__LANIA_SLOT_0__</section>'
      ),
      75
    );
    const createPayload = () =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 75,
          cacheKey: 'pane-a',
          scope: 'runtime-slot-keepalive-same-key',
          max: 2,
        },
        [
          {
            kind: 'text' as const,
            slotIndex: 0,
            path: [0, 0],
            evaluate: () => label,
          },
        ]
      );

    slot.write(createPayload());
    const pane = host.querySelector('[data-pane="same-key"]');
    expect(pane?.textContent).toBe('First');
    expect(pane).not.toBeNull();

    pane?.remove();
    expect(host.querySelector('[data-pane="same-key"]')).toBeNull();

    label = 'Second';
    slot.write(createPayload());
    const remountedPane = host.querySelector('[data-pane="same-key"]');
    expect(remountedPane).toBe(pane);
    expect(remountedPane?.textContent).toBe('Second');

    label = 'Third';
    slot.write(createPayload());
    expect(host.querySelectorAll('[data-pane="same-key"]')).toHaveLength(1);
    expect(host.querySelector('[data-pane="same-key"]')?.textContent).toBe(
      'Third'
    );
  });

  it('renders fresh uncached content when KeepAlive payload is not cacheable', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-uncached');
    host.appendChild(anchor);

    let label = 'Blocked A';
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate(
        '<section data-pane="uncached">__LANIA_SLOT_0__</section>'
      ),
      76
    );
    const createPayload = () =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 76,
          cacheKey: 'pane-a',
          scope: 'runtime-slot-keepalive-uncached',
          include: ['pane-b'],
        },
        [
          {
            kind: 'text' as const,
            slotIndex: 0,
            path: [0, 0],
            evaluate: () => label,
          },
        ]
      );

    slot.write(createPayload());
    const firstPane = host.querySelector('[data-pane="uncached"]');
    expect(firstPane?.textContent).toBe('Blocked A');

    label = 'Blocked B';
    slot.write(createPayload());
    const secondPane = host.querySelector('[data-pane="uncached"]');
    expect(secondPane?.textContent).toBe('Blocked B');
    expect(secondPane).not.toBe(firstPane);
    expect(host.querySelectorAll('[data-pane="uncached"]')).toHaveLength(1);
  });

  it('clears the previous uncached instance before mounting the next one', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-uncached-ref');
    host.appendChild(anchor);

    const refA = { current: null as HTMLButtonElement | null };
    const refB = { current: null as HTMLButtonElement | null };
    let activeRef = refA;
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate('<button data-pane="uncached-ref">Action</button>'),
      80
    );
    const createPayload = () =>
      createKeepAliveBlockPayload(
        {
          slotIndex: 80,
          cacheKey: 'pane-a',
          scope: 'runtime-slot-keepalive-uncached-ref',
          include: ['pane-b'],
        },
        [
          {
            kind: 'ref' as const,
            slotIndex: 0,
            path: [0],
            evaluate: () => activeRef,
          },
        ]
      );

    slot.write(createPayload());
    await flushMicrotasks();
    const firstButton = host.querySelector('[data-pane="uncached-ref"]');
    expect(refA.current).toBe(firstButton);

    activeRef = refB;
    slot.write(createPayload());
    await flushMicrotasks();
    const secondButton = host.querySelector('[data-pane="uncached-ref"]');
    expect(secondButton).not.toBe(firstButton);
    expect(refA.current).toBeNull();
    expect(refB.current).toBe(secondButton);
  });

  it('deactivates the active cached KeepAlive entry when the slot is destroyed', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('keepalive-destroy');
    host.appendChild(anchor);

    const ref = { current: null as HTMLButtonElement | null };
    const onDeactivate = vi.fn();
    const slot = new KeepAliveSlot(
      anchor,
      createStaticTemplate('<button data-pane="destroy">Action</button>'),
      77
    );

    slot.write(
      createKeepAliveBlockPayload(
        {
          slotIndex: 77,
          cacheKey: 'pane-a',
          scope: 'runtime-slot-keepalive-destroy',
          metadata: {
            onDeactivate,
          },
        },
        [
          {
            kind: 'ref' as const,
            slotIndex: 0,
            path: [0],
            evaluate: () => ref,
          },
        ]
      )
    );

    const button = host.querySelector('[data-pane="destroy"]');
    await flushMicrotasks();
    expect(button).not.toBeNull();
    expect(ref.current).toBe(button);

    slot.destroy();
    await flushMicrotasks();

    expect(host.querySelector('[data-pane="destroy"]')).toBeNull();
    expect(ref.current).toBeNull();
    expect(onDeactivate).toHaveBeenCalledTimes(1);
    expect(onDeactivate).toHaveBeenCalledWith(expect.any(Array), 'pane-a');
  });

  it('remounts branch nodes in IfSlot block payloads by default', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('if');
    host.appendChild(anchor);
    const slot = new IfSlot(
      anchor,
      createStaticTemplate('<input></input>'),
      71,
      createStaticTemplate('<span>Hidden</span>')
    );

    slot.write({
      __lania_if: 'block' as const,
      when: true,
      truthyBindings: [],
      falsyBindings: [],
    } as any);
    const input = host.querySelector('input') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    if (!input) {
      throw new Error('expected input branch to mount');
    }

    input.value = 'draft';
    slot.write({
      __lania_if: 'block' as const,
      when: false,
      truthyBindings: [],
      falsyBindings: [],
    } as any);
    slot.write({
      __lania_if: 'block' as const,
      when: true,
      truthyBindings: [],
      falsyBindings: [],
    } as any);

    const remountedInput = host.querySelector(
      'input'
    ) as HTMLInputElement | null;
    expect(remountedInput).not.toBe(input);
    expect(remountedInput?.value).toBe('');
  });

  it('reuses cached branch nodes in IfSlot block payloads when mode is retain', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('if');
    host.appendChild(anchor);
    const slot = new IfSlot(
      anchor,
      createStaticTemplate('<input></input>'),
      72,
      createStaticTemplate('<span>Hidden</span>')
    );

    slot.write({
      __lania_if: 'block' as const,
      when: true,
      mode: 'retain' as const,
      truthyBindings: [],
      falsyBindings: [],
    } as any);
    const input = host.querySelector('input') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    if (!input) {
      throw new Error('expected input branch to mount');
    }

    input.value = 'draft';
    slot.write({
      __lania_if: 'block' as const,
      when: false,
      mode: 'retain' as const,
      truthyBindings: [],
      falsyBindings: [],
    } as any);
    slot.write({
      __lania_if: 'block' as const,
      when: true,
      mode: 'retain' as const,
      truthyBindings: [],
      falsyBindings: [],
    } as any);

    const remountedInput = host.querySelector(
      'input'
    ) as HTMLInputElement | null;
    expect(remountedInput).toBe(input);
    expect(remountedInput?.value).toBe('draft');
  });

  it('mounts and cleans teleported content through TeleportSlot', () => {
    const host = document.createElement('div');
    const portal = document.createElement('div');
    portal.id = 'portal-root';
    const anchor = document.createComment('teleport');
    host.appendChild(anchor);
    document.body.appendChild(portal);

    const slot = new TeleportSlot(
      anchor,
      createStaticTemplate('<span>Modal</span>'),
      8
    );

    slot.write({
      __lania_teleport: 'block',
      target: '#portal-root',
      bindings: [],
    });
    expect(portal.textContent).toBe('Modal');
    expect(host.textContent).toBe('');

    slot.destroy();
    expect(portal.textContent).toBe('');
    portal.remove();
  });

  it('moves teleported nodes without remounting them', () => {
    const host = document.createElement('div');
    const portalA = document.createElement('div');
    portalA.id = 'portal-a';
    const portalB = document.createElement('div');
    portalB.id = 'portal-b';
    const anchor = document.createComment('teleport');
    host.appendChild(anchor);
    document.body.append(portalA, portalB);

    const slot = new TeleportSlot(
      anchor,
      createStaticTemplate('<span>Modal</span>'),
      81
    );

    slot.write({
      __lania_teleport: 'block',
      target: '#portal-a',
      bindings: [],
    });
    const teleported = portalA.querySelector('span');
    expect(teleported?.textContent).toBe('Modal');

    slot.write({
      __lania_teleport: 'block',
      target: '#portal-b',
      bindings: [],
    });
    expect(portalA.querySelector('span')).toBeNull();
    expect(portalB.querySelector('span')).toBe(teleported);

    slot.destroy();
    portalA.remove();
    portalB.remove();
  });

  it('renders dynamic elements and swaps them through DynamicSlot', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<span>Child</span>'),
      9
    );

    slot.write({
      component: 'section',
      props: {
        id: 'dynamic-card',
      },
    });
    expect(host.querySelector('section')?.id).toBe('dynamic-card');
    expect(host.textContent).toBe('Child');

    slot.write({
      component: (props: { title?: string; children?: Node[] }) => {
        const article = document.createElement('article');
        article.setAttribute('data-title', props.title ?? '');
        props.children?.forEach((child) => article.appendChild(child));
        return article;
      },
      props: {
        title: 'fn',
      },
    });
    expect(host.querySelector('section')).toBeNull();
    expect(host.querySelector('article')?.getAttribute('data-title')).toBe(
      'fn'
    );
    expect(host.textContent).toBe('Child');

    slot.destroy();
    expect(host.textContent).toBe('');
  });

  it('updates dynamic elements in place when the target stays the same', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<span>Child</span>'),
      91
    );

    slot.write({
      __lania_dynamic: 'block',
      component: 'section',
      props: { id: 'stable-a' },
      childBindings: [],
    });
    const section = host.querySelector('section');
    const child = section?.querySelector('span');

    slot.write({
      __lania_dynamic: 'block',
      component: 'section',
      props: { id: 'stable-b' },
      childBindings: [],
    });

    expect(host.querySelector('section')).toBe(section);
    expect(host.querySelector('section')?.getAttribute('id')).toBe('stable-b');
    expect(host.querySelector('section span')).toBe(child);
  });

  it('updates function dynamic targets in place when the function reference stays the same', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<input></input>'),
      93
    );
    const renderCard = (props: { title?: string; children?: Node[] }) => {
      const article = document.createElement('article');
      article.setAttribute('title', props.title ?? '');
      props.children?.forEach((child) => article.appendChild(child));
      return article;
    };

    slot.write({
      __lania_dynamic: 'block',
      component: renderCard,
      props: { title: 'first' },
      childBindings: [],
    });
    const article = host.querySelector('article');
    const child = article?.querySelector('input');

    slot.write({
      __lania_dynamic: 'block',
      component: renderCard,
      props: { title: 'second' },
      childBindings: [],
    });

    expect(host.querySelector('article')).toBe(article);
    expect(host.querySelector('article')?.getAttribute('title')).toBe('second');
    expect(host.querySelector('article input')).toBe(child);
  });

  it('passes function child bindings through DynamicSlot into enhanced boundaries', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic-boundary');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->'),
      931
    );
    const runtimeHost = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };

    withContextHost(runtimeHost, () => {
      slot.write({
        __lania_dynamic: 'block',
        component: ErrorBoundary,
        props: {
          payload: {
            protocol: ENHANCED_CONTRACT_PROTOCOL,
            version: ENHANCED_CONTRACT_VERSION,
            payloadKind: 'boundary' as const,
            component: 'ErrorBoundary' as const,
            irKind: 'BoundaryIR' as const,
            boundaryIndex: 9,
            initialState: 'idle' as const,
            childrenTemplate: {},
            metadata: {
              boundaryKey: 'dynamic-boundary',
            },
          },
          fallback: 'failed',
        },
        childBindings: [
          {
            kind: 'text' as const,
            slotIndex: 0,
            path: [0],
            evaluate: () => () => {
              throw new Error('boom');
            },
          },
        ],
      });
    });

    await flushMicrotasks(2);
    expect(host.textContent).toBe('failed');
  });

  it('preserves KeepAlive function-child DOM state through DynamicSlot key switches', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic-keepalive');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->'),
      932
    );
    const runtimeHost = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    let currentPage: 'page-a' | 'page-b' = 'page-a';

    const writeKeepAlive = (cacheKey: 'page-a' | 'page-b') => {
      withContextHost(runtimeHost, () => {
        slot.write({
          __lania_dynamic: 'block',
          component: KeepAlive,
          props: {
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'cache' as const,
              component: 'KeepAlive' as const,
              irKind: 'KeepAliveIR' as const,
              slotIndex: 0,
              template: {},
              cache: {
                scope: 'dynamic-keepalive-state',
                key: cacheKey,
                max: 2,
              },
            },
          },
          childBindings: [
            {
              kind: 'text' as const,
              slotIndex: 0,
              path: [0],
              evaluate: () => () =>
                When({
                  when: currentPage === 'page-a',
                  fallback: (() => {
                    const pageB = document.createElement('div');
                    pageB.dataset.page = 'page-b';
                    pageB.textContent = 'Page B';
                    return pageB;
                  })(),
                  children: (() => {
                    const pageA = document.createElement('div');
                    pageA.dataset.page = 'page-a';
                    const input = document.createElement('input');
                    input.placeholder = 'type in Page A';
                    pageA.appendChild(input);
                    return pageA;
                  })(),
                }),
            },
          ],
        });
      });
    };

    writeKeepAlive('page-a');
    await flushMicrotasks(2);

    const firstInput = host.querySelector(
      '[data-page="page-a"] input'
    ) as HTMLInputElement | null;
    expect(firstInput).not.toBeNull();
    if (!firstInput) {
      throw new Error('expected page-a input to mount');
    }
    firstInput.value = 'draft';

    currentPage = 'page-b';
    writeKeepAlive('page-b');
    await flushMicrotasks(2);
    expect(host.querySelector('[data-page="page-a"]')).toBeNull();
    expect(host.querySelector('[data-page="page-b"]')?.textContent).toBe(
      'Page B'
    );

    currentPage = 'page-a';
    writeKeepAlive('page-a');
    await flushMicrotasks(2);

    const restoredInput = host.querySelector(
      '[data-page="page-a"] input'
    ) as HTMLInputElement | null;
    expect(restoredInput).toBe(firstInput);
    expect(restoredInput?.value).toBe('draft');
    expect(host.querySelector('[data-page="page-b"]')).toBeNull();
  });

  it('drives TransitionGroup dom-host handoff from payload-first dynamic slots with Each-style keyed blocks', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic-transition-group');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->'),
      94
    );
    const itemTemplate = createStaticTemplate(
      '<li data-key="">__LANIA_SLOT_0__</li>'
    );
    const phases: string[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    const runtimeHost = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let items = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];

    const writeGroup = () => {
      withContextHost(runtimeHost, () => {
        slot.write({
          __lania_dynamic: 'block',
          component: TransitionGroup,
          props: {
            keys: items.map((item) => item.id),
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'transition' as const,
              component: 'TransitionGroup' as const,
              irKind: 'TransitionIR' as const,
              transitionIndex: 0,
              transition: {
                name: 'list',
                phases: ['appear', 'enter', 'move', 'leave'] as const,
                keyProp: 'groupKey' as const,
                key: 'todos',
                tag: 'ul',
                hooks: {
                  onAppear: (_element, context) =>
                    phases.push(`appear:${String(context.key)}`),
                  onEnter: (_element, context) =>
                    phases.push(`enter:${String(context.key)}`),
                  onLeave: async (_element, context) => {
                    phases.push(`leave:${String(context.key)}`);
                    await Promise.resolve();
                  },
                  onMove: (_element, context) =>
                    phases.push(
                      `move:${String(context.key)}:${context.previousIndex}->${context.index}`
                    ),
                },
              },
            },
          },
          childBindings: [
            {
              kind: 'for',
              slotIndex: 0,
              path: [0],
              evaluate: () => ({
                __lania_for: 'keyed-slots' as const,
                items,
                key: (item: { id: string }) => item.id,
                template: itemTemplate,
                bindings: [
                  {
                    kind: 'attr' as const,
                    slotIndex: 0,
                    path: [0],
                    name: 'data-key',
                    evaluate: (item: { id: string }) => item.id,
                  },
                  {
                    kind: 'text' as const,
                    slotIndex: 1,
                    path: [0, 0],
                    evaluate: (item: { label: string }) => item.label,
                  },
                ],
              }),
            },
          ],
        });
      });
    };

    writeGroup();
    await flushMicrotasks(3);

    const container = host.querySelector('ul');
    expect(container).not.toBeNull();
    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual(['a', 'b']);

    items = [
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ];
    writeGroup();

    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual(['b', 'c', 'a']);

    await flushMicrotasks(3);
    await wait(0);
    writeGroup();

    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual(['b', 'c']);
    expect(phases).toEqual([
      'appear:a',
      'appear:b',
      'leave:a',
      'move:b:1->0',
      'enter:c',
    ]);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('routes dom-host TransitionGroup empty renders through commitLeaving and commitHidden during handed-off block teardown', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic-transition-group-empty');
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->'),
      96
    );
    const itemTemplate = createStaticTemplate(
      '<li data-key="">__LANIA_SLOT_0__</li>'
    );
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let resolveLeave: (() => void) | null = null;
    const leaveGate = new Promise<void>((resolve) => {
      resolveLeave = resolve;
    });
    const runtimeHost = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    let items = [{ id: 'a', label: 'A' }];

    const writeGroup = () => {
      withContextHost(runtimeHost, () => {
        slot.write({
          __lania_dynamic: 'block',
          component: TransitionGroup,
          props: {
            keys: items.map((item) => item.id),
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'transition' as const,
              component: 'TransitionGroup' as const,
              irKind: 'TransitionIR' as const,
              transitionIndex: 0,
              transition: {
                name: 'list-empty-dom-host',
                phases: ['appear', 'enter', 'move', 'leave'] as const,
                keyProp: 'groupKey' as const,
                key: 'todos-empty-dom-host',
                tag: 'ul',
                hooks: {
                  onLeave: async () => {
                    await leaveGate;
                  },
                },
              },
            },
          },
          childBindings: [
            {
              kind: 'for',
              slotIndex: 0,
              path: [0],
              evaluate: () => ({
                __lania_for: 'keyed-slots' as const,
                items,
                key: (item: { id: string }) => item.id,
                template: itemTemplate,
                bindings: [
                  {
                    kind: 'attr' as const,
                    slotIndex: 0,
                    path: [0],
                    name: 'data-key',
                    evaluate: (item: { id: string }) => item.id,
                  },
                  {
                    kind: 'text' as const,
                    slotIndex: 1,
                    path: [0, 0],
                    evaluate: (item: { label: string }) => item.label,
                  },
                ],
              }),
            },
          ],
        });
      });
    };

    writeGroup();
    await flushMicrotasks(3);
    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual(['a']);

    items = [];
    writeGroup();
    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual([]);
    expect(host.querySelector('ul')).not.toBeNull();

    writeGroup();
    expect(host.querySelector('ul')).not.toBeNull();
    expect([...host.querySelectorAll('li')]).toEqual([]);

    resolveLeave?.();
    await flushMicrotasks(4);
    await wait(0);

    writeGroup();
    expect(host.querySelector('ul')).not.toBeNull();
    expect([...host.querySelectorAll('li')]).toEqual([]);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('reactivates a handed-off TransitionGroup keyed block without duplicating stale leaving nodes', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment(
      'dynamic-transition-group-reactivate'
    );
    host.appendChild(anchor);
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<!--__LANIA_SLOT_0__-->'),
      95
    );
    const itemTemplate = createStaticTemplate(
      '<li data-key="">__LANIA_SLOT_0__</li>'
    );
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let items = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];

    const writeGroup = () => {
      withContextHost(
        {
          dispatchEvent() {
            return true;
          },
        },
        () => {
          slot.write({
            __lania_dynamic: 'block',
            component: TransitionGroup,
            props: {
              keys: items.map((item) => item.id),
              payload: {
                protocol: ENHANCED_CONTRACT_PROTOCOL,
                version: ENHANCED_CONTRACT_VERSION,
                payloadKind: 'transition' as const,
                component: 'TransitionGroup' as const,
                irKind: 'TransitionIR' as const,
                transitionIndex: 0,
                transition: {
                  name: 'list-reactivate',
                  phases: ['appear', 'enter', 'move', 'leave'] as const,
                  keyProp: 'groupKey' as const,
                  key: 'todos-reactivate',
                  tag: 'ul',
                  hooks: {
                    onLeave: async () => {
                      await Promise.resolve();
                    },
                  },
                },
              },
            },
            childBindings: [
              {
                kind: 'for',
                slotIndex: 0,
                path: [0],
                evaluate: () => ({
                  __lania_for: 'keyed-slots' as const,
                  items,
                  key: (item: { id: string }) => item.id,
                  template: itemTemplate,
                  bindings: [
                    {
                      kind: 'attr' as const,
                      slotIndex: 0,
                      path: [0],
                      name: 'data-key',
                      evaluate: (item: { id: string }) => item.id,
                    },
                    {
                      kind: 'text' as const,
                      slotIndex: 1,
                      path: [0, 0],
                      evaluate: (item: { label: string }) => item.label,
                    },
                  ],
                }),
              },
            ],
          });
        }
      );
    };

    writeGroup();
    await flushMicrotasks(3);

    items = [{ id: 'b', label: 'B' }];
    writeGroup();
    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual(['b', 'a']);

    items = [
      { id: 'a', label: 'A2' },
      { id: 'b', label: 'B' },
    ];
    writeGroup();
    await flushMicrotasks(3);

    expect(
      [...host.querySelectorAll('li')].map((node) =>
        node.getAttribute('data-key')
      )
    ).toEqual(['a', 'b']);
    expect(
      [...host.querySelectorAll('li')].map((node) => node.textContent)
    ).toEqual(['A2', 'B']);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('reuses non-keyed slot list instances by index', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    const slot = new ForSlot(anchor, 92);
    const payload = {
      __lania_for: 'slots' as const,
      items: ['A'],
      template: createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      bindings: [
        {
          kind: 'text' as const,
          slotIndex: 0,
          path: [0, 0],
          evaluate: (item: string) => item,
        },
      ],
    };

    slot.write(payload);
    const span = host.querySelector('span');
    expect(span?.textContent).toBe('A');

    slot.write({ ...payload, items: ['B'] });
    expect(host.querySelector('span')).toBe(span);
    expect(host.querySelector('span')?.textContent).toBe('B');
  });

  it('applies DynamicSlot event and directive metadata onto dynamic DOM targets', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('dynamic');
    host.appendChild(anchor);
    const clicked = vi.fn();
    const ref = { current: null as HTMLElement | null };
    const slot = new DynamicSlot(
      anchor,
      createStaticTemplate('<span>Action</span>'),
      10
    );

    slot.write({
      component: 'button',
      props: {
        __lania_events: [
          {
            name: 'click',
            handler: clicked,
            modifiers: ['prevent'],
          },
        ],
        __lania_directives: [
          {
            kind: 'class',
            name: 'active',
            value: true,
            modifiers: [],
          },
          {
            kind: 'style',
            name: 'width',
            value: 24,
            modifiers: [],
            unit: 'px',
          },
          {
            kind: 'ref',
            name: 'ref',
            value: ref,
            modifiers: [],
          },
        ],
      },
    });

    const button = host.querySelector('button') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
    await flushMicrotasks();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(button?.classList.contains('active')).toBe(true);
    expect(button?.style.width).toBe('24px');
    expect(ref.current).toBe(button);
  });

  it('registers, marks and destroys slots through SlotTable', () => {
    const text = new TextSlot(document.createTextNode('ready'), 0);
    const attr = new AttrSlot(document.createElement('div'), 'data-state', 1);
    const table = new SlotTable();

    table.register(text);
    table.register(attr);
    table.markDirty(1);

    expect(table.size).toBe(2);
    expect(table.get(0)).toBe(text);
    expect(table.isDirty(1)).toBe(true);
    expect(table.getDirtySlots()).toEqual([attr]);
    expect(table.getSlotsByFrequency('low')).toEqual([attr]);

    table.destroyAll();
    expect(table.size).toBe(0);
    expect(table.dirty).toBe(0n);
  });
});

describe('BoundarySlot', () => {
  it('renders Suspense fallback and retries children after promise resolution', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('boundary-suspense');
    host.appendChild(anchor);

    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });

    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      300,
      createStaticTemplate('<span>loading</span>')
    );

    slot.write({
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'Suspense',
        irKind: 'BoundaryIR',
        boundaryIndex: 0,
        initialState: 'idle',
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          suspenseKey: 'slot-suspense',
        },
      },
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => {
            if (!resolved) {
              throw pending;
            }
            return 'ready';
          },
        },
      ],
    });

    expect(host.textContent).toBe('loading');

    release();
    await pending;
    await flushMicrotasks(3);

    expect(host.textContent).toBe('ready');
  });

  it('supports nested Suspense boundary replay inside ErrorBoundary boundary', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('boundary-nested-suspense');
    host.appendChild(anchor);

    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });

    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<section><!--__LANIA_SLOT_0__--></section>'),
      303,
      createStaticTemplate('<span>failed</span>')
    );

    slot.write({
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'ErrorBoundary',
        irKind: 'BoundaryIR',
        boundaryIndex: 3,
        initialState: 'idle',
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          boundaryKey: 'slot-nested-error',
        },
      },
      bindings: [
        {
          kind: 'boundary',
          slotIndex: 0,
          path: [0, 0],
          template: createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
          fallbackTemplate: createStaticTemplate('<span>loading</span>'),
          evaluate: () => ({
            __lania_boundary: 'block',
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'boundary',
              component: 'Suspense',
              irKind: 'BoundaryIR',
              boundaryIndex: 4,
              initialState: 'idle',
              childrenTemplate: {},
              fallbackTemplate: {},
              metadata: {
                suspenseKey: 'slot-nested-suspense',
              },
            },
            bindings: [
              {
                kind: 'text',
                slotIndex: 0,
                path: [0, 0],
                evaluate: () => {
                  if (!resolved) {
                    throw pending;
                  }
                  return 'ready';
                },
              },
            ],
          }),
        },
      ],
    });

    expect(host.textContent).toBe('loading');

    release();
    await pending;
    await flushMicrotasks(3);

    expect(host.textContent).toBe('ready');
  });

  it('hydrates nested Suspense fallback inside ErrorBoundary boundary and restores children on the next client write', async () => {
    const host = document.createElement('div');
    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });

    host.innerHTML = `<main>${ssrRenderBlockSlot(
      0,
      ssrRenderEnhancedBoundary(
        'hydrated-error-boundary',
        'ErrorBoundary',
        `<section>${ssrRenderBlockSlot(
          0,
          ssrRenderEnhancedBoundary(
            'hydrated-suspense-boundary',
            'Suspense',
            '<span>loading</span>',
            {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'boundary' as const,
              component: 'Suspense' as const,
              irKind: 'BoundaryIR' as const,
              boundaryIndex: 401,
              initialState: 'idle' as const,
              childrenTemplate: {},
              fallbackTemplate: {},
              metadata: {
                suspenseKey: 'hydrated-nested-suspense',
                status: 'pending',
              },
            }
          ),
          'boundary'
        )}</section>`,
        {
          protocol: ENHANCED_CONTRACT_PROTOCOL,
          version: ENHANCED_CONTRACT_VERSION,
          payloadKind: 'boundary' as const,
          component: 'ErrorBoundary' as const,
          irKind: 'BoundaryIR' as const,
          boundaryIndex: 400,
          initialState: 'idle' as const,
          childrenTemplate: {},
          fallbackTemplate: {},
          metadata: {
            boundaryKey: 'hydrated-nested-error',
          },
        }
      ),
      'boundary'
    )}</main>`;

    const mounted = mountStaticTemplate(
      host,
      createStaticTemplate('<main><!--__LANIA_SLOT_0__--></main>'),
      { hydrate: true }
    );
    const anchor = resolveSlotAnchor(mounted, 0, [0, 0]);
    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<section><!--__LANIA_SLOT_0__--></section>'),
      305,
      createStaticTemplate('<span>failed</span>')
    );
    const payload = {
      __lania_boundary: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary' as const,
        component: 'ErrorBoundary' as const,
        irKind: 'BoundaryIR' as const,
        boundaryIndex: 400,
        initialState: 'idle' as const,
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          boundaryKey: 'hydrated-nested-error',
        },
      },
      bindings: [
        {
          kind: 'boundary' as const,
          slotIndex: 0,
          path: [0, 0],
          template: createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
          fallbackTemplate: createStaticTemplate('<span>loading</span>'),
          evaluate: () => ({
            __lania_boundary: 'block' as const,
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'boundary' as const,
              component: 'Suspense' as const,
              irKind: 'BoundaryIR' as const,
              boundaryIndex: 401,
              initialState: 'idle' as const,
              childrenTemplate: {},
              fallbackTemplate: {},
              metadata: {
                suspenseKey: 'hydrated-nested-suspense',
              },
            },
            bindings: [
              {
                kind: 'text' as const,
                slotIndex: 0,
                path: [0, 0],
                evaluate: () => {
                  if (!resolved) {
                    throw pending;
                  }
                  return 'ready';
                },
              },
            ],
          }),
        },
      ],
    };

    if (hasHydrationSlot(mounted, 0)) {
      slot.hydrate(readHydrationSlotNodes(mounted, 0), payload);
    }

    slot.write(payload);
    expect(host.textContent).toBe('loading');

    release();
    await pending;
    await flushMicrotasks(3);
    slot.write(payload);

    expect(host.textContent).toBe('ready');
  });

  it('lets outer ErrorBoundary catch nested Suspense reject replay inside BoundarySlot', async () => {
    const host = document.createElement('div');
    const anchor = document.createComment('boundary-nested-suspense-reject');
    host.appendChild(anchor);

    let rejectPending!: (reason: unknown) => void;
    const pending = new Promise<void>((_, reject) => {
      rejectPending = reject;
    });

    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<section><!--__LANIA_SLOT_0__--></section>'),
      304,
      createStaticTemplate('<span>failed</span>')
    );

    slot.write({
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'ErrorBoundary',
        irKind: 'BoundaryIR',
        boundaryIndex: 5,
        initialState: 'idle',
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          boundaryKey: 'slot-nested-error-reject',
        },
      },
      bindings: [
        {
          kind: 'boundary',
          slotIndex: 0,
          path: [0, 0],
          template: createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
          fallbackTemplate: createStaticTemplate('<span>loading</span>'),
          evaluate: () => ({
            __lania_boundary: 'block',
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'boundary',
              component: 'Suspense',
              irKind: 'BoundaryIR',
              boundaryIndex: 6,
              initialState: 'idle',
              childrenTemplate: {},
              fallbackTemplate: {},
              metadata: {
                suspenseKey: 'slot-nested-suspense-reject',
              },
            },
            bindings: [
              {
                kind: 'text',
                slotIndex: 0,
                path: [0, 0],
                evaluate: () => {
                  throw pending;
                },
              },
            ],
          }),
        },
      ],
    });

    expect(host.textContent).toBe('loading');

    rejectPending('boom');
    await pending.catch(() => {});
    await flushMicrotasks(3);

    expect(host.textContent).toBe('failed');
  });

  it('hydrates nested Suspense fallback and lets outer ErrorBoundary catch the next client reject write', async () => {
    const host = document.createElement('div');
    let rejected: unknown = null;
    let rejectPending!: (reason: unknown) => void;
    const pending = new Promise<void>((_, reject) => {
      rejectPending = reject;
    });

    host.innerHTML = `<main>${ssrRenderBlockSlot(
      0,
      ssrRenderEnhancedBoundary(
        'hydrated-error-boundary-reject',
        'ErrorBoundary',
        `<section>${ssrRenderBlockSlot(
          0,
          ssrRenderEnhancedBoundary(
            'hydrated-suspense-boundary-reject',
            'Suspense',
            '<span>loading</span>',
            {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'boundary' as const,
              component: 'Suspense' as const,
              irKind: 'BoundaryIR' as const,
              boundaryIndex: 403,
              initialState: 'idle' as const,
              childrenTemplate: {},
              fallbackTemplate: {},
              metadata: {
                suspenseKey: 'hydrated-nested-suspense-reject',
                status: 'pending',
              },
            }
          ),
          'boundary'
        )}</section>`,
        {
          protocol: ENHANCED_CONTRACT_PROTOCOL,
          version: ENHANCED_CONTRACT_VERSION,
          payloadKind: 'boundary' as const,
          component: 'ErrorBoundary' as const,
          irKind: 'BoundaryIR' as const,
          boundaryIndex: 402,
          initialState: 'idle' as const,
          childrenTemplate: {},
          fallbackTemplate: {},
          metadata: {
            boundaryKey: 'hydrated-nested-error-reject',
          },
        }
      ),
      'boundary'
    )}</main>`;

    const mounted = mountStaticTemplate(
      host,
      createStaticTemplate('<main><!--__LANIA_SLOT_0__--></main>'),
      { hydrate: true }
    );
    const anchor = resolveSlotAnchor(mounted, 0, [0, 0]);
    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<section><!--__LANIA_SLOT_0__--></section>'),
      306,
      createStaticTemplate('<span>failed</span>')
    );
    const payload = {
      __lania_boundary: 'block' as const,
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary' as const,
        component: 'ErrorBoundary' as const,
        irKind: 'BoundaryIR' as const,
        boundaryIndex: 402,
        initialState: 'idle' as const,
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          boundaryKey: 'hydrated-nested-error-reject',
        },
      },
      bindings: [
        {
          kind: 'boundary' as const,
          slotIndex: 0,
          path: [0, 0],
          template: createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
          fallbackTemplate: createStaticTemplate('<span>loading</span>'),
          evaluate: () => ({
            __lania_boundary: 'block' as const,
            payload: {
              protocol: ENHANCED_CONTRACT_PROTOCOL,
              version: ENHANCED_CONTRACT_VERSION,
              payloadKind: 'boundary' as const,
              component: 'Suspense' as const,
              irKind: 'BoundaryIR' as const,
              boundaryIndex: 403,
              initialState: 'idle' as const,
              childrenTemplate: {},
              fallbackTemplate: {},
              metadata: {
                suspenseKey: 'hydrated-nested-suspense-reject',
              },
            },
            bindings: [
              {
                kind: 'text' as const,
                slotIndex: 0,
                path: [0, 0],
                evaluate: () => {
                  if (rejected !== null) {
                    throw rejected;
                  }
                  throw pending;
                },
              },
            ],
          }),
        },
      ],
    };

    if (hasHydrationSlot(mounted, 0)) {
      slot.hydrate(readHydrationSlotNodes(mounted, 0), payload);
    }

    slot.write(payload);
    expect(host.textContent).toBe('loading');

    rejectPending('boom');
    await pending.catch((reason) => {
      rejected = reason;
    });
    await flushMicrotasks(3);
    slot.write(payload);

    expect(host.textContent).toBe('failed');
  });

  it('renders ErrorBoundary fallback when child bindings throw', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('boundary-error');
    host.appendChild(anchor);

    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      301,
      createStaticTemplate('<span>failed</span>')
    );

    slot.write({
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'ErrorBoundary',
        irKind: 'BoundaryIR',
        boundaryIndex: 1,
        initialState: 'idle',
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          boundaryKey: 'slot-error',
        },
      },
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0, 0],
          evaluate: () => {
            throw new Error('boom');
          },
        },
      ],
    });

    expect(host.textContent).toBe('failed');
  });

  it('renders function fallback carried by ErrorBoundary payload metadata', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('boundary-error-fn');
    host.appendChild(anchor);

    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      311
    );

    slot.write({
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'ErrorBoundary',
        irKind: 'BoundaryIR',
        boundaryIndex: 2,
        initialState: 'idle',
        childrenTemplate: {},
        metadata: {
          boundaryKey: 'slot-error-fn',
          fallback: (error: unknown) => {
            const node = document.createElement('p');
            node.textContent = `caught: ${String(error)}`;
            return node;
          },
        },
      },
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => {
            throw new Error('manual boom');
          },
        },
      ],
    });

    expect(host.textContent).toBe('caught: Error: manual boom');
  });

  it('renders LazyLoad fallback and auto-replays children after observer visibility', () => {
    const host = document.createElement('div');
    const anchor = document.createComment('boundary-lazy');
    host.appendChild(anchor);

    let callback: IntersectionObserverCallback | null = null;
    class MockIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    const slot = new BoundarySlot(
      anchor,
      createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      302,
      createStaticTemplate('<span>loading</span>')
    );

    slot.write({
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'LazyLoad',
        irKind: 'BoundaryIR',
        boundaryIndex: 2,
        initialState: 'inactive',
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          lazyKey: 'slot-lazy',
          once: true,
        },
      },
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'ready',
        },
      ],
    });

    expect(host.textContent).toContain('loading');
    callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(host.textContent).toContain('ready');
    vi.unstubAllGlobals();
  });

  it('replays the most recently mounted LazyLoad instance sharing a key', () => {
    const createSlotHost = () => {
      const host = document.createElement('div');
      const anchor = document.createComment('boundary-lazy');
      host.appendChild(anchor);
      return { host, anchor };
    };

    let callback: IntersectionObserverCallback | null = null;
    class MockIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    const payload = {
      __lania_boundary: 'block',
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary',
        component: 'LazyLoad',
        irKind: 'BoundaryIR',
        boundaryIndex: 3,
        initialState: 'inactive',
        childrenTemplate: {},
        fallbackTemplate: {},
        metadata: {
          lazyKey: 'remount-lazy',
          once: true,
        },
      },
      bindings: [
        {
          kind: 'text',
          slotIndex: 0,
          path: [0, 0],
          evaluate: () => 'ready',
        },
      ],
    };

    const first = createSlotHost();
    const firstSlot = new BoundarySlot(
      first.anchor,
      createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      303,
      createStaticTemplate('<span>loading</span>')
    );
    firstSlot.write(payload as never);
    expect(first.host.textContent).toContain('loading');

    // 卸载第一个实例，换一个同 key 的新实例：共享 observer 必须回调新实例。
    firstSlot.destroy();

    const second = createSlotHost();
    const secondSlot = new BoundarySlot(
      second.anchor,
      createStaticTemplate('<span>__LANIA_SLOT_0__</span>'),
      304,
      createStaticTemplate('<span>loading-2</span>')
    );
    secondSlot.write(payload as never);
    expect(second.host.textContent).toContain('loading-2');

    callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(second.host.textContent).toContain('ready');

    secondSlot.destroy();
    vi.unstubAllGlobals();
  });
});
