import { describe, expect, it } from 'vitest';

import type { CompilerPlugin } from '@lania-v/compiler-core';
import {
  compileFunctionComponentTsx,
  compileFunctionComponentTsxToModule,
  emitFunctionComponentTsxModule,
} from '@lania-v/compiler-tsx';

describe('compiler plugins', () => {
  it('supports program transform, template transform and artifact hooks', () => {
    const source = `
function PluginHost() {
  return <section>{title()}</section>;
}

function title() {
  return 'ready';
}
`.trim();

    const calls: string[] = [];
    let generatedStaticHtml = '';
    const plugin: CompilerPlugin = {
      name: 'test-plugin',
      transformProgram(program) {
        calls.push('transformProgram');
        program.body[0]?.lifecycleHooks.push('connectedCallback');
      },
      transformTemplate(component) {
        calls.push('transformTemplate');
        const root = component.template.roots[0];

        if (root?.type === 'ElementIR') {
          root.tagName = 'article';
        }
      },
      beforeAnalyzeComponent() {
        calls.push('beforeAnalyzeComponent');
      },
      afterAnalyzeComponent(_component) {
        calls.push('afterAnalyzeComponent');
      },
      afterGenerateArtifact(artifact) {
        calls.push('afterGenerateArtifact');
        generatedStaticHtml = artifact.component.renderPlan.staticHtml;
      },
    };

    const result = compileFunctionComponentTsx('PluginHost.tsx', source, {
      plugins: [plugin],
    });

    expect(calls).toEqual([
      'transformProgram',
      'transformTemplate',
      'beforeAnalyzeComponent',
      'afterAnalyzeComponent',
      'afterGenerateArtifact',
    ]);
    expect(result.staticHtml).toBe('<article>__LANIA_SLOT_0__</article>');
    expect(result.ir.lifecycle.connected).toBe(true);
    expect(generatedStaticHtml).toBe('<article>__LANIA_SLOT_0__</article>');
  });

  it('rewrites local component tags to instance members', () => {
    const source = `
import { lazy } from '@lania-v/runtime';

function PluginHost() {
  const LazyHello = lazy(async () => ({
    default: (props: { name: string }) => <p>{props.name}</p>,
  }));
  return <section><LazyHello name="lania" /></section>;
}
`.trim();

    const moduleCode = compileFunctionComponentTsxToModule(
      'PluginHost.tsx',
      source
    );

    expect(moduleCode).toContain('LazyHello = lazy(');
    expect(moduleCode).toContain('component: this.LazyHello');
    expect(moduleCode).not.toMatch(/component:\s*LazyHello/);
  });

  it('separates compile and emit stages for TSX module output', () => {
    const source = `
import helper from './helper';
import { createSignal } from '@lania-v/runtime/reactivity';

function PluginHost() {
  const count = createSignal(1);
  return <section>{helper}{count.value}</section>;
}
`.trim();

    const compiled = compileFunctionComponentTsx('PluginHost.tsx', source);
    const emitted = emitFunctionComponentTsxModule(
      'PluginHost.tsx',
      source,
      compiled
    );
    const moduleCode = compileFunctionComponentTsxToModule(
      'PluginHost.tsx',
      source
    );

    expect(emitted.preambleCode).toContain("import helper from './helper';");
    // 二级入口的用户导入会被分流到对应的绑定块，不再出现在 preamble 里。
    expect(emitted.moduleCode).toContain(
      "import * as __laniaReactivity from '@lania-v/runtime/reactivity';"
    );
    expect(emitted.moduleCode).toContain(
      "import * as __lania from '@lania-v/runtime';"
    );
    expect(emitted.moduleCode).toContain('export default PluginHost;');
    expect(moduleCode).toBe(emitted.moduleCode);
  });
});
