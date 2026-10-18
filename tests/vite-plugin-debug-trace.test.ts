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
});
