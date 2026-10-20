import { describe, expect, it } from 'vitest';

import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const compile = (source: string): string =>
  compileFunctionComponentTsxToModule('Regression.tsx', source.trim());

/**
 * 从生成模块里取出某个属性绑定 updater 的实际 `.deps.add(...)` 清单。
 *
 * `deps` 由编译期静态注入，是 updater 唯一的订阅来源：
 * 漏掉一条依赖，对应 DOM 属性就永远不会再更新。
 */
const readUpdaterDependencies = (moduleCode: string, slotAttribute: string): string[] => {
  const lines = moduleCode.split('\n');

  const slotDeclaration = lines.find(
    (line) => line.includes('new AttrSlot(') && line.includes(`"${slotAttribute}"`)
  );
  expect(slotDeclaration).toBeDefined();

  const slotName = slotDeclaration!.trim().replace(/^const\s+/, '').split(' = ')[0]!;

  const updaterDeclaration = lines.find(
    (line) => line.includes('new SimpleUpdater(') && line.includes(`, ${slotName},`)
  );
  expect(updaterDeclaration).toBeDefined();

  const updaterName = updaterDeclaration!.trim().replace(/^const\s+/, '').split(' = ')[0]!;

  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${updaterName}.deps.add(`))
    .map((line) => line.slice(`${updaterName}.deps.add(`.length, line.lastIndexOf(');')));
};

describe('compiler tsx module output', () => {
  it('keeps component body declaration order for signal initializers', () => {
    const moduleCode = compile(`
import { createSignal, defineComponent } from '@lania-v/runtime';
import { readSeed } from './seed';

export default defineComponent(function OrderHost() {
  const remembered = readSeed();
  const account = createSignal(remembered);
  return <p>{account.value}</p>;
});
`);

    const declaration = 'protected remembered = readSeed();';
    const initializer = 'protected account = createSignal(this.remembered);';

    expect(moduleCode).toContain(declaration);
    expect(moduleCode).toContain(initializer);
    // 顺序反了会在构造期读取尚未赋值的字段，直接抛 TypeError。
    expect(moduleCode.indexOf(declaration)).toBeLessThan(moduleCode.indexOf(initializer));
  });

  it('tracks createStore path reads without tuple destructuring', () => {
    const moduleCode = compile(`
import { createStore, defineComponent } from '@lania-v/runtime';

export default defineComponent(function StoreHost() {
  const store = createStore({ user: { name: 'Ada' } });
  return (
    <button onClick={() => store.set('user.name', 'Grace')}>
      {store.user.name}
    </button>
  );
});
`);

    expect(moduleCode).toContain('createStore({ user: { name: \'Ada\' } })');
    expect(moduleCode).toContain("this.store.set('user.name', 'Grace')");
    expect(moduleCode).toContain('getStorePathSignal(this.store, ["user","name"])');
    expect(moduleCode).not.toContain('getStorePathSignal(this.store, ["set"])');
  });

  it('tracks unary negation reads as updater dependencies', () => {
    const moduleCode = compile(`
import { createMemo, createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function NegationHost() {
  const ready = createSignal(false);
  const blocked = createMemo(() => !ready.value);
  return <button disabled={!blocked.value}>go</button>;
});
`);

    expect(readUpdaterDependencies(moduleCode, 'disabled')).toEqual(['this.ready']);
  });

  it('expands nested computed chains down to leaf signals', () => {
    const moduleCode = compile(`
import { createMemo, createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function NestedComputedHost() {
  const count = createSignal(0);
  const positive = createMemo(() => count.value > 0);
  const visible = createMemo(() => positive.value);
  return <p className={visible.value ? 'on' : 'off'}>status</p>;
});
`);

    expect(readUpdaterDependencies(moduleCode, 'class')).toEqual(['this.count']);
  });

  it('rewrites signal and computed references in lifecycle callbacks', () => {
    const moduleCode = compile(`
import {
  createMemo,
  createSignal,
  defineComponent,
  onMount,
} from '@lania-v/runtime';

export default defineComponent(function LifecycleBindingsHost() {
  const account = createSignal('');
  const accountMissing = createMemo(() => account.value.trim().length === 0);
  onMount(() => {
    console.log({ account: account, accountMissing: accountMissing });
  });
  return <p>{accountMissing.value ? 'missing' : 'present'}</p>;
});
`);

    expect(moduleCode).toContain(
      'console.log({ account: this.account, accountMissing: this.accountMissing });'
    );
    // computed 与 signal 共用可读句柄语义：取值必须保留调用括号。
    expect(moduleCode).toContain(
      'protected accountMissing = createComputedAccessor(() => this.account.value.trim().length === 0);'
    );
  });

  it('rewrites two-arg provideContext to the current component host', () => {
    const moduleCode = compile(`
import {
  createContext,
  createSignal,
  defineComponent,
  provideContext,
} from '@lania-v/runtime';

const ThemeContext = createContext<'light' | 'dark'>('light');

export default defineComponent(function ProviderHost() {
  const theme = createSignal<'light' | 'dark'>('dark');
  provideContext(ThemeContext, theme);
  return <div />;
});
`);

    expect(moduleCode).toContain('provideContext(this, ThemeContext, this.theme)');
    expect(moduleCode).not.toContain('provideContext(ThemeContext,');
  });

  it('keeps computed call syntax and nested computed chains', () => {
    const moduleCode = compile(`
import { createMemo, createSignal, defineComponent, onMount } from '@lania-v/runtime';

export default defineComponent(function ComputedParityHost() {
  const count = createSignal(0);
  const positive = createMemo(() => count.value > 0);
  const label = createMemo(() => (positive.value ? 'on' : 'off'));
  onMount(() => {
    console.log(label);
  });
  return <p className={label.value}>{label.value}</p>;
});
`);

    // 模板里被内联的 computed，只要实例侧（生命周期 / effect / setup）还引用，就必须保留 memo 字段。
    expect(moduleCode).toContain('protected positive = createComputedAccessor(() => this.count.value > 0);');
    expect(moduleCode).toContain(
      "protected label = createComputedAccessor(() => (this.positive.value ? 'on' : 'off'));"
    );
    expect(moduleCode).toContain('console.log(this.label);');
    // 即使 computed 以调用形态出现，updater 仍要订阅到叶子 signal。
    expect(moduleCode).toContain('.deps.add(this.count);');
  });

  it('lowers extended event modifiers into listener options and runtime modifiers', () => {
    const moduleCode = compileFunctionComponentTsxToModule(
      'Modifiers.lania.tsx',
      `
import { defineComponent, withEventHint } from '@lania-v/runtime';

export default defineComponent(function ModifiersHost() {
  const save = () => {};
  return (
    <div>
      <button onClick.once.stop={save}>a</button>
      <button onClick.prevent.self={save}>b</button>
      <button onClick={{ handler: save, modifiers: { preventImmediate: true, left: true } }}>c</button>
      <button onClick={{ handler: withEventHint(save, 'debounce'), modifiers: { prevent: true } }}>d</button>
      <input onInput.debounce={save} />
    </div>
  );
});
`,
      {},
      'jsx-standard'
    );

    // `.once` 属于原生监听选项，不能当作模板修饰符执行。
    expect(moduleCode).toContain('new EventSlot(slot0Node, "click", 0, {"once":true})');
    expect(moduleCode).toContain('withEventModifiers(this.save, ["stop"])');
    expect(moduleCode).toContain('withEventModifiers(this.save, ["prevent","prevent:self"])');
    expect(moduleCode).toContain(
      'withEventModifiers(this.save, ["button:left","prevent","prevent:immediate"])'
    );
    // `withEventHint` 在编译期被拆成“处理器 + 提示”，避免同一处理器被包装两层。
    expect(moduleCode).toContain('withEventHint(this.save, "debounce", ["prevent"])');
    expect(moduleCode).not.toContain("withEventHint(this.save, 'debounce')");
    // 后缀 `.debounce` 走同一条提示通道。
    expect(moduleCode).toContain('new EventSlot(slot4Node, "input", 4, undefined)');
    expect(moduleCode).toContain('withEventHint(this.save, "debounce", [])');
  });
});
