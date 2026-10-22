/**
 * 解析 KeepAlive 运行时选项与 block payload。
 *
 * 这里负责把共享 cache payload、metadata hook 以及直接传入的运行时来源合并成
 * 统一的 `KeepAliveOptions`，供 JSX/runtime/slot 三条路径共用。
 *
 * 解析顺序上遵循两个原则：
 * - “来源收敛”先于“字段归一化”，即先判断来自 payload、block 还是直接 runtime source；
 * - “后读到的非空值优先生效”，便于不同入口在不复制整份配置的情况下做局部覆盖。
 */
import { isCachePayload } from '@lania-v/shared';
import {
  type KeepAliveBlockSource,
  type KeepAliveBlockKind,
  type KeepAliveKeyPattern,
  type KeepAliveOptions,
  type KeepAliveRuntimeSource,
  type ResolvedKeepAliveBlock,
} from '../types';

// include/exclude 可接受正则或白名单数组，空值视为全部命中。
export const matchesKeyPattern = (
  pattern: KeepAliveKeyPattern,
  key: string
): boolean => {
  if (!pattern) {
    return true;
  }

  if (pattern instanceof RegExp) {
    return pattern.test(key);
  }

  return Array.isArray(pattern) ? pattern.includes(key) : false;
};

export const isKeepAliveCacheable = (
  key: string | null,
  include: KeepAliveKeyPattern,
  exclude?: KeepAliveKeyPattern
): key is string => {
  return Boolean(
    key &&
    matchesKeyPattern(include, key) &&
    !(exclude ? matchesKeyPattern(exclude, key) : false)
  );
};

export const resolveKeepAliveKey = (keySource: unknown): string | null => {
  return keySource == null ? null : String(keySource);
};

export const resolveKeepAliveLimit = (value: unknown): number => {
  return typeof value === 'number'
    ? value
    : Number(value ?? Number.POSITIVE_INFINITY);
};

const isRuntimeRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const readLifecycleHook = <
  TKey extends 'onActivate' | 'onDeactivate' | 'onCache' | 'onEvict',
>(
  record: Record<string, unknown>,
  key: TKey
): KeepAliveOptions<unknown>[TKey] => {
  const value = record[key];
  return typeof value === 'function'
    ? (value as KeepAliveOptions<unknown>[TKey])
    : undefined;
};

const readRuntimeValue = (
  sources: ReadonlyArray<KeepAliveRuntimeSource | null | undefined>,
  key: keyof KeepAliveRuntimeSource
): unknown => {
  for (const source of sources) {
    const value = source?.[key];
    if (value !== undefined && value !== null) {
      // 解析器把“第一个非空命中”视为最终值，因此调用方可通过 sources 顺序表达覆盖优先级。
      return value;
    }
  }

  return undefined;
};

// 从共享 payload 中拆出 cache 配置和生命周期 metadata，供后续合并。
export const readRuntimeContract = (source: {
  payload?: unknown;
}): {
  cache: KeepAliveRuntimeSource | null;
  metadata: KeepAliveRuntimeSource | null;
} => {
  if (!isCachePayload(source.payload)) {
    return {
      cache: null,
      metadata: null,
    };
  }

  const metadata = isRuntimeRecord(source.payload.metadata)
    ? source.payload.metadata
    : null;

  return {
    cache: {
      scope: source.payload.cache.scope,
      key: source.payload.cache.key,
      include: source.payload.cache.include,
      exclude: source.payload.cache.exclude,
      max: source.payload.cache.max,
    },
    metadata: metadata
      ? {
          onActivate: readLifecycleHook(metadata, 'onActivate'),
          onDeactivate: readLifecycleHook(metadata, 'onDeactivate'),
          onCache: readLifecycleHook(metadata, 'onCache'),
          onEvict: readLifecycleHook(metadata, 'onEvict'),
        }
      : null,
  };
};

// 只要 contractCache 或 contractHooks 任一存在，就认为当前 block 受共享协议驱动。
export const resolveOptionsFromContract = <TValue>(options: {
  contractCache: KeepAliveRuntimeSource | null;
  contractHooks: KeepAliveRuntimeSource | null;
  defaultScope?: string;
}): {
  runtimeOptions: KeepAliveOptions<TValue>;
  runtimeSourceKind: KeepAliveBlockKind;
} => {
  const { contractCache, contractHooks, defaultScope = 'default' } = options;
  const hasContractRuntimeSource =
    contractCache !== null || contractHooks !== null;

  if (!hasContractRuntimeSource) {
    throw new Error(
      'KeepAlive runtime execution requires a shared cache payload.'
    );
  }

  return {
    runtimeSourceKind: 'contract',
    runtimeOptions: resolveOptionsWithScope<TValue>(
      defaultScope,
      contractCache ?? undefined,
      contractHooks ?? undefined
    ),
  };
};

