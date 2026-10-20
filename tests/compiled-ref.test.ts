// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as runtime from '@lania-v/runtime';
import * as advanced from '@lania-v/runtime/advanced';
import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

const loadComponent = (source: string): any => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/CompiledRef.lania.tsx',
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

const clickButton = (element: Element, index = 0): void => {
  element.shadowRoot?.querySelectorAll('button')[index]?.click();
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('compiled createRef bindings', () => {
  it('assigns the DOM element directly to the ref field', async () => {
    const ElementRef = loadComponent(`
import { createRef, createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function ElementRef() {
  const inputRef = createRef<HTMLInputElement>();
  const status = createSignal('unbound');
  return (
    <section>
      <input ref={inputRef} value="seed" />
      <button onClick={() => status.set(inputRef ? inputRef.value : 'missing')}>read</button>
      <button onClick={() => { if (inputRef) { inputRef.value = 'updated'; } }}>write</button>
      <output>{status.value}</output>
    </section>
  );
});
`);

    const element = runtime.mountComponent(document.body, ElementRef, {});
    await flush();

    clickButton(element, 0);
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('seed');
    expect(element.shadowRoot?.querySelector('input') as HTMLInputElement).toBeTruthy();

    clickButton(element, 1);
    expect((element.shadowRoot?.querySelector('input') as HTMLInputElement).value).toBe(
      'updated'
    );

    element.remove();
  });

  it('keeps legacy .current reads working for compiled refs', async () => {
    const LegacyRef = loadComponent(`
import { createRef, createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function LegacyRef() {
  const inputRef = createRef<HTMLInputElement>();
  const status = createSignal('unbound');
  return (
    <section>
      <input ref={inputRef} value="legacy" />
      <button onClick={() => status.set(inputRef.current?.value ?? 'missing')}>read</button>
      <output>{status.value}</output>
    </section>
  );
});
`);

    const element = runtime.mountComponent(document.body, LegacyRef, {});
    await flush();

    clickButton(element);
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('legacy');
    element.remove();
  });

  it('delivers the exposed surface for component refs', async () => {
    const Parent = loadComponent(`
import { createRef, createSignal, defineComponent, createExpose } from '@lania-v/runtime';

const Child = defineComponent(function Child(props: { ref?: { focus(): string } }) {
  createExpose(props, { focus: () => 'focused' });
  return <span>child</span>;
});

export default defineComponent(function Parent() {
  const childRef = createRef<{ focus(): string }>();
  const status = createSignal('unbound');
  return (
    <section>
      <Child ref={childRef} />
      <button onClick={() => status.set(childRef ? childRef.focus() : 'missing')}>read</button>
      <output>{status.value}</output>
    </section>
  );
});
`);

    const element = runtime.mountComponent(document.body, Parent, {});
    await flush();

    expect(element.shadowRoot?.querySelector('x-child')).toBeTruthy();

    clickButton(element);
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('focused');
    element.remove();
  });
});
