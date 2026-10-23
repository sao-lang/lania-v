import {
  emitLifecycleDebugEvent,
  isDevEnvironment,
  warning,
} from '../../core/debug';
import { isComponentHmrEnabled } from '../../dev/hmr';
import type { PropOptionsMap } from './prop-options';
import type { Signal } from '../../reactivity';
import { HIGH, defaultScheduler, type Scheduler } from '../../reactivity';
import { SlotTable } from '../../dom/slot-table';
import {
  adoptStyles,
  registerAppliedStyleTexts,
  type StaticStyles,
} from '../styles';
import type { Slot } from '../../dom/slots';
import type { Updater } from '../../dom/updaters';
import { withComponentProps, withContextHost } from './function-component';
import { attachDeclarativeShadowRoot } from '../../render/dsd';

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
/**
 * 水合策略：
 * - `eager`：连接 DOM 后立即挂载（默认）；
 * - `manual`：保留 SSR 内容，等待 `hydrate()`（由部分水合调度器触发）。
 */
export type HydrationStrategy = 'eager' | 'manual';

/**
 * 把组件侧的值归一化成 `ElementInternals.setFormValue` 可接受的形式。
 *
 * 规范只接受 `string | File | FormData | null`，而组件内部通常存的是任意 signal 值，
 * 因此在边界处统一做一次转换。
 */
const normalizeFormValue = (
  value: unknown
): string | File | FormData | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  // 非浏览器环境（或旧运行时）可能没有 File / FormData 构造器。
  if (typeof File !== 'undefined' && value instanceof File) {
    return value;
  }

  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    return value;
  }

  if (typeof value === 'boolean') {
    // 与原生 checkbox 保持一致：选中上报 'on'。
    return value ? 'on' : null;
  }

  return String(value);
};

const ReactiveElementBase: typeof HTMLElement =
  globalThis.HTMLElement ?? (class {} as typeof HTMLElement);

export abstract class ReactiveElement extends ReactiveElementBase {
  /**
   * 渲染模式：
   * - `shadow`: 默认创建/复用 ShadowRoot
   * - `light`: 直接在宿主元素上渲染
   */
  static renderMode: RenderMode = 'shadow';
  /**
   * 水合策略。
   *
   * 部分水合场景下把组件设为 `manual`，SSR 输出会原样保留，
   * 直到调度器调用 `hydrate()` 才接管 DOM。
   */
  static hydration: HydrationStrategy = 'eager';
  static styles?: StaticStyles;
  /**
   * 是否参与原生表单提交。
   *
   * 编译期识别到 `useFormValue(...)` 时会生成 `static formAssociated = true`，
   * 浏览器随后会把这个自定义元素纳入 `form.elements`，并接受 `setFormValue` 上报的值。
   */
  static formAssociated = false;
  /** 编译期从 `defineComponent(fn, { props })` 生成的 prop 选项。 */
  static propOptions?: PropOptionsMap;
  /** 编译期从 `defineComponent(fn, { emits })` 生成的事件名单。 */
  static emits?: readonly string[];
  /**
   * 浏览器在 `customElements.define()` 时读取一次的属性名单。
   *
   * 编译产物会在类求值时按 prop 选项生成；声明在这里只是给运行时一个稳定类型。
   */
  static observedAttributes?: readonly string[];

  private _internals?: ElementInternals;

  protected renderRoot!: ShadowRoot | this;
  protected _slots: Node[] = [];
  protected _updaters: Array<() => void> = [];
  protected _runtimeUpdaters: Updater[] = [];
  protected _slotTable = new SlotTable();
  protected _dirty = false;
  protected _scheduler: Scheduler = defaultScheduler;
  protected _isMounted = false;
  /** `static hydration = 'manual'` 时，是否已经被显式 hydrate()。 */
  private _hydrationRequested = false;
  /** dev + HMR 下用于兜底未声明 attribute 的变化（observedAttributes 在 define 时已固化）。 */
  private _devAttributeObserver?: MutationObserver;
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

  constructor() {
    super();

    const ctor = this.constructor as typeof ReactiveElement;
    // `attachInternals` 只能在构造期调用；未声明 formAssociated 的组件不拿 Internals，
    // 避免被意外纳入 form.elements。
    if (ctor.formAssociated && typeof this.attachInternals === 'function') {
      this._internals = this.attachInternals();
    }
  }

  /** 把当前值同步给宿主表单；未声明 `useFormValue` 的组件调用时为空操作。 */
  protected _setFormValue(value: unknown): void {
    const internals = this._internals;

    // 部分 DOM 实现（例如 jsdom）只提供 attachInternals，没有 setFormValue。
    if (!internals || typeof internals.setFormValue !== 'function') {
      return;
    }

    internals.setFormValue(normalizeFormValue(value));
  }