export const resolveOptionsFromPayload = <TValue>(options: {
  payload: unknown;
  contractHookAdapter?: (
    hooks: KeepAliveRuntimeSource | null
  ) => KeepAliveRuntimeSource | null;
  defaultScope?: string;
}): {
  runtimeOptions: KeepAliveOptions<TValue>;
  runtimeSourceKind: KeepAliveBlockKind;
} => {
  const { payload, contractHookAdapter, defaultScope } = options;
  const { cache, metadata } = readRuntimeContract({ payload });
  return resolveOptionsFromContract<TValue>({
    contractCache: cache,
    // payload 中的 metadata hook 允许在这里做一次入口适配，再并入通用 contract 解析流程。
    contractHooks: contractHookAdapter
      ? contractHookAdapter(metadata)
      : metadata,
    defaultScope,
  });
};

export const resolveOptionsFromBlock = <TValue, TBindings>(
  source: KeepAliveBlockSource<TBindings>,
  options: {
    contractHookAdapter?: (
      hooks: KeepAliveRuntimeSource | null
    ) => KeepAliveRuntimeSource | null;
    defaultScope?: string;
  } = {}
): {
  runtimeOptions: KeepAliveOptions<TValue>;
  runtimeSourceKind: KeepAliveBlockKind;
} => {
  const { contractHookAdapter, defaultScope } = options;
  return resolveOptionsFromPayload<TValue>({
    payload: source.payload,
    contractHookAdapter,
    defaultScope,
  });
};

export const resolveKeepAliveOptions = <TValue>(
  ...sources: Array<KeepAliveRuntimeSource | null | undefined>
): KeepAliveOptions<TValue> => {
  return resolveOptionsWithScope<TValue>('default', ...sources);
};

// 多个来源按先后顺序覆盖，最终输出 runtime 真正消费的规范化选项。
export const resolveOptionsWithScope = <TValue>(
  defaultScope: string,
  ...sources: Array<KeepAliveRuntimeSource | null | undefined>
): KeepAliveOptions<TValue> => {
  const normalizedSources = sources as ReadonlyArray<
    KeepAliveRuntimeSource | null | undefined
  >;

  return {
    scope: String(readRuntimeValue(normalizedSources, 'scope') ?? defaultScope),
    key: resolveKeepAliveKey(readRuntimeValue(normalizedSources, 'key')),
    include: readRuntimeValue(
      normalizedSources,
      'include'
    ) as KeepAliveKeyPattern,
    exclude: readRuntimeValue(
      normalizedSources,
      'exclude'
    ) as KeepAliveKeyPattern,
    max: resolveKeepAliveLimit(readRuntimeValue(normalizedSources, 'max')),
    onActivate: readRuntimeValue(normalizedSources, 'onActivate') as
      ((value: TValue, key: string, reused: boolean) => void) | undefined,
    onDeactivate: readRuntimeValue(normalizedSources, 'onDeactivate') as
      ((value: TValue, key: string) => void) | undefined,
    onCache: readRuntimeValue(normalizedSources, 'onCache') as
      ((value: TValue, key: string) => void) | undefined,
    onEvict: readRuntimeValue(normalizedSources, 'onEvict') as
      ((value: TValue, key: string) => void) | undefined,
  };
};

// block payload 是模板/slot 路径进入 keepalive runtime 的标准入口。
export const resolveBlockPayload = <TValue, TBindings>(
  value: unknown
): ResolvedKeepAliveBlock<TValue, TBindings> | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as Partial<KeepAliveBlockSource<TBindings>>;
  if (payload.__lania_keepalive !== 'block') {
    return null;
  }

  const blockPayload = payload as KeepAliveBlockSource<TBindings>;
  if (!isCachePayload(blockPayload.payload)) {
    return null;
  }
  const resolved = resolveOptionsFromBlock<TValue, TBindings>(blockPayload, {
    // block/slot 路径刻意使用独立默认 scope，避免与直接 JSX 执行共享同一隐式缓存空间。
    // Slot/block consumers should not share the same implicit default scope with
    // direct `jsx-runtime` execution. This avoids cross-path cache interference.
    defaultScope: 'slot:default',
  });

  return {
    payload: blockPayload,
    runtimeSourceKind: resolved.runtimeSourceKind,
    runtimeOptions: resolved.runtimeOptions,
    bindings: blockPayload.bindings ?? [],
  };
};
