/**
 * 编译期 prop 选项的运行时辅助。
 *
 * `.lania.tsx` 的 `defineComponent(fn, { props })` 会被编译成类上的
 * `static propOptions`，属性同步、反射和转换都复用这里的归一化逻辑。
 */
import { warning } from '../../core/debug';

export type PropTypeConstructor =
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor
  | ObjectConstructor
  | ArrayConstructor;

export interface PropConverter {
  from?: (value: string | null) => unknown;
  to?: (value: unknown) => string | null;
}

export interface PropOption {
  type?: PropTypeConstructor;
  /** `false` 表示不参与 attribute 同步；字符串表示自定义 attribute 名。 */
  attribute?: string | false;
  reflect?: boolean;
  /** 未传入值时的初始值；由编译产物在构造期读取。 */
  default?: unknown;
  converter?: PropConverter;
  validator?: (value: unknown) => boolean;
}

export type PropOptionInput = PropOption | PropTypeConstructor | boolean;
export type PropOptionsMap = Record<string, PropOptionInput>;

/** 编译产物上 `static __laniaOptions` 的形状。 */
export interface ComponentOptionsInput {
  props?: PropOptionsMap;
  emits?: readonly string[];
}

/**
 * 归一化 `defineComponent(fn, options)` 的 props 选项。
 *
 * 编译产物把选项原文留到运行时求值（`static propOptions = resolvePropOptions(...)`），
 * 这样选项里可以写任意表达式、引用 import，不再受“必须是字面量”限制。
 */
export const resolvePropOptions = (
  input: PropOptionsMap | undefined | null
): PropOptionsMap | undefined => {
  if (!input) {
    return undefined;
  }

  const normalized: PropOptionsMap = {};

  for (const [name, option] of Object.entries(input)) {
    normalized[name] = normalizePropOption(option);
  }

  return normalized;
};

/** 由 props 选项推导 `observedAttributes`（属性名按 kebab-case 兜底）。 */
export const resolveObservedAttributes = (
  propOptions: PropOptionsMap | undefined | null,
  propNames: readonly string[]
): string[] => {
  const attributes: string[] = [];

  for (const name of propNames) {
    const attributeName = resolvePropAttributeName(name, propOptions?.[name]);

    if (attributeName) {
      attributes.push(attributeName);
    }
  }

  return attributes;
};

/**
 * 计算 prop signal 的初始值。
 *
 * 选项里的 `default` 优先于类型推导出的初始值；`default` 缺失时原样返回 `fallback`。
 */
export const resolvePropInitialValue = (
  component: object,
  name: string,
  fallback: unknown
): unknown => {
  const propOptions = (component.constructor as { propOptions?: PropOptionsMap })
    .propOptions;
  const option = propOptions?.[name];

  if (option === undefined) {
    return fallback;
  }

  const normalized = normalizePropOption(option);

  return 'default' in normalized ? normalized.default : fallback;
};

/**
 * 首轮挂载后把 `reflect: true` 的 prop 写回 attribute。
 *
 * 反射名单不再固化在编译产物里，而是运行时按 `static propOptions` 遍历，
 * 因此新增/修改选项不需要编译器感知。
 */
/**
 * 读取编译产物声明的 prop 名单。
 *
 * 名单来自 props 类型，是编译期已知的；运行时只拿它做 attribute 映射与首轮反射。
 */
const resolvePropNames = (
  component: object,
  fallbackSource?: PropOptionsMap
): readonly string[] => {
  const declared = (component.constructor as { __laniaPropNames?: readonly string[] })
    .__laniaPropNames;

  if (declared) {
    return declared;
  }

  return fallbackSource ? Object.keys(fallbackSource) : [];
};

export const reflectInitialProps = (component: Element): void => {
  const propOptions = (component.constructor as { propOptions?: PropOptionsMap })
    .propOptions;

  if (!propOptions) {
    return;
  }

  for (const name of resolvePropNames(component, propOptions)) {
    const option = propOptions[name];
    const normalized = normalizePropOption(option);

    if (!normalized.reflect) {
      continue;
    }

    const value = (component as unknown as Record<string, unknown>)[name];
    reflectPropAttribute(component, name, value, option);
  }
};

