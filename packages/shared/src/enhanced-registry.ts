/**
 * 增强组件注册表。
 *
 * 这个文件维护编译期与运行时共享的“增强组件元信息”：
 * 1. 哪些标签名属于框架保留增强组件；
 * 2. 每个组件会下沉到哪类 IR；
 * 3. SSR、Hydration、静态渲染模式和元数据属性的约束。
 *
 * 编译器解析 `<When>` / `<Each>` / `<Teleport>` 等语法糖时，
 * 会优先查询这里的注册表，再决定后续 lowering、诊断与运行时宿主策略。
 * 因此这里的常量表既是“标签白名单”，也是跨阶段协作时的统一事实来源。
 */
// 以稳定数组维护所有保留增强组件名，便于导出联合类型与遍历检查。
export const ENHANCED_COMPONENT_NAMES = [
  'When',
  'Then',
  'Else',
  'Switch',
  'Case',
  'Default',
  'Match',
  'Each',
  'Teleport',
  'Fragment',
  'Slot',
  'Dynamic',
  'KeepAlive',
  'Transition',
  'TransitionGroup',
  'LazyLoad',
  'ErrorBoundary',
  'Suspense',
  'Await',
  'Virtual',
  'Reach',
] as const;

export type EnhancedComponentName = (typeof ENHANCED_COMPONENT_NAMES)[number];
export type EnhancedWhenBranchComponentName = 'Then' | 'Else';
export type EnhancedSwitchBranchComponentName = 'Case' | 'Match' | 'Default';
export type EnhancedBranchComponentName =
  | EnhancedWhenBranchComponentName
  | EnhancedSwitchBranchComponentName;
export type EnhancedWhenBranchKind = 'truthy' | 'fallback';
// 这类组件 SSR 时只渲染子节点本身，不会额外留下结构包装壳。
export type StructuralChildrenOnlyEnhancedComponentName = 'Transition' | 'TransitionGroup';

// 组件类别主要用于编译层做语义分组与诊断提示。
export type EnhancedComponentCategory =
  | 'syntax'
  | 'structure'
  | 'structure-lifecycle'
  | 'boundary';

// IR kind 描述该增强组件最终会在编译流水线落到哪类中间表示。
export type EnhancedComponentIrKind =
  | 'passthrough'
  | 'IfIR'
  | 'ListIR'
  | 'DynamicIR'
  | 'TeleportIR'
  | 'KeepAliveIR'
  | 'TransitionIR'
  | 'BoundaryIR';

export type EnhancedRuntimeHostKind = 'none' | 'structural' | 'boundary';

// 静态渲染模式决定 SSR/静态输出时如何处理组件自身与其 children。
export type EnhancedStaticRenderMode = 'preserve' | 'flatten' | 'children-only';

export interface EnhancedComponentRegistryEntry<
  TName extends EnhancedComponentName = EnhancedComponentName,
> {
  // 这些字段组合起来描述“一个增强组件在框架内部的完整元信息画像”。
  readonly name: TName;
  readonly category: EnhancedComponentCategory;
  readonly irKind: EnhancedComponentIrKind;
  readonly runtimeHostKind: EnhancedRuntimeHostKind;
  readonly supportsSsr: boolean;
  readonly supportsHydration: boolean;
  readonly staticRenderMode: EnhancedStaticRenderMode;
  readonly metadataPropNames: readonly string[];
  readonly notes?: string;
}

export type EnhancedEventBackedMetadataPropName = `on${string}`;

