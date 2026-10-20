/**
 * 开发态组件热更新（HMR）状态保留。
 *
 * 自定义元素一旦 `customElements.define()` 就不能重新定义，因此 HMR 走“原型热替换”：
 * - 用新版本构造器的原型方法覆盖已注册构造器；
 * - 对页面上已有实例触发一次“保留字段的重新挂载”（`__laniaHmrRemount()`）；
 * - 只有实例不支持重新挂载时，才退化成“重建节点 + 迁移状态”。
 *
 * 语义边界：实例字段（signal / store / props）在热替换中保留，
 * 因此同一实例上的交互状态不会丢；但构造器不会重跑，
 * 新增或重命名的 setup 状态需要整页刷新才会出现。
 */
import type {
  HydrationStrategy,
  RenderMode,
} from '../component/host/reactive-element';

type SignalLike = {
  value?: unknown;
  peek?: () => unknown;
  set?: unknown;
  setValue?: (value: unknown) => void;
};

/** 编译产物构造器上会被 HMR 同步的静态字段。 */
export interface HmrComponentConstructor extends CustomElementConstructor {
  tagName?: string;
  displayName?: string;
  styles?: unknown;
  propOptions?: unknown;
  emits?: readonly string[];
  handlerKeys?: readonly string[];
  formAssociated?: boolean;
  renderMode?: RenderMode;
  hydration?: HydrationStrategy;
}

export interface HmrComponentElement extends HTMLElement {
  __laniaHmrRemount?: () => void;
  isHydrated?: boolean;
}

const HMR_STATIC_KEYS = [
  'tagName',
  'displayName',
  'styles',
  'propOptions',
  'emits',
  'handlerKeys',
  'formAssociated',
  'renderMode',
  'hydration',
] as const;

/** 挂载期由基类维护的字段，不属于用户状态，迁移时跳过。 */
const INTERNAL_STATE_KEYS = new Set([
  'props',
  '_slots',
  '_updaters',
  '_runtimeUpdaters',
  '_slotTable',
  '_dirty',
  '_scheduler',
  '_isMounted',
  '_isConnectedFlag',
  '_hasUpdated',
  '_changedProps',
  '_updateRequested',
  '_forceRuntimeUpdaterFlush',
  '_autoTrackDone',
  'renderRoot',
]);

let hmrEnabled = false;

/** 是否已开启组件 HMR（由 Vite 插件在 dev 模块里自动调用）。 */
export const isComponentHmrEnabled = (): boolean => hmrEnabled;

/** 开启组件 HMR；重复调用是幂等的。 */
export const installComponentHmr = (): void => {
  hmrEnabled = true;
};

/** 关闭组件 HMR（测试与特殊宿主环境使用）。 */
export const uninstallComponentHmr = (): void => {
  hmrEnabled = false;
};

const isSignalLike = (value: unknown): value is SignalLike => {
  // signal 句柄现在是对象形态（`.value` + `.set`），不再是可调用函数。
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as SignalLike).set === 'function' &&
    typeof (value as SignalLike).peek === 'function'
  );
};

/**
 * 采集实例上可迁移的状态。
 *
 * signal 取当前值（恢复时通过 `setValue` 写回，不触发 updater 语义），
 * 其余非函数字段直接按值复制。
 */
export const captureComponentState = (
  element: HTMLElement
): Record<string, unknown> => {
  const state: Record<string, unknown> = {};

  for (const key of Object.keys(element)) {
    if (INTERNAL_STATE_KEYS.has(key)) {
      continue;
    }

    const value = (element as unknown as Record<string, unknown>)[key];

    if (isSignalLike(value)) {
      state[key] = value.peek?.();
      continue;
    }

    if (typeof value !== 'function') {
      state[key] = value;
    }
  }

  return state;
};

/** 把采集到的状态写回实例。 */
export const restoreComponentState = (
  element: HTMLElement,
  state: Record<string, unknown>
): void => {
  const target = element as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(state)) {
    // 新版实现里已不存在的字段（重命名 / 删除）直接丢弃，避免留下幽灵状态。
    if (!(key in target)) {
      continue;
    }

    const current = target[key];

    if (isSignalLike(current)) {
      if (typeof current.setValue === 'function') {
        current.setValue(value);
      }
      continue;
    }

    target[key] = value;
  }
};

const patchPrototype = (
  previous: HmrComponentConstructor,
  next: HmrComponentConstructor
): void => {
  const previousPrototype = previous.prototype as object;
  const nextPrototype = next.prototype as object;

  for (const key of Object.getOwnPropertyNames(nextPrototype)) {
    if (key === 'constructor') {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(nextPrototype, key);
    if (descriptor) {
      Object.defineProperty(previousPrototype, key, descriptor);
    }
  }
};

const patchStatics = (
  previous: HmrComponentConstructor,
  next: HmrComponentConstructor
): void => {
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;

  for (const key of HMR_STATIC_KEYS) {
    const value = nextRecord[key];

    if (value !== undefined) {
      previousRecord[key] = value;
    }
  }
};

/**
 * 把一个新版本构造器热替换到已注册的标签上。
 *
 * 返回被重新挂载的实例数量；标签未注册时返回 `0`（调用方应改为常规注册）。
 */
export const applyComponentHmrUpdate = (
  tagName: string,
  next: HmrComponentConstructor
): number => {
  if (typeof customElements === 'undefined') {
    return 0;
  }

  const previous = customElements.get(tagName) as
    | HmrComponentConstructor
    | undefined;

  if (!previous || previous === next) {
    return 0;
  }

  patchPrototype(previous, next);
  patchStatics(previous, next);

  const instances = Array.from(
    document.querySelectorAll<HmrComponentElement>(tagName)
  );
  let updated = 0;

  for (const element of instances) {
    if (typeof element.__laniaHmrRemount === 'function') {
      // setup 在 dev 产物里会重跑，因此先取快照再回填，保持交互状态。
      const state = captureComponentState(element);
      element.__laniaHmrRemount();
      restoreComponentState(element, state);
      updated += 1;
      continue;
    }

    // 非 ReactiveElement 实现缺少重新挂载钩子，只能重建节点后再迁移状态。
    const state = captureComponentState(element);
    const replacement = document.createElement(tagName);

    for (const attribute of Array.from(element.attributes)) {
      replacement.setAttribute(attribute.name, attribute.value);
    }

    element.replaceWith(replacement);
    restoreComponentState(replacement, state);
    updated += 1;
  }

  return updated;
};
