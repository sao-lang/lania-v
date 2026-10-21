import {
  batch,
  createDeferred,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  readonly,
  untrack,
  useTransition,
  watch,
} from '@lania-v/reactivity';
import {
  lazy,
  onCleanup,
  onMount,
  onUpdated,
  useContext,
} from '@lania-v/runtime/component';
import {
  Case,
  Default,
  Dynamic,
  Each,
  Else,
  ErrorBoundary,
  Fragment,
  KeepAlive,
  LazyLoad,
  Suspense,
  Switch,
  Teleport,
  Then,
  Transition,
  TransitionGroup,
  When,
} from '@lania-v/advanced';
import { createContext, provideContext } from '@lania-v/runtime/core';
import {
  isTracking,
  linkTrackedSignals,
  trackSignals,
} from '@lania-v/runtime/advanced';
import { createRef } from '@lania-v/runtime/dom';
import ShowcaseCard from './ShowcaseCard.lania.tsx';
import TodoFc from './TodoFc.lania.tsx';

type DemoTab =
  | 'reactivity'
  | 'store'
  | 'resource'
  | 'enhanced'
  | 'suspense'
  | 'transition'
  | 'local';

type StoreListItem = { id: string };
type EnhancedListItem = { id: string; text: string };
type TransitionListItem = { id: string; label: string };
type LifecycleHistory = {
  mounts: number;
  unmounts: number;
  logs: string[];
  hookLogs: string[];
};

/**
 * Transition / TransitionGroup 演示独立成组件：
 * 过渡状态与日志都只在本组件内闭环，避免被 Tab 的 `<When>` 包裹后走动态组件分支，
 * 也避免日志信号反过来触发整段 Tab 内容重挂。
 */