// 注册表正文按“结构组件 -> 纯语法节点 -> 生命周期/边界组件”的语义顺序排列。
// 这里的顺序同时决定了导出列表的稳定顺序，便于测试与调试对齐。
const registryEntries = [
  // `When` / `Switch` / `Each` 等结构型组件会真正生成宿主块或 IR 节点。
  {
    name: 'When',
    category: 'structure',
    irKind: 'IfIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['value', 'fallback', 'mode'],
    notes: 'Lower to IfIR and keep branch semantics in compiler IR.',
  },
  // `Then` / `Else` / `Case` / `Match` / `Default` 只作为父级 lowering 的语法提示。
  {
    name: 'Then',
    category: 'syntax',
    irKind: 'passthrough',
    runtimeHostKind: 'none',
    supportsSsr: false,
    supportsHydration: false,
    staticRenderMode: 'flatten',
    metadataPropNames: [],
    notes: 'Branch marker consumed by <When> lowering.',
  },
  {
    name: 'Else',
    category: 'syntax',
    irKind: 'passthrough',
    runtimeHostKind: 'none',
    supportsSsr: false,
    supportsHydration: false,
    staticRenderMode: 'flatten',
    metadataPropNames: [],
    notes: 'Branch marker consumed by <When> lowering.',
  },
  // `Switch` 有两种形态：`<Case when={值}>` 做取值匹配，`<Match value={条件}>` 做布尔分支。
  {
    name: 'Switch',
    category: 'structure',
    irKind: 'IfIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['value', 'mode'],
    notes: 'Value switch: either value lookup via <Case when> / <Default>, or boolean branches via <Match>.',
  },
  {
    name: 'Case',
    category: 'syntax',
    irKind: 'passthrough',
    runtimeHostKind: 'none',
    supportsSsr: false,
    supportsHydration: false,
    staticRenderMode: 'flatten',
    metadataPropNames: [],
    notes: 'Branch marker consumed by <Switch> lowering; `when` is the expected value.',
  },
  {
    name: 'Default',
    category: 'syntax',
    irKind: 'passthrough',
    runtimeHostKind: 'none',
    supportsSsr: false,
    supportsHydration: false,
    staticRenderMode: 'flatten',
    metadataPropNames: [],
    notes: 'Branch marker consumed by <Switch> lowering.',
  },
  {
    name: 'Match',
    category: 'syntax',
    irKind: 'passthrough',
    runtimeHostKind: 'none',
    supportsSsr: false,
    supportsHydration: false,
    staticRenderMode: 'flatten',
    metadataPropNames: [],
    notes: 'Boolean branch marker consumed by <Switch> lowering.',
  },
  {
    name: 'Each',
    category: 'structure',
    irKind: 'ListIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['value', 'key', 'fallback'],
    notes: 'Lower to ListIR and structural slot payloads.',
  },
  {
    name: 'Teleport',
    category: 'structure',
    irKind: 'TeleportIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['to'],
    notes: 'Lower to TeleportIR with target metadata.',
  },
  {
    name: 'Fragment',
    category: 'syntax',
    irKind: 'passthrough',
    runtimeHostKind: 'none',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'flatten',
    metadataPropNames: [],
    notes: 'Pure syntax sugar that flattens children into parent scope.',
  },
  {
    name: 'Slot',
    category: 'structure',
    irKind: 'DynamicIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['name', 'fallback'],
    notes: 'Projects caller children through native/custom slot semantics or runtime fallback rendering.',
  },
  {
    name: 'Dynamic',
    category: 'structure',
    irKind: 'DynamicIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['is', 'component', 'props', 'fallback'],
    notes: 'Lower to DynamicIR and execute through structural host paths.',
  },
  {
    name: 'KeepAlive',
    category: 'structure-lifecycle',
    irKind: 'KeepAliveIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: [
      'scope',
      'cacheKey',
      'include',
      'exclude',
      'max',
      'onActivate',
      'onDeactivate',
      'onCache',
      'onEvict',
    ],
    notes: 'Draft target is block-instance caching rather than renderable-value caching.',
  },
  {
    name: 'Transition',
    category: 'structure-lifecycle',
    irKind: 'TransitionIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'children-only',
    metadataPropNames: ['name', 'transitionKey'],
    notes: 'Lowered through dedicated TransitionIR while continuing to reuse structural host scheduling.',
  },
  {
    name: 'TransitionGroup',
    category: 'structure-lifecycle',
    irKind: 'TransitionIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'children-only',
    metadataPropNames: ['name', 'groupKey', 'tag'],
    notes: 'Lowered through dedicated TransitionIR while continuing to reuse structural host scheduling.',
  },
  {
    name: 'LazyLoad',
    category: 'boundary',
    irKind: 'BoundaryIR',
    runtimeHostKind: 'boundary',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'children-only',
    metadataPropNames: ['lazyKey', 'rootMargin', 'once', 'observe'],
    notes: 'Boundary-style visibility switching with hydration-facing metadata.',
  },
  {
    name: 'ErrorBoundary',
    category: 'boundary',
    irKind: 'BoundaryIR',
    runtimeHostKind: 'boundary',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'children-only',
    metadataPropNames: ['boundaryKey'],
    notes: 'BoundaryIR entry with error recovery semantics.',
  },
  {
    name: 'Suspense',
    category: 'boundary',
    irKind: 'BoundaryIR',
    runtimeHostKind: 'boundary',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'children-only',
    metadataPropNames: ['suspenseKey'],
    notes: 'BoundaryIR entry with pending/resolved/rejected state transitions.',
  },
  {
    name: 'Await',
    category: 'structure-lifecycle',
    irKind: 'DynamicIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: ['value', 'fallback', 'error', 'delay'],
    notes: 'Promise-driven dynamic block; renders fallback until the value resolves.',
  },
  {
    name: 'Virtual',
    category: 'structure-lifecycle',
    irKind: 'DynamicIR',
    runtimeHostKind: 'structural',
    supportsSsr: true,
    supportsHydration: true,
    staticRenderMode: 'preserve',
    metadataPropNames: [
      'value',
      'itemHeight',
      'height',
      'width',
      'itemWidth',
      'overscan',
      'key',
      'fallback',
      'groupBy',
      'header',
      'headerHeight',
      'endReachedThreshold',
      'hasMore',
      'scrollTo',
    ],
    notes:
      'Windowed list: fixed, per-item or estimated row sizes, scroll anchoring, sticky group headers and bidirectional virtualization.',
  },
  {
    name: 'Reach',
    category: 'structure-lifecycle',
    irKind: 'DynamicIR',
    runtimeHostKind: 'structural',
    supportsSsr: false,
    supportsHydration: false,
    staticRenderMode: 'preserve',
    metadataPropNames: ['mode', 'root', 'rootMargin', 'threshold', 'once'],
    notes:
      'IntersectionObserver sentinel for bottom-of-scroll loading, lazy reveal and impressions.',
  },
] as const satisfies readonly EnhancedComponentRegistryEntry[];

