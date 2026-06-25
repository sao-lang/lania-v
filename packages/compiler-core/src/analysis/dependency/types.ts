import type { ComponentIR } from '../../ir/component';

/**
 * 依赖分析结果类型定义。
 *
 * 这些类型用于描述组件在依赖分析阶段抽取出来的“表达式 -> signal / updater / slot / 跨组件使用”
 * 等中间结果。
 *
 * 它们本身不执行分析逻辑，而是为多个分析子模块约定统一的数据形状，便于：
 * 1. 汇总模板、computed、effect 等来源的依赖；
 * 2. 建立 signal 到 slot / updater 的反向索引；
 * 3. 做跨组件拆分与更新优先级推断。
 */

// 表达式依赖种类：区分 `this.foo()`、裸标识符调用、属性读取和 store 深路径读取。
export type DependencyKind =
  | 'this-signal-call'
  | 'identifier-call'
  | 'this-property-read'
  | 'store-path-read';

// 单条表达式依赖记录，描述“从哪种访问模式读到了哪个名字/路径”。
export interface ExpressionDependency {
  kind: DependencyKind;
  name: string;
  text: string;
  accessPath: string[];
}

// 组件内部的依赖条目。它把某个表达式来源、对应 updater 以及依赖的 signal 集合打包在一起。
export interface DependencyEntryIR {
  source:
    | 'text'
    | 'list'
    | 'condition'
    | 'component'
    | 'dynamic'
    | 'teleport'
    | 'attribute'
    | 'directive'
    | 'computed'
    | 'effect';
  expression: string;
  updater: string;
  signalDependencies: ExpressionDependency[];
  slotIndex?: number;
  path?: number[];
  attributeName?: string;
}

// 跨组件传递给子组件的单个 binding 及其依赖。
export interface CrossComponentBindingIR {
  name: string;
  expression: string;
  signalDependencies: ExpressionDependency[];
}

// 一次组件使用点的完整分析结果，用于判断更新频率、依赖信号以及是否适合作为 split point。
export interface CrossComponentUsageIR {
  kind: 'static-component' | 'dynamic-component';
  component: string;
  path: number[];
  slotIndex?: number;
  updater: string | null;
  propBindings: CrossComponentBindingIR[];
  eventBindings: string[];
  dependencySignals: string[];
  updatePriority: 'high' | 'normal';
  codeSplitEligible: boolean;
}

// 跨组件拆分点描述：记录可独立切开的组件使用位置。
export interface CrossComponentSplitPointIR {
  key: string;
  component: string;
  path: number[];
  updater: string | null;
  kind: CrossComponentUsageIR['kind'];
}

// 跨组件分析聚合结果。
export interface CrossComponentAnalysisIR {
  componentUsages: CrossComponentUsageIR[];
  highFrequencyUpdaters: string[];
  updaterPriorities: Record<string, 'high' | 'normal'>;
  splitPoints: CrossComponentSplitPointIR[];
}

// 整个组件的依赖分析总输出。
export interface DependencyAnalysisIR {
  entries: DependencyEntryIR[];
  signalToSlotMap: Record<string, number[]>;
  signalToUpdaterMap: Record<string, string[]>;
  computedDependencyChain: Record<string, string[]>;
  effectDependencyChain: Record<string, string[]>;
  deepPathReads: Record<string, string[][]>;
  storePathReads: Record<string, string[][]>;
  crossComponentAnalysis: CrossComponentAnalysisIR;
}

// 依赖分析上下文：分析某个组件时提前收集好的名字集合与组件 IR 本体。
export interface DependencyAnalysisContext {
  component: ComponentIR;
  propNames: Set<string>;
  signalNames: Set<string>;
  computedNames: Set<string>;
  propertyReadNames: Set<string>;
  templatePropertyReadNames: Set<string>;
  storeNames: Set<string>;
}
