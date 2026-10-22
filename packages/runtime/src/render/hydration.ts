/**
 * 部分水合（islands）协议。
 *
 * 服务端用 `renderIsland()` 输出带 DSD 的自定义元素，并附上水合优先级与序列化 props；
 * 客户端只把登记过的 island 交给 `hydrateIslands()`，其余 SSR 内容保持静态。
 *
 * 组件侧通过 `static hydration = 'manual'` 声明“等待调度器接管”，
 * 这样 SSR 内容不会被自定义元素的首次挂载覆盖掉。
 */
import { warning } from '../core/debug';
import { getComponentTagName } from '../component/host/function-component';
import { ssrRenderBlockSlot } from './ssr';
import {
  renderDeclarativeShadowComponent,
  renderLightComponent,
  type DeclarativeShadowComponentLike,
  type DeclarativeShadowComponentOptions,
} from './dsd';
import { ssrSerializeAttribute } from './ssr';

export const SSR_ISLAND_ATTRIBUTE = 'data-lania-island';
export const SSR_ISLAND_PROPS_ATTRIBUTE = 'data-lania-island-props';
export const SSR_ISLAND_ATTRIBUTE_NAME = 'data-lania-island-name';
export const SSR_HYDRATED_ATTRIBUTE = 'data-lania-hydrated';

export type IslandHydrationPriority =
  'eager' | 'idle' | 'visible' | 'interaction';

export interface SSRIslandOptions extends DeclarativeShadowComponentOptions {
  /** 水合优先级，默认 `eager`。 */
  priority?: IslandHydrationPriority;
  /** island 名称，客户端据此挑选组件；默认使用标签名。 */
  name?: string;
}

export interface SSRIslandRenderOptions extends SSRIslandOptions {
  /** 需要随 HTML 一起下发的 props（只支持可 JSON 序列化的值）。 */
  props?: Record<string, unknown>;
}

export interface IslandRecord {
  element: HTMLElement;
  name: string;
  priority: IslandHydrationPriority;
  props: Record<string, unknown>;
}

const HYDRATION_PRIORITIES: readonly IslandHydrationPriority[] = [
  'eager',
  'idle',
  'visible',
  'interaction',
];

const normalizePriority = (value: string | null): IslandHydrationPriority => {
  return HYDRATION_PRIORITIES.includes(value as IslandHydrationPriority)
    ? (value as IslandHydrationPriority)
    : 'eager';
};

/**
 * 序列化 island props。
 *
 * 函数与 symbol 无法跨网络传输，这里丢弃并在开发态提示一次，
 * 避免 hydration 后出现“props 悄悄丢了”的排查成本。
 */
export const serializeIslandProps = (
  props: Record<string, unknown> = {}
): string => {
  const dropped: string[] = [];

  const serialized = JSON.stringify(props, (key, value: unknown) => {
    if (typeof value === 'function' || typeof value === 'symbol') {
      dropped.push(key);
      return undefined;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    return value;
  });

  if (dropped.length > 0) {
    warning(
      `Island props contain non-serializable values and were dropped: ${dropped.join(', ')}.`
    );
  }

  return serialized ?? '{}';
};

export const parseIslandProps = (
  value: string | null
): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    warning('Failed to parse island props; falling back to an empty object.');
    return {};
  }
};

const appendAttributes = (
  attributes: Record<string, unknown> | string | undefined,
  extra: Record<string, unknown>
): Record<string, unknown> | string => {
  const extraText = Object.entries(extra)
    .map(([name, value]) => ssrSerializeAttribute(name, value))
    .join('');

  if (attributes == null) {
    return extra;
  }

  if (typeof attributes === 'string') {
    return `${attributes.trim()}${extraText}`;
  }

  return { ...attributes, ...extra };
};

/**
 * 输出一个 island 宿主元素。
 *
 * 与 `renderDeclarativeShadowComponent()` 的区别是额外写入水合元信息，
 * 客户端因此可以只挑需要的 island 接管；light 模式组件不会包 DSD 模板。
 */
