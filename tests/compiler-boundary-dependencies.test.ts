import { describe, expect, it } from 'vitest';

import { compileFunctionComponentTsx } from '@lania-v/compiler-tsx';

const compile = (source: string) =>
  compileFunctionComponentTsx('BoundaryDependency.tsx', source.trim());

const storePathKeys = (source: string): string[] => {
  const compiled = compile(source);
  const reads = compiled.ir.dependencyAnalysis.storePathReads ?? {};
  return Object.entries(reads).flatMap(([storeName, paths]) =>
    paths.map((path) => `${storeName}.${path.join('.')}`)
  );
};

describe('boundary and transition dependencies', () => {
  it('keeps store reads from the Suspense children subtree', () => {
    const keys = storePathKeys(`
import { createStore, defineComponent } from '@lania-v/runtime';
import { Suspense } from '@lania-v/runtime/advanced';

export default defineComponent(function SuspenseChildHost() {
  const form = createStore({ status: 'idle', account: '' });
  return (
    <Suspense fallback={<p>loading</p>}>
      <p>{form.account}</p>
    </Suspense>
  );
});
`);
    expect(keys).toContain('form.account');
  });

  it('keeps store reads from the Transition children subtree', () => {
    const keys = storePathKeys(`
import { createStore, defineComponent } from '@lania-v/runtime';
import { Transition } from '@lania-v/runtime/advanced';

export default defineComponent(function TransitionHost() {
  const form = createStore({ mode: 'idle' });
  return (
    <Transition name="fade">
      <p>{form.mode}</p>
    </Transition>
  );
});
`);
    expect(keys).toContain('form.mode');
  });

  it('keeps store reads referenced only from an ErrorBoundary fallback expression', () => {
    const keys = storePathKeys(`
import { createStore, defineComponent } from '@lania-v/runtime';
import { ErrorBoundary } from '@lania-v/runtime/advanced';

export default defineComponent(function ErrorBoundaryHost() {
  const form = createStore({ message: 'boom' });
  return (
    <ErrorBoundary fallback={(err) => <p>{form.message}</p>}>
      <p>ok</p>
    </ErrorBoundary>
  );
});
`);
    expect(keys).toContain('form.message');
  });
});
