// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as runtime from '@lania-v/runtime';
import { createContext, provideContext } from '@lania-v/runtime';
import {
  Dynamic,
  Each,
  ErrorBoundary as ErrorBoundaryComponent,
  Fragment,
  KeepAlive as KeepAliveComponent,
  LazyLoad as LazyLoadComponent,
  Slot,
  Suspense as SuspenseComponent,
  Transition as TransitionComponent,
  TransitionGroup as TransitionGroupComponent,
  When,
} from '@lania-v/runtime';
import {
  bindHandlers,
  bindProps,
  bindSlots,
  createExpose,
  createComponentElement,
  createRoot,
  defineComponent,
  lazy,
  useContext,
} from '@lania-v/runtime';
import { createResource } from '@lania-v/runtime';
import {
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  readonly,
  untrack,
  watch,
} from '@lania-v/runtime';
import { isTracking, trackSignals } from '@lania-v/runtime/advanced';
import { createStore } from '@lania-v/runtime';
import {
  createErrorBoundaryHost,
  createLazyBoundaryHost,
  createSuspenseBoundaryHost,
  readContextBoundaryHost,
  withContextHost,
  withContextHost as withInternalContextHost,
  withDomHost,
} from '@lania-v/runtime/internal';
import { resetRuntimeTestState } from '@lania-v/runtime/testing';
import { jsx } from '../packages/runtime/src/entry/jsx-runtime';
import {
  type BoundaryPayload,
  type CachePayload,
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  type TransitionPayload,
} from '../packages/shared/src/enhanced-contract';
import { bootstrapRuntime } from '../packages/runtime/src/component/transition/host';
import { readRuntimeContract } from '../packages/runtime/src/component/lifecycle/keepalive-registry';
import {
  ErrorBoundary as ErrorBoundaryInternalComponent,
  type EnhancedRenderable,
  LazyLoad as LazyLoadInternalComponent,
  Suspense as SuspenseInternalComponent,
  TransitionGroup as TransitionGroupInternalComponent,
} from '../packages/runtime/src/component/enhanced-components';
import { resolveLazyOptions } from '../packages/runtime/src/component/lifecycle/boundary-registry';
import {
  bootstrapSnapshotRuntime,
  createCommitDebugSummary,
  createDomCommit,
  createSnapCommit,
  createGroupState,
  getTransitionGroupState,
} from '../packages/runtime/src/component/transition/group-registry';

const flushMicrotasks = async (times = 2): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

let runtimeBoundaryTestId = 0;

const nextRuntimeBoundaryStateKey = (prefix: string): string => {
  runtimeBoundaryTestId += 1;
  return `${prefix}-${runtimeBoundaryTestId}`;
};

type LegacyKeepAliveTestProps = {
  payload?: CachePayload;
  scope?: string;
  cacheKey?: PropertyKey | null;
  include?: readonly string[] | RegExp | null;
  exclude?: readonly string[] | RegExp | null;
  max?: number;
  onActivate?: (value: EnhancedRenderable, key: string, reused: boolean) => void;
  onDeactivate?: (value: EnhancedRenderable, key: string) => void;
  onCache?: (value: EnhancedRenderable, key: string) => void;
  onEvict?: (value: EnhancedRenderable, key: string) => void;
  children?: unknown;
};

type BoundaryLazyLoadTestProps = {
  payload: BoundaryPayload;
  fallback?: EnhancedRenderable;
  target?: Element | null;
  onVisibleChange?: (visible: boolean) => void;
  children?: unknown;
};

type BoundaryErrorTestProps = {
  payload: BoundaryPayload;
  fallback?: EnhancedRenderable | ((error: unknown, reset: () => void) => EnhancedRenderable);
  onError?: (error: unknown) => void;
  onReset?: () => void;
  children?: unknown;
};

type BoundarySuspenseTestProps = {
  payload: BoundaryPayload;
  fallback?: EnhancedRenderable;
  onPending?: (promise: Promise<unknown>) => void;
  onResolve?: () => void;
  onReject?: (error: unknown) => void;
  children?: unknown;
};

type LegacyTransitionTestProps = {
  payload?: TransitionPayload;
  name?: string;
  transitionKey?: PropertyKey | null;
  enter?: any;
  leave?: any;
  appear?: any;
  onEnter?: any;
  onLeave?: any;
  onAppear?: any;
  children?: unknown;
};

type LegacyTransitionGroupTestProps = {
  payload?: TransitionPayload;
  name?: string;
  tag?: string;
  groupKey?: PropertyKey | null;
  keys?: readonly PropertyKey[];
  move?: any;
  leave?: any;
  enter?: any;
  appear?: any;
  onMove?: any;
  onLeave?: any;
  onEnter?: any;
  onAppear?: any;
  children?: unknown;
};

const createKeepAlivePayload = (options: Omit<LegacyKeepAliveTestProps, 'children' | 'payload'>): CachePayload => {
  return {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    payloadKind: 'cache',
    component: 'KeepAlive',
    irKind: 'KeepAliveIR',
    slotIndex: 0,
    template: {},
    cache: {
      scope: options.scope,
      key: options.cacheKey,
      include: Array.isArray(options.include) ? options.include : undefined,
      exclude: Array.isArray(options.exclude) ? options.exclude : undefined,
      max: options.max,
    },
    metadata: {
      onActivate: options.onActivate,
      onDeactivate: options.onDeactivate,
      onCache: options.onCache,
      onEvict: options.onEvict,
    },
  };
};

const createBoundaryPayload = (
  component: BoundaryPayload['component'],
  metadata: Record<string, unknown> = {}
): BoundaryPayload => {
  return {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    payloadKind: 'boundary',
    component,
    irKind: 'BoundaryIR',
    boundaryIndex: 0,
    initialState: component === 'LazyLoad' ? 'inactive' : 'idle',
    childrenTemplate: {},
    metadata,
  };
};

const createLazyLoadPayload = (options: {
  key?: PropertyKey | null;
  rootMargin?: string;
  once?: boolean;
  observe?: boolean;
} = {}): BoundaryPayload => {
  return createBoundaryPayload('LazyLoad', {
    lazyKey: options.key,
    rootMargin: options.rootMargin,
    once: options.once,
    observe: options.observe,
  });
};

const createErrorBoundaryPayload = (options: {
  key?: PropertyKey | null;
} = {}): BoundaryPayload => {
  return createBoundaryPayload('ErrorBoundary', {
    boundaryKey: options.key,
  });
};

const createSuspensePayload = (options: {
  key?: PropertyKey | null;
} = {}): BoundaryPayload => {
  return createBoundaryPayload('Suspense', {
    suspenseKey: options.key,
  });
};

const createTransitionPayload = (
  component: TransitionPayload['component'],
  options: {
    name?: string;
    key?: PropertyKey | null;
    tag?: string;
    hooks?: TransitionPayload['transition']['hooks'];
  } = {}
): TransitionPayload => {
  return {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    payloadKind: 'transition',
    component,
    irKind: 'TransitionIR',
    transitionIndex: 0,
    transition: {
      name: options.name,
      key: options.key,
      keyProp: component === 'TransitionGroup' ? 'groupKey' : 'transitionKey',
      tag: options.tag,
      phases: component === 'TransitionGroup'
        ? ['appear', 'enter', 'move', 'leave']
        : ['appear', 'enter', 'leave'],
      hooks: options.hooks,
    },
  };
};

const KeepAlive = (props: LegacyKeepAliveTestProps) => {
  return KeepAliveComponent({
    payload: props.payload ?? createKeepAlivePayload(props),
    children: props.children,
  });
};

const LazyLoad = (props: BoundaryLazyLoadTestProps) => {
  return LazyLoadComponent({
    payload: props.payload,
    fallback: props.fallback as any,
    target: props.target,
    onVisibleChange: props.onVisibleChange,
    children: props.children,
  });
};

const LazyLoadInternal = (props: BoundaryLazyLoadTestProps) => {
  return LazyLoadInternalComponent({
    payload: props.payload,
    fallback: props.fallback as any,
    target: props.target,
    onVisibleChange: props.onVisibleChange,
    children: props.children,
  });
};

const ErrorBoundary = (props: BoundaryErrorTestProps) => {
  return ErrorBoundaryComponent({
    payload: props.payload,
    fallback: props.fallback as any,
    onError: props.onError,
    onReset: props.onReset,
    children: props.children,
  });
};

const ErrorBoundaryInternal = (props: BoundaryErrorTestProps) => {
  return ErrorBoundaryInternalComponent({
    payload: props.payload,
    fallback: props.fallback as any,
    onError: props.onError,
    onReset: props.onReset,
    children: props.children,
  });
};

const Suspense = (props: BoundarySuspenseTestProps) => {
  return SuspenseComponent({
    payload: props.payload,
    fallback: props.fallback as any,
    onPending: props.onPending,
    onResolve: props.onResolve,
    onReject: props.onReject,
    children: props.children,
  });
};

const SuspenseInternal = (props: BoundarySuspenseTestProps) => {
  return SuspenseInternalComponent({
    payload: props.payload,
    fallback: props.fallback as any,
    onPending: props.onPending,
    onResolve: props.onResolve,
    onReject: props.onReject,
    children: props.children,
  });
};

const Transition = (props: LegacyTransitionTestProps) => {
  return TransitionComponent({
    payload: props.payload ?? createTransitionPayload('Transition', {
      name: props.name,
      key: props.transitionKey,
      hooks: {
        enter: props.enter,
        leave: props.leave,
        appear: props.appear,
        onEnter: props.onEnter,
        onLeave: props.onLeave,
        onAppear: props.onAppear,
      },
    }),
    children: props.children,
  });
};

const TransitionGroup = (props: LegacyTransitionGroupTestProps) => {
  return TransitionGroupComponent({
    payload: props.payload ?? createTransitionPayload('TransitionGroup', {
      name: props.name,
      key: props.groupKey,
      tag: props.tag,
      hooks: {
        move: props.move,
        leave: props.leave,
        enter: props.enter,
        appear: props.appear,
        onMove: props.onMove,
        onLeave: props.onLeave,
        onEnter: props.onEnter,
        onAppear: props.onAppear,
      },
    }),
    keys: props.keys,
    children: props.children,
  });
};

const TransitionGroupInternal = (props: LegacyTransitionGroupTestProps) => {
  return TransitionGroupInternalComponent({
    payload: props.payload ?? createTransitionPayload('TransitionGroup', {
      name: props.name,
      key: props.groupKey,
      tag: props.tag,
      hooks: {
        move: props.move,
        leave: props.leave,
        enter: props.enter,
        appear: props.appear,
        onMove: props.onMove,
        onLeave: props.onLeave,
        onEnter: props.onEnter,
        onAppear: props.onAppear,
      },
    }),
    keys: props.keys,
    children: props.children,
  });
};

beforeEach(() => {
  resetRuntimeTestState();
  runtimeBoundaryTestId = 0;
});