export const renderIsland = (
  html: string,
  options: SSRIslandRenderOptions
): string => {
  const priority = options.priority ?? 'eager';
  const name = options.name ?? options.tagName;
  const attributes = appendAttributes(options.attributes, {
    [SSR_ISLAND_ATTRIBUTE]: priority,
    [SSR_ISLAND_ATTRIBUTE_NAME]: name,
    [SSR_ISLAND_PROPS_ATTRIBUTE]: serializeIslandProps(options.props),
  });

  if ((options.renderMode ?? 'shadow') === 'light') {
    return renderLightComponent(html, { ...options, attributes });
  }

  return renderDeclarativeShadowComponent(html, {
    ...options,
    attributes,
  });
};

/** 调用编译产物 `static render()` 并输出带 island 元信息的 DSD 元素。 */
export const renderToStringAsIsland = (
  component: DeclarativeShadowComponentLike,
  props: Record<string, unknown>,
  options: SSRIslandRenderOptions
): string => {
  if (typeof component.render !== 'function') {
    throw new TypeError(
      'renderToStringAsIsland() expects a compiled component with a static render() method.'
    );
  }

  return renderIsland(component.render(props), {
    ...options,
    props,
    styles: options.styles ?? component.styles,
  });
};

interface IslandComponentLike extends DeclarativeShadowComponentLike {
  renderMode?: 'shadow' | 'light';
}

/**
 * SSR：把一个组件渲染成 island 宿主元素。
 *
 * 编译产物里 `<Child client:visible />` 会落到这里：
 * - 子组件用**自己的** `static render()` 输出内容（因此是完整的 SSR，而不是空壳）；
 * - props 会被序列化进 `data-lania-island-props`，供客户端水合时回填；
 * - 函数 / symbol 等不可序列化的 props 会被丢弃并告警；
 * - 组件不可渲染时退回普通 block slot + 子模板 HTML。
 */
export const ssrRenderIslandSlot = (
  slotIndex: number,
  component: unknown,
  props: unknown,
  priority: string,
  fallbackHtml = ''
): string => {
  const renderable = component as IslandComponentLike | undefined;

  if (!renderable || typeof renderable.render !== 'function') {
    return ssrRenderBlockSlot(slotIndex, fallbackHtml, 'dynamic');
  }

  const propsRecord =
    props && typeof props === 'object'
      ? (props as Record<string, unknown>)
      : {};
  const tagName =
    getComponentTagName(renderable) ?? `lania-island-${slotIndex}`;
  const componentName =
    (renderable as { displayName?: string }).displayName ??
    (renderable as { name?: string }).name ??
    tagName;
  const html = renderIsland(renderable.render(propsRecord), {
    tagName,
    name: componentName,
    props: propsRecord,
    priority: priority as IslandHydrationPriority,
    styles: renderable.styles,
    renderMode: renderable.renderMode,
  });

  return ssrRenderBlockSlot(slotIndex, html, 'island');
};

/** 收集容器里所有尚未水合的 island。 */ export const collectIslands = (
  root: ParentNode
): IslandRecord[] => {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>(`[${SSR_ISLAND_ATTRIBUTE}]`)
  ).filter((element) => !element.hasAttribute(SSR_HYDRATED_ATTRIBUTE));

  return elements.map((element) => ({
    element,
    name:
      element.getAttribute(SSR_ISLAND_ATTRIBUTE_NAME) ??
      element.tagName.toLowerCase(),
    priority: normalizePriority(element.getAttribute(SSR_ISLAND_ATTRIBUTE)),
    props: parseIslandProps(element.getAttribute(SSR_ISLAND_PROPS_ATTRIBUTE)),
  }));
};

type IslandComponentTarget =
  | CustomElementConstructor
  | (() =>
      | CustomElementConstructor
      | void
      | Promise<CustomElementConstructor | void>);

export interface HydrateIslandsOptions {
  /** 搜索范围，默认整个 document。 */
  root?: ParentNode;
  /**
   * island 名称到组件的映射。
   *
   * 值为函数时按需调用，可返回组件构造器（用于动态 import），
   * 也可以直接在函数内完成 `customElements.define()`。
   */
  components?: Record<string, IslandComponentTarget>;
  /** 只处理这些优先级；默认全部。 */
  priorities?: readonly IslandHydrationPriority[];
  onHydrate?: (record: IslandRecord) => void;
  onError?: (error: unknown, record: IslandRecord) => void;
}