function TransitionDemoSection() {
  const visible = createSignal(true);
  const logs = createSignal<string[]>([]);
  const items = createSignal<TransitionListItem[]>([
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ]);
  const nextItemId = createSignal(3);
  const itemKey = ((item: TransitionListItem, _index: number) =>
    item.id) as never;

  const pushLog = (line: string) => {
    logs.set((prev) => [line, ...prev].slice(0, 8));
  };

  const animateElement = (
    element: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ): Animation | null => {
    if (
      !(element instanceof HTMLElement) ||
      typeof element.animate !== 'function'
    ) {
      return null;
    }

    return element.animate(keyframes, {
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
      ...options,
    });
  };

  const clearAnimatedStyle = (element: Element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.style.transform = '';
    element.style.opacity = '';
    element.style.willChange = '';
  };

  // 进场：淡入 + 轻微下移回弹；出场：淡出 + 向上收起。
  const playEnterAnimation = (element: Element): Animation | null => {
    const animation = animateElement(
      element,
      [
        { opacity: 0, transform: 'translate3d(0, 16px, 0) scale(0.96)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      { duration: 320 }
    );
    animation?.addEventListener('finish', () => clearAnimatedStyle(element), {
      once: true,
    });
    animation?.addEventListener('cancel', () => clearAnimatedStyle(element), {
      once: true,
    });
    return animation;
  };

  const playLeaveAnimation = (element: Element): Animation | null => {
    const animation = animateElement(
      element,
      [
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        { opacity: 0, transform: 'translate3d(0, -12px, 0) scale(0.96)' },
      ],
      { duration: 220 }
    );
    animation?.addEventListener('finish', () => clearAnimatedStyle(element), {
      once: true,
    });
    animation?.addEventListener('cancel', () => clearAnimatedStyle(element), {
      once: true,
    });
    return animation;
  };

  // 列表重排：按索引差做一次 FLIP 位移动画。
  const playMoveAnimation = (
    element: Element,
    previousIndex: number | undefined,
    index: number
  ): Animation | null => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const delta = (previousIndex ?? index) - index;
    if (delta === 0) {
      return null;
    }

    const fromTransform = `translate3d(${delta * 32}px, 0, 0) scale(0.92)`;
    element.style.transform = fromTransform;
    element.style.opacity = '0.6';
    element.style.willChange = 'transform, opacity';

    const animation = animateElement(
      element,
      [
        { transform: fromTransform, opacity: 0.6 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      ],
      { duration: 260 }
    );
    animation?.addEventListener('finish', () => clearAnimatedStyle(element), {
      once: true,
    });
    animation?.addEventListener('cancel', () => clearAnimatedStyle(element), {
      once: true,
    });
    return animation;
  };

  const appendItem = () => {
    nextItemId.set((value) => value + 1);
    const id = `item-${nextItemId.peek()}`;
    items.set((prev) => prev.concat({ id, label: `#${nextItemId.peek()}` }));
  };

  const moveFirstItem = () => {
    items.set((prev) => {
      if (prev.length <= 1) {
        return prev;
      }

      const next = [...prev];
      const first = next.shift();
      if (first) {
        next.splice(Math.min(1, next.length), 0, first);
      }
      return next;
    });
  };

  const removeFirstItem = () => {
    items.set((prev) => prev.slice(1));
  };

  return (
    <div>
      <div className="item">
        <p className="summary">&lt;Transition /&gt;（进场 / 出场动画）</p>
        <div className="row">
          <button
            className="btn"
            onClick={() => visible.set((value) => !value)}
          >
            {visible() ? '出场（leave）' : '进场（enter）'}
          </button>
        </div>
        <Transition
          name="visibility"
          onEnter={(element: Element, ctx: { phase: string }) => {
            playEnterAnimation(element);
            pushLog(`enter:${ctx.phase}`);
          }}
          onLeave={(element: Element, ctx: { phase: string }) => {
            playLeaveAnimation(element);
            pushLog(`leave:${ctx.phase}`);
          }}
        >
          <When value={visible()}>
            <div
              data-demo="transition-block"
              style={{
                marginTop: '8px',
                padding: '12px',
                borderRadius: '12px',
                background: '#e2e8f0',
                color: '#0f172a',
                fontWeight: '600',
              }}
            >
              进场 / 出场内容
            </div>
          </When>
        </Transition>
      </div>

      <div className="item">
        <p className="summary">
          &lt;TransitionGroup /&gt;（进场 / 移动 / 出场动画）
        </p>
        <div className="row">
          <button className="btn" onClick={appendItem}>
            进场：append item
          </button>
          <button className="btn" onClick={moveFirstItem}>
            移动：move first
          </button>
          <button className="btn" onClick={removeFirstItem}>
            出场：remove first
          </button>
        </div>
        <TransitionGroup
          keys={items().map((item) => item.id)}
          onEnter={(
            element: Element,
            ctx: { key: PropertyKey; phase: string }
          ) => {
            playEnterAnimation(element);
            pushLog(`enter:${String(ctx.key)}:${ctx.phase}`);
          }}
          onLeave={(
            element: Element,
            ctx: { key: PropertyKey; phase: string }
          ) => {
            playLeaveAnimation(element);
            pushLog(`leave:${String(ctx.key)}:${ctx.phase}`);
          }}
          onMove={(
            element: Element,
            ctx: {
              key: PropertyKey;
              phase: string;
              previousIndex?: number;
              index: number;
            }
          ) => {
            playMoveAnimation(element, ctx.previousIndex, ctx.index);
            pushLog(`move:${String(ctx.key)}:${ctx.phase}`);
          }}
        >
          <Each
            value={items()}
            key={itemKey}
            fallback={<p className="empty">empty</p>}
          >
            {(item: TransitionListItem): any => (
              <div
                data-key={item.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: '48px',
                  height: '40px',
                  marginRight: '8px',
                  marginTop: '8px',
                  borderRadius: '999px',
                  color: '#0f172a',
                  background: '#e2e8f0',
                  border: '1px solid #cbd5e1',
                  fontWeight: '600',
                }}
              >
                {item.label}
              </div>
            )}
          </Each>
        </TransitionGroup>
      </div>

      <div className="item">
        <p className="summary">transition logs</p>
        <Each value={logs()} fallback={<p className="empty">no logs</p>}>
          {(line: string): any => <p className="empty">{line}</p>}
        </Each>
      </div>
    </div>
  );
}

function FcShowcase() {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const renderEmpty = (text: string): any => <p className="empty">{text}</p>;
  const DemoContext = createContext<string>(
    '(no provider)',
    'fc-showcase-demo-context'
  );
  const lifecycleHookNames = ['onMount', 'onCleanup', 'onUpdated'] as const;
  const withLifecycleHookSync = (fn: () => void) => fn();
  const getFcShowcaseLifecycleHistory = (): LifecycleHistory => {
    const host = globalThis as typeof globalThis & {
      __fcShowcaseLifecycleHistory__?: LifecycleHistory;
    };

    if (!host.__fcShowcaseLifecycleHistory__) {
      host.__fcShowcaseLifecycleHistory__ = {
        mounts: 0,
        unmounts: 0,
        logs: [],
        hookLogs: [],
      };
    }

    return host.__fcShowcaseLifecycleHistory__;
  };
  const syncLifecycleSignals = (snapshot: LifecycleHistory) => {
    lifecycleMountCount.set(snapshot.mounts);
    lifecycleUnmountCount.set(snapshot.unmounts);
    lifecycleLog.set(snapshot.logs);
    lifecycleHookLog.set(snapshot.hookLogs);
  };
  const refreshLifecycleLogs = () => {
    // Manual refresh avoids hook->set->update loops while still letting us inspect hook activity.
    syncLifecycleSignals(getFcShowcaseLifecycleHistory());
  };
  const recordLifecycle = (kind: 'onMount' | 'onCleanup') => {
    const snapshot = getFcShowcaseLifecycleHistory();
    if (kind === 'onMount') {
      snapshot.mounts += 1;
    } else {
      snapshot.unmounts += 1;
    }

    const hookCount = kind === 'onMount' ? snapshot.mounts : snapshot.unmounts;
    snapshot.logs = [
      `${kind} #${hookCount} @ ${new Date().toLocaleTimeString()}`,
      ...snapshot.logs,
    ].slice(0, 5);
    return snapshot;
  };
  const appendHookLog = (label: string) => {
    const snapshot = getFcShowcaseLifecycleHistory();
    snapshot.hookLogs = [
      `${label} @ ${new Date().toLocaleTimeString()}`,
      ...snapshot.hookLogs,
    ].slice(0, 8);
  };
  const LazyHello = lazy(async () => {
    await sleep(600);
    return {
      default: (props: { name: string }) => {
        return <p className="summary">Lazy component resolved: {props.name}</p>;
      },
    };
  });
  const tab = createSignal<DemoTab>('reactivity');

  // 1) Reactivity
  const count = createSignal(0);
  const doubled = createMemo(() => count() * 2);
  const readonlyCount = readonly(count);
  const deferredCount = createDeferred(count, { timeoutMs: 400 });
  const trackingFlag = createMemo(() =>
    isTracking() ? 'tracking' : 'not-tracking'
  );
  const untrackedSnapshot = createMemo(() => untrack(() => count()));
  const watchLog = createSignal<string[]>([]);
  const watchMultiLog = createSignal<string[]>([]);
  const watchEnabled = createSignal(true);
  const inputRef = createRef<HTMLInputElement>();
  const inputText = createSignal('focus me');
  const batchLeft = createSignal(1);
  const batchRight = createSignal(10);
  const batchSum = createMemo(() => batchLeft() + batchRight());
  const batchEffectRuns = createSignal(0);
  const transitionUrgent = createSignal(0);
  const transitionDeferred = createSignal(0);
  const { pending: transitionPendingState, start: startSchedulerTransition } =
    useTransition();
  const transitionStateLog = createSignal<string[]>([]);
  const lifecycleMountCount = createSignal(0);
  const lifecycleUnmountCount = createSignal(0);
  const lifecycleLog = createSignal<string[]>([]);
  const lifecycleHookLog = createSignal<string[]>([]);
  const lifecycleReady = createSignal(false);
  const lifecycleWillUpdateCount = createSignal(0);
  const lifecycleUpdatedCount = createSignal(0);

  watch(count, (current, previous) => {
    watchLog.set((prev) =>
      [`count: ${previous} -> ${current}`, ...prev].slice(0, 5)
    );
  });
  let stopMultiWatch: (() => void) | null = watch(
    [count, batchLeft],
    (current, previous) => {
      watchMultiLog.set((prev) =>
        [`[${previous.join(', ')}] -> [${current.join(', ')}]`, ...prev].slice(
          0,
          5
        )
      );
    }
  );

  const trackedDeps = createSignal<number | null>(null);
  const runTrackSignals = () => {
    const tracked = trackSignals(() => {
      // Intentionally do not read count() directly here. We "link" deps from inner trackers.
      const a = trackSignals(() => count());
      const b = trackSignals(() => doubled());
      linkTrackedSignals(a.deps);
      linkTrackedSignals(b.deps);
      return a.value + (b.value as number);
    });
    trackedDeps.set(tracked.deps.size);
  };
  const resumeMultiWatch = () => {
    if (stopMultiWatch !== null) {
      return;
    }

    stopMultiWatch = watch([count, batchLeft], (current, previous) => {
      watchMultiLog.set((prev) =>
        [`[${previous.join(', ')}] -> [${current.join(', ')}]`, ...prev].slice(
          0,
          5
        )
      );
    });
    watchEnabled.set(true);
  };
  const pauseMultiWatch = () => {
    stopMultiWatch?.();
    stopMultiWatch = null;
    watchEnabled.set(false);
  };
  const runSplitBatchDemo = () => {
    batchLeft.set((v) => v + 1);
    queueMicrotask(() => {
      batchRight.set((v) => v + 1);
    });
  };
  const runBatchedDemo = () => {
    batch(() => {
      batchLeft.set((v) => v + 1);
      batchRight.set((v) => v + 1);
    });
  };
  const resetBatchDemo = () => {
    batch(() => {
      batchLeft.set(1);
      batchRight.set(10);
      batchEffectRuns.set(0);
    });
  };
  const runSchedulerTransition = () => {
    transitionUrgent.set((v) => v + 1);
    transitionStateLog.set((prev) =>
      [`urgent -> ${transitionUrgent.peek()}`, ...prev].slice(0, 6)
    );
    startSchedulerTransition(() => {
      transitionDeferred.set((v) => v + 1);
      transitionStateLog.set((prev) =>
        [`transition -> ${transitionDeferred.peek()}`, ...prev].slice(0, 6)
      );
    });
  };
  const resetTransitionDemo = () => {
    batch(() => {
      transitionUrgent.set(0);
      transitionDeferred.set(0);
      transitionStateLog.set([]);
    });
  };

  // 2) Atom（@lania/store）
  const store = createAtom({
    user: { name: 'lania', clicks: 0 },
    nested: { counter: 0 },
    list: [{ id: 'a' }, { id: 'b' }] as StoreListItem[],
  });
  const storeUserName = createMemo(() => store.value.user.name);
  const storeUserClicks = createMemo(() => store.value.user.clicks);
  const storeNestedCounter = createMemo(() => store.value.nested.counter);
  const storeListIds = createMemo(() =>
    Array.from(
      { length: store.value.list.length },
      (_value, index) => store.value.list[index]?.id ?? `item-${index + 1}`
    )
  );

  // 3) Resource (async + auto refetch on deps)
  const query = createSignal('hello');
  const [result, controls] = createResource(query, async () => {
    const q = query();
    await sleep(350);
    return `server(${q})@${Date.now()}`;
  });
  const contextValue = createSignal('ctx: A');
  // Declarative provider: compiler rewrites to `provideContext(this, DemoContext, contextValue)`.
  provideContext(DemoContext, contextValue);
  const contextSnapshot = createMemo(() => {
    return useContext(DemoContext)();
  });

  const whenFlag = createSignal(true);
  const whenBranchFlag = createSignal(true);
  const whenModeDemoVisible = createSignal(true);
  const switchCase = createSignal<0 | 1 | 2 | 3>(1);
  const switchMode = createSignal<'retain' | 'remount'>('retain');
  const eachItems = createSignal<EnhancedListItem[]>([
    { id: '1', text: 'Each item A' },
    { id: '2', text: 'Each item B' },
    { id: '3', text: 'Each item C' },
  ]);
  // JSX reserves `key`, so this callback prop needs a type-only cast for TS.
  const eachItemKey = ((item: EnhancedListItem, _index: number) =>
    item.id) as never;
  const dynamicTag = createSignal<any>('section');
  const dynamicLabel = createMemo(() => {
    const v = dynamicTag();
    if (typeof v === 'string') {
      return v;
    }
    if (v && typeof v === 'function') {
      return (
        (v as any).tagName ??
        (v as any).displayName ??
        (v as any).name ??
        '(anonymous)'
      );
    }
    return String(v);
  });
  const keepAliveKey = createSignal<'page-a' | 'page-b'>('page-a');
  const keepAliveLog = createSignal<string[]>([]);
  const enhancedTabSession = createSignal(0);
  const keepAliveViews = createSignal({
    pageA: (
      <div data-key="page-a">
        <p className="summary">Page A (cached)</p>
        <p className="empty">
          Type text here, switch to page-b, then switch back.
        </p>
        <input className="input" placeholder="type in Page A" />
      </div>
    ) as any,
    pageB: (
      <div data-key="page-b">
        <p className="summary">Page B (cached)</p>
        <p className="empty">
          Type text here, switch to page-a, then switch back.
        </p>
        <input className="input" placeholder="type in Page B" />
      </div>
    ) as any,
  });
  const pushKeepAliveLog = (msg: string) => {
    queueMicrotask(() => {
      keepAliveLog.set((prev) =>
        [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 8)
      );
    });
  };
  const resetEnhancedTabState = () => {
    whenFlag.set(true);
    whenBranchFlag.set(true);
    whenModeDemoVisible.set(true);
    switchCase.set(1);
    switchMode.set('retain');
    eachItems.setValue([
      { id: '1', text: 'Each item A' },
      { id: '2', text: 'Each item B' },
      { id: '3', text: 'Each item C' },
    ]);
    dynamicTag.set('section');
    keepAliveKey.set('page-a');
    keepAliveLog.setValue([]);
    keepAliveViews.setValue({
      pageA: (
        <div data-key="page-a">
          <p className="summary">Page A (cached)</p>
          <p className="empty">
            Type text here, switch to page-b, then switch back.
          </p>
          <input className="input" placeholder="type in Page A" />
        </div>
      ) as any,
      pageB: (
        <div data-key="page-b">
          <p className="summary">Page B (cached)</p>
          <p className="empty">
            Type text here, switch to page-a, then switch back.
          </p>
          <input className="input" placeholder="type in Page B" />
        </div>
      ) as any,
    });
    enhancedTabSession.set((value) => value + 1);
  };
  watch(tab, (nextTab, previousTabValue) => {
    if (nextTab === 'enhanced' && previousTabValue !== 'enhanced') {
      resetEnhancedTabState();
    }
    if (nextTab === 'suspense' && previousTabValue !== 'suspense') {
      resetSuspenseTabState();
    }
  });

  // 5) Suspense + ErrorBoundary
  const lazyName = createSignal('world');
  const throwError = createSignal(false);
  const suspenseTabSession = createSignal(0);
  const resetSuspenseTabState = () => {
    lazyName.set('world');
    throwError.set(false);
    suspenseTabSession.set((value) => value + 1);
  };

  // 6) Transition tab：LazyLoad 可见性日志与演示共用同一个日志面板入口
  const transitionLog = createSignal<string[]>([]);
  const pushTransitionLog = (msg: string) => {
    transitionLog.set((prev) => [msg, ...prev].slice(0, 8));
  };
  const resetTransitionTabState = () => {
    transitionLog.set([]);
  };

  onMount(() => {
    withLifecycleHookSync(() => {
      lifecycleReady.set(true);
      syncLifecycleSignals(recordLifecycle('onMount'));
    });
    appendHookLog('onMount');
    refreshLifecycleLogs();
  });
  onUpdated(() => {
    appendHookLog('onUpdated');
  });
  onCleanup(() => {
    const snapshot = recordLifecycle('onCleanup');
    withLifecycleHookSync(() => {
      lifecycleReady.set(false);
      syncLifecycleSignals(snapshot);
    });
    appendHookLog('onCleanup');
    refreshLifecycleLogs();
  });

  createEffect(() => {
    // Basic proof that effects run and track signals.
    void count();
  });
  createEffect(() => {
    void batchSum();
    batchEffectRuns.set(batchEffectRuns.peek() + 1);
  });

  return (
    <section className="todo-card">
      <header>
        <h3>FC API / 链路 / 增强组件验证</h3>
        <p className="summary">按 Tab 切换验证不同能力点（都有交互）。</p>
      </header>

      <div className="filters">
        <button
          className="chip"
          aria-pressed={tab() === 'reactivity'}
          onClick={() => tab.set('reactivity')}
        >
          Reactivity
        </button>
        <button
          className="chip"
          aria-pressed={tab() === 'store'}
          onClick={() => tab.set('store')}
        >
          Store
        </button>
        <button
          className="chip"
          aria-pressed={tab() === 'resource'}
          onClick={() => tab.set('resource')}
        >
          Resource
        </button>
        <button
          className="chip"
          aria-pressed={tab() === 'enhanced'}
          onClick={() => {
            tab.set('enhanced');
            resetEnhancedTabState();
          }}
        >
          Enhanced
        </button>
        <button
          className="chip"
          aria-pressed={tab() === 'suspense'}
          onClick={() => {
            tab.set('suspense');
            resetSuspenseTabState();
          }}
        >
          Suspense
        </button>
        <button
          className="chip"
          aria-pressed={tab() === 'transition'}
          onClick={() => {
            tab.set('transition');
            resetTransitionTabState();
          }}
        >
          Transition
        </button>
        <button
          className="chip"
          aria-pressed={tab() === 'local'}
          onClick={() => {
            tab.set('local');
            resetTransitionTabState();
          }}
        >
          Local
        </button>
      </div>

      <div className="list">
        <When value={tab() === 'reactivity'} mode="remount">
          <div>
            <div className="item">
              <p className="summary">
                createSignal / createMemo / createEffect
              </p>
              <p>
                count: <span>{count()}</span> | doubled:{' '}
                <span>{doubled()}</span>
              </p>
              <div className="row">
                <button className="btn" onClick={() => count.set((v) => v + 1)}>
                  +1
                </button>
                <button className="btn" onClick={() => count.set((v) => v - 1)}>
                  -1
                </button>
              </div>
            </div>

            <div className="item">
              <p className="summary">readonly / createDeferred</p>
              <p>
                readonly(count): <span>{readonlyCount()}</span>
              </p>
              <p>
                deferred(count, 400ms): <span>{deferredCount()}</span>
              </p>
            </div>

            <div className="item">
              <p className="summary">FC lifecycle hooks</p>
              <p>
                ready: <span>{lifecycleReady() ? 'mounted' : 'idle'}</span> |
                mounts/unmounts:
                <span> {lifecycleMountCount()}</span> /{' '}
                <span>{lifecycleUnmountCount()}</span>
              </p>
              <p>
                beforeUpdate/updated: <span>{lifecycleWillUpdateCount()}</span>{' '}
                / <span>{lifecycleUpdatedCount()}</span>
              </p>
              <p className="summary">
                支持的 FC hooks: {lifecycleHookNames.join(' / ')}
              </p>
              <div className="row">
                <button className="btn" onClick={refreshLifecycleLogs}>
                  refresh logs
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    const snapshot = getFcShowcaseLifecycleHistory();
                    snapshot.logs = [];
                    snapshot.hookLogs = [];
                    refreshLifecycleLogs();
                  }}
                >
                  clear logs
                </button>
              </div>
              <Each
                value={lifecycleLog()}
                fallback={renderEmpty('no lifecycle logs yet')}
              >
                {(line): any => <p className="empty">{line}</p>}
              </Each>
              <Each
                value={lifecycleHookLog()}
                fallback={renderEmpty('no hook logs yet')}
              >
                {(line: string): any => <p className="empty">{line}</p>}
              </Each>
            </div>

            <div className="item">
              <p className="summary">ref（RefSlot）</p>
              <div className="row">
                <input
                  className="input"
                  ref={inputRef}
                  value={inputText()}
                  onInput={(event: Event) => {
                    const target = event.target as HTMLInputElement | null;
                    inputText.set(target?.value ?? '');
                  }}
                />
                <button
                  className="btn"
                  onClick={() => {
                    inputRef?.focus();
                  }}
                >
                  focus()
                </button>
              </div>
            </div>

            <div className="item">
              <p className="summary">
                isTracking / untrack / trackSignals / linkTrackedSignals
              </p>
              <p>
                isTracking() inside memo: <span>{trackingFlag()}</span>
              </p>
              <p>
                untrack(() =&gt; count()): <span>{untrackedSnapshot()}</span>{' '}
                (不会随 count 更新)
              </p>
              <button className="btn" onClick={runTrackSignals}>
                计算依赖数量
              </button>
              <p>
                依赖数量:{' '}
                <span>{trackedDeps() == null ? '-' : trackedDeps()}</span>
              </p>
            </div>

            <div className="item">
              <p className="summary">watch</p>
              <Each value={watchLog()} fallback={renderEmpty('no watch logs')}>
                {(line: string): any => <p className="empty">{line}</p>}
              </Each>
            </div>

            <div className="item">
              <p className="summary">watch（多源 + stop/resume）</p>
              <p>
                watch([count, batchLeft]) active:{' '}
                <span>{watchEnabled() ? 'yes' : 'no'}</span>
              </p>
              <div className="row">
                <button className="btn" onClick={resumeMultiWatch}>
                  resume
                </button>
                <button className="btn" onClick={pauseMultiWatch}>
                  stop
                </button>
                <button className="btn" onClick={() => watchMultiLog.set([])}>
                  clear
                </button>
              </div>
              <Each
                value={watchMultiLog()}
                fallback={renderEmpty('no watch logs')}
              >
                {(line: string): any => <p className="empty">{line}</p>}
              </Each>
            </div>

            <div className="item">
              <p className="summary">batch</p>
              <p>
                left/right/sum: <span>{batchLeft()}</span> /{' '}
                <span>{batchRight()}</span> / <span>{batchSum()}</span>
              </p>
              <p>
                effect runs: <span>{batchEffectRuns()}</span>
              </p>
              <div className="row">
                <button className="btn" onClick={runSplitBatchDemo}>
                  split update
                </button>
                <button className="btn" onClick={runBatchedDemo}>
                  batch update
                </button>
                <button className="btn" onClick={resetBatchDemo}>
                  reset
                </button>
              </div>
              <p className="summary">
                `split update` 会拆成两次 flush；`batch update`
                会把两次写入合成一次提交。
              </p>
            </div>

            <div className="item">
              <p className="summary">
                useTransition + startTransition（scheduler）
              </p>
              <p>
                urgent: <span>{transitionUrgent()}</span> | deferred:{' '}
                <span>{transitionDeferred()}</span>
              </p>
              <p>
                pending: <span>{transitionPendingState() ? 'yes' : 'no'}</span>
              </p>
              <div className="row">
                <button className="btn" onClick={runSchedulerTransition}>
                  run transition
                </button>
                <button className="btn" onClick={resetTransitionDemo}>
                  reset
                </button>
              </div>
              <Each
                value={transitionStateLog()}
                fallback={renderEmpty('no transition logs')}
              >
                {(line: string): any => <p className="empty">{line}</p>}
              </Each>
            </div>
          </div>
        </When>

        <When value={tab() === 'store'}>
          <div className="item">
            <p className="summary">@lania/store 原子读写链路</p>
            <p>store.value.user.name: {storeUserName()}</p>
            <p>store.value.user.clicks: {storeUserClicks()}</p>
            <p>store.value.nested.counter: {storeNestedCounter()}</p>
            <div className="row">
              <button
                className="btn"
                onClick={() =>
                  store.set('user', 'clicks', (v: number) => v + 1)
                }
              >
                click +1
              </button>
              <button
                className="btn"
                onClick={() =>
                  store.set('nested', 'counter', (v: number) => v + 1)
                }
              >
                nested +1
              </button>
              <button
                className="btn"
                onClick={() =>
                  store.set('user', 'name', (v: string) => `${v}!`)
                }
              >
                name +!
              </button>
              <button
                className="btn"
                onClick={() =>
                  store.set('list', (prev: StoreListItem[]) =>
                    prev.concat({ id: `item-${prev.length + 1}` })
                  )
                }
              >
                append item
              </button>
            </div>
            <p>store.value.list ids: {storeListIds().join(', ') || '-'}</p>
          </div>
        </When>

        <When value={tab() === 'resource'}>
          <div className="item">
            <p className="summary">createResource（依赖追踪 + 异步刷新）</p>
            <p>query: {query()}</p>
            <div className="row">
              <button className="btn" onClick={() => query.set('hello')}>
                hello
              </button>
              <button className="btn" onClick={() => query.set('lania')}>
                lania
              </button>
              <button className="btn" onClick={() => query.set('zip')}>
                zip
              </button>
              <button className="btn" onClick={() => controls.refetch()}>
                refetch()
              </button>
            </div>
            <p>loading: {String(controls.loading())}</p>
            <p>error: {controls.error() ? String(controls.error()) : '-'}</p>
            <p>value: {result() ?? '-'}</p>
          </div>

          <div className="item">
            <p className="summary">
              createContext / provideContext / useContext
            </p>
            <div className="row">
              <button
                className="btn"
                onClick={() => contextValue.set('ctx: A')}
              >
                set A
              </button>
              <button
                className="btn"
                onClick={() => contextValue.set('ctx: B')}
              >
                set B
              </button>
              <button
                className="btn"
                onClick={() => contextValue.set(`ctx: ${Date.now()}`)}
              >
                set timestamp
              </button>
            </div>
            <p className="empty">
              useContext(DemoContext): {contextSnapshot()}
            </p>
          </div>
        </When>

        <When value={tab() === 'enhanced'}>
          <div className="item">
            <p className="summary">&lt;When fallback /&gt;</p>
            <button className="btn" onClick={() => whenFlag.set((v) => !v)}>
              toggle: {String(whenFlag())}
            </button>
            <When value={whenFlag()} fallback={renderEmpty('fallback branch')}>
              <p className="summary">truthy branch</p>
            </When>
          </div>

          <div className="item">
            <p className="summary">
              &lt;When&gt; + &lt;Then /&gt; + &lt;Else /&gt;
            </p>
            <p className="empty">
              `Then` / `Else` 只能作为 `When` 的直接子节点使用。
            </p>
            <button
              className="btn"
              onClick={() => whenBranchFlag.set((v) => !v)}
            >
              toggle branch: {String(whenBranchFlag())}
            </button>
            <When value={whenBranchFlag()}>
              <Then>
                <p className="summary">Then branch: visible = true</p>
              </Then>
              <Else>
                <p className="empty">Else branch: visible = false</p>
              </Else>
            </When>
          </div>

          <div className="item">
            <p className="summary">&lt;When mode="remount" /&gt;</p>
            <p className="empty">
              在两个输入框里分别输入内容，然后 toggle hide/show。上面会保留原
              DOM 输入值，下面会重新创建 DOM 并清空输入内容。
            </p>
            <button
              className="btn"
              onClick={() => whenModeDemoVisible.set((v) => !v)}
            >
              toggle demo: {String(whenModeDemoVisible())}
            </button>
            <div
              style={{
                display: 'grid',
                gap: '12px',
                marginTop: '12px',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              }}
            >
              <When value={whenModeDemoVisible()}>
                <div
                  className="surface-light"
                  style={{
                    padding: '12px',
                    borderRadius: '12px',
                    border: '1px solid #d0d7de',
                    background: '#f8fafc',
                  }}
                >
                  <p className="summary">retain (default)</p>
                  <p className="empty">hide/show 后输入内容会保留</p>
                  <input className="input" placeholder="type in retain block" />
                </div>
              </When>
              <When value={whenModeDemoVisible()} mode="remount">
                <div
                  className="surface-light"
                  style={{
                    padding: '12px',
                    borderRadius: '12px',
                    border: '1px solid #d0d7de',
                    background: '#fff7ed',
                  }}
                >
                  <p className="summary">remount</p>
                  <p className="empty">hide/show 后输入内容会被清空</p>
                  <input
                    className="input"
                    placeholder="type in remount block"
                  />
                </div>
              </When>
            </div>
          </div>

          <div className="item">
            <p className="summary">
              &lt;Switch&gt; + &lt;Case /&gt; + &lt;Default /&gt;
            </p>
            <p className="empty">
              `Case` / `Default` 只能作为 `Switch`
              的直接子节点使用；按顺序匹配第一个为 true 的 Case，否则走
              Default。
            </p>
            <div className="row">
              <button className="btn" onClick={() => switchCase.set(1)}>
                set 1
              </button>
              <button className="btn" onClick={() => switchCase.set(2)}>
                set 2
              </button>
              <button className="btn" onClick={() => switchCase.set(3)}>
                set 3
              </button>
              <button className="btn" onClick={() => switchCase.set(0)}>
                set other
              </button>
            </div>
            <div className="row" style={{ marginTop: '10px' }}>
              <button
                className="btn"
                onClick={() => switchMode.set('retain')}
                disabled={switchMode() === 'retain'}
              >
                mode=retain
              </button>
              <button
                className="btn"
                onClick={() => switchMode.set('remount')}
                disabled={switchMode() === 'remount'}
              >
                mode=remount
              </button>
            </div>
            <p className="empty">
              tips: 在 A/B/Default 里输入内容，来回切分支再回来；retain
              会保留输入值，remount 会清空。
            </p>
            <When value={switchMode() === 'retain'}>
              <Then>
                <Switch mode="retain">
                  <Case value={switchCase() === 1}>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#f8fafc',
                      }}
                    >
                      <p className="summary">Case 1</p>
                      <input className="input" placeholder="type in 1" />
                    </div>
                  </Case>
                  <Case value={switchCase() === 2}>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#ecfeff',
                      }}
                    >
                      <p className="summary">Case 2</p>
                      <input className="input" placeholder="type in 2" />
                    </div>
                  </Case>
                  <Case value={switchCase() === 3}>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#eef2ff',
                      }}
                    >
                      <p className="summary">Case 3</p>
                      <input className="input" placeholder="type in 3" />
                    </div>
                  </Case>
                  <Default>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#fff7ed',
                      }}
                    >
                      <p className="summary">Default</p>
                      <input className="input" placeholder="type in Default" />
                    </div>
                  </Default>
                </Switch>
              </Then>
              <Else>
                <Switch mode="remount">
                  <Case value={switchCase() === 1}>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#f8fafc',
                      }}
                    >
                      <p className="summary">Case 1</p>
                      <input className="input" placeholder="type in 1" />
                    </div>
                  </Case>
                  <Case value={switchCase() === 2}>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#ecfeff',
                      }}
                    >
                      <p className="summary">Case 2</p>
                      <input className="input" placeholder="type in 2" />
                    </div>
                  </Case>
                  <Case value={switchCase() === 3}>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#eef2ff',
                      }}
                    >
                      <p className="summary">Case 3</p>
                      <input className="input" placeholder="type in 3" />
                    </div>
                  </Case>
                  <Default>
                    <div
                      className="surface-light"
                      style={{
                        padding: '12px',
                        borderRadius: '12px',
                        border: '1px solid #d0d7de',
                        background: '#fff7ed',
                      }}
                    >
                      <p className="summary">Default</p>
                      <input className="input" placeholder="type in Default" />
                    </div>
                  </Default>
                </Switch>
              </Else>
            </When>
          </div>

          <div className="item">
            <p className="summary">&lt;Each /&gt;（keyed）</p>
            <div className="row">
              <button
                className="btn"
                onClick={() =>
                  eachItems.set((prev) =>
                    prev.concat({
                      id: String(prev.length + 1),
                      text: `Each item ${prev.length + 1}`,
                    })
                  )
                }
              >
                append
              </button>
              <button
                className="btn"
                onClick={() => eachItems.set((prev) => prev.slice(0, -1))}
              >
                pop
              </button>
            </div>
            <Each
              value={eachItems()}
              key={eachItemKey}
              fallback={renderEmpty('empty')}
            >
              {(item: EnhancedListItem): any => (
                <p className="empty">
                  {item.id}: {item.text}
                </p>
              )}
            </Each>
          </div>

          <div className="item">
            <p className="summary">&lt;Fragment /&gt; + &lt;Dynamic /&gt;</p>
            <div className="row">
              <button className="btn" onClick={() => dynamicTag.set('section')}>
                section
              </button>
              <button className="btn" onClick={() => dynamicTag.set('article')}>
                article
              </button>
              <button className="btn" onClick={() => dynamicTag.set('button')}>
                button
              </button>
              <button
                className="btn"
                onClick={() => dynamicTag.set('x-todo-fc')}
              >
                x-todo-fc (string)
              </button>
              <button
                className="btn"
                onClick={() => dynamicTag.setValue(TodoFc)}
              >
                TodoFc (ctor)
              </button>
              <button
                className="btn"
                onClick={() => dynamicTag.setValue(ShowcaseCard)}
              >
                ShowcaseCard (ctor)
              </button>
            </div>
            <Fragment>
              <p className="empty">dynamic: {dynamicLabel()}</p>
              <Dynamic
                is={dynamicTag()}
                props={{
                  title: 'dynamic-title',
                  style: {
                    width: '240px',
                    padding: '10px 12px',
                    borderRadius: '12px',
                    border: '1px solid #d0d7de',
                    background: '#ffffff',
                    color: '#0f172a',
                  },
                }}
              >
                Body
              </Dynamic>
            </Fragment>
          </div>

          <div className="item">
            <p className="summary">&lt;Teleport /&gt;</p>
            <Teleport to="#portal-root">
              <p className="summary" data-key="teleported">
                Teleported content
              </p>
            </Teleport>
          </div>

          <div className="item">
            <p className="summary">&lt;KeepAlive /&gt;</p>
            <div className="row">
              <button
                className="btn"
                onClick={() => keepAliveKey.set('page-a')}
              >
                page-a
              </button>
              <button
                className="btn"
                onClick={() => keepAliveKey.set('page-b')}
              >
                page-b
              </button>
            </div>
            <KeepAlive
              scope={`fc-showcase-${enhancedTabSession()}`}
              cacheKey={keepAliveKey()}
              max={2}
              onCache={(_value: unknown, key: string) =>
                pushKeepAliveLog(`cache ${key}`)
              }
              onActivate={(_value: unknown, key: string, reused: boolean) =>
                pushKeepAliveLog(`activate ${key} reused=${String(reused)}`)
              }
              onDeactivate={(_value: unknown, key: string) =>
                pushKeepAliveLog(`deactivate ${key}`)
              }
              onEvict={(_value: unknown, key: string) =>
                pushKeepAliveLog(`evict ${key}`)
              }
            >
              {keepAliveKey() === 'page-a'
                ? keepAliveViews().pageA
                : keepAliveViews().pageB}
            </KeepAlive>
            <Each
              value={keepAliveLog()}
              fallback={renderEmpty('no keep-alive logs')}
            >
              {(line: string): any => <p className="empty">{line}</p>}
            </Each>
          </div>

          <div className="item">
            <p className="summary">&lt;LazyLoad /&gt;</p>
            <LazyLoad
              fallback={<p className="empty">lazyload placeholder</p>}
              onVisibleChange={(visible) =>
                pushTransitionLog(`lazy visible=${String(visible)}`)
              }
            >
              <p className="empty">Observed content for LazyLoad.</p>
            </LazyLoad>
          </div>
        </When>

        <When value={tab() === 'suspense'} mode="remount">
          <div className="item">
            <p className="summary">
              &lt;Suspense /&gt; + lazy() + &lt;LazyLoad /&gt;
            </p>
            <div className="row">
              <button className="btn" onClick={() => lazyName.set('lania')}>
                name=lania
              </button>
              <button className="btn" onClick={() => lazyName.set('runtime')}>
                name=runtime
              </button>
              <button className="btn" onClick={() => throwError.set((v) => !v)}>
                toggle error
              </button>
            </div>
            <ErrorBoundary
              fallback={(error) => (
                <p className="empty">caught: {String(error)}</p>
              )}
            >
              <Suspense fallback={<p className="empty">loading...</p>}>
                <When value={!throwError()}>
                  <Then>
                    <LazyHello name={lazyName()} key={suspenseTabSession()} />
                  </Then>
                  <Else>
                    {(() => {
                      throw new Error('manual suspense demo error');
                    })()}
                  </Else>
                </When>
              </Suspense>
            </ErrorBoundary>
          </div>

          <div className="item">
            <p className="summary">&lt;LazyLoad /&gt;</p>
            <LazyLoad
              fallback={<p className="empty">lazyload placeholder</p>}
              onVisibleChange={(visible) =>
                pushTransitionLog(`lazy visible=${String(visible)}`)
              }
            >
              <p className="empty">Observed content for LazyLoad.</p>
            </LazyLoad>
          </div>
        </When>

        <When value={tab() === 'transition'} mode="remount">
          <TransitionDemoSection />
        </When>
        <When value={tab() === 'local'} mode="remount">
          <Dynamic component="x-local-state-counter-card" />
        </When>
      </div>
    </section>
  );
}

export default FcShowcase;
