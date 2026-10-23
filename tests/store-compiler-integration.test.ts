import { describe, expect, it } from 'vitest';

import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

describe('@lania-v/store compiler integration', () => {
  it('keeps @lania-v/store imports and lifts atoms into instance fields', () => {
    const moduleCode = compileFunctionComponentTsxToModule(
      'Counter.lania.tsx',
      `
import { createAtom, createDerivedAtom } from '@lania-v/store';
import { defineComponent } from '@lania-v/runtime';

export default defineComponent(function Counter() {
  const count = createAtom(0);
  const doubled = createDerivedAtom(() => count.value * 2);

  return (
    <div>
      <span data-testid="doubled">{doubled.value}</span>
      <button onClick={() => count.set(count.value + 1)}>{count.value}</button>
    </div>
  );
});
`.trim()
    );

    // atom 工厂按信号声明处理，直接落成实例字段。
    expect(moduleCode).toContain('this.count');
    expect(moduleCode).toContain('this.doubled');
    // 用户写下的 store 导入必须原样保留，否则产物里没有 createAtom。
    expect(moduleCode).toContain('@lania-v/store');
  });
});
