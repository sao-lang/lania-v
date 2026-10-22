import type { ComponentIR } from '../../ir/component';
import {
  buildStaticSignalFoldMap,
  collectRetainedComputedNames,
} from './expression';
import { analyzeExpressionMerges, rebuildRenderPlan } from './render-plan';
import {
  applySlotPacking,
  buildSlotPackingMap,
  collectUsedSignalNames,
  optimizeTemplateNodes,
} from './template';
export * from './types';

/**
 * 模板与 updater 优化。
 *
 * 当前覆盖：
 * - computed 内联
 * - 常量折叠
 * - 静态 signal 内联
 * - slot 索引压缩
 * - 相同表达式 updater 合并
 */

export const optimizeComponentTemplate = (component: ComponentIR): void => {
  const optimization = component.optimizationPass;
  const usedComputed = new Set<string>();
  const initialUsedSignals = collectUsedSignalNames(component);
  const staticSignals = buildStaticSignalFoldMap(component, initialUsedSignals);
  const optimizedNodes = optimizeTemplateNodes(
    component.template.roots,
    component,
    optimization,
    usedComputed,
    staticSignals
  );
  const slotPackingMap = buildSlotPackingMap(optimizedNodes);
  const packedNodes = applySlotPacking(optimizedNodes, slotPackingMap);
  const rebuiltRenderPlan = rebuildRenderPlan(packedNodes);

  // computed 只有在完全内联且没有实例侧引用时才允许从类里删掉。
  const retainedComputed = collectRetainedComputedNames(component);

  component.template.roots = packedNodes;
  component.template.slotCount = rebuiltRenderPlan.slotCount;
  component.renderPlan = {
    staticHtml: rebuiltRenderPlan.staticHtml,
    textBindings: rebuiltRenderPlan.textBindings,
    componentBindings: rebuiltRenderPlan.componentBindings,
    listBindings: rebuiltRenderPlan.listBindings,
    conditionBindings: rebuiltRenderPlan.conditionBindings,
    dynamicBindings: rebuiltRenderPlan.dynamicBindings,
    boundaryBindings: rebuiltRenderPlan.boundaryBindings,
    transitionBindings: rebuiltRenderPlan.transitionBindings,
    keepAliveBindings: rebuiltRenderPlan.keepAliveBindings,
    teleportBindings: rebuiltRenderPlan.teleportBindings,
    runtimeUpdaters: component.renderPlan.runtimeUpdaters,
    signalBindingMap: component.renderPlan.signalBindingMap,
    storeBindingMap: component.renderPlan.storeBindingMap,
  };
  component.computed = component.computed.filter(
    (computed) =>
      !usedComputed.has(computed.name) || retainedComputed.has(computed.name)
  );
  const usedSignals = collectUsedSignalNames(component);
  optimization.staticSignalFolds = Object.entries(staticSignals).map(
    ([signal, folded]) => ({
      signal,
      folded,
    })
  );
  const prunedSignals = component.signals
    .filter((signal) => !usedSignals.has(signal.name))
    .map((signal) => signal.name)
    .sort();
  const runtimeUpdaterSignals = new Set(
    component.renderPlan.runtimeUpdaters.flatMap(
      (updater) => updater.dependencies
    )
  );
  component.signals = component.signals.filter((signal) =>
    usedSignals.has(signal.name)
  );
  component.renderPlan.signalBindingMap = Object.fromEntries(
    Object.entries(component.renderPlan.signalBindingMap).filter(
      ([signalName]) => {
        return (
          !prunedSignals.includes(signalName) ||
          runtimeUpdaterSignals.has(signalName)
        );
      }
    )
  );
  optimization.inlinedComputed = [...usedComputed].sort();
  optimization.prunedSignals = prunedSignals;
  optimization.slotPackingMap = slotPackingMap;
  optimization.staticDomHoisted = component.renderPlan.staticHtml.length > 0;
};

export const optimizeComponentUpdaters = (component: ComponentIR): void => {
  component.optimizationPass.expressionMerges =
    analyzeExpressionMerges(component);
};
