// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as runtime from '@lania-v/runtime';
import * as advanced from '@lania-v/runtime/advanced';
import {
  attachDeclarativeShadowRoot,
  readDeclarativeShadowTemplate,
  renderComponentToString,
  renderComponentToStream,
  renderDeclarativeShadowComponent,
  renderDeclarativeShadowRoot,
  renderStreamToDeclarativeShadow,
  renderToStringWithDeclarativeShadow,
} from '@lania-v/runtime';
import { compileFunctionComponentTsxToModule } from '@lania-v/compiler-tsx';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const loadComponent = (source: string): any => {
  const moduleCode = compileFunctionComponentTsxToModule(
    '/virtual/DsdCard.lania.tsx',
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

describe('declarative shadow DOM', () => {
  it('wraps html into a declarative shadow root with inlined styles', () => {
    const html = renderDeclarativeShadowRoot('<p>hi</p>', {
      styles: runtime.css`p { color: red; }`,
    });

    expect(html.startsWith('<template shadowrootmode="open">')).toBe(true);
    expect(html).toContain('<style data-lania-ssr-style>p { color: red; }</style>');
    expect(html).toContain('<p>hi</p>');
    expect(html.endsWith('</template>')).toBe(true);
  });

  it('serializes host attributes and light dom around the shadow template', () => {
    const html = renderDeclarativeShadowComponent('<span>shadow</span>', {
      tagName: 'my-card',
      attributes: { title: 'Hello', disabled: true, hidden: false },
      lightDom: '<b>slot</b>',
      mode: 'closed',
      delegatesFocus: true,
    });

    expect(html).toContain('<my-card title="Hello" disabled>');
    expect(html).toContain('<template shadowrootmode="closed" shadowrootdelegatesfocus>');
    expect(html.endsWith('</template><b>slot</b></my-card>')).toBe(true);
  });

  it('rejects invalid host tag names', () => {
    expect(() =>
      renderDeclarativeShadowComponent('<i></i>', { tagName: 'my card' })
    ).toThrow(/invalid tag name/);
  });

  it('takes over an unconsumed declarative template on the client', () => {
    const host = document.createElement('div');
    // 手工构造未被平台消费的模板，模拟不支持 DSD 的宿主环境。
    host.innerHTML =
      '<template shadowrootmode="open"><style>i{color:red}</style><i>shadow</i></template>';
    const template = readDeclarativeShadowTemplate(host);
    expect(template).not.toBeNull();

    const root = attachDeclarativeShadowRoot(host);

    expect(root).not.toBeNull();
    expect(root?.querySelector('i')?.textContent).toBe('shadow');
    expect(root?.querySelector('style')?.textContent).toBe('i{color:red}');
    expect(host.querySelector('template')).toBeNull();
    expect(readDeclarativeShadowTemplate(host)).toBeNull();
  });

  it('returns null when there is nothing to take over', () => {
    const host = document.createElement('div');
    expect(attachDeclarativeShadowRoot(host)).toBeNull();
  });

  it('hydrates compiled components from SSRed shadow content without duplication', async () => {
    const CardDsd = loadComponent(`
import { css, defineComponent } from '@lania-v/runtime';
const CardDsd = defineComponent(function CardDsd(props: { title: string }) {
  return <div>{props.title}</div>;
});
CardDsd.styles = css\`div { color: red; }\`;
export default CardDsd;
`);

    runtime.defineComponent(CardDsd);
    const tagName = runtime.getComponentTagName(CardDsd);
    expect(tagName).toBeTruthy();

    const html = renderToStringWithDeclarativeShadow(
      CardDsd,
      { title: 'SSR' },
      { tagName: tagName as string, attributes: { title: 'SSR' } }
    );

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const element = container.firstElementChild as HTMLElement & {
      title: string;
    };
    await flush();

    expect(element.shadowRoot).not.toBeNull();
    expect(element.shadowRoot?.querySelectorAll('style').length).toBe(1);
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('SSR');
    expect(element.getAttribute('title')).toBe('SSR');

    element.title = 'Client';
    await flush();
    expect(element.shadowRoot?.querySelector('div')?.textContent).toBe('Client');
    expect(element.shadowRoot?.querySelectorAll('style').length).toBe(1);

    element.remove();
    container.remove();
  });

  it('streams the same shadow wrapper as the sync output', async () => {    const CardStreamDsd = loadComponent(`
import { defineComponent } from '@lania-v/runtime';
const CardStreamDsd = defineComponent(function CardStreamDsd(props: { title: string }) {
  return <div>{props.title}</div>;
});
export default CardStreamDsd;
`);

    let output = '';
    for await (const chunk of renderStreamToDeclarativeShadow(
      CardStreamDsd,
      { title: 'Chunk' },
      { tagName: 'card-stream-dsd', attributes: { title: 'Chunk' } }
    )) {
      output += chunk;
    }

    expect(output.startsWith('<card-stream-dsd title="Chunk"><template shadowrootmode="open">')).toBe(
      true
    );
    expect(output).toContain('Chunk');
    expect(output.endsWith('</template></card-stream-dsd>')).toBe(true);
  });

  it('dispatches on renderMode and emits plain light DOM for light components', async () => {
    const CardLightDsd = loadComponent(`
import { defineComponent } from '@lania-v/runtime';
const CardLightDsd = defineComponent(function CardLightDsd(props: { title: string }) {
  return <div>{props.title}</div>;
});
CardLightDsd.renderMode = 'light';
export default CardLightDsd;
`);

    expect(CardLightDsd.renderMode).toBe('light');

    const html = renderComponentToString(
      CardLightDsd,
      { title: 'Light' },
      { tagName: 'card-light-dsd' }
    );

    // light 模式不能包 DSD：否则 SSR 内容会进一个组件永远不用的 shadow root。
    expect(html.startsWith('<card-light-dsd>')).toBe(true);
    expect(html).not.toContain('<template shadowrootmode');
    expect(html).toContain('Light');
    expect(html.endsWith('</card-light-dsd>')).toBe(true);

    let streamed = '';
    for await (const chunk of renderComponentToStream(
      CardLightDsd,
      { title: 'Streamed' },
      { tagName: 'card-light-dsd' }
    )) {
      streamed += chunk;
    }

    expect(streamed.startsWith('<card-light-dsd>')).toBe(true);
    expect(streamed).not.toContain('<template shadowrootmode');
    expect(streamed).toContain('Streamed');
    expect(streamed.endsWith('</card-light-dsd>')).toBe(true);

    // shadow 组件仍然走 DSD 输出。
    const shadowHtml = renderComponentToString(
      CardLightDsd,
      { title: 'Forced' },
      { tagName: 'card-light-dsd', renderMode: 'shadow' }
    );
    expect(shadowHtml).toContain('<template shadowrootmode="open">');
  });

  it('hydrates light-mode SSR content in place without duplication', async () => {
    const CardLightHydrate = loadComponent(`
import { css, defineComponent } from '@lania-v/runtime';
const CardLightHydrate = defineComponent(function CardLightHydrate(props: { title: string }) {
  return <div>{props.title}</div>;
});
CardLightHydrate.renderMode = 'light';
CardLightHydrate.styles = css\`div { color: red; }\`;
export default CardLightHydrate;
`);

    runtime.defineComponent(CardLightHydrate);
    const html = renderComponentToString(
      CardLightHydrate,
      { title: 'SSR' },
      { tagName: 'card-light-hydrate', attributes: { title: 'SSR' } }
    );

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const element = container.firstElementChild as HTMLElement & {
      title: string;
    };
    await flush();

    // 没有 shadow root，内容直接复用 SSR 的 light DOM 节点。
    expect(element.shadowRoot).toBeNull();
    expect(element.querySelectorAll('div').length).toBe(1);
    expect(element.querySelector('div')?.textContent).toBe('SSR');
    expect(element.querySelectorAll('style').length).toBe(1);

    element.title = 'Client';
    await flush();
    expect(element.querySelector('div')?.textContent).toBe('Client');
    expect(element.querySelectorAll('div').length).toBe(1);

    element.remove();
    container.remove();
  });
});