  /**
   * 把校验结果同步给宿主表单。
   *
   * 支持三种形态：
   * - `true` / `false`：仅表示是否通过；
   * - `{ valid: false, message }`：带自定义错误信息；
   * - `null` / `undefined`：视为通过并清空错误。
   */
  protected _setFormValidity(result: unknown): void {
    const internals = this._internals;

    if (!internals || typeof internals.setValidity !== 'function') {
      return;
    }

    const record =
      result && typeof result === 'object'
        ? (result as { valid?: unknown; message?: unknown })
        : null;
    const valid = record ? record.valid !== false : result !== false;

    if (valid) {
      internals.setValidity({});
      return;
    }

    const message =
      record && typeof record.message === 'string'
        ? record.message
        : 'Invalid value';

    internals.setValidity({ customError: true }, message);
  }

  /**
   * 组件连接到 DOM 时：
   * - 首次连接：创建 renderRoot、应用 styles、执行首屏 render/mount
   * - 每次连接：绑定 signals/updaters、触发一次更新
   */
  connectedCallback(): void {
    this._isConnectedFlag = true;
    this._syncDevAttributeObserver();
    emitLifecycleDebugEvent({
      type: 'connected',
      component: this,
      tagName: this.tagName.toLowerCase(),
    });

    if (!this._isMounted) {
      if (this.shouldDeferHydration()) {
        // 部分水合：先把 SSR 内容接上（shadow root / 样式），但暂不接管节点，
        // 等调度器调用 hydrate() 再执行首屏渲染。
        this._bindTrackedSignals();
        this.__fcOnMount();
        this.renderRoot = this.createRenderRoot();
        this.adoptStyles();
        return;
      }

      this._bindTrackedSignals();
      this.__fcOnMount();
      this._mountSurface();
    }

    this._autoTrackSignalsNotDrivenByRuntimeUpdaters();
    this.requestUpdate();
  }

  /** 是否延后首次挂载（`manual` 组件，或 SSR island 宿主）。 */ protected shouldDeferHydration(): boolean {
    const ctor = this.constructor as typeof ReactiveElement;
    // `<Child client:visible />` 渲染出的宿主带 `data-lania-island`，
    // 这类元素统一等 `hydrateIslands()` 调度，避免一升级就整块水合。
    const isIsland = this.hasAttribute('data-lania-island');
    return (
      (ctor.hydration === 'manual' || isIsland) && !this._hydrationRequested
    );
  }

  /** 手动触发首次挂载；已挂载时为空操作。 */
  hydrate(): void {
    this._hydrationRequested = true;

    if (!this._isConnectedFlag || this._isMounted) {
      return;
    }

    this._mountSurface();
    this.requestUpdate();
  }

  /** 当前是否已经完成首次挂载（SSR 的 `manual` 组件在 hydrate 前为 false）。 */
  get isHydrated(): boolean {
    return this._isMounted;
  }

  private _mountSurface(): void {
    this.renderRoot = this.createRenderRoot();
    this.adoptStyles();
    this._renderAndMount();
    this._isMounted = true;
  }

