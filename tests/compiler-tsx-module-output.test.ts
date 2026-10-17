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
  return <p>{account()}</p>;
});
`);

    const declaration = 'protected remembered = readSeed();';
    const initializer = 'protected account = createSignal(this.remembered);';

    expect(moduleCode).toContain(declaration);
    expect(moduleCode).toContain(initializer);
    // 顺序反了会在构造期读取尚未赋值的字段，直接抛 TypeError。
    expect(moduleCode.indexOf(declaration)).toBeLessThan(moduleCode.indexOf(initializer));
  });

  it('tracks unary negation reads as updater dependencies', () => {
    const moduleCode = compile(`
import { createMemo, createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function NegationHost() {
  const ready = createSignal(false);
  const blocked = createMemo(() => !ready());
  return <button disabled={!blocked()}>go</button>;
});
`);

    expect(readUpdaterDependencies(moduleCode, 'disabled')).toEqual(['this.ready']);
  });

  it('expands nested computed chains down to leaf signals', () => {
    const moduleCode = compile(`
import { createMemo, createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function NestedComputedHost() {
  const count = createSignal(0);
  const positive = createMemo(() => count() > 0);
  const visible = createMemo(() => positive());
  return <p className={visible() ? 'on' : 'off'}>status</p>;
});
`);

    expect(readUpdaterDependencies(moduleCode, 'class')).toEqual(['this.count']);
  });
});