interface IslandElementLike extends HTMLElement {
  hydrate?: () => void;
}

/** 把序列化的 props 写回元素并触发组件挂载。 */
export const hydrateIslandElement = (record: IslandRecord): boolean => {
  const element = record.element as IslandElementLike;
  const declaredProps = (
    element.constructor as { __laniaPropNames?: readonly string[] }
  ).__laniaPropNames;

  for (const [key, value] of Object.entries(record.props)) {
    // 只回填组件真正声明的 prop；`children` 这类结构字段由 SSR 内容本身承载。
    if (declaredProps && !declaredProps.includes(key)) {
      continue;
    }

    (element as unknown as Record<string, unknown>)[key] = value;
  }

  element.removeAttribute(SSR_ISLAND_PROPS_ATTRIBUTE);

  if (typeof element.hydrate !== 'function') {
    // 组件还没升级（构造器未注册）时保留 island 标记，等注册后重试。
    return false;
  }

  element.hydrate();
  element.setAttribute(SSR_HYDRATED_ATTRIBUTE, '');
  return true;
};

const scheduleByPriority = (record: IslandRecord, run: () => void): void => {
  const { element, priority } = record;

  if (priority === 'idle') {
    const idle = (
      globalThis as { requestIdleCallback?: (cb: () => void) => number }
    ).requestIdleCallback;

    if (typeof idle === 'function') {
      idle(run);
      return;
    }

    setTimeout(run, 0);
    return;
  }

  if (priority === 'visible') {
    if (typeof IntersectionObserver !== 'function') {
      run();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        run();
      }
    });
    observer.observe(element);
    return;
  }

  if (priority === 'interaction') {
    const events = ['pointerdown', 'focusin', 'click'] as const;
    const trigger = (): void => {
      events.forEach((event) =>
        element.removeEventListener(event, trigger, true)
      );
      run();
    };

    events.forEach((event) =>
      element.addEventListener(event, trigger, { capture: true, once: true })
    );
    return;
  }

  run();
};

const resolveIslandConstructor = async (
  record: IslandRecord,
  components: HydrateIslandsOptions['components']
): Promise<void> => {
  const target = components?.[record.name];

  if (!target) {
    // 组件可能已经通过静态 import 注册过，交给升级流程判断。
    if (
      typeof customElements !== 'undefined' &&
      !customElements.get(record.element.tagName.toLowerCase())
    ) {
      warning(
        `Island "${record.name}" has no registered component; it stays static.`
      );
    }

    return;
  }

  if (
    typeof target === 'function' &&
    !(target.prototype instanceof HTMLElement)
  ) {
    await (target as () => unknown)();
  }

  if (typeof customElements !== 'undefined') {
    customElements.upgrade(record.element);
  }
};

/**
 * 按优先级水合容器里的 island。
 *
 * `eager` 会立即完成，其余优先级只注册触发器，函数本身随即返回。
 */
export const hydrateIslands = async (
  options: HydrateIslandsOptions = {}
): Promise<IslandRecord[]> => {
  const root = options.root ?? document;
  const priorities = options.priorities ?? HYDRATION_PRIORITIES;
  const records = collectIslands(root).filter((record) =>
    priorities.includes(record.priority)
  );
  const hydrated: IslandRecord[] = [];

  for (const record of records) {
    const run = (): void => {
      try {
        if (hydrateIslandElement(record)) {
          hydrated.push(record);
          options.onHydrate?.(record);
        }
      } catch (error) {
        options.onError?.(error, record);
      }
    };

    if (record.priority === 'eager') {
      await resolveIslandConstructor(record, options.components);
      run();
      continue;
    }

    // 非 eager island 的组件加载也等到触发器执行，避免拖慢首屏。
    scheduleByPriority(record, () => {
      void resolveIslandConstructor(record, options.components)
        .catch((error: unknown) => options.onError?.(error, record))
        .then(run);
    });
  }

  return hydrated;
};
