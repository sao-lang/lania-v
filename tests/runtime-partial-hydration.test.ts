// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

import * as runtime from '@lania-v/runtime';
import * as reactivityNs from '@lania-v/runtime/reactivity';
import * as runtimeInternalNs from '@lania-v/runtime/internal';
import * as advanced from '@lania-v/runtime/advanced';
import {
  SSR_HYDRATED_ATTRIBUTE,
  SSR_ISLAND_ATTRIBUTE,
  SSR_ISLAND_PROPS_ATTRIBUTE,
  collectIslands,
  hydrateIslandElement,
  hydrateIslands,
  parseIslandProps,
  renderToStringAsIsland,
  serializeIslandProps,
} from '@lania-v/runtime';
import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const loadModule = (source: string): Record<string, any> => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/IslandCard.lania.tsx',
    source
  );
  const commonjs = ts.transpileModule(moduleCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: '@lania-v/runtime',
      esModuleInterop: true,
      useDefineForClassFields: false,
    },
  }).outputText;
  const exportsObject: Record<string, unknown> = {};
  const moduleObject = { exports: exportsObject };
  const requireFn = (id: string): unknown => {
    if (id === '@lania-v/runtime') {
      return runtime;
    }
    if (id === '@lania-v/runtime/advanced') {
      return advanced;
    }
    if (id === '@lania-v/runtime/reactivity') {
      return reactivityNs;
    }
    if (id === '@lania-v/runtime/internal') {
      return runtimeInternalNs;
    }
    throw new Error(`Unexpected import: ${id}`);
  };

  new Function('exports', 'require', 'module', commonjs)(
    exportsObject,
    requireFn,
    moduleObject
  );

  return moduleObject.exports as Record<string, any>;
};

const loadComponent = (source: string): any => loadModule(source).default;

const ISLAND_SOURCE = `
import { defineComponent } from '@lania-v/runtime';
const IslandCard = defineComponent(function IslandCard(props: { title: string }) {
  return <div>{props.title}</div>;
});
IslandCard.hydration = 'manual';
export default IslandCard;
`;

