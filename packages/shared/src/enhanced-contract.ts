/**
 * 增强组件跨包协议契约。
 *
 * 这个文件只定义“数据结构”和“运行时守卫”，不承载具体编译或运行逻辑：
 * 1. 编译器根据这里的 payload 结构序列化结构块元数据；
 * 2. 运行时根据这里的判别字段恢复不同增强组件能力；
 * 3. SSR / hydration / 边界恢复逻辑也依赖这里的 marker 与状态字面量保持兼容。
 *
 * 因而这里最大的约束不是算法复杂度，而是协议稳定性：
 * 任意字段名、字面量和默认版本号，都会直接影响跨包通信兼容面。
 */
import {
  getEnhancedComponentRegistryEntry,
  isEnhancedComponentName,
  type EnhancedComponentIrKind,
  type EnhancedComponentName,
  type StructuralChildrenOnlyEnhancedComponentName,
} from './enhanced-registry.js';

// 协议名用于快速识别该对象是否属于增强组件 payload 体系。
export const ENHANCED_CONTRACT_PROTOCOL = 'lania.enhanced' as const;
// 版本号用于后续协议演进时做向前/向后兼容判断。
export const ENHANCED_CONTRACT_VERSION = '0.1-draft' as const;

// 顶层 payload 分类，对应不同增强组件最终下沉到的运行时块类型。
export type EnhancedBlockPayloadKind =
  | 'structural'
  | 'teleport'
  | 'cache'
  | 'transition'
  | 'boundary';

// `passthrough` 只表示语法辅助节点，不会形成可执行块，因此这里排除掉。
export type EnhancedExecutableIrKind = Exclude<EnhancedComponentIrKind, 'passthrough'>;

// 下面这些类型别名把“payload 分类”和“合法组件名”一一对齐，方便后续泛型约束。
export type StructuralPayloadComponentName = 'When' | 'Switch' | 'Each' | 'Dynamic';
export type TeleportPayloadComponentName = 'Teleport';
export type CachePayloadComponentName = 'KeepAlive';
export type TransitionPayloadComponentName = StructuralChildrenOnlyEnhancedComponentName;
export type BoundaryPayloadComponentName = 'Suspense' | 'ErrorBoundary' | 'LazyLoad';

// 标记描述符用于 SSR 与 hydration 阶段对块边界、锚点位置进行重新定位。
export type EnhancedMarkerKind =
  | 'block-start'
  | 'block-end'
  | 'boundary-start'
  | 'boundary-end'
  | 'teleport-anchor'
  | 'cache-anchor'
  | 'transition-anchor';

export type HydrationRecoveryMode = 'resume' | 'replay' | 'remount';
export type BoundaryState = 'idle' | 'pending' | 'resolved' | 'rejected' | 'inactive';
// 生命周期操作用于描述结构块在宿主调度中的关键步骤。
export type StructuralLifecycleOp =
  | 'mount'
  | 'unmount'
  | 'move'
  | 'activate'
  | 'deactivate'
  | 'handoff'
  | 'finalizeRemoval';

export interface EnhancedTemplateContract {
  // `html` / `hoist` / `bindingPaths` 共同描述静态模板及其动态绑定位置信息。
  readonly html?: string;
  readonly hoist?: string;
  readonly bindingPaths?: readonly (readonly number[])[];
}

export interface EnhancedMarkerDescriptor {
  // `id` 与 `kind` 负责唯一定位标记，`component` / `path` / `scope` 提供上下文。
  readonly kind: EnhancedMarkerKind;
  readonly id: string;
  readonly component: EnhancedComponentName;
  readonly path?: readonly number[];
  readonly scope?: string;
}

export interface HydrationContract {
  // 这里不直接绑定实现细节，只描述恢复策略与可选的 marker/payload 锚点。
  readonly mode: HydrationRecoveryMode;
  readonly markerId?: string;
  readonly payloadId?: string;
}

interface BaseEnhancedBlockPayload<
  TPayloadKind extends EnhancedBlockPayloadKind,
  TComponent extends EnhancedComponentName,
  TIrKind extends EnhancedExecutableIrKind,