export const normalizePropOption = (
  option: PropOptionInput | undefined
): PropOption => {
  if (option === undefined || option === true) {
    return {};
  }
  if (option === false) {
    return { attribute: false };
  }
  if (typeof option === 'function') {
    return { type: option };
  }
  return option;
};

const toKebabCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

export const resolvePropAttributeName = (
  name: string,
  option: PropOptionInput | undefined
): string | null => {
  const normalized = normalizePropOption(option);
  if (normalized.attribute === false) {
    return null;
  }
  return typeof normalized.attribute === 'string'
    ? normalized.attribute
    : toKebabCase(name);
};

const parseByType = (
  type: PropTypeConstructor | undefined,
  value: string | null
): unknown => {
  switch (type) {
    case Number:
      return value === null ? undefined : Number(value);
    case Boolean:
      return value !== null && value !== 'false';
    case Object:
    case Array:
      return value === null ? undefined : JSON.parse(value);
    case String:
    default:
      return value ?? undefined;
  }
};

/** attribute -> prop 值。 */
export const parsePropAttributeValue = (
  option: PropOptionInput | undefined,
  value: string | null
): unknown => {
  const normalized = normalizePropOption(option);
  if (normalized.converter?.from) {
    return normalized.converter.from(value);
  }
  return parseByType(normalized.type, value);
};

/** prop 值 -> attribute 字符串；返回 `null` 表示移除 attribute。 */
export const serializePropAttributeValue = (
  option: PropOptionInput | undefined,
  value: unknown
): string | null => {
  const normalized = normalizePropOption(option);
  if (normalized.converter?.to) {
    return normalized.converter.to(value);
  }
  if (value === undefined || value === null) {
    return null;
  }
  if (normalized.type === Boolean) {
    return String(Boolean(value));
  }
  if (normalized.type === Object || normalized.type === Array) {
    return JSON.stringify(value);
  }
  return String(value);
};

/**
 * 按 `reflect: true` 把 prop 写回 attribute。
 *
 * 先比较当前 attribute，避免 attributeChangedCallback -> setter -> reflect
 * 形成无意义的重复写入。
 */
export const reflectPropAttribute = (
  element: Element,
  name: string,
  value: unknown,
  option: PropOptionInput | undefined
): void => {
  const normalized = normalizePropOption(option);
  if (!normalized.reflect) {
    return;
  }
  const attributeName = resolvePropAttributeName(name, normalized);
  if (!attributeName) {
    return;
  }
  const nextValue = serializePropAttributeValue(normalized, value);
  if (nextValue === null) {
    if (element.hasAttribute(attributeName)) {
      element.removeAttribute(attributeName);
    }
    return;
  }
  if (element.getAttribute(attributeName) !== nextValue) {
    element.setAttribute(attributeName, nextValue);
  }
};

/**
 * attribute -> prop 的统一入口。
 *
 * 编译产物只生成一句 `applyPropAttributes(this, name, newValue)`：
 * attribute 名单、类型转换与 converter 都由 `static propOptions` 决定。
 */
export const applyPropAttributes = (
  component: Element,
  attributeName: string,
  value: string | null
): void => {
  const propOptions = (component.constructor as { propOptions?: PropOptionsMap })
    .propOptions;

  for (const name of resolvePropNames(component, propOptions)) {
    const option = propOptions?.[name];

    if (resolvePropAttributeName(name, option) !== attributeName) {
      continue;
    }

    if (!(name in component)) {
      return;
    }

    (component as unknown as Record<string, unknown>)[name] =
      parsePropAttributeValue(option, value);
    return;
  }
};

/** 校验 prop 值；dev 环境只告警，不打断渲染。 */
export const validatePropValue = (
  componentName: string,
  name: string,
  value: unknown,
  option: PropOptionInput | undefined
): void => {
  const validator = normalizePropOption(option).validator;
  if (!validator || value === undefined) {
    return;
  }
  if (!validator(value)) {
    warning(`Invalid value for prop "${name}" on <${componentName}>.`);
  }
};