describe('partial hydration islands', () => {
  it('serializes island props and drops non-serializable values', () => {
    const serialized = serializeIslandProps({
      title: 'a',
      count: 2,
      onTap: () => undefined,
      nested: { ok: true },
    });

    expect(JSON.parse(serialized)).toEqual({
      title: 'a',
      count: 2,
      nested: { ok: true },
    });
    expect(parseIslandProps(serialized)).toMatchObject({ count: 2 });
    expect(parseIslandProps('not-json')).toEqual({});
    expect(parseIslandProps(null)).toEqual({});
  });

  it('emits island metadata alongside the declarative shadow root', () => {
    const IslandCard = loadComponent(ISLAND_SOURCE);
    const html = renderToStringAsIsland(
      IslandCard,
      { title: 'Island' },
      { tagName: 'island-card', priority: 'visible', name: 'IslandCard' }
    );

    expect(html).toContain(`${SSR_ISLAND_ATTRIBUTE}="visible"`);
    expect(html).toContain('data-lania-island-name="IslandCard"');
    expect(html).toContain(
      `${SSR_ISLAND_PROPS_ATTRIBUTE}="{&quot;title&quot;:&quot;Island&quot;}"`
    );
    expect(html).toContain('<template shadowrootmode="open">');
  });

  it('keeps manual components static until hydrate() is called', async () => {
    const IslandCard = loadComponent(ISLAND_SOURCE);
    runtime.defineComponent(IslandCard);
    const tagName = runtime.getComponentTagName(IslandCard) as string;

    const html = renderToStringAsIsland(
      IslandCard,
      { title: 'SSR' },
      { tagName }
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const element = container.firstElementChild as HTMLElement & {
      hydrate: () => void;
      isHydrated: boolean;
      title: string;
    };
    await flush();

    expect(element.isHydrated).toBe(false);
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('SSR');

    element.title = 'SSR';
    element.hydrate();
    await flush();
    expect(element.isHydrated).toBe(true);
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('SSR');

    element.title = 'Client';
    await flush();
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe(
      'Client'
    );

    element.remove();
    container.remove();
  });

  it('hydrates only eager islands and applies serialized props', async () => {
    const IslandCard = loadComponent(ISLAND_SOURCE);
    runtime.defineComponent(IslandCard);
    const tagName = runtime.getComponentTagName(IslandCard) as string;

    const container = document.createElement('div');
    container.innerHTML =
      renderToStringAsIsland(IslandCard, { title: 'First' }, { tagName }) +
      renderToStringAsIsland(
        IslandCard,
        { title: 'Second' },
        { tagName, priority: 'interaction' }
      );
    document.body.appendChild(container);

    const [first, second] = Array.from(container.children) as Array<
      HTMLElement & { isHydrated: boolean; title: string }
    >;
    await flush();

    const records = collectIslands(container);
    expect(records).toHaveLength(2);
    expect(records[0]?.props).toEqual({ title: 'First' });

    const onHydrate = vi.fn();
    await hydrateIslands({
      root: container,
      components: { [tagName]: runtime.defineComponent(IslandCard) },
      onHydrate,
    });
    await flush();

    expect(first?.isHydrated).toBe(true);
    expect(first?.shadowRoot?.querySelector('div')?.textContent).toBe('First');
    expect(first?.hasAttribute(SSR_HYDRATED_ATTRIBUTE)).toBe(true);

    // interaction island 只有触发事件后才接管。
    expect(second?.isHydrated).toBe(false);
    second?.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(second?.isHydrated).toBe(true);
    expect(second?.shadowRoot?.querySelector('div')?.textContent).toBe(
      'Second'
    );
    expect(onHydrate).toHaveBeenCalledTimes(2);

    first?.remove();
    second?.remove();
    container.remove();
  });

  it('reports when an island cannot be hydrated yet', () => {
    const element = document.createElement('div');
    element.setAttribute(SSR_ISLAND_ATTRIBUTE, 'eager');
    expect(
      hydrateIslandElement({
        element,
        name: 'missing',
        priority: 'eager',
        props: {},
      })
    ).toBe(false);
    expect(element.hasAttribute(SSR_HYDRATED_ATTRIBUTE)).toBe(false);
  });

  it('compiles <Child client:visible /> into an SSR island and hydrates it on demand', async () => {
    const IslandModule = loadModule(`
import { defineComponent } from '@lania-v/runtime';

const IslandChild = defineComponent(function IslandChild(props: { label: string }) {
  return <span class="island-child">{props.label}</span>;
});

const IslandParent = defineComponent(function IslandParent() {
  return (
    <section>
      <h2>parent</h2>
      <IslandChild client:visible label="nested" />
    </section>
  );
});

export default IslandParent;
`);

    const ParentClass = IslandModule.default;
    const ChildClass = IslandModule.IslandChild;

    // 1) SSR：父组件输出宿主 + DSD，内部包含 island 宿主（子组件自己输出 DSD 内容）
    const html = runtime.renderComponentToString(
      ParentClass,
      {},
      {
        tagName: 'island-parent',
      }
    );
    expect(html).toContain('data-lania-island="visible"');
    expect(html).toContain('data-lania-island-name="IslandChild"');
    expect(html).toContain('data-lania-island-props');
    expect(html).toContain('<template shadowrootmode="open">');
    expect(html).toContain('island-child');

    // 2) 客户端：先只挂父组件，island 保持静态
    runtime.defineComponent(ParentClass);
    runtime.defineComponent(ChildClass);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    await flush();

    const parent = container.firstElementChild as HTMLElement & {
      isHydrated: boolean;
    };
    const island = parent.shadowRoot?.querySelector('island-child') as
      (HTMLElement & { isHydrated: boolean }) | null;

    expect(parent.isHydrated).toBe(true);
    expect(island).not.toBeNull();
    // island 宿主升级后仍然保持静态（SSR 内容可见，但没有被接管）
    expect(island?.isHydrated).toBe(false);
    expect(
      island?.shadowRoot?.querySelector('.island-child')?.textContent
    ).toBe('nested');

    // 3) hydrateIslands 只接管 island，不影响已水合的父组件
    const hydrated = await hydrateIslands({
      root: parent.shadowRoot ?? container,
    });
    await flush();

    expect(hydrated.length).toBe(1);
    expect(island?.isHydrated).toBe(true);
    expect(
      island?.shadowRoot?.querySelector('.island-child')?.textContent
    ).toBe('nested');

    parent.remove();
    container.remove();
  });
});