// 额外构建 name -> entry 的字典，避免调用方重复线性扫描列表。
const registryRecord = {} as Record<EnhancedComponentName, EnhancedComponentRegistryEntry>;

registryEntries.forEach((entry) => {
  // 入口对象在注册阶段冻结，保证后续只读消费不会意外改写共享元数据。
  registryRecord[entry.name] = Object.freeze({
    ...entry,
  });
});

// 列表视图保留原始声明顺序，更适合测试快照与文档枚举。
export const ENHANCED_COMPONENT_REGISTRY_LIST = Object.freeze(
  registryEntries.map((entry) => registryRecord[entry.name])
) as readonly EnhancedComponentRegistryEntry[];

// 字典视图适合高频随机访问，供类型守卫与编译流程快速查询。
export const ENHANCED_COMPONENT_REGISTRY = Object.freeze(
  registryRecord
) as Readonly<Record<EnhancedComponentName, EnhancedComponentRegistryEntry>>;

const hasOwn = <TKey extends PropertyKey>(
  value: object,
  key: TKey
): value is Record<TKey, unknown> => {
  // 统一走原型安全的 hasOwnProperty，避免原型链污染影响判断结果。
  return Object.prototype.hasOwnProperty.call(value, key);
};

export const isEnhancedComponentName = (name: string): name is EnhancedComponentName => {
  // 通过字典成员测试做运行时类型收窄。
  return hasOwn(ENHANCED_COMPONENT_REGISTRY, name);
};

export const isWhenBranchEnhancedComponentName = (
  name: string
): name is EnhancedWhenBranchComponentName => {
  // `Then` / `Else` 共用一张分支语义映射表，避免散落条件判断。
  return hasOwn(ENHANCED_WHEN_BRANCH_KINDS, name);
};

// `When` 分支语义在 lowering 阶段需要区分真值分支和兜底分支。
const ENHANCED_WHEN_BRANCH_KINDS = Object.freeze({
  Then: 'truthy',
  Else: 'fallback',
} satisfies Record<EnhancedWhenBranchComponentName, EnhancedWhenBranchKind>);

