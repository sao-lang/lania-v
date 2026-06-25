/**
 * 优化阶段 IR 定义。
 *
 * 这些结构只描述“优化阶段观察到或产出的事实”，
 * 例如常量折叠记录、表达式合并结果以及 slot 重排映射，
 * 供后续代码生成、调试输出和测试断言复用。
 */
export interface ConstantFoldRecord {
  original: string;
  folded: string;
  path: number[];
}

export interface ExpressionMergeGroupIR {
  updaterName: string;
  expression: string;
  dependencies: string[];
  slotIndices: number[];
}

export interface OptimizationPassIR {
  // 静态 DOM 是否已经被提升成可复用模板。
  staticDomHoisted: boolean;
  // 记录表达式级常量折叠前后的源码片段。
  constantFoldedExpressions: ConstantFoldRecord[];
  // 记录被判定为静态 signal 的折叠值，便于调试优化命中情况。
  staticSignalFolds: Array<{
    signal: string;
    folded: string;
  }>;
  // 多个 slot 共享同一表达式时，会被合并成单个 updater 组。
  expressionMerges: ExpressionMergeGroupIR[];
  // slot 重排后，原 slot 与压缩后 slot 的映射关系。
  slotPackingMap: Record<number, number>;
  // 被内联进其他表达式中的 computed 名称。
  inlinedComputed: string[];
  // 确认可裁剪、不再需要运行时订阅的 signal 名称。
  prunedSignals: string[];
}

export const createEmptyOptimizationPass = (): OptimizationPassIR => {
  return {
    staticDomHoisted: false,
    constantFoldedExpressions: [],
    staticSignalFolds: [],
    expressionMerges: [],
    slotPackingMap: {},
    inlinedComputed: [],
    prunedSignals: [],
  };
};
