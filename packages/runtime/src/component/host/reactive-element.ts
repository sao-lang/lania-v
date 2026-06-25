import { emitLifecycleDebugEvent } from '../../core/debug';
import type { Signal } from '../../reactivity/signal';
import {
  HIGH,
  defaultScheduler,
  type Scheduler,
} from '../../reactivity/scheduler';
import { SlotTable } from '../../dom/slot-table';
import { adoptStyles, type StaticStyles } from '../styles';
import type { Slot } from '../../dom/slots';
import type { Updater } from '../../dom/updaters';
import { withContextHost } from './function-component';

/**
 * 运行时组件基类（Custom Element）。
 *
 * 目标：
 * - 提供统一的更新调度（`Scheduler`）与生命周期钩子；
 * - 在响应式 `Signal` 变化时自动触发更新（tracked signals）；
 * 注意：子类只需要实现 `_renderAndMount()` 并在其内部注册 slots/updaters，
 * 其余更新节奏由基类控制。
 */
export interface ChangedPropRecord {
  previous: unknown;
  current: unknown;
}

export type ChangedProps = Map<string, ChangedPropRecord>;
export type RenderMode = 'shadow' | 'light';

const ReactiveElementBase: typeof HTMLElement =
  (globalThis.HTMLElement ?? class {} as typeof HTMLElement);

export abstract class ReactiveElement extends ReactiveElementBase {
  /**
   * 渲染模式：
   * - `shadow`: 默认创建/复用 ShadowRoot
   * - `light`: 直接在宿主元素上渲染
   */
  static renderMode: RenderMode = 'shadow';
  static styles?: StaticStyles;

  protected renderRoot!: ShadowRoot | this;
  protected _slots: Node[] = [];
  protected _updaters: Array<() => void> = [];
  protected _runtimeUpdaters: Updater[] = [];
  protected _slotTable = new SlotTable();
  protected _dirty = false;
  protected _scheduler: Scheduler = defaultScheduler;
  protected _isMounted = false;
  // connectedCallback/disconnectedCallback 的状态并不等价于 isConnected（跨文档/移动节点场景）
  protected _isConnectedFlag = false;
  protected _hasUpdated = false;

  // 当前组件订阅的信号集合（一般由子类在 render/setup 时调用 trackSignal 注册）
  private readonly _trackedSignals = new Set<Signal<any>>();
  // 本轮更新周期内记录的属性变化（供 shouldUpdate/willUpdate/updated 使用）
  private readonly _changedProps = new Map<string, ChangedPropRecord>();
  private _updateRequested = false;
  private _forceRuntimeUpdaterFlush = false;
  private _autoTrackDone = false;
  private readonly _requestUpdateJob = () => {
    this.requestUpdate();
  };
  private readonly _performUpdateJob = () => {
    this._updateRequested = false;
    this.performUpdate();
  };

  /**
   * 组件连接到 DOM 时：
   * - 首次连接：创建 renderRoot、应用 styles、执行首屏 render/mount
   * - 每次连接：绑定 signals/updaters、触发一次更新
   */
  connectedCallback(): void {
    this._isConnectedFlag = true;
    emitLifecycleDebugEvent({
      type: 'connected',
      component: this,
      tagName: this.tagName.toLowerCase(),
    });
    this._bindTrackedSignals();
    this.__fcOnMount();

    if (!this._isMounted) {
      this.renderRoot = this.createRenderRoot();
      this.adoptStyles();
      this._renderAndMount();
      this._isMounted = true;
    }

    this._autoTrackSignalsNotDrivenByRuntimeUpdaters();
    this.requestUpdate();
  }

  /**
   * 组件从 DOM 断开时：
   * - 解绑所有 signal/updater 订阅，避免内存泄漏/后台更新
   */
  disconnectedCallback(): void {
    this.__fcOnCleanup();
    this._isConnectedFlag = false;
    emitLifecycleDebugEvent({
      type: 'disconnected',
      component: this,
      tagName: this.tagName.toLowerCase(),
    });
    this._unbindTrackedSignals();
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    void name;
    void oldValue;
    void newValue;
  }

  adoptedCallback(): void {
    this.requestUpdate();
  }

  errorCallback(_error: unknown): void {}

