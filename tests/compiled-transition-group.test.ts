// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as runtime from '@lania-v/runtime';
import * as advanced from '@lania-v/runtime/advanced';
import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

const loadComponent = (source: string): any => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/TransitionGroupDemo.lania.tsx',
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
    throw new Error(`Unexpected import: ${id}`);
  };

  new Function('exports', 'require', 'module', commonjs)(
    exportsObject,
    requireFn,
    moduleObject
  );

  return moduleObject.exports.default;
};

describe('compiled transition group', () => {
  it('fires enter/move/leave hooks', async () => {
    const Demo = loadComponent(`
import { createSignal, defineComponent, TransitionGroup, Each } from '@lania-v/runtime';

type Item = { id: string; label: string };

export default defineComponent(function Demo() {
  const items = createSignal<Item[]>([
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ]);
  const log = createSignal<string[]>([]);
  const push = (line: string) => log.set((prev) => [line, ...prev]);
  const keyOf = ((item: Item) => item.id) as never;

  return (
    <section>
      <button onClick={() => items.set([...items(), { id: 'd' + String(items().length), label: 'X' }])}>append</button>
      <button onClick={() => items.set(items().slice(1))}>remove</button>
      <button onClick={() => items.set([...items()].reverse())}>reverse</button>
      <TransitionGroup
        keys={items().map((item) => item.id)}
        onEnter={(_el: Element, ctx: { key: PropertyKey; phase: string }) => push('enter:' + String(ctx.key))}
        onLeave={(_el: Element, ctx: { key: PropertyKey; phase: string }) => push('leave:' + String(ctx.key))}
        onMove={(_el: Element, ctx: { key: PropertyKey; phase: string; index: number }) => push('move:' + String(ctx.key) + ':' + String(ctx.index))}
      >
        <Each items={items()} key={keyOf}>
          {(item: Item): any => <div data-key={item.id}>{item.label}</div>}
        </Each>
      </TransitionGroup>
      <output>{log().join(',')}</output>
    </section>
  );
});
`);

    const element = runtime.mountComponent(document.body, Demo, {});
    await flush();

    const buttons = [...(element.shadowRoot?.querySelectorAll('button') ?? [])];
    const output = () => element.shadowRoot?.querySelector('output')?.textContent ?? '';
    const itemsHtml = () =>
      [...(element.shadowRoot?.querySelectorAll('[data-key]') ?? [])]
        .map((node) => node.getAttribute('data-key'))
        .join(',');

    buttons[0].click();
    await flush();
    expect(itemsHtml()).toBe('a,b,c,d3');

    buttons[2].click();
    await flush();
    expect(itemsHtml()).toBe('d3,c,b,a');

    buttons[1].click();
    await flush();
    expect(itemsHtml()).toBe('c,b,a');

    expect(output()).toContain('enter');
    expect(output()).toContain('leave');
    expect(output()).toContain('move');
  });
});