  /**
   * dev + HMR 下的 attribute 兜底。
   *
   * `observedAttributes` 在 `customElements.define()` 时已被浏览器固化，
   * HMR 给组件新增 attribute 时浏览器不会回调；这里用 MutationObserver 补上，
   * 只处理“当前 observedAttributes 未覆盖”的属性，避免与原生回调重复。
   */
  private _syncDevAttributeObserver(): void {
    if (typeof MutationObserver !== 'function' || !isDevEnvironment()) {
      return;
    }

    if (!isComponentHmrEnabled()) {
      return;
    }

    if (this._devAttributeObserver) {
      return;
    }

    const observed = new Set(
      (
        (this.constructor as typeof ReactiveElement).observedAttributes ?? []
      ).map((name) => name.toLowerCase())
    );

    this._devAttributeObserver = new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName;
        if (!name || observed.has(name.toLowerCase())) {
          continue;
        }

        this.attributeChangedCallback(
          name,
          record.oldValue,
          this.getAttribute(name)
        );
      }
    });

    this._devAttributeObserver.observe(this, {
      attributes: true,
      attributeOldValue: true,
    });
  }

  /**
   * 开发态专用：保留实例字段（signal / store / props）重新执行首屏挂载。
   *
   * HMR 只替换原型方法，构造器不会重跑，因此这里手动清理挂载期产物
   * （slots / updaters / 渲染节点），再用新模板重新挂载一次。
   * dev 产物把 setup 收进 `__laniaSetup()`，因此新增的 setup 状态也能在这里补建。
   */
  __laniaHmrRemount(): void {
    if (!this._isConnectedFlag) {
      return;
    }

    this._unbindTrackedSignals();
    this._trackedSignals.clear();
    this._slots = [];
    this._updaters = [];
    this._runtimeUpdaters = [];
    this._slotTable = new SlotTable();
    this._changedProps.clear();
    this._autoTrackDone = false;
    this._forceRuntimeUpdaterFlush = false;
    this._updateRequested = false;

    // 旧字段先留一份快照：setup 重跑会重建 signal，值需要按字段名回填。
    const setup = (this as { __laniaSetup?: () => void }).__laniaSetup;

    if (typeof setup === 'function') {
      // setup 重跑会重建实例 props，用 getter 保证 `bindProps()` / `bindHandlers()`
      // 在本次重跑中读到的是最新快照。
      const props = (this as { props?: object }).props;

      if (props) {
        withComponentProps(
          () => (this as { props?: object }).props ?? props,
          () => setup.call(this)
        );
      } else {
        setup.call(this);
      }
    }

    const root = this.renderRoot as Node & { replaceChildren?: () => void };
    if (typeof root.replaceChildren === 'function') {
      root.replaceChildren();
    } else {
      while (root.firstChild) {
        root.removeChild(root.firstChild);
      }
    }

    this._isMounted = false;
    this._bindTrackedSignals();
    this._mountSurface();
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
    this._devAttributeObserver?.disconnect();
    this._devAttributeObserver = undefined;
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
    const declaredEmits = (this.constructor as typeof ReactiveElement).emits;
    if (declaredEmits && !declaredEmits.includes(name)) {
      warning(
        `Undeclared emit "${name}" on <${
          (this.constructor as { tagName?: string }).tagName ??
          this.tagName.toLowerCase()
        }>. Add it to defineComponent({ emits: [...] }).`
      );
    }
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
      // light 模式下 SSR 的内联样式就在宿主里，登记后才不会在 hydration 时重复注入。
      registerAppliedStyleTexts(this);
      return this;
    }

    // SSR 输出了 `<template shadowrootmode>` 时优先接管它，
    // 这样 hydration 复用的是服务端已经生成的 shadow DOM，而不是重建一份。
    return (
      attachDeclarativeShadowRoot(this) ??
      this.shadowRoot ??
      this.attachShadow({ mode: 'open' })
    );
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

    // effect 语义要求挂载后先执行一次，否则像表单值这类"只写不读"的副作用永远不会落地。
    if ((updater as { kind?: unknown }).kind === 'effect') {
      updater.dirty = true;
    }

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
      const forceStructuralPass = this._forceRuntimeUpdaterFlush;

      for (const updater of this._runtimeUpdaters) {
        let shouldRun = updater.dirty;
        const slots = updater.slots;

        // 强制轮只补跑条件槽；普通绑定槽已经在 signal 通知时精确执行过。
        if (!shouldRun && forceStructuralPass) {
          for (let index = 0; index < slots.length; index += 1) {
            if (slots[index].type === 'if') {
              shouldRun = true;
              break;
            }
          }
        }

        if (!shouldRun) {
          for (let index = 0; index < slots.length; index += 1) {
            if (this._slotTable.isDirty(slots[index].index)) {
              shouldRun = true;
              break;
            }
          }
        }

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

    // 已经被 runtime updater 订阅的 signal 由各自 updater 精确驱动；
    // 再挂组件级 requestUpdate 会让每次 set 同时走两条更新路径（重复执行）。
    const driven = new Set<Signal<any>>();
    for (const updater of this._runtimeUpdaters) {
      for (const signal of updater.deps) {
        driven.add(signal);
      }
    }

    for (const key of Object.keys(this)) {
      const value = (this as unknown as Record<string, unknown>)[key];
      if (
        value != null &&
        typeof value === 'object' &&
        typeof (value as { set?: unknown }).set === 'function' &&
        (() => {
          const updaters = (value as { updaters?: unknown }).updaters as
            { add?: unknown; delete?: unknown } | undefined;
          // Signal.updaters is a Set-like CompactJobSet at runtime, so use duck typing.
          return (
            updaters != null &&
            typeof updaters.add === 'function' &&
            typeof updaters.delete === 'function'
          );
        })()
      ) {
        const signal = value as Signal<any>;
        if (driven.has(signal)) {
          continue;
        }
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