  /** 触发一个默认 bubbles+composed 的自定义事件（适合组件对外通知）。 */
  emit<T>(
    name: string,
    detail?: T,
    options: Omit<CustomEventInit<T>, 'detail'> = {}
  ): boolean {
    return this.dispatchEvent(
      new CustomEvent<T>(name, {
        detail,
        bubbles: options.bubbles ?? true,
        composed: options.composed ?? true,
        cancelable: options.cancelable ?? false,
      })
    );
  }

  /**
   * 请求一次更新。
   * - 同一微任务内多次 requestUpdate 会合并为一次 performUpdate
   * - 可选记录某个属性的变化（用于 shouldUpdate / 生命周期入参）
   */
  requestUpdate(name?: string, previous?: unknown, current?: unknown): void {
    if (name) {
      this._recordChangedProp(name, previous, current);
    }
    // Signal-driven updates can miss deep structural deps (e.g. nested `Each` inside
    // a truthy `When` child payload). Keep a forced structural pass, but `_flushUpdaters`
    // will scope that pass to active branches instead of every updater.
    this._forceRuntimeUpdaterFlush = true;

    if (this._updateRequested) {
      return;
    }

    this._updateRequested = true;
    emitLifecycleDebugEvent({
      type: 'request-update',
      component: this,
      tagName: this.tagName.toLowerCase(),
      changedKeys: name ? [name] : undefined,
    });
    this._scheduler.scheduleLifecycle(this._performUpdateJob, HIGH);
  }

  /**
   * 执行一次更新（由 scheduler 调度）。
   * 更新流程：
   * 1. 收集并清空 changedProps（本次快照）
   * 2. shouldUpdate: 允许子类跳过更新
   * 3. willUpdate -> flushUpdaters -> updated
   * 4. 首次更新额外触发 firstUpdated
   */
  performUpdate(): void {
    if (!this._isConnectedFlag) {
      return;
    }

    const changedProps = new Map(this._changedProps);
    this._changedProps.clear();

    const changedKeys = [...changedProps.keys()];

    if (!this.shouldUpdate(changedProps)) {
      return;
    }

    emitLifecycleDebugEvent({
      type: 'will-update',
      component: this,
      tagName: this.tagName.toLowerCase(),
      changedKeys,
    });
    this.willUpdate(changedProps);
    this._flushUpdaters();
    emitLifecycleDebugEvent({
      type: 'updated',
      component: this,
      tagName: this.tagName.toLowerCase(),
      changedKeys,
    });
    this.updated(changedProps);
    this.__fcOnUpdated(changedProps);

    if (!this._hasUpdated) {
      this._hasUpdated = true;
      emitLifecycleDebugEvent({
        type: 'first-updated',
        component: this,
        tagName: this.tagName.toLowerCase(),
        changedKeys,
      });
      this.firstUpdated(changedProps);
    }
  }

  protected createRenderRoot(): ShadowRoot | this {
    const ctor = this.constructor as typeof ReactiveElement;

    if (ctor.renderMode === 'light') {
      return this;
    }

    return this.shadowRoot ?? this.attachShadow({ mode: 'open' });
  }

  protected adoptStyles(): void {
    const ctor = this.constructor as typeof ReactiveElement;
    adoptStyles(this.renderRoot, ctor.styles);
  }

  protected shouldUpdate(_changedProps: ChangedProps): boolean {
    return true;
  }

  protected __fcOnMount(): void {}

  protected __fcOnCleanup(): void {}

  protected __fcOnUpdated(_changedProps: ChangedProps): void {}

  protected willUpdate(_changedProps: ChangedProps): void {}

  protected updated(_changedProps: ChangedProps): void {}

  protected firstUpdated(_changedProps: ChangedProps): void {}

  /**
   * 供子类在不触发 requestUpdate 合并逻辑的情况下记录属性变化。
   * 基类内部仍会在 requestUpdate 时使用该记录。
   */
  protected recordChangedProp(
    name: string,
    previous: unknown,
    current: unknown
  ): void {
    this._recordChangedProp(name, previous, current);
  }

