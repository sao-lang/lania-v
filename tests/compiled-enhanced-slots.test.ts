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
  await new Promise((resolve) => setTimeout(resolve, 40));
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

const compileModule = (source: string): string =>
  compileFunctionComponentTsxToModule('/virtual/Enhanced.lania.tsx', source);

const loadComponent = (source: string): any => {
  const moduleCode = compileModule(source);
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

const declaredRuntimeBindings = (moduleCode: string): Set<string> => {
  const head = moduleCode.split('\n').slice(0, 160);
  return new Set(head.map((line) => line.trim().replace(/,$/, '')));
};

describe('compiled enhanced component slots', () => {
  it('mounts a top-level custom element through ComponentSlot', async () => {
    const source = `
import { defineComponent } from '@lania-v/runtime';

export default defineComponent(function CustomElementParent() {
  return <section><x-child data-label="hello" /></section>;
});
`;
    const moduleCode = compileModule(source);
    expect(moduleCode).toContain('new ComponentSlot(');
    expect(declaredRuntimeBindings(moduleCode).has('ComponentSlot')).toBe(true);

    const Parent = loadComponent(source);
    const element = runtime.mountComponent(document.body, Parent, {});
    await flush();

    expect(element.shadowRoot?.querySelector('x-child')).toBeTruthy();
    element.remove();
  });

  it('mounts a top-level KeepAlive through KeepAliveSlot', async () => {
    const source = `
import { defineComponent, createSignal, KeepAlive } from '@lania-v/runtime';

export default defineComponent(function KeepAliveParent() {
  const key = createSignal('a');
  return (
    <section>
      <button onClick={() => key.set(key.value === 'a' ? 'b' : 'a')}>switch</button>
      <KeepAlive cacheKey={key.value}>
        <p>{key.value}</p>
      </KeepAlive>
    </section>
  );
});
`;
    const moduleCode = compileModule(source);
    expect(moduleCode).toContain('new KeepAliveSlot(');
    expect(declaredRuntimeBindings(moduleCode).has('KeepAliveSlot')).toBe(true);

    const Parent = loadComponent(source);
    const element = runtime.mountComponent(document.body, Parent, {});
    await flush();

    expect(element.shadowRoot?.textContent).toContain('a');
    element.remove();
  });
});
