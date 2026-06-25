/**
 * 内置指令与工具函数。
 *
 * - `bind/model` 主要面向表单元素；
 * - `DirectiveSlot` 提供 mounted/updated/unmounted 生命周期封装，避免重复样板代码。
 */

export type ModelModifier = 'trim' | 'number' | 'lazy' | (string & {});

export interface ModelTargetBinding<T = unknown> {
  target: (() => T) & { set(value: T): unknown };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: {
    trim?: boolean;
    number?: boolean;
    lazy?: boolean;
  };
}

export interface ModelSourceBinding<T = unknown> {
  source: {
    get: () => T;
    set: (value: T) => unknown;
  };
  prop?: 'value' | 'checked' | 'selected';
  modifiers?: {
    trim?: boolean;
    number?: boolean;
    lazy?: boolean;
  };
}

export type ModelBinding<T = unknown> = ModelTargetBinding<T> | ModelSourceBinding<T>;

export interface DirectiveDef<T = unknown, TElement extends HTMLElement = HTMLElement> {
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

export const resolveDirective = <T = unknown>(name: string): DirectiveDef<T> | undefined => {
  return directiveRegistry.get(name) as DirectiveDef<T> | undefined;
};

export const clearDirectiveRegistry = (): void => {
  directiveRegistry.clear();
};

export const applyBoundValue = (
  target: HTMLElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
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
): string | number => {
  if (modifiers.length === 0) {
    return value;
  }

  let next: string | number = value;

  if (modifiers.includes('trim') && typeof next === 'string') {
    next = next.trim();
  }

  if (modifiers.includes('number')) {
    next = Number(next);
  }

  return next;
};

export const createModelEventHandler = <T>(
  target: { set(value: T): unknown },
  modifiers: readonly ModelModifier[] = [],
  prop = 'value'
): ((event: Event) => void) => {
  if (modifiers.length === 0) {
    return (event: Event) => {
      const source = event.target as Record<string, unknown> | null;
      target.set((source?.[prop] ?? '') as T);
    };
  }

  return (event: Event) => {
    const source = event.target as Record<string, unknown> | null;
    // 与编译期 `model` 约定对齐：从触发事件的目标元素读取 prop，再交给 signal/store 回写。
    const rawValue = source?.[prop];

    target.set(
      normalizeModelValue(
        typeof rawValue === 'string' ? rawValue : String(rawValue ?? ''),
        modifiers
      ) as T
    );
  };
};

export const readModelModifiers = (
  binding: Pick<ModelBinding, 'modifiers'> | null | undefined
): ModelModifier[] => {
  if (!binding?.modifiers) {
    return [];
  }

  return (['trim', 'number', 'lazy'] as const).filter((name) => binding.modifiers?.[name]);
};

export class DirectiveSlot<
  TValue,
  TElement extends HTMLElement = HTMLElement,
> {
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
