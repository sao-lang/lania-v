import { describe, expect, it } from 'vitest';

import { analyzeComputedSource } from '@lania-v/compiler-core';

describe('compiler computed analysis', () => {
  it('classifies simple getters as inline candidates', () => {
    const source = `
class CounterElement {
  get doubleCount() {
    return this.count() * 2;
  }
}
`.trim();

    const result = analyzeComputedSource('counter.ts', source, 'doubleCount');

    expect(result.ownerName).toBe('CounterElement');
    expect(result.complexity).toBe('simple');
    expect(result.strategy).toBe('inline');
    expect(result.expressionText).toBe('this.count() * 2');
    expect(result.dependencies).toEqual([
      {
        kind: 'this-signal-call',
        name: 'count',
        text: 'this.count()',
      },
    ]);
    expect(result.reasons).toEqual([]);
  });

  it('classifies multi-statement getters as updater-chain candidates', () => {
    const source = `
class CounterElement {
  get label() {
    const base = this.count() * 2;
    return \`value:\${base}\`;
  }
}
`.trim();

    const result = analyzeComputedSource('counter.ts', source, 'label');

    expect(result.complexity).toBe('complex');
    expect(result.strategy).toBe('updater_chain');
    expect(result.expressionText).toBeNull();
    expect(result.reasons).toContain('getter contains multiple statements');
  });

  it('classifies non signal-style calls as complex', () => {
    const source = `
class CounterElement {
  get normalized() {
    return formatValue(this.count());
  }
}
`.trim();

    const result = analyzeComputedSource('counter.ts', source, 'normalized');

    expect(result.complexity).toBe('complex');
    expect(result.strategy).toBe('updater_chain');
    expect(result.expressionText).toBe('formatValue(this.count())');
    expect(result.reasons).toContain(
      'call expression "formatValue(this.count())" is not a signal-style read'
    );
  });

  it('returns a diagnostic-like reason when getter is missing', () => {
    const source = `
class CounterElement {
  value = 1;
}
`.trim();

    const result = analyzeComputedSource('counter.ts', source, 'missingGetter');

    expect(result.complexity).toBe('complex');
    expect(result.strategy).toBe('updater_chain');
    expect(result.reasons).toEqual(['getter "missingGetter" was not found']);
  });
});
