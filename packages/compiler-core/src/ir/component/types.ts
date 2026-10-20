import type {
  CompilerProgram,
  DirectiveNode,
  ElementNode,
  EventListenerOptionsNode,
  TemplateChildNode,
} from '../../ast';
import type { DependencyAnalysisIR } from '../../analysis/dependency';
import type { OptimizationPassIR } from '../../transform/optimization';
import type {
  RenderBoundaryBindingPlan,
  RenderComponentBindingPlan,
  RenderConditionBindingPlan,
  RenderDynamicBindingPlan,
  RenderKeepAliveBindingPlan,
  RenderListBindingPlan,
  RenderRuntimeUpdaterPlan,
  RenderTeleportBindingPlan,
  RenderTextBindingPlan,
  RenderTransitionBindingPlan,
} from '../../codegen/render';
import type { SlotAllocationIR } from '../../plan/slots';
import type { UpdaterGenerationIR } from '../../plan/updaters';
import type {
  TransitionPayloadComponentName,
} from '@lania-v/shared';

/**
 * 组件 IR 全量类型定义。
 *
 * 这一组接口描述 `compiler-core` 在组件级编译阶段使用的统一中间表示，
 * 既承接 AST lowering 结果，也作为优化、slot 分配、updater 规划与代码生成
 * 的共同输入输出契约。
 *
 * 设计上大致分三层：
 * 1. 组件元信息：props、signals、computed、lifecycle 等；
 * 2. 模板结构 IR：ElementIR、ExpressionIR、ListIR 等模板节点；
 * 3. lowering 辅助协议：模板递归下降结果、上下文与选项。
 *
 * 这份类型文件本身不承载行为逻辑，但它决定了各编译阶段如何“交接数据”。
 * 因此这里的注释重点是说明字段在流水线中的职责边界，帮助阅读者快速判断：
 * 某个字段是 AST 语义、模板结构、还是 codegen/runtime 所需的派生信息。
 */
export interface ComponentIR {
  type: 'ComponentIR';
  name: string;
  sourceKind: CompilerProgram['sourceKind'];
  props: PropIR[];
  signals: SignalIR[];
  computed: ComputedIR[];
  effects: EffectIR[];
  lifecycle: LifecycleIR;
  lifecycleCallbacks: LifecycleCallbackIR[];
  setupBindings: SetupBindingIR[];
  template: TemplateIR;
  /** 是否参与原生表单提交（由 `useFormValue` 推导）。 */
  formAssociated?: boolean;
  /** `defineComponent(fn, options)` 第二个参数的原文，供运行时求值。 */
  optionsSource?: string;
  renderPlan: ComponentRenderPlanIR;
  optimizationPass: OptimizationPassIR;
  dependencyAnalysis: DependencyAnalysisIR;
  slotAllocation: SlotAllocationIR;
  updaterGeneration: UpdaterGenerationIR;
}

// 组件实例字段级 IR，保存类成员与 setup 语义在编译阶段的标准化结果。
export interface PropIR {
  name: string;
  initializer: string | null;
}

export interface SignalIR {
  name: string;
  initializer: string | null;
  /** signal 在组件体内的源码顺序，供字段初始化顺序还原。 */
  order?: number;
}

export interface ComputedIR {
  name: string;
  expression: string | null;
}

export interface EffectIR {
  name: string;
  body: string | null;
}

export interface LifecycleIR {
  connected: boolean;
  disconnected: boolean;
  adopted: boolean;
  attributeChanged: boolean;
  willUpdate: boolean;
  updated: boolean;
  firstUpdated: boolean;
}

export interface LifecycleCallbackIR {
  hook: string;
  params: string;
  body: string | null;
}

export interface SetupBindingIR {
  name: string;
  kind: 'field' | 'method' | 'statement';
  params: string;
  body: string | null;
  initializer: string | null;
  /** setup 绑定在组件体内的源码顺序，供字段初始化顺序还原。 */
  order?: number;
}

export interface ComponentRenderPlanIR {
  // 组件 render plan 汇总 lowering 后已知的静态 HTML 与各种运行时绑定。
  // 它已经不再是“树状模板语义”，而是更贴近 codegen 消费的线性计划。
  staticHtml: string;
  textBindings: RenderTextBindingPlan[];
  componentBindings: RenderComponentBindingPlan[];
  listBindings: RenderListBindingPlan[];
  conditionBindings: RenderConditionBindingPlan[];
  dynamicBindings: RenderDynamicBindingPlan[];
  boundaryBindings: RenderBoundaryBindingPlan[];
  transitionBindings: RenderTransitionBindingPlan[];
  keepAliveBindings: RenderKeepAliveBindingPlan[];
  teleportBindings: RenderTeleportBindingPlan[];
  runtimeUpdaters: RenderRuntimeUpdaterPlan[];
  signalBindingMap: Record<string, string>;
  storeBindingMap: Record<string, string>;
}

export interface TemplateIR {
  type: 'TemplateIR';
  roots: TemplateIRNode[];
  slotCount: number;
  boundaryCount: number;
}

// 模板节点类型大体可分为三组：普通结构节点、block 节点，以及仅承载绑定信息的叶子节点。
// 以下接口描述模板 lowering 产出的节点类型，后续阶段会按 `type` 分派处理。
export interface ElementIR {
  type: 'ElementIR';
  tagName: string;
  path: number[];
  staticAttributes: Record<string, string | true>;
  dynamicAttributes: DynamicAttributeIR[];
  events: EventIR[];
  directives: DirectiveIR[];
  children: TemplateIRNode[];
}