> {
  // 这组公共字段构成所有 payload 的统一判别头。
  readonly protocol: typeof ENHANCED_CONTRACT_PROTOCOL;
  readonly version: typeof ENHANCED_CONTRACT_VERSION;
  readonly payloadKind: TPayloadKind;
  readonly component: TComponent;
  readonly irKind: TIrKind;
  readonly markers?: readonly EnhancedMarkerDescriptor[];
  readonly hydration?: HydrationContract;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// 下面几组 payload 类型分别对应结构块、Teleport、缓存块、过渡块和边界块五类执行模型。
export interface StructuralBlockPayload
  extends BaseEnhancedBlockPayload<
    'structural',
    StructuralPayloadComponentName,
    'IfIR' | 'ListIR' | 'DynamicIR'
  > {
  // 结构型组件通过 slotIndex/template/lifecycle 组合描述其块实例与模板关系。
  readonly slotIndex: number;
  readonly template: EnhancedTemplateContract;
  readonly fallbackTemplate?: EnhancedTemplateContract;
  readonly lifecycle: readonly StructuralLifecycleOp[];
}

export interface TeleportPayload
  extends BaseEnhancedBlockPayload<'teleport', TeleportPayloadComponentName, 'TeleportIR'> {
  // Teleport 额外记录目标挂载策略，便于运行时决定如何解析 `to`。
  readonly slotIndex: number;
  readonly template: EnhancedTemplateContract;
  readonly target: {
    readonly expression: string;
    readonly strategy: 'selector' | 'node' | 'expression';
  };
}

export interface CachePayload
  extends BaseEnhancedBlockPayload<'cache', CachePayloadComponentName, 'KeepAliveIR'> {
  // 缓存域配置直接决定 KeepAlive 风格组件的复用与淘汰策略。
  readonly slotIndex: number;
  readonly template: EnhancedTemplateContract;
  readonly cache: {
    readonly scope?: string;
    readonly key?: PropertyKey | null;
    readonly max?: number;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

export interface TransitionPayload
  extends BaseEnhancedBlockPayload<
    'transition',
    TransitionPayloadComponentName,
    'TransitionIR'
  > {
  // 过渡块把模板信息与动画阶段配置一起下发给运行时。
  readonly transitionIndex: number;
  readonly template?: EnhancedTemplateContract;
  readonly fallbackTemplate?: EnhancedTemplateContract;
  readonly transition: {
    readonly name?: string;
    readonly phases: readonly ('appear' | 'enter' | 'move' | 'leave')[];
    readonly keyProp: 'transitionKey' | 'groupKey';
    readonly key?: PropertyKey | null;
    readonly tag?: string;
    readonly hooks?: {
      readonly enter?: unknown;
      readonly leave?: unknown;
      readonly appear?: unknown;
      readonly move?: unknown;
      readonly onEnter?: unknown;
      readonly onLeave?: unknown;
      readonly onAppear?: unknown;
      readonly onMove?: unknown;
    };
  };
}

export interface TransitionPayloadComponentConfig {
  // 该配置只刻画 Transition / TransitionGroup 在协议层的差异点。
  readonly keyPropName: 'transitionKey' | 'groupKey';
  readonly phases: readonly ('appear' | 'enter' | 'move' | 'leave')[];
  readonly tagPropName?: 'tag';
}

export interface BoundaryPayload
  extends BaseEnhancedBlockPayload<'boundary', BoundaryPayloadComponentName, 'BoundaryIR'> {
  // 边界型组件除了模板外，还需要初始状态来驱动运行时状态机。
  readonly boundaryIndex: number;
  readonly initialState: BoundaryState;
  readonly childrenTemplate: EnhancedTemplateContract;
  readonly fallbackTemplate?: EnhancedTemplateContract;
}

export type EnhancedBlockPayload =
  | StructuralBlockPayload
  | TeleportPayload
  | CachePayload
  | TransitionPayload
  | BoundaryPayload;

// 过渡组件的协议差异被单独抽到静态配置里，方便编译期与运行时共用同一套约束。
// Transition / TransitionGroup 在 payload 结构上接近，但 key/tag 约束不同。
const TRANSITION_PAYLOAD_COMPONENT_CONFIG = Object.freeze({
  Transition: {
    keyPropName: 'transitionKey',
    phases: ['appear', 'enter', 'leave'],
  },
  TransitionGroup: {
    keyPropName: 'groupKey',
    phases: ['appear', 'enter', 'move', 'leave'],
    tagPropName: 'tag',
  },
} satisfies Record<TransitionPayloadComponentName, TransitionPayloadComponentConfig>);

export const getEnhancedBlockPayloadKind = (
  componentName: EnhancedComponentName
): EnhancedBlockPayloadKind | null => {
  // 先从共享注册表读取 IR 类型，避免这里重复维护组件分类表。
  const entry = getEnhancedComponentRegistryEntry(componentName);

  if (!entry || entry.irKind === 'passthrough') {
    // 纯语法辅助节点不会产出可执行 payload。
    return null;
  }

  switch (entry.irKind) {
    // 多个结构型组件都会映射到统一的 structural payload 分类。
    case 'IfIR':
    case 'ListIR':
    case 'DynamicIR':
      return 'structural';
    case 'TeleportIR':
      return 'teleport';
    case 'KeepAliveIR':
      return 'cache';
    case 'TransitionIR':
      return 'transition';
    case 'BoundaryIR':
      return 'boundary';
    default:
      return null;
  }
};

export const getEnhancedExecutableIrKind = (
  componentName: EnhancedComponentName
): EnhancedExecutableIrKind | null => {
  // 复用注册表信息，同时把不可执行的 passthrough 过滤掉。
  const irKind = getEnhancedComponentRegistryEntry(componentName)?.irKind;
  return irKind && irKind !== 'passthrough' ? irKind : null;
};

export const isTransitionPayloadComponentName = (
  componentName: string
): componentName is TransitionPayloadComponentName => {
  // 先确认属于增强组件名，再确认 payload 分类，避免把普通字符串误缩窄。
  return (
    isEnhancedComponentName(componentName) &&
    getEnhancedBlockPayloadKind(componentName) === 'transition'
  );
};

export const getTransitionPayloadComponentConfig = (
  componentName: TransitionPayloadComponentName
): TransitionPayloadComponentConfig => {
  // 使用预先冻结的静态映射，保证配置读取稳定且零分配。
  return TRANSITION_PAYLOAD_COMPONENT_CONFIG[componentName];
};

export const doesTransitionPayloadComponentUseSsrWrapperTag = (
  componentName: TransitionPayloadComponentName
): boolean => {
  const config = TRANSITION_PAYLOAD_COMPONENT_CONFIG[componentName];
  // 只有 TransitionGroup 这类带 `tag` 语义的组件需要额外 SSR 包裹标签。
  return 'tagPropName' in config && config.tagPropName !== undefined;
};

export const isSuspenseBoundaryComponentName = (
  componentName: string
): componentName is 'Suspense' => {
  // 当前 boundary 族里只有 Suspense 具备“等待态”专属运行时流程。
  return componentName === 'Suspense';
};

export const getDefaultBoundaryState = (
  componentName: BoundaryPayloadComponentName
): BoundaryState => {
  // LazyLoad 天生处于“待激活”语义，其余边界型组件默认从 idle 启动。
  return componentName === 'LazyLoad' ? 'inactive' : 'idle';
};

// 使用 Set 维护协议字面量白名单，便于运行时守卫快速判定。
const PAYLOAD_KINDS = new Set<EnhancedBlockPayloadKind>([
  'structural',
  'teleport',
  'cache',
  'transition',
  'boundary',
]);

const MARKER_KINDS = new Set<EnhancedMarkerKind>([
  'block-start',
  'block-end',
  'boundary-start',
  'boundary-end',
  'teleport-anchor',
  'cache-anchor',
  'transition-anchor',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  // 统一的对象形态守卫，供后续 payload/marker 判定复用。
  return typeof value === 'object' && value !== null;
};

// 守卫层只负责协议头和公共判别字段，具体 payload 细项继续交由下游按种类细化。
export const isEnhancedMarkerDescriptor = (
  value: unknown
): value is EnhancedMarkerDescriptor => {
  if (!isRecord(value)) {
    return false;
  }

  // 这里仅校验 marker 公共判别字段，不深入校验可选上下文属性。
  return (
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    MARKER_KINDS.has(value.kind as EnhancedMarkerKind) &&
    typeof value.component === 'string' &&
    isEnhancedComponentName(value.component)
  );
};

export const isEnhancedBlockPayload = (value: unknown): value is EnhancedBlockPayload => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    // 先校验协议版本、payload kind 与组件名，再交给调用方按具体 payload 细分。
    value.protocol !== ENHANCED_CONTRACT_PROTOCOL ||
    value.version !== ENHANCED_CONTRACT_VERSION ||
    typeof value.payloadKind !== 'string' ||
    !PAYLOAD_KINDS.has(value.payloadKind as EnhancedBlockPayloadKind) ||
    typeof value.component !== 'string' ||
    !isEnhancedComponentName(value.component) ||
    typeof value.irKind !== 'string'
  ) {
    return false;
  }

  // 当前守卫停留在“协议头正确”层级，细分字段由下游按 payloadKind 再校验。
  return true;
};

export const isBoundaryPayload = (value: unknown): value is BoundaryPayload => {
  // 先复用公共协议头校验，再利用判别字段完成窄化。
  return isEnhancedBlockPayload(value) && value.payloadKind === 'boundary';
};

export const isTransitionPayload = (value: unknown): value is TransitionPayload => {
  // 细分守卫全部建立在公共协议头成立之后，再按 payloadKind 继续缩窄。
  return isEnhancedBlockPayload(value) && value.payloadKind === 'transition';
};

export const isCachePayload = (value: unknown): value is CachePayload => {
  return isEnhancedBlockPayload(value) && value.payloadKind === 'cache';
};

export const isStructuralBlockPayload = (value: unknown): value is StructuralBlockPayload => {
  return isEnhancedBlockPayload(value) && value.payloadKind === 'structural';
};

export const isTeleportPayload = (value: unknown): value is TeleportPayload => {
  return isEnhancedBlockPayload(value) && value.payloadKind === 'teleport';
};
