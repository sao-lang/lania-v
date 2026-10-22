/**
 * 内置指令与工具函数。
 *
 * - `bind/model` 主要面向表单元素；
 * - `DirectiveSlot` 提供 mounted/updated/unmounted 生命周期封装，避免重复样板代码。
 */

export type ModelModifier =
  | 'trim'
  | 'number'
  | 'lazy'
  | 'checked'
  | 'boolean'
  | 'empty'
  | 'debounce'
  | (string & {});

export interface ModelModifierOptions {
  /** `trim` / `number` / `lazy` 等基础修饰符。 */
  trim?: boolean;
  number?: boolean;
  lazy?: boolean;
  /** 复选框：等价于 `prop: 'checked'`。 */
  checked?: boolean;
  /** 把复选状态读成布尔值写回。 */
  boolean?: boolean;
  /** 空字符串写回 `undefined`。 */
  empty?: boolean;
  /** 输入停止后再回写。 */
  debounce?: boolean;
  /** `debounce` 的等待时间，默认 16ms。 */
  debounceMs?: number;
  [modifier: string]: boolean | number | undefined;
}

export interface ModelTargetBinding<T = unknown> {
  target: (() => T) & { set(value: T): unknown };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: ModelModifierOptions;
}

export interface ModelSourceBinding<T = unknown> {
  source: {
    get: () => T;
    set: (value: T) => unknown;
  };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: ModelModifierOptions;
}

export type ModelBinding<T = unknown> =
  ModelTargetBinding<T> | ModelSourceBinding<T>;

export interface DirectiveDef<
  T = unknown,
  TElement extends HTMLElement = HTMLElement,
> {
  mounted?(el: TElement, value: T): void;
  updated?(el: TElement, value: T, oldValue: T | undefined): void;
  unmounted?(el: TElement): void;
}

const directiveRegistry = new Map<string, DirectiveDef<unknown, HTMLElement>>();

export const registerDirective = <T = unknown>(
  name: string,
  directive: DirectiveDef<T>
): void => {
  directiveRegistry.set(name, directive as DirectiveDef<unknown, HTMLElement>);
};

export const resolveDirective = <T = unknown>(
  name: string
): DirectiveDef<T> | undefined => {
  return directiveRegistry.get(name) as DirectiveDef<T> | undefined;
};

export const clearDirectiveRegistry = (): void => {
  directiveRegistry.clear();
};

export const applyBoundValue = (
  target:
    HTMLElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  prop: string,
  value: unknown
): void => {
  // 这里直接写宿主属性而不是 attribute，适合 value/checked 等表单实时状态。
  const record = target as unknown as Record<string, unknown>;
  record[prop] = value;
};

export const normalizeModelValue = (
  value: string,
  modifiers: readonly ModelModifier[]
): string | number | undefined => {
  if (modifiers.length === 0) {
    return value;
  }

  let next: string | number | undefined = value;

  if (modifiers.includes('trim') && typeof next === 'string') {
    next = next.trim();
  }

  if (
    typeof next === 'string' &&
    next.length === 0 &&
    modifiers.includes('empty')
  ) {
    return undefined;
  }

  if (modifiers.includes('number')) {
    next = Number(next);
  }

  return next;
};

/** 把元素上的原始值转换成本修饰符组需要的写入形态（含布尔/空值语义）。 */
const normalizeModelInputValue = (
  rawValue: unknown,
  modifiers: readonly ModelModifier[]
): unknown => {
  if (modifiers.includes('boolean') || modifiers.includes('checked')) {
    return Boolean(rawValue);
  }

  if (typeof rawValue === 'string') {
    return normalizeModelValue(rawValue, modifiers);
  }

  if (rawValue == null && modifiers.includes('empty')) {
    return undefined;
  }

  return rawValue;
};

export const DEFAULT_MODEL_DEBOUNCE_MS = 16;

export interface ModelEventHandlerOptions {
  debounceMs?: number;
}

/**
 * 创建 model 回写处理器。
 *
 * 修饰符都集中在回写侧：`trim` / `number` / `empty` 归一化取值，
 * `debounce` 延迟写回，`checked` / `boolean` 按布尔语义读取。
 */
export const createModelEventHandler = <T>(
  target: { set(value: T): unknown },
  modifiers: readonly ModelModifier[] = [],
  prop = 'value',
  options: ModelEventHandlerOptions = {}
): ((event: Event) => void) => {
  const needsDebounce = modifiers.includes('debounce');
  const debounceMs = options.debounceMs ?? DEFAULT_MODEL_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const commit = (event: Event): void => {
    const source = event.target as Record<string, unknown> | null;
    const rawValue = source?.[prop];

    if (modifiers.length === 0) {
      target.set((rawValue === undefined ? '' : rawValue) as T);
      return;
    }

    target.set(normalizeModelInputValue(rawValue, modifiers) as T);
  };

  if (!needsDebounce) {
    return commit;
  }

  return (event: Event) => {
    if (timer) {
      clearTimeout(timer);
    }

    // 事件对象在定时器回调里可能已被复用/失效，先把目标值取出来。
    const source = event.target as Record<string, unknown> | null;
    const snapshot = { target: { [prop]: source?.[prop] } } as unknown as Event;

    timer = setTimeout(() => {
      timer = null;
      commit(snapshot);
    }, debounceMs);
  };
};

export const readModelModifiers = (
  binding: Pick<ModelBinding, 'modifiers'> | null | undefined
): ModelModifier[] => {
  if (!binding?.modifiers) {
    return [];
  }

  const modifiers = (
    [
      'trim',
      'number',
      'lazy',
      'checked',
      'boolean',
      'empty',
      'debounce',
    ] as const
  ).filter((name) => binding.modifiers?.[name] === true) as ModelModifier[];
  const debounceMs = readModelDebounceMs(binding);

  // `debounceMs` 随修饰符一起透传，运行时才能据此确定等待时间。
  return debounceMs === undefined
    ? modifiers
    : [...modifiers, `debounceMs:${debounceMs}`];
};

/** 读取 `debounce` 自定义等待时间，未配置时返回 undefined。 */
export const readModelDebounceMs = (
  binding: Pick<ModelBinding, 'modifiers'> | null | undefined
): number | undefined => {
  const value = binding?.modifiers?.debounceMs;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
};

/** 从编译期静态修饰符列表（形如 `['debounce', 'debounceMs:120']`）解析等待时间。 */
export const parseModelDebounceModifier = (
  modifiers: readonly ModelModifier[]
): number | undefined => {
  for (const modifier of modifiers) {
    const match = /^debounceMs:(\d+(?:\.\d+)?)$/.exec(modifier);

    if (match) {
      return Number(match[1]);
    }
  }

  return undefined;
};

export class DirectiveSlot<TValue, TElement extends HTMLElement = HTMLElement> {
  private initialized = false;
  private previousValue: TValue | undefined;

  constructor(
    public readonly node: TElement,
    public readonly def: DirectiveDef<TValue, TElement>,
    public readonly index: number
  ) {}

  write(value: TValue): void {
    if (!this.initialized) {
      this.initialized = true;
      // 首次写入映射到 mounted，后续同一 slot 复用时再走 updated。
      this.def.mounted?.(this.node, value);
    } else {
      this.def.updated?.(this.node, value, this.previousValue);
    }

    this.previousValue = value;
  }

  destroy(): void {
    if (!this.initialized) {
      return;
    }

    this.def.unmounted?.(this.node);
    this.initialized = false;
    this.previousValue = undefined;
  }
}
