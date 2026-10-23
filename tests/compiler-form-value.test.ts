import { describe, expect, it } from 'vitest';

import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const compile = (source: string): string =>
  compileFunctionComponentTsxToModule('FormField.tsx', source.trim());

describe('compiler form value support', () => {
  it('emits formAssociated and a synchronized effect updater', () => {
    const moduleCode = compile(`
import { defineComponent, useFormValue } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';

export default defineComponent(function FormField() {
  const value = createSignal('seed');
  useFormValue(() => value.value);
  return <input value={value.value} />;
});
`);

    expect(moduleCode).toContain('static formAssociated = true;');
    expect(moduleCode).toContain('this._setFormValue(this.value.value);');
    // 复用 effect 通道：依赖必须挂到负责写表单值的 updater 上。
    expect(moduleCode).toMatch(
      /const runEffect___formValue = new EffectUpdater/
    );
    expect(moduleCode).toContain('runEffect___formValue.deps.add(this.value);');
    expect(moduleCode).toContain(
      'this.registerRuntimeUpdater(runEffect___formValue);'
    );
  });

  it('does not treat useFormValue as a setup field', () => {
    const moduleCode = compile(`
import { defineComponent, useFormValue } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';

export default defineComponent(function FormField() {
  const value = createSignal('seed');
  useFormValue(() => value.value);
  return <p>{value.value}</p>;
});
`);

    expect(moduleCode).not.toContain('useFormValue(');
    expect(moduleCode).not.toContain('__setup_statement_');
  });

  it('supports the variable declaration form', () => {
    const moduleCode = compile(`
import { defineComponent, useFormValue } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';

export default defineComponent(function FormField() {
  const value = createSignal(1);
  const formValue = useFormValue(() => value.value);
  return <p>{value.value}{formValue === undefined ? '' : ''}</p>;
});
`);

    expect(moduleCode).toContain('static formAssociated = true;');
    expect(moduleCode).toContain('this._setFormValue(this.value.value);');
  });

  it('skips form association when useFormValue is absent', () => {
    const moduleCode = compile(`
import { defineComponent } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';

export default defineComponent(function PlainField() {
  const value = createSignal('seed');
  return <p>{value.value}</p>;
});
`);

    expect(moduleCode).not.toContain('formAssociated');
    expect(moduleCode).not.toContain('_setFormValue');
  });

  it('rejects getters with more than one expression', () => {
    expect(() =>
      compile(`
import { defineComponent, useFormValue } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';

export default defineComponent(function FormField() {
  const value = createSignal('seed');
  useFormValue(() => { const next = value.value; return next; });
  return <p>{value.value}</p>;
});
`)
    ).toThrowError(/useFormValue/);
  });
});

describe('compiler object-style event modifiers', () => {
  const compileEvent = (attributes: string): string =>
    compile(`
import { defineComponent } from '@lania-v/runtime';

export default defineComponent(function EventField() {
  const submit = () => undefined;
  return <input ${attributes} />;
});
`);

  it('lower keyboard modifiers in object-style event bindings', () => {
    const moduleCode = compileEvent(
      'onKeyDown={{ handler: submit, modifiers: { enter: true } }}'
    );

    // 对象写法必须与 `onKeyDown.enter` 一样降到 `key:*`，否则运行时收不到修饰符。
    expect(moduleCode).toContain(
      'withEventModifiers(this.submit, ["key:enter"])'
    );
  });

  it('lower system modifiers in object-style event bindings', () => {
    const moduleCode = compileEvent(
      'onKeyDown={{ handler: submit, modifiers: { system: { ctrl: true }, prevent: true } }}'
    );

    expect(moduleCode).toContain('"prevent","system:ctrl"');
  });
});