  /**
   * 注册一个会触发组件更新的 Signal。
   * 通常在子类构造/初始化阶段调用；连接到 DOM 后会自动绑定 updater。
   */
  protected trackSignal<T>(signal: Signal<T>): void {
    this._trackedSignals.add(signal);

    if (this._isConnectedFlag) {
      signal.updaters.add(this._requestUpdateJob);
    }
  }

  /**
   * 注册一个“纯函数” updater：每次更新时都会执行（适合将计算结果写入 slot）。
   * 这类 updater 的执行时机由组件生命周期驱动，而不是 signal 直接触发。
   */
  protected registerUpdater(updater: () => void): void {
    this._updaters.push(updater);
  }

  /**
   * 注册运行时 Updater（可订阅 signals 并自行调度）。
   * - 连接时 attach，断开时 detach
   * - flushUpdaters 时会根据 slot dirty 情况选择性执行
   */
  protected registerRuntimeUpdater(updater: Updater): void {
    this._runtimeUpdaters.push(updater);

    if (this._isConnectedFlag) {
      updater.attach();
    }
  }

  /** 注册 slot 并进入 slot-table，用于“按 slot 粒度”的 dirty 跟踪。 */
  protected registerSlot<TSlot extends Slot>(slot: TSlot): TSlot {
    this._slotTable.register(slot);
    return slot;
  }

  protected _flushUpdaters(): void {
    // Ensure enhanced components (e.g. Suspense/LazyLoad) can access the current host.
    // Dynamic slots may call function targets directly, so we establish the host context here.
    withContextHost(this, () => {
      // 纯函数 updater 总是执行（组件级刷新点）
      for (const updater of this._updaters) {
        updater();
      }

      // 运行时 updater 在组件进入一次更新周期时至少执行一轮，
      // 避免结构型 slot 的依赖遗漏导致“状态已变、分支未刷新”。
      for (const updater of this._runtimeUpdaters) {
        const shouldForceRun =
          this._forceRuntimeUpdaterFlush &&
          updater.slots.some((slot) => {
            if (slot.type !== 'if') {
              return false;
            }
            return true;
          });
        const shouldRun =
          shouldForceRun ||
          updater.dirty ||
          updater.slots.some((slot) => this._slotTable.isDirty(slot.index));

        if (shouldRun) {
          updater.run();
        }
      }

      this._forceRuntimeUpdaterFlush = false;

      this._slotTable.clearDirty();
    });
  }

  private _autoTrackSignalsNotDrivenByRuntimeUpdaters(): void {
    if (this._autoTrackDone) {
      return;
    }

    this._autoTrackDone = true;
    for (const key of Object.keys(this)) {
      const value = (this as unknown as Record<string, unknown>)[key];
      if (
        typeof value === 'function' &&
        typeof (value as { set?: unknown }).set === 'function' &&
        (() => {
          const updaters = (value as { updaters?: unknown }).updaters as
            | { add?: unknown; delete?: unknown }
            | undefined;
          // Signal.updaters is a Set-like CompactJobSet at runtime, so use duck typing.
          return (
            updaters != null &&
            typeof updaters.add === 'function' &&
            typeof updaters.delete === 'function'
          );
        })()
      ) {
        const signal = value as Signal<any>;
        this.trackSignal(signal);
      }
    }
  }

  private _bindTrackedSignals(): void {
    // tracked signals：signal.set -> schedule update（组件级）
    for (const signal of this._trackedSignals) {
      signal.updaters.add(this._requestUpdateJob);
    }

    // runtime updater：内部通常会把 job 绑定到 deps 上
    for (const updater of this._runtimeUpdaters) {
      updater.attach();
    }
  }

  private _unbindTrackedSignals(): void {
    for (const signal of this._trackedSignals) {
      signal.updaters.delete(this._requestUpdateJob);
    }

    for (const updater of this._runtimeUpdaters) {
      updater.detach();
    }
  }

  private _recordChangedProp(
    name: string,
    previous: unknown,
    current: unknown
  ): void {
    const existing = this._changedProps.get(name);

    // 同一轮内多次写入同一 key：previous 保留第一次的值，current 以最后一次为准
    this._changedProps.set(name, {
      previous: existing ? existing.previous : previous,
      current,
    });
  }

  protected abstract _renderAndMount(): void;
}
