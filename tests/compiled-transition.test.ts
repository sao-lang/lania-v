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
};

const loadComponent = (source: string): any => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/TransitionDemo.lania.tsx',
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

describe('compiled transition', () => {
  it('destructures BoundarySlot from the runtime entry', () => {
    const moduleCode = compileFunctionComponentTsxToModule(
      '/virtual/TransitionBinding.lania.tsx',
      `
import { createSignal, defineComponent, Transition } from '@lania-v/runtime';

export default defineComponent(function Demo() {
  const visible = createSignal(true);
  return (
    <Transition name="fade" onEnter={() => undefined}>
      <section>{String(visible.value)}</section>
    </Transition>
  );
});
`
    );

    expect(moduleCode).toContain('new BoundarySlot(');
    expect(moduleCode.split('\n').some((line) => line.trim() === 'BoundarySlot,')).toBe(true);
  });

  it('fires enter and leave hooks', async () => {
    const Demo = loadComponent(`
import { createSignal, defineComponent, Transition, When } from '@lania-v/runtime';

export default defineComponent(function Demo() {
  const visible = createSignal(true);
  const log = createSignal<string[]>([]);
  const push = (line: string) => log.set((prev) => [line, ...prev]);

  return (
    <section>
      <button onClick={() => visible.set(!visible.value)}>toggle</button>
      <Transition
        transitionKey="visibility"
        onEnter={(_el: Element, ctx: { phase: string }) => push('enter:' + ctx.phase)}
        onLeave={(_el: Element, ctx: { phase: string }) => push('leave:' + ctx.phase)}
      >
        <When value={visible.value}>
          <div>content</div>
        </When>
      </Transition>
      <output>{log.value.join(',')}</output>
    </section>
  );
});
`);

    const element = runtime.mountComponent(document.body, Demo, {});
    await flush();

    const button = element.shadowRoot?.querySelector('button') as HTMLButtonElement;
    const output = () => element.shadowRoot?.querySelector('output')?.textContent ?? '';

    button.click();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush();

    button.click();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush();

    expect(output()).toContain('leave');
    expect(output()).toContain('enter');
  });

  it('removes every leaving snapshot after the transition settles', async () => {
    const Demo = loadComponent(`
import { createSignal, defineComponent, Transition, When } from '@lania-v/runtime';

export default defineComponent(function LeaveCleanupDemo() {
  const visible = createSignal(true);
  return (
    <section>
      <button onClick={() => visible.set(!visible.value)}>toggle</button>
      <Transition transitionKey="cleanup">
        <When value={visible.value}>
          <div>content</div>
        </When>
      </Transition>
    </section>
  );
});
`);

    const element = runtime.mountComponent(document.body, Demo, {});
    await flush();

    const divCount = () => element.shadowRoot?.querySelectorAll('div').length ?? -1;
    const button = element.shadowRoot?.querySelector('button');
    const counts = [divCount()];

    for (let index = 0; index < 4; index += 1) {
      button?.click();
      await flush();
      counts.push(divCount());
    }

    // 每次出场都必须把离场快照彻底移除，否则重复切换会不断累积节点。
    expect(counts).toEqual([1, 0, 1, 0, 1]);
    element.remove();
  });
});
