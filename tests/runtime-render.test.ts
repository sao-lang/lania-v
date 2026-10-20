// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  ReactiveElement,
  TextSlot,
  applySSRChunk,
  attachSSRRenderContext,
  createSignal,
  createSSRRenderContext,
  createStaticTemplate,
  mountStaticTemplate,
  readHydrationBoundaries,
  readTeleportNodes,
  resolveTemplateNode,
  ssrDrainSuspenseChunks,
  ssrRenderSuspenseBoundary,
  ssrRenderTeleportContainer,
  ssrRenderTeleportSlot,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 2): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const CARD_TEMPLATE = createStaticTemplate(
  '<section><h1>Static title</h1><p>Count: <span>0</span></p></section>'
);

const GeneratedRenderElement = (() => {
  const existing = customElements.get('x-generated-render');

  if (existing) {
    return existing as typeof ReactiveElement;
  }

  class GeneratedRenderElementImpl extends ReactiveElement {
    readonly count = createSignal(0);
    mountCalls = 0;
    writeCalls = 0;
    private countSlot!: TextSlot;

    protected _renderAndMount(): void {
      this.mountCalls += 1;
      const mounted = mountStaticTemplate(this.renderRoot, CARD_TEMPLATE);
      const countNode = resolveTemplateNode(mounted.nodes, [0, 1, 1, 0]) as Text;

      this.countSlot = new TextSlot(countNode, 0);
      this._slots[0] = this.countSlot.node;
      this.trackSignal(this.count);
      this.registerUpdater(() => {
        this.writeCalls += 1;
        this.countSlot.write(this.count.value);
      });
      this.writeCalls += 1;
      this.countSlot.write(this.count.value);
    }
  }

  customElements.define('x-generated-render', GeneratedRenderElementImpl);
  return GeneratedRenderElementImpl;
})();

