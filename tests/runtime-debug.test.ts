// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReactiveElement,
  Scheduler,
  clearRuntimeDebugHooks,
  clearRuntimePlugins,
  createSignal,
  SimpleUpdater,
  TextSlot,
  registerRuntimeDebugHooks,
  setDevEnvironmentOverride,
  useRuntimePlugin,
  warning,
  assert,
} from '@lania-v/runtime';

const flushMicrotasks = async (times = 2): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  clearRuntimeDebugHooks();
  clearRuntimePlugins();
  setDevEnvironmentOverride(null);
});

describe('runtime debug hooks', () => {
  it('emits scheduler and signal debug events in dev mode', async () => {
    setDevEnvironmentOverride(true);
    const schedulerEvents: string[] = [];
    const signalEvents: Array<[unknown, unknown]> = [];
    const stop = registerRuntimeDebugHooks({
      onSchedulerEvent(event) {
        schedulerEvents.push(event.type);
      },
      onSignalEvent(event) {
        signalEvents.push([event.previous, event.current]);
      },
    });
    const scheduler = new Scheduler();
    const count = createSignal(0, scheduler);
    count.updaters.add(() => undefined);

    count.set(1);
    await flushMicrotasks();

    stop();

    expect(signalEvents).toEqual([[0, 1]]);
    expect(schedulerEvents).toContain('schedule');
    expect(schedulerEvents).toContain('flush-start');
    expect(schedulerEvents).toContain('flush-end');
  });

  it('emits value-free signal, updater, and slot events with correlatable ids', async () => {
    setDevEnvironmentOverride(true);
    const events: Array<{ type: string; payload?: unknown }> = [];
    registerRuntimeDebugHooks({
      onDevtoolsEvent(event) {
        events.push(event);
      },
      onSignalEvent(event) {
        events.push({
          type: `signal-${event.type}`,
          payload: { signalId: event.signalId },
        });
      },
    });

    const signal = createSignal('secret-value');
    const slot = new TextSlot(document.createTextNode(''), 4);
    const updater = new SimpleUpdater(() => signal.value, slot);
    updater.deps.add(signal);
    updater.attach();
    signal.set('changed-secret');
    await flushMicrotasks();

    const signalEvent = events.find((event) => event.type === 'signal-set');
    const updaterEvent = events.find((event) => event.type === 'updater-run');
    const slotEvent = events.find((event) => event.type === 'slot-write');

    expect(signalEvent?.payload).toMatchObject({
      signalId: expect.any(Number),
    });
    expect(updaterEvent?.payload).toMatchObject({
      updaterId: expect.any(Number),
      slots: [{ type: 'text', index: 4 }],
    });
    expect(slotEvent?.payload).toMatchObject({
      updaterId: expect.any(Number),
      slotType: 'text',
      slotIndex: 4,
    });
    expect(JSON.stringify(events)).not.toContain('secret-value');
    expect(JSON.stringify(events)).not.toContain('changed-secret');
  });

  it('emits lifecycle logs and runtime plugin devtools events', async () => {
    setDevEnvironmentOverride(true);
    const lifecycleEvents: string[] = [];
    const devtoolsEvents: string[] = [];

    useRuntimePlugin({
      name: 'debug-test-plugin',
      setup(api) {
        return api.registerDebugHooks({
          onLifecycleEvent(event) {
            lifecycleEvents.push(event.type);
          },
          onDevtoolsEvent(event) {
            devtoolsEvents.push(event.type);
          },
        });
      },
    });

    class DebugLifecycleElement extends ReactiveElement {
      protected _renderAndMount(): void {
        this.renderRoot.appendChild(document.createElement('div'));
      }
    }

    if (!customElements.get('x-debug-lifecycle')) {
      customElements.define('x-debug-lifecycle', DebugLifecycleElement);
    }

    const element = document.createElement(
      'x-debug-lifecycle'
    ) as DebugLifecycleElement;
    document.body.appendChild(element);
    await flushMicrotasks();
    warning('debug warning');
    element.remove();
    await flushMicrotasks();

    expect(lifecycleEvents).toContain('connected');
    expect(lifecycleEvents).toContain('request-update');
    expect(lifecycleEvents).toContain('will-update');
    expect(lifecycleEvents).toContain('updated');
    expect(lifecycleEvents).toContain('first-updated');
    expect(lifecycleEvents).toContain('disconnected');
    expect(devtoolsEvents).toContain('warning');
  });
});

describe('runtime dev mode helpers', () => {
  it('warns only in dev mode and always throws asserts', () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    setDevEnvironmentOverride(true);
    expect(warning('dev warning')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    setDevEnvironmentOverride(false);
    expect(warning('prod warning')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    expect(() => assert(false, 'broken')).toThrow('[lania-v] broken');
    warnSpy.mockRestore();
  });
});
