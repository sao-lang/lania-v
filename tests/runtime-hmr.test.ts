// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as runtime from '@lania-v/runtime';
import * as advanced from '@lania-v/runtime/advanced';
import {
  applyComponentHmrUpdate,
  captureComponentState,
  installComponentHmr,
  isComponentHmrEnabled,
  restoreComponentState,
  uninstallComponentHmr,
} from '@lania-v/runtime';
import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const loadComponent = (source: string, options: { hotReload?: boolean } = {}): any => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/HmrCard.lania.tsx',
    source,
    options
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

const cardSource = (label: string, name = 'HmrCard'): string => `
import { createSignal, defineComponent } from '@lania-v/runtime';
const ${name} = defineComponent(function ${name}(props: { title: string }) {
  const count = createSignal(0);
  return (
    <div>
      <button onClick={() => count.set(count.value + 1)}>inc</button>
      <output>{count.value}</output>
      <span class="label">${label}</span>
    </div>
  );
});
export default ${name};
`;

// dev 产物：多一个新的 setup 状态 + 改模板，用于验证 HMR 能补建新状态且保留旧值。
const cardWithExtraStateSource = (name = 'HmrSetupCard'): string => `
import { createSignal, defineComponent } from '@lania-v/runtime';
const ${name} = defineComponent(function ${name}(props: { title: string }) {
  const count = createSignal(0);
  const note = createSignal('fresh');
  return (
    <div>
      <button onClick={() => count.set(count.value + 1)}>inc</button>
      <output>{count.value}</output>
      <span class="note">{note.value}</span>
    </div>
  );
});
export default ${name};
`;

const cardWithoutExtraStateSource = (name = 'HmrSetupCard'): string => `
import { createSignal, defineComponent } from '@lania-v/runtime';
const ${name} = defineComponent(function ${name}(props: { title: string }) {
  const count = createSignal(0);
  return (
    <div>
      <button onClick={() => count.set(count.value + 1)}>inc</button>
      <output>{count.value}</output>
    </div>
  );
});
export default ${name};
`;

afterEach(() => {
  uninstallComponentHmr();
});

describe('component HMR state preservation', () => {
  it('patches the live instance and keeps signal state', async () => {
    installComponentHmr();
    expect(isComponentHmrEnabled()).toBe(true);

    const v1 = loadComponent(cardSource('v1'));
    runtime.defineComponent(v1);
    const element = runtime.mountComponent(document.body, v1, {
      props: { title: 'Card' },
    });
    await flush();

    const button = element.shadowRoot?.querySelector('button') as HTMLButtonElement;
    button.click();
    button.click();
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('2');
    expect(element.shadowRoot?.querySelector('.label')?.textContent).toBe('v1');

    const v2 = loadComponent(cardSource('v2'));
    const updated = applyComponentHmrUpdate(
      runtime.getComponentTagName(v1) as string,
      v2
    );
    await flush();

    expect(updated).toBe(1);
    expect(element.shadowRoot?.querySelector('.label')?.textContent).toBe('v2');
    // 实例没有被重建，signal 状态保留。
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('2');

    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('3');

    element.remove();
  });

  it('re-registering a tag through defineComponent routes into the HMR bridge in dev', async () => {
    installComponentHmr();
    const v1 = loadComponent(cardSource('first', 'HmrBridgeCard'));
    runtime.defineComponent(v1);
    const tagName = runtime.getComponentTagName(v1) as string;

    const element = runtime.mountComponent(document.body, v1, { props: {} });
    await flush();

    const v2 = loadComponent(cardSource('second', 'HmrBridgeCard'));
    const registered = runtime.defineComponent(v2);

    // 新构造器没有抢到标签：注册表仍指向首次注册的实现，但原型已被热替换。
    expect(registered).toBe(v2);
    expect(customElements.get(tagName)).toBe(v1);
    await flush();
    expect(element.shadowRoot?.querySelector('.label')?.textContent).toBe('second');

    element.remove();
  });

  it('captures and restores signal state on rebuilt elements', async () => {
    const v1 = loadComponent(cardSource('state', 'HmrStateCard'));
    runtime.defineComponent(v1);
    const element = runtime.mountComponent(document.body, v1, { props: {} });
    await flush();

    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await flush();

    const state = captureComponentState(element);
    expect(state.count).toBe(1);

    const fresh = document.createElement(
      runtime.getComponentTagName(v1) as string
    ) as HTMLElement;
    document.body.appendChild(fresh);
    await flush();
    restoreComponentState(fresh, state);
    await flush();

    expect(fresh.shadowRoot?.querySelector('output')?.textContent).toBe('1');

    element.remove();
    fresh.remove();
  });

  it('re-runs setup in dev builds so newly added state exists after HMR', async () => {
    installComponentHmr();

    const v1 = loadComponent(cardWithoutExtraStateSource(), { hotReload: true });
    runtime.defineComponent(v1);
    const element = runtime.mountComponent(document.body, v1, { props: {} });
    await flush();

    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('2');

    const v2 = loadComponent(cardWithExtraStateSource(), { hotReload: true });
    applyComponentHmrUpdate(runtime.getComponentTagName(v1) as string, v2);
    await flush();

    // 新增的 setup 状态被补建（构造器没重跑，但 dev 产物把 setup 收进了 __laniaSetup）
    expect(element.shadowRoot?.querySelector('.note')?.textContent).toBe('fresh');
    // 旧 signal 的值按字段名保留
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('2');

    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('3');

    element.remove();
  });

  it('keeps setup as class fields when hotReload is off', () => {
    const prod = loadComponent(cardWithoutExtraStateSource('HmrProdCard'));
    expect(typeof (prod.prototype as { __laniaSetup?: unknown }).__laniaSetup).toBe(
      'undefined'
    );

    const dev = loadComponent(cardWithoutExtraStateSource('HmrDevCard'), {
      hotReload: true,
    });
    expect(typeof (dev.prototype as { __laniaSetup?: unknown }).__laniaSetup).toBe(
      'function'
    );
  });
});
