import type { AllocatedSlotIR } from '../../plan/slots';
import type { TemplateIRNode } from '../../ir/component';

/**
 * render codegen 规划类型。
 *
 * 这些类型位于“IR/plan 阶段”和“最终代码生成阶段”之间，
 * 负责描述生成 `_renderAndMount()` 所需的全部中间信息。
 *
 * 可以把它们理解为一份“渲染代码施工图”：
 * - 哪些 slot 需要初始化；
 * - 哪些 block 需要 hoist 模板；
 * - 哪些表达式需要在首次挂载时写入；
 * - 哪些依赖需要注册到 runtime updater。
 *
 * `generate.ts` 不会直接遍历原始模板 AST，而是消费这些 plan 类型来输出最终源码。
 */

// 文本绑定计划：描述一个 TextSlot 应该挂在哪个 slotIndex/path，并由哪个表达式驱动。
export interface RenderTextBindingPlan {
  slotIndex: number;
  path: number[];
  expression: string;
}

// 组件绑定计划：描述组件占位 slot 及其 props 表达式。
export interface RenderComponentBindingPlan {
  slotIndex: number;
  path: number[];
  tagName: string;
  propsExpression: string;
}

// 列表绑定计划：除了列表表达式本身，还会携带 item/fallback 模板及对应 hoist 名。
export interface RenderListBindingPlan {
  slotIndex: number;
  path: number[];
  expression: string;
  itemTemplateHtml?: string;
  itemTemplateHoistName?: string;
  itemBindingsExpression?: string;
  keyedItemTemplateHtml?: string;
  keyedItemHoistName?: string;
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
}

// 条件块绑定计划：同时描述条件表达式、主模板、fallback 模板及两边的子绑定树。
export interface RenderConditionBindingPlan {
  slotIndex: number;
  path: number[];
  expression: string;
  mode?: 'retain' | 'remount';
  templateHtml: string;
  hoistName: string;
  children?: TemplateIRNode[];
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
  fallbackChildren?: TemplateIRNode[];
}

// Teleport 计划：需要额外记录目标表达式，因为挂载位置和渲染位置分离。
export interface RenderTeleportBindingPlan {
  slotIndex: number;
  path: number[];
  targetExpression: string;
  templateHtml: string;
  hoistName: string;
  children?: TemplateIRNode[];
}

// Dynamic 计划：运行时需要同时求值组件引用、props 和子绑定 payload。
export interface RenderDynamicBindingPlan {
  slotIndex: number;
  path: number[];
  componentExpression: string;
  propsExpression: string;
  templateHtml: string;
  hoistName: string;
  children?: TemplateIRNode[];
}

// Boundary 计划：除模板本体外，还携带 payload 表达式供运行时边界协议消费。
export interface RenderBoundaryBindingPlan {
  slotIndex: number;
  path: number[];
  componentName: string;
  templateHtml: string;
  hoistName: string;
  payloadExpression: string;
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
  children?: TemplateIRNode[];
}

// Transition 计划形态与 Boundary 接近，但语义上由 transition runtime 接管。
export interface RenderTransitionBindingPlan {
  slotIndex: number;
  path: number[];
  componentName: string;
  templateHtml: string;
  hoistName: string;
  payloadExpression: string;
  fallbackTemplateHtml?: string;
  fallbackHoistName?: string;
  children?: TemplateIRNode[];
}

// KeepAlive 计划：主要携带缓存 payload 和可延迟接管的子绑定描述。
export interface RenderKeepAliveBindingPlan {
  slotIndex: number;
  path: number[];
  templateHtml: string;
  hoistName: string;
  payloadExpression: string;
  children?: TemplateIRNode[];
}

export type RenderRuntimeUpdaterKind =
  'single-slot' | 'multi-slot' | 'condition' | 'effect';

// runtime updater 计划：描述一个运行时 updater 如何构造、依赖哪些响应式源以及更新哪些 slot。
export interface RenderRuntimeUpdaterPlan {
  name: string;
  kind: RenderRuntimeUpdaterKind;
  slotIndices: number[];
  dependencies: string[];
  expression: string;
  priority?: 'immediate' | 'high' | 'normal' | 'low' | 'idle';
}

// 传给 render codegen 的总输入。它把“静态模板 + 各类绑定计划 + slot/updater 分配结果”打包在一起。
export interface RenderCodegenOptions {
  className: string;
  staticHtml: string;
  textBindings: RenderTextBindingPlan[];
  componentBindings?: RenderComponentBindingPlan[];
  listBindings?: RenderListBindingPlan[];
  conditionBindings?: RenderConditionBindingPlan[];
  dynamicBindings?: RenderDynamicBindingPlan[];
  boundaryBindings?: RenderBoundaryBindingPlan[];
  transitionBindings?: RenderTransitionBindingPlan[];
  keepAliveBindings?: RenderKeepAliveBindingPlan[];
  teleportBindings?: RenderTeleportBindingPlan[];
  allocatedSlots?: AllocatedSlotIR[];
  runtimeUpdaters?: RenderRuntimeUpdaterPlan[];
  signalBindingMap?: Record<string, string>;
  storeBindingMap?: Record<string, string>;
  hoistName?: string;
}

// render codegen 的最终产物：既包含可复用的 hoist 声明，也包含最终方法源码。
export interface RenderCodegenResult {
  hoistName: string;
  hoists: string[];
  method: string;
  code: string;
}