describe('runtime render helpers', () => {
  it('mounts static templates through DocumentFragment and resolves node paths', () => {
    const root = document.createElement('div');
    const mounted = mountStaticTemplate(root, CARD_TEMPLATE);

    expect(root.childNodes).toHaveLength(1);
    expect(mounted.nodes).toHaveLength(1);
    expect(resolveTemplateNode(mounted.nodes, [0, 0, 0]).textContent).toBe(
      'Static title'
    );
  });

  it('clones static trees per component instance instead of reusing live DOM nodes', async () => {
    expect(customElements.get('x-generated-render')).toBe(GeneratedRenderElement);

    const first = document.createElement(
      'x-generated-render'
    ) as InstanceType<typeof GeneratedRenderElement>;
    const second = document.createElement(
      'x-generated-render'
    ) as InstanceType<typeof GeneratedRenderElement>;

    document.body.append(first, second);
    await flushMicrotasks();

    const firstTitle = first.shadowRoot?.querySelector('h1');
    const secondTitle = second.shadowRoot?.querySelector('h1');

    expect(firstTitle?.textContent).toBe('Static title');
    expect(secondTitle?.textContent).toBe('Static title');
    expect(firstTitle).not.toBe(secondTitle);
  });

  it('does not recreate static nodes across repeated updates and only updates the dynamic text node', async () => {
    const element = document.createElement(
      'x-generated-render'
    ) as InstanceType<typeof GeneratedRenderElement>;

    document.body.appendChild(element);
    await flushMicrotasks();

    const title = element.shadowRoot?.querySelector('h1');
    const span = element.shadowRoot?.querySelector('span');

    expect(span?.textContent).toBe('0');

    element.count.set(2);
    await flushMicrotasks();
    element.count.set(5);
    await flushMicrotasks();

    expect(element.mountCalls).toBe(1);
    expect(element.shadowRoot?.querySelector('h1')).toBe(title);
    expect(element.shadowRoot?.querySelector('span')).toBe(span);
    expect(title?.textContent).toBe('Static title');
    expect(span?.textContent).toBe('5');
  });

  it('performs one targeted dynamic write per state change after mount', async () => {
    const element = document.createElement(
      'x-generated-render'
    ) as InstanceType<typeof GeneratedRenderElement>;

    document.body.appendChild(element);
    await flushMicrotasks();

    const baselineWrites = element.writeCalls;

    element.count.set(1);
    await flushMicrotasks();
    element.count.set(2);
    await flushMicrotasks();

    expect(element.writeCalls).toBe(baselineWrites + 2);
    expect(element.shadowRoot?.querySelector('span')?.textContent).toBe('2');
  });

  it('collects teleport SSR output into target containers and reuses hydrated target nodes', () => {
    const scope = attachSSRRenderContext({ title: 'Portal' }, createSSRRenderContext());
    const root = document.createElement('div');
    const target = document.createElement('div');
    target.id = 'portal-root';

    root.innerHTML = `<section>${ssrRenderTeleportSlot(0, '#portal-root', '<strong>Portal</strong>', scope)}</section>`;
    target.innerHTML = ssrRenderTeleportContainer(scope, '#portal-root');
    document.body.append(root, target);

    const mounted = mountStaticTemplate(
      root,
      createStaticTemplate('<section><!--__LANIA_SLOT_0__--></section>'),
      { hydrate: true }
    );
    const teleportedNodes = readTeleportNodes(mounted, 0, '#portal-root');

    expect(teleportedNodes).toHaveLength(1);
    expect(teleportedNodes[0]?.textContent).toBe('Portal');

    root.remove();
    target.remove();
  });

  it('serializes suspense boundaries and applies streamed SSR chunks back into the hydrated DOM', async () => {
    const scope = attachSSRRenderContext({}, createSSRRenderContext());
    let resolveChunk!: (value: string) => void;
    const html = ssrRenderSuspenseBoundary(
      0,
      () =>
        new Promise<string>((resolve) => {
          resolveChunk = resolve;
        }),
      '<p>Loading</p>',
      scope,
      {
        suspenseKey: 'hero',
      }
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    const mounted = mountStaticTemplate(root, createStaticTemplate(''), {
      hydrate: true,
    });

    const [boundary] = readHydrationBoundaries(mounted, 'Suspense');

    expect(boundary?.metadata).toMatchObject({
      suspenseKey: 'hero',
      status: 'pending',
    });
    expect(root.textContent).toContain('Loading');

    resolveChunk('<article>Ready</article>');
    const [chunk] = await ssrDrainSuspenseChunks(scope);

    expect(applySSRChunk(root, chunk ?? '')).toBe(true);
    expect(root.textContent).toContain('Ready');
  });

  it('preserves shared boundary payloads across suspense SSR markers and hydration reads', async () => {
    const scope = attachSSRRenderContext({}, createSSRRenderContext());
    let resolveChunk!: (value: string) => void;
    const html = ssrRenderSuspenseBoundary(
      1,
      () =>
        new Promise<string>((resolve) => {
          resolveChunk = resolve;
        }),
      '<p>Fallback</p>',
      scope,
      {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'boundary' as const,
        component: 'Suspense' as const,
        irKind: 'BoundaryIR' as const,
        boundaryIndex: 1,
        initialState: 'pending' as const,
        childrenTemplate: {
          html: '<article>Ready</article>',
        },
        fallbackTemplate: {
          html: '<p>Fallback</p>',
        },
        metadata: {
          suspenseKey: 'hero-contract',
        },
      }
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    const mounted = mountStaticTemplate(root, createStaticTemplate(''), {
      hydrate: true,
    });

    const [boundary] = readHydrationBoundaries(mounted, 'Suspense');

    expect(boundary?.payload).toMatchObject({
      protocol: ENHANCED_CONTRACT_PROTOCOL,
      payloadKind: 'boundary',
      component: 'Suspense',
    });
    expect(boundary?.metadata).toMatchObject({
      suspenseKey: 'hero-contract',
      status: 'pending',
    });

    resolveChunk('<article>Ready</article>');
    const [chunk] = await ssrDrainSuspenseChunks(scope);

    expect(decodeURIComponent(chunk ?? '')).toContain('"payloadKind":"boundary"');
    expect(applySSRChunk(root, chunk ?? '')).toBe(true);
  });
});
