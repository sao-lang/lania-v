import { describe, expect, it } from 'vitest';

import { laniaFcVitePlugin } from '@lania-v/vite-plugin';

const source = `
  import { defineComponent } from '@lania-v/runtime';
  export default defineComponent(function LoginPage() {
    return <section>Welcome</section>;
  });
`;

describe('Vite compiler debug trace', () => {
  it('injects compile-stage snapshots only for opted-in dev transforms', async () => {
    const plugin = laniaFcVitePlugin({ debug: true });
    plugin.configResolved?.({ command: 'serve' } as never);
    const result = await plugin.transform?.call(
      plugin,
      source,
      'LoginPage.lania.tsx'
    );

    expect(result).not.toBeNull();
    expect(result?.code).toContain('[lania-v] compile: LoginPage');
    expect(result?.code).toContain('Component IR');
    expect(result?.code).toContain('renderPlan');
    expect(result?.code).toContain('Generated module');
    expect(result?.code).toContain('__laniaCompile');
  });

  it('does not inject compile snapshots into production builds', async () => {
    const plugin = laniaFcVitePlugin({ debug: true });
    plugin.configResolved?.({ command: 'build' } as never);
    const result = await plugin.transform?.call(
      plugin,
      source,
      'LoginPage.lania.tsx'
    );

    expect(result?.code).not.toContain('[lania-v] compile:');
  });

  it('injects the component HMR bridge only for dev transforms', async () => {
    const devPlugin = laniaFcVitePlugin();
    devPlugin.configResolved?.({ command: 'serve' } as never);
    const devResult = await devPlugin.transform?.call(
      devPlugin,
      source,
      'LoginPage.lania.tsx'
    );

    // dev 下模块自我接受，并通过桥接把同名标签的重注册转成原型热替换。
    expect(devResult?.code).toContain('installComponentHmr');
    expect(devResult?.code).toContain('import.meta.hot.accept()');

    const buildPlugin = laniaFcVitePlugin();
    buildPlugin.configResolved?.({ command: 'build' } as never);
    const buildResult = await buildPlugin.transform?.call(
      buildPlugin,
      source,
      'LoginPage.lania.tsx'
    );

    // 生产产物不能出现 import.meta.hot 相关语句。
    expect(buildResult?.code).not.toContain('installComponentHmr');
    expect(buildResult?.code).not.toContain('import.meta.hot');
  });
});