export interface TextIR {
  type: 'TextIR';
  path: number[];
  value: string;
}

export interface ExpressionIR {
  type: 'ExpressionIR';
  path: number[];
  slotIndex: number;
  expression: string;
}

export interface ListIR {
  type: 'ListIR';
  path: number[];
  slotIndex: number;
  expression: string;
  // 以下几组字段描述不同列表渲染策略可复用的模板壳与绑定信息。
  itemTemplateHtml?: string;
  itemTemplateHoistName?: string;
  itemBindingsExpression?: string;
  keyedItemTemplateHtml?: string;
  keyedItemHoistName?: string;
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
}

export interface IfIR {
  type: 'IfIR';
  path: number[];
  slotIndex: number;
  expression: string;
  // `mode` 影响条件切换时是保留节点状态还是整块重建。
  mode?: 'retain' | 'remount';
  templateHtml: string;
  hoistName: string;
  children?: TemplateIRNode[];
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
  fallbackChildren?: TemplateIRNode[];
}

export interface TeleportIR {
  type: 'TeleportIR';
  path: number[];
  slotIndex: number;
  targetExpression: string;
  templateHtml: string;
  hoistName: string;
  children?: TemplateIRNode[];
}

export interface DynamicIR {
  type: 'DynamicIR';
  path: number[];
  slotIndex: number;
  // `componentExpression` 与 `propsExpression` 在运行时共同决定动态块如何实例化。
  componentExpression: string;
  propsExpression: string;
  templateHtml: string;
  hoistName: string;
  enhancedComponentName?: TransitionPayloadComponentName;
  ssrWrapperTagExpression?: string;
  /** `client:<priority>` 声明的 island 水合优先级。 */
  island?: { priority: string };
  children?: TemplateIRNode[];
}

export interface KeepAliveIR {
  type: 'KeepAliveIR';
  path: number[];
  slotIndex: number;
  templateHtml: string;
  hoistName: string;
  payloadExpression: string;
  children?: TemplateIRNode[];
}

export interface StaticComponentIR {
  type: 'StaticComponentIR';
  path: number[];
  slotIndex: number;
  tagName: string;
  propsExpression: string;
  eventNames: string[];
}

export interface BoundaryIR {
  type: 'BoundaryIR';
  path: number[];
  slotIndex: number;
  boundaryIndex: number;
  componentName: string;
  templateHtml: string;
  hoistName: string;
  // payload 里会携带边界运行时需要恢复的组件名、props、fallback 等信息。
  payloadExpression: string;
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
  children: TemplateIRNode[];
}

export interface TransitionIR {
  type: 'TransitionIR';
  path: number[];
  slotIndex: number;
  transitionIndex: number;
  componentName: TransitionPayloadComponentName;
  templateHtml: string;
  hoistName: string;
  // Transition 的 payload 与 Boundary 类似，但会附带过渡组件专属配置。
  payloadExpression: string;
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
  children: TemplateIRNode[];
}

export interface DynamicAttributeIR {
  name: string;
  expression: string;
  path: number[];
  slotIndex?: number;
}

// 以下三类描述元素叶子级绑定，slotIndex 会在 slot allocation 阶段后补齐。
export interface EventIR {
  name: string;
  expression: string;
  modifiers: string[];
  listener?: EventListenerOptionsNode;
  component: boolean;
  path: number[];
  slotIndex?: number;
  /** 需要额外监听的提示性修饰符（`debounce` / `throttle`）。 */
  hints?: string[];
  /**
   * 单个事件声明展开出的多条回调时（如 `.debounce` / `.throttle` 需要包装额外监听），
   * 这里记录每条附加回调对应的提示名；为空表示只生成一条 listener。
   */
  entries?: EventEntryIR[];
}

export interface EventEntryIR {
  hints: string[];
}

export interface DirectiveIR {
  kind: DirectiveNode['kind'];
  name: string;
  expression: string;
  modifiers: string[];
  unit?: string;
  path: number[];
  slotIndex?: number;
}

export type TemplateIRNode =
  | ElementIR
  | TextIR
  | ExpressionIR
  | StaticComponentIR
  | ListIR
  | IfIR
  | DynamicIR
  | TeleportIR
  | KeepAliveIR
  | TransitionIR
  | BoundaryIR;

// lowering 返回值除了节点列表本身，还会携带 slot/boundary 游标供递归续用。
export interface LowerTemplateResult {
  nodes: TemplateIRNode[];
  staticHtml: string;
  nextSlotIndex: number;
  nextBoundaryIndex: number;
  renderedRootCount: number;
}

export interface LowerTemplateOptions {
  // 某些 children-only enhanced component 需要保留为动态块，而不是直接扁平化。
  preserveChildrenOnlyEnhancedAsDynamic?: boolean;
}

export type TemplateLowerer = (
  children: TemplateChildNode[],
  parentPath: number[],
  nextSlotIndex: number,
  nextBoundaryIndex: number,
  startDomIndex?: number,
  options?: LowerTemplateOptions
) => LowerTemplateResult;

export interface LowerEnhancedComponentContext {
  // 这里保存 enhanced component 下降时需要的完整位置上下文与 slot 游标。
  child: ElementNode;
  path: number[];
  parentPath: number[];
  slotIndex: number;
  boundaryIndex: number;
  domIndex: number;
}