describe('function component runtime helpers', () => {
  it('exposes only the supported FC lifecycle runtime helpers', () => {
    expect(runtime.onMount).toBeTypeOf('function');
    expect(runtime.onCleanup).toBeTypeOf('function');
    expect(runtime.onUpdated).toBeTypeOf('function');
    expect(runtime.onMounted).toBe(runtime.onMount);
    expect(runtime.onUnmounted).toBe(runtime.onCleanup);
    expect('onBeforeUpdate' in runtime).toBe(false);
    expect('onUpdate' in runtime).toBe(false);
    expect('onError' in runtime).toBe(false);
    expect('onAdopted' in runtime).toBe(false);
    expect('onAttributeChanged' in runtime).toBe(false);
  });

  it('fails loudly when compile-only lifecycle markers reach the runtime directly', () => {
    expect(() => runtime.onMount(() => {})).toThrowError(/compile-time only/i);
    expect(() => runtime.onCleanup(() => {})).toThrowError(/compile-time only/i);
    expect(() => runtime.onUpdated(() => {})).toThrowError(/compile-time only/i);
  });

  it('keeps host bridge and testing helpers off the runtime root entry', () => {
    expect('withContextHost' in runtime).toBe(false);
    expect('withDomHost' in runtime).toBe(false);
    expect('getCurrentContextHost' in runtime).toBe(false);
    expect('trackSignals' in runtime).toBe(false);
    expect('linkTrackedSignals' in runtime).toBe(false);
    expect('isTracking' in runtime).toBe(false);
    expect('resetRuntimeTestState' in runtime).toBe(false);
    expect(resetRuntimeTestState).toBeTypeOf('function');
  });

  it('returns the original function from defineComponent', () => {
    const component = defineComponent((props: { count: number }) => props.count);

    expect(component({ count: 3 })).toBe(3);
  });

  it('splits function component props and handlers into dedicated views', () => {
    const Child = defineComponent((props: {
      title: string;
      count: number;
      onToggle?: () => void;
      onSubmit?: { handler: () => void };
    }) => {
      const p = bindProps(props);
      const h = bindHandlers(props);

      return {
        propKeys: Object.keys(p).sort(),
        handlerKeys: Object.keys(h).sort(),
        title: p.title,
        count: p.count,
        onToggle: h.onToggle,
        onSubmit: h.onSubmit,
        hasHandlerInProps: 'onToggle' in p,
      } as const;
    });
    const onToggle = vi.fn();
    const onSubmit = { handler: vi.fn() };

    const first = jsx(Child, {
      title: 'Panel',
      count: 1,
      onToggle,
      onSubmit,
    }) as {
      propKeys: string[];
      handlerKeys: string[];
      title: string;
      count: number;
      onToggle?: () => void;
      onSubmit?: { handler: () => void };
      hasHandlerInProps: boolean;
    };

    expect(first.propKeys).toEqual(['count', 'key', 'title']);
    expect(first.handlerKeys).toEqual(['onSubmit', 'onToggle']);
    expect(first.title).toBe('Panel');
    expect(first.count).toBe(1);
    expect(first.onToggle).toBe(onToggle);
    expect(first.onSubmit).toBe(onSubmit);
    expect(first.hasHandlerInProps).toBe(false);
  });

  it('reads default and named slots through bindSlots', () => {
    const Child = defineComponent(() => {
      const slots = bindSlots();

      return {
        hasDefault: slots.has(),
        hasHeader: slots.has('header'),
        header: slots.get('header'),
        body: slots.renderDefault('fallback body'),
        footer: slots.render('footer', 'fallback footer'),
      } as const;
    });

    expect(
      jsx(Child, {
        children: {
          header: 'Header',
          default: 'Body',
        },
      })
    ).toEqual({
      hasDefault: true,
      hasHeader: true,
      header: 'Header',
      body: 'Body',
      footer: 'Body',
    });

    expect(jsx(Child, {})).toEqual({
      hasDefault: false,
      hasHeader: false,
      header: undefined,
      body: 'fallback body',
      footer: 'fallback footer',
    });
  });

  it('writes function component expose refs and clears them on root teardown', () => {
    const panelRef = { current: null as { focus(): string } | null };
    const Panel = defineComponent((props: { ref?: typeof panelRef }) => {
      createExpose(props, {
        focus() {
          return 'focused';
        },
      });

      const button = document.createElement('button');
      button.textContent = 'panel';
      return button;
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    root.render(jsx(Panel, { ref: panelRef }));
    expect(panelRef.current?.focus()).toBe('focused');

    root.render(document.createTextNode('next'));
    expect(panelRef.current).toBeNull();

    root.render(jsx(Panel, { ref: panelRef }));
    expect(panelRef.current?.focus()).toBe('focused');

    root.unmount();
    expect(panelRef.current).toBeNull();
  });

  it('keeps Transition publish result contracts on value-only visible and kind-plus-value previous shapes', () => {
    const stateKey = nextRuntimeBoundaryStateKey('transition-publish');
    const runtime = bootstrapRuntime<Node>({
      stateKey,
      getElements: (snapshot) => (snapshot instanceof Element ? [snapshot] : []),
    });
    const node = document.createElement('div');

    const visiblePublishResult = runtime.publishVisibleCommitState({
      rendered: node,
      previous: undefined,
      elements: [node],
    });
    const previousPublishResult = runtime.publishPreviousCommitState({
      previous: undefined,
      kind: 'hidden',
    });

    expect(Object.keys(visiblePublishResult)).toEqual(['value']);
    expect(Object.keys(previousPublishResult).sort()).toEqual(['kind', 'value']);
    expect(previousPublishResult.kind).toBe('hidden');
    expect('kind' in visiblePublishResult).toBe(false);
  });

  it('keeps TransitionGroup commit intent inside debug summary helper instead of publish result payloads', () => {
    const stateKey = nextRuntimeBoundaryStateKey('transition-group-publish');
    const runtime = bootstrapSnapshotRuntime<Node>({
      stateKey,
      leaveEnabled: false,
      getElements: (snapshot) => (snapshot instanceof Element ? [snapshot] : []),
    });
    const previousNode = document.createElement('li');
    previousNode.dataset.key = 'a';
    const previous = createGroupState<Node>({
      keys: ['a'],
      snapshots: [previousNode],
      container: null,
      tag: undefined,
      domHostAnchor: null,
      domHostLeaveAnchor: null,
      owner: null,
      activeBlocks: new Map(),
      leavingBlocks: new Map(),
      leavingSnapshots: new Map(),
      leaveVersion: 0,
    });
    const nextNode = document.createElement('li');
    nextNode.dataset.key = 'a';

    const debugSummary = createCommitDebugSummary({
      previous,
      keys: ['a'],
    });
    const visiblePublishResult = runtime.publishVisibleCommitState(
      createSnapCommit({
        keys: ['a'],
        renderedSnapshots: [nextNode],
        previous,
      })
    );
    const previousPublishResult = runtime.publishPreviousCommitState({
      previous,
      kind: 'hidden',
    });

    expect(debugSummary.commitIntent).toBe('visible');
    expect(debugSummary.nextKeyCount).toBe(1);
    expect(Object.keys(visiblePublishResult)).toEqual(['value']);
    expect(Object.keys(previousPublishResult).sort()).toEqual(['kind', 'value']);
    expect('commitIntent' in visiblePublishResult).toBe(false);
    expect('commitIntent' in previousPublishResult).toBe(false);
  });

  it('normalizes dom-host TransitionGroup bootstrap state out of visible commit context previous keys', () => {
    const runtimeState = createGroupState<Node>({
      keys: [],
      snapshots: [],
      container: document.createElement('ul'),
      tag: 'ul',
      domHostAnchor: document.createComment('anchor'),
      domHostLeaveAnchor: document.createComment('leave'),
      owner: null,
      activeBlocks: new Map(),
      leavingBlocks: new Map(),
      leavingSnapshots: new Map(),
      leaveVersion: 0,
    });
    const rendered = [document.createElement('li')];

    const context = createDomCommit({
      keys: ['a'],
      previous: runtimeState,
      runtime: {
        container: runtimeState.container!,
        activeAnchor: runtimeState.domHostAnchor!,
        leaveAnchor: runtimeState.domHostLeaveAnchor!,
        owner: {
          registerActiveBlock() {},
          handoffRemovedBlock() {
            return false;
          },
        },
        activeBlocks: runtimeState.activeBlocks,
        leavingBlocks: runtimeState.leavingBlocks,
        leavingSnapshots: runtimeState.leavingSnapshots,
        leaveVersion: runtimeState.leaveVersion,
        registerLeavingBlock() {},
        scheduleLeavingBlock() {},
        dispatchPhases() {},
        dispatchVisibleCommitPhases() {},
        publishVisibleCommitState() {
          return {
            value: runtimeState,
          };
        },
        renderEntries() {
          return rendered;
        },
        getPrevious() {
          return runtimeState;
        },
        summarizePrevious() {
          return {
            hasPrevious: true,
            previousVisible: false,
            previousAppeared: false,
            previousLeaving: false,
            hasSnapshot: false,
            previousKeys: [],
            previousContainerChildCount: 0,
            hasOwner: false,
            leavingBlockCount: 0,
          };
        },
        resolveCommitIntent() {
          return 'visible';
        },
        resolveKeys() {
          return ['a'];
        },
        resolvePrevious() {
          return runtimeState;
        },
        commit() {
          return runtimeState.container!;
        },
        commitLeaving() {
          return runtimeState.container!;
        },
        commitHidden() {
          return runtimeState.container!;
        },
        renderVisibleCommitResult() {
          return runtimeState.container!;
        },
        commitVisibleContext() {
          return runtimeState.container!;
        },
        commitVisible() {
          return runtimeState.container!;
        },
        publishPreviousCommitState(context) {
          return {
            kind: context.kind,
            value: context.previous,
          };
        },
        renderPreviousCommitResult() {
          return runtimeState.container!;
        },
        commitPreviousContext() {
          return runtimeState.container!;
        },
      },
      rendered,
    });

    expect(context.previous).toBeUndefined();
    expect(context.previousKeys).toBeUndefined();
    expect(context.publishStateInput.keys).toEqual(['a']);
  });

  it('reads context through the current host bridge', () => {
    const themeContext = createContext('light', 'theme');
    const provider = document.createElement('section');
    const consumer = document.createElement('div');
    provider.appendChild(consumer);

    provideContext(provider, themeContext, 'dark');

    const value = withContextHost(consumer, () => useContext(themeContext));

    expect(value()).toBe('dark');
  });

  it('renders and unmounts content through createRoot', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const node = document.createElement('span');
    node.textContent = 'mounted';

    root.render(node);
    expect(container.textContent).toBe('mounted');

    root.render('replaced');
    expect(container.textContent).toBe('replaced');

    root.unmount();
    expect(container.textContent).toBe('');
  });

  it('keeps createRoot scoped to already-rendered values instead of function references', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const App = () => document.createElement('span');

    expect(() => root.render(App)).toThrowError(/already-rendered values/i);
    expect(container.textContent).toBe('');
  });

  it('creates component elements with auto-registration and keeps registered styles current', () => {
    class XAutoRegister extends HTMLElement {
      static tagName = 'x-auto-register';
    }
    class XAutoRegisterHot extends HTMLElement {
      static tagName = 'x-auto-register';
    }

    const styleA = { cssText: ':host { color: red; }', kind: 'css-result', toString() { return this.cssText; } } as const;
    const styleB = { cssText: ':host { color: blue; }', kind: 'css-result', toString() { return this.cssText; } } as const;

    const firstElement = createComponentElement(XAutoRegister, {
      styles: styleA,
    });
    const secondElement = createComponentElement(XAutoRegisterHot, {
      styles: styleB,
    });

    expect(firstElement).toBeInstanceOf(XAutoRegister);
    expect(secondElement.tagName.toLowerCase()).toBe('x-auto-register');
    expect(customElements.get('x-auto-register')).toBe(XAutoRegister);
    expect((XAutoRegister as typeof XAutoRegister & { styles?: unknown }).styles).toBe(styleB);
  });

  it('renders component elements through createRoot without a dedicated mount helper', () => {
    class XMountedCard extends HTMLElement {
      static tagName = 'x-mounted-card';
      private _title = '';

      get title() {
        return this._title;
      }

      set title(value: string) {
        this._title = value;
      }

      connectedCallback() {
        this.textContent = `title:${this.title}`;
      }
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const mounted = createComponentElement(XMountedCard, {
      props: {
        title: 'demo',
      },
    });
    root.render(mounted);

    expect(mounted).toBeInstanceOf(XMountedCard);
    expect(container.firstElementChild).toBe(mounted);
    expect(container.textContent).toBe('title:demo');
    expect(createComponentElement(XMountedCard).tagName.toLowerCase()).toBe('x-mounted-card');
    container.remove();
  });

  it('creates compiled component constructors directly from jsx usage', () => {
    class XJsxMountedCard extends HTMLElement {
      static tagName = 'x-jsx-mounted-card';
      private _title = '';

      get title() {
        return this._title;
      }

      set title(value: string) {
        this._title = value;
      }
    }

    const rendered = jsx(XJsxMountedCard, {
      title: 'demo',
    });

    expect(rendered).toBeInstanceOf(XJsxMountedCard);
    expect((rendered as XJsxMountedCard).title).toBe('demo');
    expect(customElements.get('x-jsx-mounted-card')).toBe(XJsxMountedCard);
  });

  it('loads lazy components through preload and invokes the resolved component', async () => {
    const LazyGreeting = lazy(async () => {
      return {
        default: (props: { name: string }) => `hello ${props.name}`,
      };
    });

    expect(LazyGreeting.resolved()).toBeNull();
    await LazyGreeting.preload();

    expect(LazyGreeting.resolved()).not.toBeNull();
    expect(LazyGreeting({ name: 'lania' })).toBe('hello lania');
  });

  it('evaluates enhanced component helpers with their first-pass runtime semantics', () => {
    expect(When({ when: true, children: 'ready', fallback: 'empty' })).toBe('ready');
    expect(When({ when: false, children: 'ready', fallback: 'empty' })).toBe('empty');
    expect(When({ when: true, mode: 'remount', children: 'ready', fallback: 'empty' })).toBe('ready');
    expect(
      Each({
        items: ['A', 'B'],
        children: (item) => item.toLowerCase(),
      })
    ).toEqual(['a', 'b']);
    expect(
      Each({
        items: [],
        fallback: 'none',
        children: (item: string) => item,
      })
    ).toBe('none');
    expect(Fragment({ children: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(Slot({ children: 'fallback' })).toBe('fallback');
  });

  it('renders Slot helpers against caller children in function-component scope', () => {
    const Child = defineComponent(() => Slot({ fallback: 'empty' }));

    expect(jsx(Child, { children: 'projected' })).toBe('projected');
    expect(jsx(Child, {})).toBe('empty');
  });

  it('renders Dynamic helpers against tags and function components', () => {
    const target = Dynamic({
      is: 'section',
      props: {
        id: 'hero',
      },
      children: 'Ready',
    });

    expect(target).toBeInstanceOf(HTMLElement);
    expect((target as HTMLElement).tagName.toLowerCase()).toBe('section');
    expect((target as HTMLElement).id).toBe('hero');
    expect((target as HTMLElement).textContent).toBe('Ready');

    expect(
      Dynamic({
        component: (props: { label?: string; children?: unknown }) => {
          return `${props.label}:${props.children as string}`;
        },
        props: {
          label: 'demo',
        },
        children: 'value',
      })
    ).toBe('demo:value');
  });

  it('uses ErrorBoundary fallback and Suspense fallback helpers', () => {
    let reset: (() => void) | undefined;
    const events: string[] = [];

    expect(
      ErrorBoundary({
        payload: createErrorBoundaryPayload({
          key: 'error-boundary-basic',
        }),
        fallback: (error, nextReset) => {
          reset = nextReset;
          return `failed:${(error as Error).message}`;
        },
        onError: (error) => events.push(`error:${(error as Error).message}`),
        onReset: () => events.push('reset'),
        children: () => {
          throw new Error('boom');
        },
      })
    ).toBe('failed:boom');
    expect(
      ErrorBoundary({
        payload: createErrorBoundaryPayload({
          key: 'error-boundary-basic',
        }),
        fallback: 'failed',
        children: 'ok',
      })
    ).toBe('failed');
    reset?.();
    expect(
      ErrorBoundary({
        payload: createErrorBoundaryPayload({
          key: 'error-boundary-basic',
        }),
        fallback: 'failed',
        children: 'ok',
      })
    ).toBe('ok');
    expect(events).toEqual(['error:boom', 'reset']);

    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });
    const suspenseEvents: string[] = [];
    expect(
      Suspense({
        payload: createSuspensePayload({
          key: 'suspense-basic',
        }),
        fallback: 'loading',
        onPending: () => suspenseEvents.push('pending'),
        onResolve: () => suspenseEvents.push('resolve'),
        children: () => {
          if (!resolved) {
            throw pending;
          }

          return 'ready';
        },
      })
    ).toBe('loading');
    release();
    return pending.then(async () => {
      await flushMicrotasks(3);
      expect(
        Suspense({
          payload: createSuspensePayload({
            key: 'suspense-basic',
          }),
          fallback: 'loading',
          children: () => 'ready',
        })
      ).toBe('ready');
      expect(suspenseEvents).toEqual(['pending', 'resolve']);
    });
  });

  it('accepts direct FC props for boundary enhanced components without hand-written payloads', async () => {
    let reset: (() => void) | undefined;
    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });

    expect(
      LazyLoadComponent({
        lazyKey: 'fc-direct-lazy',
        observe: false,
        fallback: 'loading',
        children: 'ready',
      })
    ).toBe('ready');

    expect(
      ErrorBoundaryComponent({
        boundaryKey: 'fc-direct-boundary',
        fallback: (error, nextReset) => {
          reset = nextReset;
          return `failed:${(error as Error).message}`;
        },
        children: () => {
          throw new Error('boom');
        },
      })
    ).toBe('failed:boom');
    reset?.();
    expect(
      ErrorBoundaryComponent({
        boundaryKey: 'fc-direct-boundary',
        fallback: 'failed',
        children: 'ready',
      })
    ).toBe('ready');

    expect(
      SuspenseComponent({
        suspenseKey: 'fc-direct-suspense',
        fallback: 'loading',
        children: () => {
          if (!resolved) {
            throw pending;
          }
          return 'ready';
        },
      })
    ).toBe('loading');

    release();
    await pending;
    await flushMicrotasks(3);

    expect(
      SuspenseComponent({
        suspenseKey: 'fc-direct-suspense',
        fallback: 'loading',
        children: () => 'ready',
      })
    ).toBe('ready');
  });

  it('reuses recorded error for ErrorBoundary function fallback', () => {
    let reset: (() => void) | undefined;

    expect(
      ErrorBoundaryInternal({
        payload: createErrorBoundaryPayload({
          key: 'error-boundary-function-cache',
        }),
        fallback: 'failed',
        children: () => {
          throw new Error('cached-boom');
        },
      })
    ).toBe('failed');

    expect(
      ErrorBoundaryInternal({
        payload: createErrorBoundaryPayload({
          key: 'error-boundary-function-cache',
        }),
        fallback: (error, nextReset) => {
          reset = nextReset;
          return `cached:${(error as Error).message}`;
        },
        children: 'ok',
      })
    ).toBe('cached:cached-boom');

    reset?.();

    expect(
      ErrorBoundaryInternal({
        payload: createErrorBoundaryPayload({
          key: 'error-boundary-function-cache',
        }),
        fallback: 'failed',
        children: 'ok',
      })
    ).toBe('ok');
  });

  it('requests a host update when ErrorBoundary reset clears the recorded error', () => {
    let reset: (() => void) | undefined;
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };

    expect(
      withContextHost(host, () =>
        ErrorBoundary({
          payload: createErrorBoundaryPayload({
            key: 'error-boundary-host-reset',
          }),
          fallback: (error, nextReset) => {
            reset = nextReset;
            return `failed:${(error as Error).message}`;
          },
          children: () => {
            throw new Error('boom');
          },
        })
      )
    ).toBe('failed:boom');

    expect(host.requestUpdate).not.toHaveBeenCalled();
    reset?.();
    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
    expect(
      withContextHost(host, () =>
        ErrorBoundary({
          payload: createErrorBoundaryPayload({
            key: 'error-boundary-host-reset',
          }),
          fallback: 'failed',
          children: 'ok',
        })
      )
    ).toBe('ok');
  });

  it('requests a host update when Suspense resolves', async () => {
    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    let resolved = false;
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };

    expect(
      withContextHost(host, () =>
        Suspense({
          payload: createSuspensePayload({
            key: 'suspense-host-refresh',
          }),
          fallback: 'loading',
          children: () => {
            if (!resolved) {
              throw pending;
            }

            return 'ready';
          },
        })
      )
    ).toBe('loading');

    resolved = true;
    resolvePending();
    await pending;
    await flushMicrotasks(3);

    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
    expect(
      withContextHost(host, () =>
        Suspense({
          payload: createSuspensePayload({
            key: 'suspense-host-refresh',
          }),
          fallback: 'loading',
          children: () => 'ready',
        })
      )
    ).toBe('ready');
  });

  it('formalizes BoundaryHost builders on top of the shared context host contract', () => {
    const requestUpdate = vi.fn();
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate,
    };

    withInternalContextHost(host, () => {
      const boundary = readContextBoundaryHost();
      const lazyHost = createLazyBoundaryHost({
        boundary,
        observeWhileVisible: true,
        renderChild: () => 'child',
        renderFallback: () => 'fallback',
      });
      const errorHost = createErrorBoundaryHost({
        boundary,
        renderChild: () => 'child',
        renderFallback: (_error: unknown, reset: () => void) => {
          reset();
          return 'failed';
        },
      });
      const suspenseHost = createSuspenseBoundaryHost({
        boundary,
        renderChild: () => 'child',
        renderFallback: () => 'loading',
      });

      expect(lazyHost.renderChild()).toBe('child');
      expect(lazyHost.renderFallback(document.createElement('span'))).toBe('fallback');
      expect(lazyHost.observeWhileVisible).toBe(true);
      expect(errorHost.renderFallback(new Error('boom'), () => undefined)).toBe('failed');
      expect(suspenseHost.renderFallback()).toBe('loading');

      lazyHost.replay();
      suspenseHost.reset();
    });

    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });

  it('rethrows rejected Suspense promise on next render and calls onReject', async () => {
    let rejectPending!: (reason: unknown) => void;
    const pending = new Promise<void>((_, reject) => {
      rejectPending = reject;
    });
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const events: string[] = [];

    expect(
      withContextHost(host, () =>
        Suspense({
          payload: createSuspensePayload({
            key: 'suspense-reject',
          }),
          fallback: 'loading',
          onPending: () => events.push('pending'),
          onReject: (error) => events.push(`reject:${String(error)}`),
          children: () => {
            throw pending;
          },
        })
      )
    ).toBe('loading');

    rejectPending('boom');
    await pending.catch(() => {});
    await flushMicrotasks(3);

    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['pending', 'reject:boom']);
    expect(() =>
      withContextHost(host, () =>
        Suspense({
          payload: createSuspensePayload({
            key: 'suspense-reject',
          }),
          fallback: 'loading',
          children: () => 'ready',
        })
      )
    ).toThrow('boom');
  });

  it('lets ErrorBoundary catch rejected Suspense errors on replay', async () => {
    let rejectPending!: (reason: unknown) => void;
    const pending = new Promise<void>((_, reject) => {
      rejectPending = reject;
    });
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const events: string[] = [];
    const render = () =>
      withContextHost(host, () =>
        ErrorBoundary({
          payload: createErrorBoundaryPayload({
            key: 'error-boundary-suspense-reject',
          }),
          fallback: (error) => `failed:${String(error)}`,
          onError: (error) => events.push(`error:${String(error)}`),
          children: () =>
            Suspense({
              payload: createSuspensePayload({
                key: 'suspense-reject-inside-boundary',
              }),
              fallback: 'loading',
              onPending: () => events.push('pending'),
              onReject: (error) => events.push(`reject:${String(error)}`),
              children: () => {
                throw pending;
              },
            }),
        })
      );

    expect(render()).toBe('loading');

    rejectPending('boom');
    await pending.catch(() => {});
    await flushMicrotasks(3);

    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
    expect(render()).toBe('failed:boom');
    expect(events).toEqual(['pending', 'reject:boom', 'error:boom']);
  });

  it('uses LazyLoad fallback, once and repeat observation semantics', () => {
    const observerRecords: Array<{
      callback: IntersectionObserverCallback;
      targets: Element[];
      disconnects: number;
      unobserved: Element[];
    }> = [];
    class MockIntersectionObserver {
      private readonly index: number;

      constructor(callback: IntersectionObserverCallback) {
        this.index = observerRecords.push({
          callback,
          targets: [],
          disconnects: 0,
          unobserved: [],
        }) - 1;
      }

      observe(target: Element) {
        observerRecords[this.index]!.targets.push(target);
      }

      unobserve(target: Element) {
        observerRecords[this.index]!.unobserved.push(target);
      }

      disconnect() {
        observerRecords[this.index]!.disconnects += 1;
      }
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    const onceChanges: boolean[] = [];
    const card = document.createElement('article');
    card.textContent = 'Card';
    const firstPass = LazyLoadInternal({
      payload: createLazyLoadPayload({
        key: 'lazy-once',
        once: true,
      }),
      fallback: 'loading',
      onVisibleChange: (visible) => onceChanges.push(visible),
      children: card,
    });

    expect(Array.isArray(firstPass)).toBe(true);
    expect(firstPass).toEqual(expect.arrayContaining(['loading']));
    const onceObserver = observerRecords.at(-1);
    expect(onceObserver).toBeDefined();
    expect(onceObserver?.targets[0]).not.toBe(card);
    onceObserver?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(
      LazyLoadInternal({
        payload: createLazyLoadPayload({
          key: 'lazy-once',
          once: true,
        }),
        fallback: 'loading',
        children: card,
      })
    ).toBe(card);
    expect(onceChanges).toEqual([true]);
    expect(observerRecords[0]?.disconnects).toBe(1);

    const repeatChanges: boolean[] = [];
    const list = document.createElement('section');
    list.textContent = 'List';
    const repeatPass = LazyLoad({
      payload: createLazyLoadPayload({
        key: 'lazy-repeat',
        once: false,
      }),
      fallback: 'pending',
      onVisibleChange: (visible) => repeatChanges.push(visible),
      children: list,
    });

    expect(Array.isArray(repeatPass)).toBe(true);
    const repeatObserver = observerRecords.at(-1);
    expect(repeatObserver).toBeDefined();
    expect(repeatObserver?.targets[0]).not.toBe(list);
    repeatObserver?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(
      LazyLoad({
        payload: createLazyLoadPayload({
          key: 'lazy-repeat',
          once: false,
        }),
        fallback: 'pending',
        onVisibleChange: (visible) => repeatChanges.push(visible),
        children: list,
      })
    ).toBe(list);
    expect(repeatObserver?.targets.at(-1)).toBe(list);
    expect(repeatObserver?.unobserved.at(-1)).toBe(repeatObserver?.targets[0]);
    repeatObserver?.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    const repeatFallback = LazyLoad({
      payload: createLazyLoadPayload({
        key: 'lazy-repeat',
        once: false,
      }),
      fallback: 'pending',
      onVisibleChange: (visible) => repeatChanges.push(visible),
      children: list,
    });
    expect(Array.isArray(repeatFallback)).toBe(true);
    expect(repeatObserver?.targets.at(-1)).not.toBe(list);
    expect(repeatObserver?.unobserved.at(-1)).toBe(list);
    expect(repeatChanges).toEqual([true, false]);
    vi.unstubAllGlobals();
  });

  it('keeps LazyLoad observe=false as passthrough while shared helper still switches to child after visibility', () => {
    const observerRecords: Array<{
      callback: IntersectionObserverCallback;
      targets: Element[];
    }> = [];
    class MockIntersectionObserver {
      private readonly index: number;

      constructor(callback: IntersectionObserverCallback) {
        this.index = observerRecords.push({
          callback,
          targets: [],
        }) - 1;
      }

      observe(target: Element) {
        observerRecords[this.index]!.targets.push(target);
      }

      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    expect(
      LazyLoadInternal({
        payload: createLazyLoadPayload({
          key: 'lazy-no-observe',
          observe: false,
        }),
        fallback: 'loading',
        children: 'ready',
      })
    ).toBe('ready');
    expect(observerRecords).toHaveLength(0);

    const card = document.createElement('article');
    card.textContent = 'Card';
    const visibilityChanges: boolean[] = [];
    const firstPass = LazyLoadInternal({
      payload: createLazyLoadPayload({
        key: 'lazy-shared-helper-switch',
        once: true,
      }),
      fallback: 'loading',
      onVisibleChange: (visible) => visibilityChanges.push(visible),
      children: card,
    });

    expect(Array.isArray(firstPass)).toBe(true);
    observerRecords[0]?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(visibilityChanges).toEqual([true]);
    expect(
      LazyLoadInternal({
        payload: createLazyLoadPayload({
          key: 'lazy-shared-helper-switch',
          once: true,
        }),
        fallback: 'loading',
        children: card,
      })
    ).toBe(card);

    vi.unstubAllGlobals();
  });

  it('prefers LazyLoad boundary payload metadata key over local props', () => {
    const observerRecords: Array<{
      callback: IntersectionObserverCallback;
      targets: Element[];
    }> = [];
    class MockIntersectionObserver {
      private readonly index: number;

      constructor(callback: IntersectionObserverCallback) {
        this.index = observerRecords.push({
          callback,
          targets: [],
        }) - 1;
      }

      observe(target: Element) {
        observerRecords[this.index]!.targets.push(target);
      }

      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    const card = document.createElement('article');
    card.textContent = 'Card';
    const payload = {
      protocol: ENHANCED_CONTRACT_PROTOCOL,
      version: ENHANCED_CONTRACT_VERSION,
      payloadKind: 'boundary' as const,
      component: 'LazyLoad' as const,
      irKind: 'BoundaryIR' as const,
      boundaryIndex: 0,
      initialState: 'inactive' as const,
      childrenTemplate: {},
      metadata: {
        lazyKey: 'payload-key',
      },
    };
    expect(
      resolveLazyOptions({
        payload,
      }).key
    ).toBe('payload-key');

    const firstPass = LazyLoad({
      payload,
      fallback: 'loading',
      children: card,
    });
    expect(Array.isArray(firstPass)).toBe(true);

    observerRecords[0]?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
    expect(
      resolveLazyOptions({
        payload,
      }).key
    ).toBe('payload-key');

    vi.unstubAllGlobals();
  });

  it('uses ErrorBoundary payload metadata key as the state source', () => {
    const first = ErrorBoundaryInternal({
      payload: createErrorBoundaryPayload({
        key: 'payload-boundary',
      }),
      fallback: 'failed',
      children: () => {
        throw new Error('boom');
      },
    });

    expect(first).toBe('failed');
    // The second call should keep reading the cached error from the payload key.
    expect(
      ErrorBoundaryInternal({
        payload: createErrorBoundaryPayload({
          key: 'payload-boundary',
        }),
        fallback: 'failed',
        children: 'ok',
      })
    ).toBe('failed');
  });

  it('uses Suspense payload metadata key as the state source', async () => {
    let resolved = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = () => {
        resolved = true;
        resolve();
      };
    });

    expect(
      SuspenseInternal({
        payload: createSuspensePayload({
          key: 'payload-suspense',
        }),
        fallback: 'loading',
        children: () => {
          if (!resolved) {
            throw pending;
          }
          return 'ready';
        },
      })
    ).toBe('loading');

    // A second render with the same payload key should keep reading the pending state.
    expect(
      SuspenseInternal({
        payload: createSuspensePayload({
          key: 'payload-suspense',
        }),
        fallback: 'loading',
        children: () => 'ready',
      })
    ).toBe('loading');

    release();
    await pending;
    await flushMicrotasks(3);

    // After resolution, the same payload key should now surface the resolved branch.
    expect(
      SuspenseInternal({
        payload: createSuspensePayload({
          key: 'payload-suspense',
        }),
        fallback: 'loading',
        children: () => 'ready',
      })
    ).toBe('ready');
  });

  it('caches KeepAlive branches and fires lifecycle hooks', () => {
    const events: string[] = [];
    const first = document.createElement('section');
    first.dataset.key = 'page-a';
    first.textContent = 'A';
    const second = document.createElement('section');
    second.dataset.key = 'page-b';
    second.textContent = 'B';
    const third = document.createElement('section');
    third.dataset.key = 'page-c';
    third.textContent = 'C';

    const a1 = KeepAlive({
      scope: 'tabs',
      cacheKey: 'page-a',
      include: ['page-a', 'page-b', 'page-c'],
      max: 2,
      children: first,
      onCache: (_value, key) => events.push(`cache:${key}`),
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
      onDeactivate: (_value, key) => events.push(`deactivate:${key}`),
      onEvict: (_value, key) => events.push(`evict:${key}`),
    });
    const b1 = KeepAlive({
      scope: 'tabs',
      cacheKey: 'page-b',
      include: ['page-a', 'page-b', 'page-c'],
      max: 2,
      children: second,
      onCache: (_value, key) => events.push(`cache:${key}`),
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
      onDeactivate: (_value, key) => events.push(`deactivate:${key}`),
      onEvict: (_value, key) => events.push(`evict:${key}`),
    });
    const a2 = KeepAlive({
      scope: 'tabs',
      cacheKey: 'page-a',
      include: ['page-a', 'page-b', 'page-c'],
      max: 2,
      children: document.createElement('section'),
      onCache: (_value, key) => events.push(`cache:${key}`),
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
      onDeactivate: (_value, key) => events.push(`deactivate:${key}`),
      onEvict: (_value, key) => events.push(`evict:${key}`),
    });
    const c1 = KeepAlive({
      scope: 'tabs',
      cacheKey: 'page-c',
      include: ['page-a', 'page-b', 'page-c'],
      max: 2,
      children: third,
      onCache: (_value, key) => events.push(`cache:${key}`),
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
      onDeactivate: (_value, key) => events.push(`deactivate:${key}`),
      onEvict: (_value, key) => events.push(`evict:${key}`),
    });

    expect(a1).toBe(first);
    expect(b1).toBe(second);
    expect(a2).toBe(first);
    expect(c1).toBe(third);
    expect(events).toEqual([
      'cache:page-a',
      'activate:page-a:false',
      'cache:page-b',
      'deactivate:page-a',
      'activate:page-b:false',
      'deactivate:page-b',
      'activate:page-a:true',
      'cache:page-c',
      'deactivate:page-a',
      'activate:page-c:false',
      'evict:page-b',
    ]);
  });

  it('reuses multi-node KeepAlive branches without losing cached nodes', () => {
    const host = document.createElement('div');
    const firstA = document.createElement('span');
    firstA.dataset.keepalivePane = 'a-1';
    firstA.textContent = 'A-1';
    const secondA = document.createElement('span');
    secondA.dataset.keepalivePane = 'a-2';
    secondA.textContent = 'A-2';
    const pageB = document.createElement('section');
    pageB.dataset.keepalivePane = 'b';
    pageB.textContent = 'B';
    const renderIntoHost = (content: EnhancedRenderable) => {
      host.replaceChildren();
      const append = (value: EnhancedRenderable) => {
        if (Array.isArray(value)) {
          value.forEach((entry) => append(entry));
          return;
        }
        if (value == null || value === false) {
          return;
        }
        if (value instanceof Node) {
          host.appendChild(value);
          return;
        }
        host.appendChild(document.createTextNode(String(value)));
      };
      append(content);
    };

    const a1 = KeepAlive({
      scope: 'multi-pane',
      cacheKey: 'page-a',
      children: [firstA, secondA],
    });
    expect(Array.isArray(a1)).toBe(true);
    renderIntoHost(a1);
    expect(host.querySelectorAll('[data-keepalive-pane^="a-"]')).toHaveLength(2);

    const b1 = KeepAlive({
      scope: 'multi-pane',
      cacheKey: 'page-b',
      children: pageB,
    });
    renderIntoHost(b1);
    expect(host.querySelector('[data-keepalive-pane="b"]')).toBe(pageB);

    const a2 = KeepAlive({
      scope: 'multi-pane',
      cacheKey: 'page-a',
      children: [document.createElement('em'), document.createElement('strong')],
    });
    expect(Array.isArray(a2)).toBe(true);
    renderIntoHost(a2);

    const rendered = [...host.querySelectorAll('[data-keepalive-pane^="a-"]')];
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toBe(firstA);
    expect(rendered[1]).toBe(secondA);
    expect(host.textContent).toBe('A-1A-2');
  });

  it('keeps multi-node KeepAlive hook values aligned with the cached node set', () => {
    const first = document.createElement('span');
    first.textContent = 'first';
    const second = document.createElement('span');
    second.textContent = 'second';
    const updated = document.createElement('em');
    updated.textContent = 'updated';
    const pageB = document.createElement('section');
    pageB.textContent = 'page-b';
    const cachedValues: EnhancedRenderable[] = [];
    const activatedValues: EnhancedRenderable[] = [];

    const initial = KeepAlive({
      scope: 'hook-nodes',
      cacheKey: 'page-a',
      children: [first, second],
      onCache: (value) => cachedValues.push(value),
      onActivate: (value) => activatedValues.push(value),
    });
    const reused = KeepAlive({
      scope: 'hook-nodes',
      cacheKey: 'page-a',
      children: updated,
      onActivate: (value) => activatedValues.push(value),
    });
    KeepAlive({
      scope: 'hook-nodes',
      cacheKey: 'page-b',
      children: pageB,
    });
    const reactivated = KeepAlive({
      scope: 'hook-nodes',
      cacheKey: 'page-a',
      children: document.createElement('strong'),
      onActivate: (value) => activatedValues.push(value),
    });

    expect(Array.isArray(initial)).toBe(true);
    expect(reused).toBe(updated);
    expect(cachedValues).toHaveLength(1);
    expect(activatedValues).toHaveLength(2);
    expect(cachedValues[0]).toStrictEqual(initial);
    expect(activatedValues[0]).toStrictEqual(initial);
    expect(activatedValues[1]).toBe(reactivated);
    expect(reactivated).toBe(updated);
  });

  it('keeps single-node KeepAlive hook values aligned with the public return shape', () => {
    const first = document.createElement('article');
    first.textContent = 'first';
    const updated = document.createElement('section');
    updated.textContent = 'updated';
    const pageB = document.createElement('aside');
    pageB.textContent = 'page-b';
    const cachedValues: EnhancedRenderable[] = [];
    const activatedValues: EnhancedRenderable[] = [];

    const initial = KeepAlive({
      scope: 'hook-single-node',
      cacheKey: 'page-a',
      children: first,
      onCache: (value) => cachedValues.push(value),
      onActivate: (value) => activatedValues.push(value),
    });
    const reused = KeepAlive({
      scope: 'hook-single-node',
      cacheKey: 'page-a',
      children: updated,
      onActivate: (value) => activatedValues.push(value),
    });
    KeepAlive({
      scope: 'hook-single-node',
      cacheKey: 'page-b',
      children: pageB,
    });
    const reactivated = KeepAlive({
      scope: 'hook-single-node',
      cacheKey: 'page-a',
      children: document.createElement('strong'),
      onActivate: (value) => activatedValues.push(value),
    });

    expect(initial).toBe(first);
    expect(reused).toBe(updated);
    expect(cachedValues).toEqual([first]);
    expect(activatedValues).toHaveLength(2);
    expect(activatedValues[0]).toBe(first);
    expect(activatedValues[1]).toBe(updated);
    expect(reactivated).toBe(updated);
  });

  it('accepts KeepAlive shared contract payloads in the function-component path', () => {
    const pane = document.createElement('section');
    pane.dataset.keepalivePane = 'contract';
    pane.textContent = 'Contract payload';

    const rendered = KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-fc',
          key: 'pane-a',
          include: ['pane-a'],
          max: 1,
        },
      },
      children: pane,
    });

    expect(rendered).toBe(pane);
  });

  it('accepts direct FC props for KeepAlive and Transition without hand-written payloads', async () => {
    const events: string[] = [];
    const first = document.createElement('section');
    first.textContent = 'A';
    const second = document.createElement('section');
    second.textContent = 'B';
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };

    const firstRender = KeepAliveComponent({
      scope: 'fc-direct-keepalive',
      cacheKey: 'page-a',
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
      children: first,
    });
    const secondRender = KeepAliveComponent({
      scope: 'fc-direct-keepalive',
      cacheKey: 'page-b',
      children: second,
    });
    const restoredRender = KeepAliveComponent({
      scope: 'fc-direct-keepalive',
      cacheKey: 'page-a',
      children: document.createElement('article'),
    });

    expect(firstRender).toBe(first);
    expect(secondRender).toBe(second);
    expect(restoredRender).toBe(first);
    expect(events).toEqual(['activate:page-a:false']);

    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    const phases: string[] = [];
    const transitionNode = document.createElement('div');
    transitionNode.textContent = 'hello';

    expect(
      withContextHost(host, () =>
        TransitionComponent({
          name: 'fade',
          transitionKey: 'fc-direct-transition',
          onAppear: (_element, context) => phases.push(context.phase),
          children: transitionNode,
        })
      )
    ).toBe(transitionNode);

    await flushMicrotasks(3);
    expect(phases).toEqual(['appear']);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('uses KeepAlive shared contract cache without inventing legacy hook fallbacks when metadata is absent', () => {
    const contractPane = document.createElement('section');
    contractPane.dataset.keepalivePane = 'contract';
    contractPane.textContent = 'Contract';
    const otherPane = document.createElement('section');
    otherPane.dataset.keepalivePane = 'other';
    otherPane.textContent = 'Other';
    const onActivateFromLegacy = vi.fn();

    const first = KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-tabs',
          key: 'contract-a',
          include: ['contract-a', 'contract-b'],
          max: 2,
        },
      },
      scope: 'legacy-tabs',
      cacheKey: 'legacy-a',
      include: ['legacy-a'],
      max: 1,
      onActivate: onActivateFromLegacy,
      children: contractPane,
    });
    const second = KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-tabs',
          key: 'contract-b',
          include: ['contract-a', 'contract-b'],
          max: 2,
        },
      },
      scope: 'legacy-tabs',
      cacheKey: 'legacy-b',
      onActivate: onActivateFromLegacy,
      children: otherPane,
    });
    const restored = KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-tabs',
          key: 'contract-a',
          include: ['contract-a', 'contract-b'],
          max: 2,
        },
      },
      scope: 'legacy-tabs',
      cacheKey: 'legacy-a',
      onActivate: onActivateFromLegacy,
      children: document.createElement('article'),
    });

    expect(first).toBe(contractPane);
    expect(second).toBe(otherPane);
    expect(restored).toBe(contractPane);
    expect(onActivateFromLegacy).not.toHaveBeenCalled();
  });

  it('prefers KeepAlive shared contract metadata hooks over legacy hooks in the function-component path', () => {
    const contractEvents: string[] = [];
    const contractPane = document.createElement('section');
    contractPane.dataset.keepalivePane = 'contract';
    const otherPane = document.createElement('section');
    otherPane.dataset.keepalivePane = 'other';
    const onActivateFromLegacy = vi.fn();

    KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-hook',
          key: 'contract-a',
          include: ['contract-a', 'contract-b'],
          max: 2,
        },
        metadata: {
          onActivate: (_value: unknown, key: string, reused: boolean) =>
            contractEvents.push(`activate:${key}:${reused}`),
        },
      },
      scope: 'legacy-hook',
      cacheKey: 'legacy-a',
      onActivate: onActivateFromLegacy,
      children: contractPane,
    });
    KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-hook',
          key: 'contract-b',
          include: ['contract-a', 'contract-b'],
          max: 2,
        },
        metadata: {
          onActivate: (_value: unknown, key: string, reused: boolean) =>
            contractEvents.push(`activate:${key}:${reused}`),
        },
      },
      scope: 'legacy-hook',
      cacheKey: 'legacy-b',
      onActivate: onActivateFromLegacy,
      children: otherPane,
    });
    KeepAlive({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-hook',
          key: 'contract-a',
          include: ['contract-a', 'contract-b'],
          max: 2,
        },
        metadata: {
          onActivate: (_value: unknown, key: string, reused: boolean) =>
            contractEvents.push(`activate:${key}:${reused}`),
        },
      },
      scope: 'legacy-hook',
      cacheKey: 'legacy-a',
      onActivate: onActivateFromLegacy,
      children: document.createElement('article'),
    });

    const contractProbe = readRuntimeContract({
      payload: {
        protocol: ENHANCED_CONTRACT_PROTOCOL,
        version: ENHANCED_CONTRACT_VERSION,
        payloadKind: 'cache' as const,
        component: 'KeepAlive' as const,
        irKind: 'KeepAliveIR' as const,
        slotIndex: 0,
        template: {
          html: '<section data-pane="contract">__LANIA_SLOT_0__</section>',
        },
        cache: {
          scope: 'contract-hook',
          key: 'contract-a',
        },
        metadata: {
          onActivate: () => {},
        },
      },
    });

    expect(typeof contractProbe.metadata?.onActivate).toBe('function');
    expect(contractEvents).toEqual([
      'activate:contract-a:false',
      'activate:contract-b:false',
      'activate:contract-a:true',
    ]);
    expect(onActivateFromLegacy).not.toHaveBeenCalled();
  });

  it('deactivates mounted KeepAlive nodes before switching keys and reuses them on return', () => {
    const host = document.createElement('div');
    const first = document.createElement('span');
    first.textContent = 'A-1';
    const second = document.createElement('span');
    second.textContent = 'A-2';
    const pageB = document.createElement('section');
    pageB.textContent = 'B';
    const mount = (content: EnhancedRenderable) => {
      if (Array.isArray(content)) {
        content.forEach((entry) => mount(entry));
        return;
      }
      if (content == null || content === false) {
        return;
      }
      if (content instanceof Node) {
        host.appendChild(content);
        return;
      }
      host.appendChild(document.createTextNode(String(content)));
    };

    const firstRender = KeepAlive({
      scope: 'mounted-switch',
      cacheKey: 'page-a',
      children: [first, second],
    });
    mount(firstRender);
    expect(host.textContent).toBe('A-1A-2');

    const secondRender = KeepAlive({
      scope: 'mounted-switch',
      cacheKey: 'page-b',
      children: pageB,
    });
    expect(host.textContent).toBe('');
    mount(secondRender);
    expect(host.textContent).toBe('B');

    const thirdRender = KeepAlive({
      scope: 'mounted-switch',
      cacheKey: 'page-a',
      children: [document.createElement('em')],
    });
    expect(host.textContent).toBe('');
    mount(thirdRender);
    expect(host.textContent).toBe('A-1A-2');
    expect(host.childNodes[0]).toBe(first);
    expect(host.childNodes[1]).toBe(second);
  });

  it('updates the active function-component KeepAlive entry in place when the same key renders again', () => {
    const host = document.createElement('div');
    let label = 'First';
    const mountIntoHost = (content: EnhancedRenderable) => {
      host.replaceChildren();
      const append = (value: EnhancedRenderable) => {
        if (Array.isArray(value)) {
          value.forEach((entry) => append(entry));
          return;
        }
        if (value == null || value === false) {
          return;
        }
        if (value instanceof Node) {
          host.appendChild(value);
          return;
        }
        host.appendChild(document.createTextNode(String(value)));
      };
      append(content);
    };

    const firstRender = KeepAlive({
      scope: 'function-same-key-update',
      cacheKey: 'page-a',
      children: () => {
        const section = document.createElement('section');
        section.dataset.keepalivePane = 'same-key';
        section.textContent = label;
        return section;
      },
    });
    mountIntoHost(firstRender);
    const pane = host.querySelector('[data-keepalive-pane="same-key"]');
    expect(pane?.textContent).toBe('First');

    label = 'Second';
    const secondRender = KeepAlive({
      scope: 'function-same-key-update',
      cacheKey: 'page-a',
      children: () => {
        const section = document.createElement('section');
        section.dataset.keepalivePane = 'same-key';
        section.textContent = label;
        return section;
      },
    });
    mountIntoHost(secondRender);

    const updatedPane = host.querySelector('[data-keepalive-pane="same-key"]');
    expect(updatedPane).not.toBeNull();
    expect(updatedPane?.textContent).toBe('Second');
    expect(host.querySelectorAll('[data-keepalive-pane="same-key"]')).toHaveLength(1);
    expect(updatedPane).not.toBe(pane);
  });

  it('does not re-fire KeepAlive activate hooks for mounted same-key function-component renders', () => {
    const events: string[] = [];
    const host = document.createElement('div');
    const mount = (content: EnhancedRenderable) => {
      host.replaceChildren();
      if (Array.isArray(content)) {
        content.forEach((entry) => mount(entry));
        return;
      }
      if (content == null || content === false) {
        return;
      }
      if (content instanceof Node) {
        host.appendChild(content);
        return;
      }
      host.appendChild(document.createTextNode(String(content)));
    };

    const first = KeepAlive({
      scope: 'function-activate-order',
      cacheKey: 'page-a',
      children: (() => {
        const section = document.createElement('section');
        section.textContent = 'A';
        return section;
      })(),
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
    });
    mount(first);

    const second = KeepAlive({
      scope: 'function-activate-order',
      cacheKey: 'page-a',
      children: (() => {
        const section = document.createElement('section');
        section.textContent = 'A2';
        return section;
      })(),
      onActivate: (_value, key, reused) => events.push(`activate:${key}:${reused}`),
    });
    mount(second);

    expect(events).toEqual(['activate:page-a:false']);
  });

  it('prefers dom-host target resolution for same-key function-component KeepAlive updates', () => {
    const host = document.createElement('div');
    const contextualParent = document.createElement('div');
    const contextualAnchor = document.createComment('keepalive-anchor');
    contextualParent.appendChild(contextualAnchor);
    const runtimeHost = {
      dispatchEvent: (_event: Event) => true,
    };
    let label = 'First';

    const firstRender = withContextHost(runtimeHost, () =>
      withDomHost({ parent: contextualParent, anchor: contextualAnchor }, () =>
        KeepAlive({
          scope: 'function-dom-host-target',
          cacheKey: 'page-a',
          children: () => {
            const section = document.createElement('section');
            section.dataset.keepalivePane = 'dom-host';
            section.textContent = label;
            return section;
          },
        })
      )
    );
    host.appendChild(firstRender as Node);
    expect(contextualParent.textContent).toBe('');
    expect(host.textContent).toBe('First');

    label = 'Second';
    const secondRender = withContextHost(runtimeHost, () =>
      withDomHost({ parent: contextualParent, anchor: contextualAnchor }, () =>
        KeepAlive({
          scope: 'function-dom-host-target',
          cacheKey: 'page-a',
          children: () => {
            const section = document.createElement('section');
            section.dataset.keepalivePane = 'dom-host';
            section.textContent = label;
            return section;
          },
        })
      )
    );

    expect(secondRender).not.toBeNull();
    expect(host.textContent).toBe('');
    expect(contextualParent.textContent).toBe('Second');
    expect(contextualParent.querySelectorAll('[data-keepalive-pane="dom-host"]')).toHaveLength(1);
  });

  it('preserves nested When branch state across KeepAlive key switches', () => {
    const host = document.createElement('div');
    let currentPage: 'page-a' | 'page-b' = 'page-a';
    const mountIntoHost = (content: EnhancedRenderable) => {
      host.replaceChildren();
      const append = (value: EnhancedRenderable) => {
        if (Array.isArray(value)) {
          value.forEach((entry) => append(entry));
          return;
        }
        if (value == null || value === false) {
          return;
        }
        if (value instanceof Node) {
          host.appendChild(value);
          return;
        }
        host.appendChild(document.createTextNode(String(value)));
      };
      append(content);
    };
    const renderPage = (cacheKey: 'page-a' | 'page-b') =>
      KeepAlive({
        scope: 'function-keepalive-when-combo',
        cacheKey,
        children: [
          When({
            when: currentPage === 'page-a',
            children: () => {
              const input = document.createElement('input');
              input.dataset.page = 'page-a';
              return input;
            },
          }),
          When({
            when: currentPage === 'page-b',
            children: () => {
              const section = document.createElement('section');
              section.dataset.page = 'page-b';
              section.textContent = 'Page B';
              return section;
            },
          }),
        ],
      });

    mountIntoHost(renderPage('page-a'));
    const firstInput = host.querySelector('[data-page="page-a"]') as HTMLInputElement | null;
    expect(firstInput).not.toBeNull();
    expect(host.querySelector('[data-page="page-b"]')).toBeNull();

    if (!firstInput) {
      throw new Error('expected page-a input to mount');
    }

    firstInput.value = 'draft';
    currentPage = 'page-b';
    mountIntoHost(renderPage('page-b'));
    expect(host.querySelector('[data-page="page-a"]')).toBeNull();
    expect(host.querySelector('[data-page="page-b"]')?.textContent).toBe('Page B');

    currentPage = 'page-a';
    mountIntoHost(renderPage('page-a'));
    const restoredInput = host.querySelector('[data-page="page-a"]') as HTMLInputElement | null;
    expect(restoredInput).toBe(firstInput);
    expect(restoredInput?.value).toBe('draft');
    expect(host.querySelector('[data-page="page-b"]')).toBeNull();
  });

  it('reactivates cached Transition branches inside KeepAlive without re-running transition entry hooks', async () => {
    const host = document.createElement('div');
    const phases: string[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    const runtimeHost = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const transitionPayload = {
      protocol: 'lania.enhanced' as const,
      version: '0.1-draft' as const,
      payloadKind: 'transition' as const,
      component: 'Transition' as const,
      irKind: 'TransitionIR' as const,
      transitionIndex: 0,
      transition: {
        name: 'keepalive-combo',
        phases: ['appear', 'enter', 'leave'] as const,
        keyProp: 'transitionKey' as const,
        key: 'keepalive-combo',
        hooks: {
          onAppear: (_element: Element, context: { phase: string }) => phases.push(context.phase),
          onEnter: (_element: Element, context: { phase: string }) => phases.push(context.phase),
          onLeave: async (_element: Element, context: { phase: string }) => {
            phases.push(context.phase);
            await Promise.resolve();
          },
        },
      },
    };
    const mountIntoHost = (content: EnhancedRenderable) => {
      host.replaceChildren();
      const append = (value: EnhancedRenderable) => {
        if (Array.isArray(value)) {
          value.forEach((entry) => append(entry));
          return;
        }
        if (value == null || value === false) {
          return;
        }
        if (value instanceof Node) {
          host.appendChild(value);
          return;
        }
        host.appendChild(document.createTextNode(String(value)));
      };
      append(content);
    };
    const renderPageA = (label: string) =>
      withContextHost(runtimeHost, () =>
        KeepAlive({
          scope: 'function-keepalive-transition-combo',
          cacheKey: 'page-a',
          children: Transition({
            payload: transitionPayload,
            children: (() => {
              const section = document.createElement('section');
              section.dataset.page = 'page-a';
              section.textContent = label;
              return section;
            })(),
          }),
        })
      );

    mountIntoHost(renderPageA('Page A'));
    const firstPane = host.querySelector('[data-page="page-a"]');
    expect(firstPane?.textContent).toBe('Page A');

    await flushMicrotasks(3);

    mountIntoHost(
      KeepAlive({
        scope: 'function-keepalive-transition-combo',
        cacheKey: 'page-b',
        children: (() => {
          const section = document.createElement('section');
          section.dataset.page = 'page-b';
          section.textContent = 'Page B';
          return section;
        })(),
      })
    );
    expect(host.querySelector('[data-page="page-a"]')).toBeNull();
    expect(host.querySelector('[data-page="page-b"]')?.textContent).toBe('Page B');

    mountIntoHost(renderPageA('Page A updated'));
    const restoredPane = host.querySelector('[data-page="page-a"]');
    expect(restoredPane).toBe(firstPane);
    expect(restoredPane?.textContent).toBe('Page A');
    expect(host.querySelector('[data-page="page-b"]')).toBeNull();
    expect(phases).toEqual(['appear']);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('preserves visible LazyLoad children across KeepAlive cache switches', () => {
    const observerRecords: Array<{
      callback: IntersectionObserverCallback;
      targets: Element[];
    }> = [];
    class MockIntersectionObserver {
      private readonly index: number;

      constructor(callback: IntersectionObserverCallback) {
        this.index = observerRecords.push({
          callback,
          targets: [],
        }) - 1;
      }

      observe(target: Element) {
        observerRecords[this.index]!.targets.push(target);
      }

      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    );

    const host = document.createElement('div');
    const mountIntoHost = (content: EnhancedRenderable) => {
      host.replaceChildren();
      const append = (value: EnhancedRenderable) => {
        if (Array.isArray(value)) {
          value.forEach((entry) => append(entry));
          return;
        }
        if (value == null || value === false) {
          return;
        }
        if (value instanceof Node) {
          host.appendChild(value);
          return;
        }
        host.appendChild(document.createTextNode(String(value)));
      };
      append(content);
    };
    const pageAInput = document.createElement('input');
    pageAInput.dataset.page = 'lazy-a';
    const renderPageA = () =>
      KeepAlive({
        scope: 'function-keepalive-lazyload-combo',
        cacheKey: 'page-a',
        children: LazyLoadInternal({
          payload: createLazyLoadPayload({
            key: 'keepalive-lazyload-page-a',
            once: true,
          }),
          fallback: 'loading-a',
          children: pageAInput,
        }),
      });
    const renderPageB = () =>
      KeepAlive({
        scope: 'function-keepalive-lazyload-combo',
        cacheKey: 'page-b',
        children: (() => {
          const section = document.createElement('section');
          section.dataset.page = 'lazy-b';
          section.textContent = 'Page B';
          return section;
        })(),
      });

    mountIntoHost(renderPageA());
    expect(host.textContent).toContain('loading-a');
    expect(host.querySelector('[data-page="lazy-a"]')).toBeNull();

    observerRecords[0]?.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );

    mountIntoHost(renderPageA());
    const visibleInput = host.querySelector('[data-page="lazy-a"]') as HTMLInputElement | null;
    expect(visibleInput).toBe(pageAInput);

    if (!visibleInput) {
      throw new Error('expected KeepAlive + LazyLoad child to become visible');
    }

    visibleInput.value = 'draft';
    mountIntoHost(renderPageB());
    expect(host.querySelector('[data-page="lazy-a"]')).toBeNull();
    expect(host.querySelector('[data-page="lazy-b"]')?.textContent).toBe('Page B');

    mountIntoHost(renderPageA());
    const restoredInput = host.querySelector('[data-page="lazy-a"]') as HTMLInputElement | null;
    expect(restoredInput).toBe(pageAInput);
    expect(restoredInput?.value).toBe('draft');
    expect(host.textContent).toBe('');

    vi.unstubAllGlobals();
  });

  it('prefers Transition payload fields over local props while preserving appear, leave and enter phases', async () => {
    const phases: string[] = [];
    const fallbackPhases: string[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    const first = document.createElement('div');
    first.textContent = 'hello';
    const second = document.createElement('div');
    second.textContent = 'hello-again';
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };

    expect(
      withContextHost(host, () =>
        Transition({
          payload: createTransitionPayload('Transition', {
            name: 'fade',
            key: 'demo',
            hooks: {
              onAppear: (_element: Element, context: any) => phases.push(context.phase),
              onEnter: (_element: Element, context: any) => phases.push(context.phase),
              onLeave: async (_element: Element, context: any) => {
                phases.push(context.phase);
                await Promise.resolve();
              },
            },
          }),
          children: first,
        })
      )
    ).toBe(first);

    await flushMicrotasks(3);

    expect(
      withContextHost(host, () =>
        Transition({
          payload: createTransitionPayload('Transition', {
            name: 'fade',
            key: 'demo',
            hooks: {
              onAppear: (_element: Element, context: any) => phases.push(context.phase),
              onEnter: (_element: Element, context: any) => phases.push(context.phase),
              onLeave: async (_element: Element, context: any) => {
                phases.push(context.phase);
                await Promise.resolve();
              },
            },
          }),
          children: null,
        })
      )
    ).toBe(first);

    await flushMicrotasks(3);

    expect(
      withContextHost(host, () =>
        Transition({
          payload: createTransitionPayload('Transition', {
            name: 'fade',
            key: 'demo',
            hooks: {
              onAppear: (_element: Element, context: any) => phases.push(context.phase),
              onEnter: (_element: Element, context: any) => phases.push(context.phase),
              onLeave: async (_element: Element, context: any) => {
                phases.push(context.phase);
                await Promise.resolve();
              },
            },
          }),
          children: second,
        })
      )
    ).toBe(second);

    await flushMicrotasks(3);
    expect(phases).toEqual(['appear', 'leave', 'enter']);
    expect(fallbackPhases).toEqual([]);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('retains Transition leave snapshots across adjacent hidden renders until finalize settles', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let resolveLeave: (() => void) | null = null;
    const leaveGate = new Promise<void>((resolve) => {
      resolveLeave = resolve;
    });
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const first = document.createElement('div');
    first.dataset.key = 'first';
    first.textContent = 'first';
    const payload = {
      protocol: 'lania.enhanced' as const,
      version: '0.1-draft' as const,
      payloadKind: 'transition' as const,
      component: 'Transition' as const,
      irKind: 'TransitionIR' as const,
      transitionIndex: 0,
      transition: {
        name: 'fade-hold',
        phases: ['appear', 'enter', 'leave'] as const,
        keyProp: 'transitionKey' as const,
        key: 'fade-hold',
        hooks: {
          onLeave: async () => {
            await leaveGate;
          },
        },
      },
    };

    withContextHost(host, () =>
      Transition({
        payload,
        children: first,
      })
    );

    const leavingView = withContextHost(host, () =>
      Transition({
        payload,
        children: null,
      })
    );
    const stillLeavingView = withContextHost(host, () =>
      Transition({
        payload,
        children: null,
      })
    );

    expect(leavingView).toBe(first);
    expect(stillLeavingView).toBe(first);
    expect(host.requestUpdate).not.toHaveBeenCalled();

    (resolveLeave as (() => void) | null)?.();
    await flushMicrotasks(4);
    await wait(0);

    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
    expect(
      withContextHost(host, () =>
        Transition({
          payload,
          children: null,
        })
      )
    ).toBeNull();
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('ignores stale Transition leave finalize when content re-enters before settle', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let resolveLeave: (() => void) | null = null;
    const leaveGate = new Promise<void>((resolve) => {
      resolveLeave = resolve;
    });
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const first = document.createElement('div');
    first.dataset.key = 'first';
    first.textContent = 'first';
    const second = document.createElement('div');
    second.dataset.key = 'second';
    second.textContent = 'second';
    const payload = {
      protocol: 'lania.enhanced' as const,
      version: '0.1-draft' as const,
      payloadKind: 'transition' as const,
      component: 'Transition' as const,
      irKind: 'TransitionIR' as const,
      transitionIndex: 0,
      transition: {
        name: 'fade-reenter',
        phases: ['appear', 'enter', 'leave'] as const,
        keyProp: 'transitionKey' as const,
        key: 'fade-reenter',
        hooks: {
          onLeave: async () => {
            await leaveGate;
          },
        },
      },
    };

    withContextHost(host, () =>
      Transition({
        payload,
        children: first,
      })
    );

    expect(
      withContextHost(host, () =>
        Transition({
          payload,
          children: null,
        })
      )
    ).toBe(first);

    host.requestUpdate.mockClear();

    expect(
      withContextHost(host, () =>
        Transition({
          payload,
          children: second,
        })
      )
    ).toBe(second);

    (resolveLeave as (() => void) | null)?.();
    await flushMicrotasks(4);
    await wait(0);

    expect(host.requestUpdate).not.toHaveBeenCalled();
    expect(
      withContextHost(host, () =>
        Transition({
          payload,
          children: second,
        })
      )
    ).toBe(second);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('prefers TransitionGroup payload fields over local props while preserving appear, enter, leave and move', async () => {
    const phases: string[] = [];
    const fallbackPhases: string[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    const createNode = (key: string) => {
      const node = document.createElement('li');
      node.dataset.key = key;
      node.textContent = key;
      return node;
    };

    const first = [createNode('a'), createNode('b')];
    const second = [createNode('b'), createNode('c')];

    withContextHost(host, () =>
      TransitionGroup({
        payload: createTransitionPayload('TransitionGroup', {
          name: 'list',
          key: 'todos',
          hooks: {
            onAppear: (_element: Element, context: any) => phases.push(`appear:${String(context.key)}`),
            onEnter: (_element: Element, context: any) => phases.push(`enter:${String(context.key)}`),
            onLeave: async (_element: Element, context: any) => {
              phases.push(`leave:${String(context.key)}`);
              await Promise.resolve();
            },
            onMove: (_element: Element, context: any) =>
              phases.push(`move:${String(context.key)}:${context.previousIndex}->${context.index}`),
          },
        }),
        keys: ['a', 'b'],
        children: first,
      })
    );

    await flushMicrotasks(3);

    const leavingView = withContextHost(host, () =>
      TransitionGroup({
        payload: createTransitionPayload('TransitionGroup', {
          name: 'list',
          key: 'todos',
          hooks: {
            onAppear: (_element: Element, context: any) => phases.push(`appear:${String(context.key)}`),
            onEnter: (_element: Element, context: any) => phases.push(`enter:${String(context.key)}`),
            onLeave: async (_element: Element, context: any) => {
              phases.push(`leave:${String(context.key)}`);
              await Promise.resolve();
            },
            onMove: (_element: Element, context: any) =>
              phases.push(`move:${String(context.key)}:${context.previousIndex}->${context.index}`),
          },
        }),
        keys: ['b', 'c'],
        children: second,
      })
    ) as HTMLElement[];

    expect(leavingView.map((child) => child.dataset.key)).toEqual(['a', 'b', 'c']);

    await flushMicrotasks(3);
    await wait(0);

    const settledView = withContextHost(host, () =>
      TransitionGroup({
        payload: createTransitionPayload('TransitionGroup', {
          name: 'list',
          key: 'todos',
          hooks: {
            onAppear: (_element: Element, context: any) => phases.push(`appear:${String(context.key)}`),
            onEnter: (_element: Element, context: any) => phases.push(`enter:${String(context.key)}`),
            onLeave: async (_element: Element, context: any) => {
              phases.push(`leave:${String(context.key)}`);
              await Promise.resolve();
            },
            onMove: (_element: Element, context: any) =>
              phases.push(`move:${String(context.key)}:${context.previousIndex}->${context.index}`),
          },
        }),
        keys: ['b', 'c'],
        children: second,
      })
    ) as HTMLElement[];

    expect(settledView.map((child) => child.dataset.key)).toEqual(['b', 'c']);
    expect(phases).toEqual([
      'appear:a',
      'appear:b',
      'leave:a',
      'move:b:1->0',
      'enter:c',
    ]);
    expect(fallbackPhases).toEqual([]);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('does not share TransitionGroup state between snapshot and dom-host modes for the same base key', () => {
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const createNode = (key: string) => {
      const node = document.createElement('li');
      node.dataset.key = key;
      node.textContent = key;
      return node;
    };

    // Use the same module instance as `getTransitionGroupState` to observe state map effects.
    withContextHost(host, () =>
      TransitionGroupInternal({
        groupKey: 'todos',
        keys: ['a'],
        children: [createNode('a')],
      })
    );

    withContextHost(host, () =>
      TransitionGroupInternal({
        groupKey: 'todos',
        tag: 'ul',
        keys: ['a'],
        children: [createNode('a')],
      })
    );

    expect(getTransitionGroupState('todos:snapshot')).toBeTruthy();
    expect(getTransitionGroupState('todos:dom-host')).toBeTruthy();
  });

  it('drops stale non-dom-host leaving snapshots when a TransitionGroup key re-enters before leave settles', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let resolveLeave: (() => void) | null = null;
    const leaveGate = new Promise<void>((resolve) => {
      resolveLeave = resolve;
    });
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const createNode = (key: string) => {
      const node = document.createElement('li');
      node.dataset.key = key;
      node.textContent = key;
      return node;
    };

    withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-reenter',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-reenter',
            hooks: {
              onLeave: async () => {
                await leaveGate;
              },
            },
          },
        },
        keys: ['a', 'b'],
        children: [createNode('a'), createNode('b')],
      })
    );

    const leavingView = withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-reenter',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-reenter',
            hooks: {
              onLeave: async () => {
                await leaveGate;
              },
            },
          },
        },
        keys: ['b'],
        children: [createNode('b')],
      })
    ) as HTMLElement[];

    expect(leavingView.map((child) => child.dataset.key)).toEqual(['a', 'b']);

    const reenteredView = withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-reenter',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-reenter',
            hooks: {
              onLeave: async () => {
                await leaveGate;
              },
            },
          },
        },
        keys: ['a', 'b'],
        children: [createNode('a2'), createNode('b')],
      })
    ) as HTMLElement[];

    expect(reenteredView.map((child) => child.dataset.key)).toEqual(['a2', 'b']);

    (resolveLeave as (() => void) | null)?.();
    await flushMicrotasks(4);
    await wait(0);

    const settledView = withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-reenter',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-reenter',
          },
        },
        keys: ['a', 'b'],
        children: [createNode('a2'), createNode('b')],
      })
    ) as HTMLElement[];

    expect(settledView.map((child) => child.dataset.key)).toEqual(['a2', 'b']);
    globalThis.requestAnimationFrame = previousRaf;
  });

  it('routes empty non-dom-host TransitionGroup renders through commitLeaving and commitHidden', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    let resolveLeave: (() => void) | null = null;
    const leaveGate = new Promise<void>((resolve) => {
      resolveLeave = resolve;
    });
    const host = {
      dispatchEvent() {
        return true;
      },
      requestUpdate: vi.fn(),
    };
    const createNode = (key: string) => {
      const node = document.createElement('li');
      node.dataset.key = key;
      node.textContent = key;
      return node;
    };

    withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-empty-commit',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-empty-commit',
            hooks: {
              onLeave: async () => {
                await leaveGate;
              },
            },
          },
        },
        keys: ['a'],
        children: [createNode('a')],
      })
    );

    const leavingView = withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-empty-commit',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-empty-commit',
            hooks: {
              onLeave: async () => {
                await leaveGate;
              },
            },
          },
        },
        keys: [],
        children: [],
      })
    ) as HTMLElement[];

    expect(leavingView.map((child) => child.dataset.key)).toEqual(['a']);

    const retainedLeavingView = withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-empty-commit',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-empty-commit',
            hooks: {
              onLeave: async () => {
                await leaveGate;
              },
            },
          },
        },
        keys: [],
        children: [],
      })
    ) as HTMLElement[];

    expect(retainedLeavingView.map((child) => child.dataset.key)).toEqual(['a']);

    (resolveLeave as (() => void) | null)?.();
    await flushMicrotasks(4);
    await wait(0);

    const hiddenView = withContextHost(host, () =>
      TransitionGroup({
        payload: {
          protocol: 'lania.enhanced',
          version: '0.1-draft',
          payloadKind: 'transition',
          component: 'TransitionGroup',
          irKind: 'TransitionIR',
          transitionIndex: 0,
          transition: {
            name: 'list-empty-commit',
            phases: ['appear', 'enter', 'move', 'leave'],
            keyProp: 'groupKey',
            key: 'todos-empty-commit',
          },
        },
        keys: [],
        children: [],
      })
    ) as HTMLElement[];

    expect(hiddenView).toEqual([]);
    globalThis.requestAnimationFrame = previousRaf;
  });
});

