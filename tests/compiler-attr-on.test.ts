import { describe, expect, it } from 'vitest';

import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const compile = (body: string): string =>
  compileFunctionComponentTsxToModule(
    '/virtual/AttrOn.lania.tsx',
    `
import { createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function Demo() {
  const alt = createSignal('a');
  const label = createSignal('b');
  return (
    <div>
${body}
    </div>
  );
});
`
  );

describe('attr directive', () => {
  it('expands each key into its own attribute slot', () => {
    const code = compile(
      `<img attr={{ alt: alt.value, 'data-id': label.value, loading: 'lazy' }} />`
    );

    // 每个 key 独立成槽，便于按属性精确更新。
    expect(code).toContain('new AttrSlot(slot0Node, "alt", 0)');
    expect(code).toContain('new AttrSlot(slot1Node, "data-id", 1)');
    expect(code).toContain('new AttrSlot(slot2Node, "loading", 2)');
  });

  it('supports string literal keys such as data-* and aria-*', () => {
    const code = compile(
      `<div attr={{ 'data-state': label.value, 'aria-label': alt.value }} />`
    );

    expect(code).toContain('"data-state"');
    expect(code).toContain('"aria-label"');
  });

  it('tracks dependencies of dynamic attribute values', () => {
    const code = compile(`<img attr={{ alt: alt.value }} />`);

    expect(code).toContain('updateDirective_attr');
    expect(code).toContain('deps.add(this.alt)');
  });

  it('rejects spread and computed keys', () => {
    expect(() => compile('<div attr={{ ...rest }} />')).toThrow(
      /spread properties are not supported/
    );

    expect(() => compile('<div attr={{ [name]: alt.value }} />')).toThrow(
      /computed property names are not supported/
    );
  });

  it('requires an object literal', () => {
    expect(() => compile('<div attr={bindings} />')).not.toThrow();
  });
});

describe('on directive', () => {
  it('expands each key into its own event slot', () => {
    const code = compile(
      `<button on={{ click: () => alt.set('x'), keydown: () => label.set('y') }}>go</button>`
    );

    expect(code).toContain('new EventSlot(slot0Node, "click", 0, undefined)');
    expect(code).toContain('new EventSlot(slot1Node, "keydown", 1, undefined)');
    expect(code).toContain('attachEvent_');
    expect(code).toContain('_click(): void');
    expect(code).toContain('_keydown(): void');
  });

  it('supports custom event names via string keys', () => {
    const code = compile(`<div on={{ 'my:event': () => alt.set('x') }} />`);

    expect(code).toContain('"my:event"');
  });

  it('rejects spread properties', () => {
    expect(() => compile('<div on={{ ...handlers }} />')).toThrow(
      /spread properties are not supported/
    );
  });
});

describe('legacy directive-extended syntax', () => {
  it('reports a migration error for colon-style directives', () => {
    expect(() => compile('<div model:value={alt.value} />')).toThrow();
  });

  it('reports a migration error for suffix-style event modifiers', () => {
    expect(() => compile('<div click.stop={() => {}} />')).toThrow();
  });
});
