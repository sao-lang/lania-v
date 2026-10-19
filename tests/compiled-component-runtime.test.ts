// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

import * as runtime from '@lania-v/runtime';
import * as advanced from '@lania-v/runtime/advanced';
import { mountComponent } from '@lania-v/runtime';
import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const loadComponent = (source: string): any => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/Compiled.lania.tsx',
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

describe('compiled component runtime integration', () => {
  it('mounts destructured props and updates them reactively', async () => {
    const CardProps = loadComponent(`
import { defineComponent } from '@lania-v/runtime';
export default defineComponent(function CardProps(props: { title: string }) {
  const { title } = props;
  return <div>{title}</div>;
});
`);

    const element = mountComponent(document.body, CardProps, {
      props: { title: 'Hello' },
    });
    await flush();
    expect(element.shadowRoot?.textContent).toBe('Hello');

    element.title = 'Updated';
    await flush();
    expect(element.shadowRoot?.textContent).toBe('Updated');
    element.remove();
  });

  it('supports destructured props declared through a local type alias', async () => {
    const CardAliasView = loadComponent(`
import { defineComponent } from '@lania-v/runtime';
type CardAliasProps = { title: string };
interface CardAliasBase { subtitle?: string }
export default defineComponent(function CardAliasView(props: CardAliasProps & CardAliasBase) {
  const { title, subtitle } = props;
  return <div>{title}|{subtitle ?? ''}</div>;
});
`);

    const element = mountComponent(document.body, CardAliasView, {
      props: { title: 'Hello', subtitle: 'Base' },
    });
    await flush();
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('Hello|Base');

    element.title = 'Updated';
    await flush();
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('Updated|Base');
    element.remove();
  });

  it('updates signals returned from a composable', async () => {
    const CardComposable = loadComponent(`
import { createSignal, defineComponent } from '@lania-v/runtime';
export default defineComponent(function CardComposable() {
  const useCounter = () => createSignal(0);
  const count = useCounter();
  return (
    <div>
      <button onClick={() => count.set(count() + 1)}>inc</button>
      <output>{count()}</output>
    </div>
  );
});
`);

    const element = mountComponent(document.body, CardComposable, {});
    await flush();
    expect(element.shadowRoot?.textContent).toBe('inc0');

    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(element.shadowRoot?.textContent).toBe('inc1');
    element.remove();
  });

  it('updates compiled store paths through store.set', async () => {
    const StoreView = loadComponent(`
import { createStore, defineComponent } from '@lania-v/runtime';
export default defineComponent(function StoreView() {
  const store = createStore({
    user: { name: 'Ada' },
    list: [{ title: 'a' }],
  });
  return (
    <div>
      <button
        onClick={() => {
          store.set('user.name', 'Grace');
          store.set('list.0.title', 'b');
        }}
      >
        update
      </button>
      <output>{store.user.name}|{store.list[0].title}</output>
    </div>
  );
});
`);

    const element = mountComponent(document.body, StoreView, {});
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('Ada|a');

    (element.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(element.shadowRoot?.querySelector('output')?.textContent).toBe('Grace|b');
    element.remove();
  });

  it('keeps bindProps, bindHandlers and bindSlots live in compiled components', async () => {
    const BindingPanel = loadComponent(`
import {
  bindHandlers,
  bindProps,
  bindSlots,
  defineComponent,
} from '@lania-v/runtime';

type BindingPanelProps = {
  title: string;
  count: number;
  onToggle?: () => void;
  children?: unknown;
};

export default defineComponent(function BindingPanel(props: BindingPanelProps) {
  const p = bindProps(props);
  const h = bindHandlers(props);
  const slots = bindSlots();

  return (
    <section>
      <span className="prop">{String(p.title)}|{String(p.count)}</span>
      <span className="handlers">{Object.keys(h).join(',')}</span>
      <span className="header">{String(slots.render('header', 'none'))}</span>
      <div className="default">{String(slots.renderDefault('none'))}</div>
      <div className="footer">
        {slots.has('footer') ? String(slots.render('footer')) : 'missing'}
      </div>
      <button className="toggle" onClick={() => h.onToggle?.()}>toggle</button>
    </section>
  );
});
`);

    let toggles = 0;
    const element = mountComponent(document.body, BindingPanel, {
      props: {
        title: 'A',
        count: 1,
        onToggle: () => {
          toggles += 1;
        },
        children: {
          header: 'H',
          default: 'D',
          footer: 'F',
        },
      },
    });
    await flush();

    expect(element.shadowRoot?.querySelector('.prop')?.textContent).toBe('A|1');
    expect(element.shadowRoot?.querySelector('.handlers')?.textContent).toBe(
      'onToggle'
    );
    expect(element.shadowRoot?.querySelector('.header')?.textContent).toBe('H');
    expect(element.shadowRoot?.querySelector('.default')?.textContent).toBe('D');
    expect(element.shadowRoot?.querySelector('.footer')?.textContent).toBe('F');

    (element.shadowRoot?.querySelector('.toggle') as HTMLButtonElement).click();
    expect(toggles).toBe(1);

    element.title = 'B';
    element.count = 2;
    await flush();
    expect(element.shadowRoot?.querySelector('.prop')?.textContent).toBe('B|2');

    element.children = { header: 'H2', default: 'D2' };
    await flush();
    expect(element.shadowRoot?.querySelector('.header')?.textContent).toBe('H2');
    expect(element.shadowRoot?.querySelector('.default')?.textContent).toBe('D2');
    expect(element.shadowRoot?.querySelector('.footer')?.textContent).toBe(
      'missing'
    );

    element.remove();
  });

  it('supports typed prop options, attribute reflection and emits validation', async () => {
    const FancyInput = loadComponent(`
import { defineComponent } from '@lania-v/runtime';

type FancyInputProps = {
  count: number;
  userName: string;
  active: boolean;
  level: number;
  onSelect?: (value: number) => void;
};

export default defineComponent(function FancyInput(props: FancyInputProps) {
  return (
    <div>
      <span className="count">{String((props as any).count)}</span>
      <span className="user">{String((props as any).userName)}</span>
      <span className="active">{String((props as any).active)}</span>
      <span className="level">{String((props as any).level)}</span>
    </div>
  );
}, {
  props: {
    count: { type: Number, reflect: true, default: 3, validator: (value) => typeof value === 'number' },
    userName: { type: String, attribute: 'user-name' },
    active: { type: Boolean, reflect: true },
    level: {
      type: Number,
      attribute: false,
      converter: {
        from: (value) => (value === null ? 0 : Number(value) * 10),
        to: (value) => String(Number(value) / 10),
      },
    },
    onSelect: { attribute: false },
  },
  emits: ['select'],
});
`);

    const element = mountComponent(document.body, FancyInput, {
      props: { userName: 'Ann', active: true, level: 4 },
    });
    await flush();

    expect(element.count).toBe(3);
    expect(element.shadowRoot?.querySelector('.count')?.textContent).toBe('3');
    expect(element.userName).toBe('Ann');
    expect(element.active).toBe(true);

    // reflect: property -> attribute
    element.count = 5;
    await flush();
    expect(element.getAttribute('count')).toBe('5');
    expect(element.shadowRoot?.querySelector('.count')?.textContent).toBe('5');

    // attribute -> property，自定义 attribute 名
    element.setAttribute('count', '7');
    element.setAttribute('user-name', 'Bob');
    await flush();
    expect(element.count).toBe(7);
    expect(element.userName).toBe('Bob');
    expect(element.shadowRoot?.querySelector('.user')?.textContent).toBe('Bob');

    // Boolean attribute 语义
    element.removeAttribute('active');
    await flush();
    expect(element.active).toBe(false);
    element.setAttribute('active', '');
    await flush();
    expect(element.active).toBe(true);

    // attribute: false 的 prop 不进入 observedAttributes，也不做 attribute 同步
    expect(element.constructor.observedAttributes).not.toContain('level');
    expect(element.constructor.observedAttributes).not.toContain('on-select');
    element.level = 6;
    await flush();
    expect(element.hasAttribute('level')).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    element.emit('select', 1);
    element.emit('unknown-event', 2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    element.remove();
  });

  it('keeps referenced module-scope helpers and component static config', async () => {
    const CardStyled = loadComponent(`
import { css, defineComponent } from '@lania-v/runtime';
const LABEL = 'hello';
function suffix() { return '!'; }
const CardStyled = defineComponent(function CardStyled() {
  return <div>{LABEL}{suffix()}</div>;
});
CardStyled.styles = css\`:host { color: red; }\`;
export default CardStyled;
`);

    expect(CardStyled.styles).toBeTruthy();

    const element = mountComponent(document.body, CardStyled, {});
    await flush();
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('hello!');
    element.remove();
  });

  it('evaluates defineComponent options at runtime so expressions and imports work', async () => {
    const FancyShared = loadComponent(`
import { defineComponent } from '@lania-v/runtime';

const ATTR_NAMES = { user: 'user-name' } as const;
const ESCAPE_EVENTS = ['select'];
const sharedProps = {
  userName: { type: String, attribute: ATTR_NAMES.user },
  count: { type: Number, reflect: true, default: 5 },
  onSelect: { attribute: false },
};

export default defineComponent(function FancyShared(props: { userName: string; count: number; onSelect?: (value: number) => void }) {
  return <div><span className="user">{String((props as any).userName)}</span><span className="count">{String((props as any).count)}</span></div>;
}, {
  props: sharedProps,
  emits: ESCAPE_EVENTS,
});
`);

    const element = mountComponent(document.body, FancyShared, {
      props: { userName: 'Ann' },
    });
    await flush();

    // 非字面量选项：custom attribute 名与 default 都要生效
    expect(element.count).toBe(5);
    expect(element.constructor.observedAttributes).toContain('user-name');
    expect(element.constructor.observedAttributes).not.toContain('on-select');

    element.setAttribute('user-name', 'Bob');
    await flush();
    expect(element.userName).toBe('Bob');

    element.count = 9;
    await flush();
    expect(element.getAttribute('count')).toBe('9');

    element.remove();
  });

  it('lowers props destructuring defaults, nested paths and rest views', async () => {
    const DestructuredCard = loadComponent(`
import { defineComponent } from '@lania-v/runtime';

export default defineComponent(function DestructuredCard(props: {
  title?: string;
  user: { name: string; age?: number };
  count: number;
  active: boolean;
}) {
  const { title = 'fallback', user: { name, age = 0 }, ...rest } = props;
  return (
    <div>
      <span className="title">{title}</span>
      <span className="name">{name}</span>
      <span className="age">{String(age)}</span>
      <span className="rest">{String(rest.count)}-{String(rest.active)}</span>
    </div>
  );
});
`);

    const element = mountComponent(document.body, DestructuredCard, {
      props: { user: { name: 'Ann' }, count: 2, active: true },
    });
    await flush();

    expect(element.shadowRoot?.querySelector('.title')?.textContent).toBe('fallback');
    expect(element.shadowRoot?.querySelector('.name')?.textContent).toBe('Ann');
    expect(element.shadowRoot?.querySelector('.age')?.textContent).toBe('0');
    expect(element.shadowRoot?.querySelector('.rest')?.textContent).toBe('2-true');

    element.title = 'Hello';
    element.user = { name: 'Bob', age: 30 };
    element.count = 7;
    await flush();

    expect(element.shadowRoot?.querySelector('.title')?.textContent).toBe('Hello');
    expect(element.shadowRoot?.querySelector('.name')?.textContent).toBe('Bob');
    expect(element.shadowRoot?.querySelector('.age')?.textContent).toBe('30');
    expect(element.shadowRoot?.querySelector('.rest')?.textContent).toBe('7-true');

    element.remove();
  });

  it('compiles every component in a multi-component file and defaults to the exported one', async () => {
    const MultiFile = loadComponent(`
import { defineComponent } from '@lania-v/runtime';

const MultiChild = defineComponent(function MultiChild(props: { label: string }) {
  return <span class="child">{props.label}</span>;
});

const MultiParent = defineComponent(function MultiParent(props: { title: string }) {
  return (
    <div>
      <h2>{props.title}</h2>
      <MultiChild label="nested" />
    </div>
  );
});

export default MultiParent;
`);

    // 默认导出的是父组件，而不是文件里第一个组件。
    expect(MultiFile.name).toBe('MultiParent');

    const element = mountComponent(document.body, MultiFile, {
      props: { title: 'Hello' },
    });
    await flush();

    expect(element.shadowRoot?.querySelector('h2')?.textContent).toBe('Hello');

    // 子组件同样走了编译路径：它是独立自定义元素，自己有 shadow root。
    const child = element.shadowRoot?.querySelector('multi-child') as
      | (HTMLElement & { label?: string })
      | null;
    expect(child).not.toBeNull();
    expect(child?.shadowRoot?.querySelector('.child')?.textContent).toBe('nested');

    child!.label = 'changed';
    await flush();
    expect(child?.shadowRoot?.querySelector('.child')?.textContent).toBe('changed');

    element.title = 'Updated';
    await flush();
    expect(element.shadowRoot?.querySelector('h2')?.textContent).toBe('Updated');

    element.remove();
  });
});
