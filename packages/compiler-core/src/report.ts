/**
 * 编译报告插件。
 *
 * 编译期已经掌握了 slot 数量、updater 依赖和跨组件 usage，
 * 这里把它们整理成稳定的结构化摘要，供构建脚本或调试面板消费。
 */
import type { ComponentIR } from './ir/component';
import type { CompilerPlugin } from './pipeline/plugins';

export interface CompileReportEntry {
  component: string;
  slots: number;
  updaters: number;
  signals: number;
  computed: number;
  effects: number;
  dependencies: number;
  crossComponentUsages: number;
}

export interface CompileReport {
  entries: CompileReportEntry[];
}

export const createCompileReportEntry = (
  component: ComponentIR
): CompileReportEntry => {
  return {
    component: component.name,
    slots: component.slotAllocation.totalSlots,
    updaters: component.updaterGeneration.updaters.length,
    signals: component.signals.length,
    computed: component.computed.length,
    effects: component.effects.length,
    dependencies: component.dependencyAnalysis.entries.length,
    crossComponentUsages:
      component.dependencyAnalysis.crossComponentAnalysis.componentUsages.length,
  };
};

export const createCompileReportPlugin = (
  onReport: (report: CompileReport) => void
): CompilerPlugin => {
  const entries: CompileReportEntry[] = [];

  return {
    name: 'lania-compile-report',
    transformProgram() {
      // 一次编译可能包含多个组件，程序级钩子负责清空上一轮结果。
      entries.length = 0;
    },
    afterGenerateArtifact(artifact) {
      entries.push(createCompileReportEntry(artifact.component));
      onReport({ entries: [...entries] });
    },
  };
};
