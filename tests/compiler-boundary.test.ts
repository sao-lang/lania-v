import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCompileReportPlugin,
  type CompileReport,
} from '@lania-v/compiler-core';
import {
  compileFunctionComponentTsx,
  compileFunctionComponentTsxToModule,
} from '@lania-v/compiler-tsx';

const compile = (source: string): string =>
  compileFunctionComponentTsxToModule('/virtual/Boundary.lania.tsx', source);

describe('compiler static boundary', () => {
  it('rewrites destructured props to instance getters with dependencies', () => {
    const code = compile(`
import { defineComponent } from '@lania-v/runtime';
export default defineComponent(function Card(props: { title: string; count: number }) {
  const { title, count: total } = props;
  return <div>{title}{total}</div>;
});
`);

    expect(code).toContain('() => this.title');
    expect(code).toContain('() => this.count');
    expect(code).toContain('deps.add(this.__prop_title)');
    expect(code).toContain('deps.add(this.__prop_count)');
    expect(code).not.toContain('() => title');
  });

  it('resolves local type alias and interface props for destructuring', () => {
    const aliasCode = compile(`
import { defineComponent } from '@lania-v/runtime';
type CardProps = { title: string; count: number };
export default defineComponent(function Card(props: CardProps) {
  const { title, count: total } = props;
  return <div>{title}{total}</div>;
});
`);

    expect(aliasCode).toContain('static __laniaPropNames = ["title","count"]');
    expect(aliasCode).toContain(
      'static observedAttributes = resolveObservedAttributes('
    );
    expect(aliasCode).toContain('() => this.title');
    expect(aliasCode).toContain('deps.add(this.__prop_count)');

    const interfaceCode = compile(`
import { defineComponent } from '@lania-v/runtime';
interface BaseProps { title: string }
interface CardProps extends BaseProps { count: number }
export default defineComponent(function Card(props: CardProps) {
  const { title, count } = props;
  return <div>{title}{count}</div>;
});
`);

    expect(interfaceCode).toContain(
      'static __laniaPropNames = ["title","count"]'
    );
    expect(interfaceCode).toContain('() => this.count');
  });

  it('resolves props types imported from a sibling file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lania-props-'));
    const typesFile = path.join(directory, 'card-props.ts');
    const componentFile = path.join(directory, 'Card.lania.tsx');

    fs.writeFileSync(
      typesFile,
      [
        'export interface CardBase { title: string }',
        'export type CardProps = CardBase & { count: number; onSelect?: (value: number) => void };',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      componentFile,
      [
        "import { defineComponent } from '@lania-v/runtime';",
        "import type { CardProps } from './card-props';",
        'export default defineComponent(function Card(props: CardProps) {',
        '  const { title, count } = props;',
        '  return <div>{title}{count}</div>;',
        '});',
      ].join('\n'),
      'utf8'
    );

    const code = compileFunctionComponentTsxToModule(
      componentFile,
      fs.readFileSync(componentFile, 'utf8')
    );

    expect(code).toContain(
      'static __laniaPropNames = ["title","count","onSelect"]'
    );
    expect(code).toContain('deps.add(this.__prop_count)');
    expect(code).toContain('this.title');

    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects destructuring when the props type cannot be resolved', () => {
    expect(() =>
      compile(`
import { defineComponent } from '@lania-v/runtime';
import type { ExternalProps } from './types';
export default defineComponent(function Card(props: ExternalProps) {
  const { title } = props;
  return <div>{title}</div>;
});
`)
    ).toThrow(/Cannot statically resolve the props type for destructuring/);
  });

  it('lowers props destructuring defaults, rest and nested patterns', () => {
    const code = compile(`
import { defineComponent } from '@lania-v/runtime';
type CardProps = { title?: string; user: { name: string; age?: number }; count: number; active: boolean };
export default defineComponent(function Card(props: CardProps) {
  const { title = 'fallback', user: { name, age = 0 }, ...rest } = props;
  return <div>{title}{name}{age}{rest.count}</div>;
});
`);

    expect(code).toContain("(this.title ?? 'fallback')");
    expect(code).toContain('this.user?.name');
    expect(code).toContain('(this.user?.age ?? 0)');
    expect(code).toContain('get count() { return __laniaSelf.count; }');
    expect(code).toContain('get active() { return __laniaSelf.active; }');
    expect(code).not.toContain('get user() {');
  });

  it('rejects computed property names in props destructuring', () => {
    expect(() =>
      compile(`
import { defineComponent } from '@lania-v/runtime';
export default defineComponent(function Card(props: { title?: string }) {
  const key = 'title';
  const { [key]: value } = props;
  return <div>{value}</div>;
});
`)
    ).toThrow(
      /Computed property names are not supported when destructuring props/
    );
  });

  it('keeps component spread props in the runtime props expression', () => {
    const code = compile(`
import { defineComponent } from '@lania-v/runtime';
import Child from './Child.lania.tsx';
export default defineComponent(function Parent(props: { title: string }) {
  const rest = { title: props.title, extra: 1 };
  return <Child {...rest} data-x="1" />;
});
`);

    expect(code).toContain('...((this.rest))');
    expect(code).toContain('"data-x": "1"');
  });

  it('reports spread attributes on intrinsic elements instead of dropping them', () => {
    expect(() =>
      compile(`
import { defineComponent } from '@lania-v/runtime';
export default defineComponent(function Card(props: { title: string }) {
  const rest = { title: props.title };
  return <div {...rest} />;
});
`)
    ).toThrow(/Spread attributes are only supported on component tags/);
  });

  it('preserves referenced module-scope declarations', () => {
    const code = compile(`
import { defineComponent } from '@lania-v/runtime';
const LABEL = 'hello';
function suffix() { return '!'; }
export default defineComponent(function Card() {
  return <div>{LABEL}{suffix()}</div>;
});
`);

    expect(code).toContain("const LABEL = 'hello';");
    expect(code).toContain("function suffix() { return '!'; }");
  });

  it('preserves component static config after the class definition', () => {
    const code = compile(`
import { defineComponent, css } from '@lania-v/runtime';
const Card = defineComponent(function Card() {
  return <div>hi</div>;
});
Card.styles = css\`:host { color: red; }\`;
export default Card;
`);

    expect(code).toContain('Card.styles = css');
    expect(code.indexOf('Card.styles = css')).toBeGreaterThan(
      code.indexOf('class Card')
    );
  });

  it('lowers useFormValidity into a form-associated effect', () => {
    const code = compile(`
import { defineComponent, useFormValidity } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';
export default defineComponent(function Field() {
  const valid = createSignal(false);
  useFormValidity(() => valid.value ? true : { valid: false, message: 'required' });
  return <input />;
});
`);

    expect(code).toContain('static formAssociated = true;');
    expect(code).toContain('this._setFormValidity(');
  });

  it('exposes a compile report with slot and updater stats', () => {
    const reports: CompileReport[] = [];
    const reportPlugin = createCompileReportPlugin((value) =>
      reports.push(value)
    );

    compileFunctionComponentTsx(
      '/virtual/Report.lania.tsx',
      `
import { defineComponent } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';
export default defineComponent(function Report(props: { title: string }) {
  const count = createSignal(0);
  return <section>{props.title}{count.value}</section>;
});
`,
      { plugins: [reportPlugin] }
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]!.entries[0]).toMatchObject({
      component: 'Report',
      slots: 2,
      signals: 1,
    });
  });
});