describe('function reactive apis', () => {
  it('creates readonly wrappers without exposing setters', () => {
    const count = createSignal(1);
    const publicCount = readonly(count);

    expect(publicCount()).toBe(1);
    expect('set' in publicCount).toBe(false);
  });

  it('reports tracking state and allows untracked reads', () => {
    const count = createSignal(2);
    const tracked = trackSignals(() => {
      expect(isTracking()).toBe(true);
      return {
        tracked: count(),
        untracked: untrack(() => count()),
      };
    });

    expect(isTracking()).toBe(false);
    expect(tracked.value).toEqual({
      tracked: 2,
      untracked: 2,
    });
    expect([...tracked.deps]).toEqual([count]);
  });

  it('recomputes createMemo values when dependencies change', async () => {
    const count = createSignal(1);
    const doubled = createMemo(() => count() * 2);

    expect(doubled()).toBe(2);

    count.set(4);
    await flushMicrotasks();

    expect(doubled()).toBe(8);
  });

  it('runs createEffect immediately and after dependency updates with cleanup', async () => {
    const count = createSignal(0);
    const events: string[] = [];

    createEffect(() => {
      events.push(`run:${count()}`);
      return () => {
        events.push(`cleanup:${count.peek()}`);
      };
    });

    count.set(2);
    await flushMicrotasks(3);

    expect(events).toEqual(['run:0', 'cleanup:2', 'run:2']);
  });

  it('watches single and multiple signals without running immediately', async () => {
    const count = createSignal(1);
    const name = createSignal('a');
    const singleEvents: Array<[number, number]> = [];
    const multiEvents: Array<[readonly [number, string], readonly [number, string]]> = [];

    watch(count, (current, previous) => {
      singleEvents.push([current, previous]);
    });
    watch([count, name] as const, (current, previous) => {
      multiEvents.push([current, previous]);
    });

    count.set(3);
    name.set('b');
    await flushMicrotasks(3);

    expect(singleEvents).toEqual([[3, 1]]);
    expect(multiEvents).toEqual([[[3, 'b'], [1, 'a']]]);
  });

  it('defers value propagation with createDeferred', async () => {
    const count = createSignal(1);
    const deferred = createDeferred(count, { timeoutMs: 10 });

    count.set(5);
    await flushMicrotasks(3);
    expect(deferred()).toBe(1);

    await wait(20);
    expect(deferred()).toBe(5);
  });

  it('updates nested store paths immutably through createStore', async () => {
    const store = createStore({
      user: {
        name: 'Ada',
        age: 20,
      },
      todos: [{ title: 'write docs' }],
    });
    const values: string[] = [];

    createEffect(() => {
      values.push(`${store.user.name}:${store.user.age}`);
    });

    store.set('user', 'name', 'Grace');
    store.set('user', 'age', (age: number) => Number(age) + 1);
    await flushMicrotasks(3);

    expect(store.user.name).toBe('Grace');
    expect(store.user.age).toBe(21);
    expect(store.todos[0].title).toBe('write docs');
    expect(values).toEqual(['Ada:20', 'Grace:21']);
  });

  it('resolves dot paths in store.set', async () => {
    const store = createStore({
      user: { name: 'Ada', age: 20 },
      todos: [{ title: 'write docs' }],
    });

    store.set('user.name', 'Grace');
    store.set('user.age', (age: number) => age + 1);
    store.set('todos.0.title', 'ship code');

    expect(store.user.name).toBe('Grace');
    expect(store.user.age).toBe(21);
    expect(store.todos[0]?.title).toBe('ship code');
  });

  it('exposes signal-like set and peek on the store handle', async () => {
    const store = createStore({
      user: { name: 'Ada' },
      count: 0,
    });
    const runs: string[] = [];

    createEffect(() => {
      runs.push(store.user.name);
    });

    expect(store.peek()).toEqual({ user: { name: 'Ada' }, count: 0 });
    expect(runs).toEqual(['Ada']);

    store.set({ user: { name: 'Grace' }, count: 1 });
    await flushMicrotasks(3);

    expect(store.peek().count).toBe(1);
    expect(runs).toEqual(['Ada', 'Grace']);
  });

  it('tracks store dependencies by exact path instead of invalidating sibling reads', async () => {
    const store = createStore({
      user: {
        name: 'Ada',
        age: 20,
      },
    });
    const nameRuns: string[] = [];
    const ageRuns: number[] = [];

    createEffect(() => {
      nameRuns.push(store.user.name);
    });
    createEffect(() => {
      ageRuns.push(store.user.age);
    });

    store.set('user', 'name', 'Grace');
    await flushMicrotasks(3);

    expect(nameRuns).toEqual(['Ada', 'Grace']);
    expect(ageRuns).toEqual([20]);

    store.set('user', 'age', 21);
    await flushMicrotasks(3);

    expect(nameRuns).toEqual(['Ada', 'Grace']);
    expect(ageRuns).toEqual([20, 21]);
  });

  it('invalidates descendant paths when replacing a parent object', async () => {
    const store = createStore({
      user: {
        name: 'Ada',
        age: 20,
      },
    });
    const values: string[] = [];

    createEffect(() => {
      values.push(`${store.user.name}:${store.user.age}`);
    });

    store.set('user', {
      name: 'Grace',
      age: 21,
    });
    await flushMicrotasks(3);

    expect(values).toEqual(['Ada:20', 'Grace:21']);
  });

  it('tracks async resource state and refetches when dependencies change', async () => {
    const id = createSignal(1);
    const requests: number[] = [];
    const [user, resource] = createResource(id, async () => {
      const currentId = id();
      requests.push(currentId);
      await wait(5);
      return `user-${currentId}`;
    });

    expect(resource.loading()).toBe(true);
    await wait(10);
    await flushMicrotasks(3);

    expect(user()).toBe('user-1');
    expect(resource.loading()).toBe(false);
    expect(resource.error()).toBeUndefined();

    id.set(2);
    await wait(10);
    await flushMicrotasks(3);

    expect(user()).toBe('user-2');
    expect(requests).toEqual([1, 2]);

    await resource.refetch();
    await flushMicrotasks(3);
    expect(requests).toEqual([1, 2, 2]);
  });
});