// 这些语法糖节点必须依附特定直接父节点，否则无法成立语义。
const ENHANCED_COMPONENT_PARENT_REQUIREMENTS = Object.freeze({
  Then: 'When',
  Else: 'When',
  Case: 'Switch',
  Match: 'Switch',
  Default: 'Switch',
} satisfies Record<EnhancedBranchComponentName, EnhancedComponentName>);

// 下面这组查询 API 都只读取冻结后的注册表，不再暴露内部构建过程。
export const getEnhancedWhenBranchKind = (
  name: string
): EnhancedWhenBranchKind | null => {
  // 非法名字返回 null，方便调用方直接做空值分支处理。
  return isWhenBranchEnhancedComponentName(name) ? ENHANCED_WHEN_BRANCH_KINDS[name] : null;
};

export const getRequiredEnhancedParentComponentName = (
  name: string
): EnhancedComponentName | null => {
  // 分支型语法糖依赖直接父组件语义，这里统一给模板诊断与解析层复用。
  return hasOwn(ENHANCED_COMPONENT_PARENT_REQUIREMENTS, name)
    ? ENHANCED_COMPONENT_PARENT_REQUIREMENTS[name as EnhancedBranchComponentName]
    : null;
};

export const createEnhancedParentRequirementErrorMessage = (
  name: string
): string | null => {
  // 错误文案保持单点生成，便于诊断逻辑与测试断言共用。
  const parentName = getRequiredEnhancedParentComponentName(name);
  return parentName ? `<${name}> can only be used as a direct child of <${parentName}>.` : null;
};

const escapeRegExp = (value: string): string => {
  // 把用户可见文案转成安全正则，避免 `<`、`>` 等字符扰乱匹配。
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export const isEnhancedParentRequirementErrorMessage = (message: string): boolean => {
  // 通过复用统一错误文案模板，识别是否属于父子约束类诊断。
  return ENHANCED_COMPONENT_NAMES.some((name) => {
    const expectedMessage = createEnhancedParentRequirementErrorMessage(name);
    return expectedMessage ? new RegExp(`^${escapeRegExp(expectedMessage)}$`).test(message) : false;
  });
};

export const getEnhancedComponentRegistryEntry = (
  name: string
): EnhancedComponentRegistryEntry | null => {
  // 未命中保留名时返回 null，而不是抛错，方便解析器渐进式探测。
  return isEnhancedComponentName(name) ? ENHANCED_COMPONENT_REGISTRY[name] : null;
};

export const getEnhancedComponentMetadataPropNames = (name: string): readonly string[] => {
  // 元数据属性列表由注册表统一维护，避免多个编译阶段自行硬编码。
  return getEnhancedComponentRegistryEntry(name)?.metadataPropNames ?? [];
};

export const getEnhancedEventBackedMetadataPropNames = (
  name: string
): readonly EnhancedEventBackedMetadataPropName[] => {
  // 约定所有 `onXxx` 元数据都会被当作事件型回调属性处理。
  return getEnhancedComponentMetadataPropNames(name).filter(
    (propName): propName is EnhancedEventBackedMetadataPropName => propName.startsWith('on')
  );
};

export const isFlattenedEnhancedComponentName = (name: string): boolean => {
  // `flatten` 模式代表组件标签本身不会保留在静态输出中。
  return getEnhancedComponentRegistryEntry(name)?.staticRenderMode === 'flatten';
};

export const shouldRenderEnhancedComponentChildrenOnly = (name: string): boolean => {
  // `children-only` 常用于过渡/边界类组件，它们保留语义但不输出自身壳层。
  return getEnhancedComponentRegistryEntry(name)?.staticRenderMode === 'children-only';
};

export const isStructuralChildrenOnlyEnhancedComponentName = (
  name: string
): name is StructuralChildrenOnlyEnhancedComponentName => {
  const entry = getEnhancedComponentRegistryEntry(name);
  // 同时要求“children-only + structural host”，避免把边界型组件误判进来。
  return (
    entry?.staticRenderMode === 'children-only' &&
    entry.runtimeHostKind === 'structural'
  );
};
