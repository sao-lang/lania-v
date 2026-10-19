/**
 * 组件级依赖分析。
 *
 * 这个模块把表达式分析、模板遍历和跨组件分析串起来，产出组件完整的依赖画像。
 * 它是连接“模板结构”与“运行时更新计划”的关键一环，主要负责：
 * - 为文本、条件、列表、动态组件、属性、指令等模板节点生成依赖条目；
 * - 为 computed / effect 生成独立依赖条目，并归档它们的依赖链；
 * - 汇总 signal -> slot / updater 的映射，以及 deep path / store path 的读取记录；
 * - 额外补充跨组件 usage 信息，服务于优先级和拆分决策。
 *
 * 这里不直接做 slot 分配或 updater 合并，而是先把“谁依赖谁”这件事尽量描述完整，
 * 让后续阶段在统一数据基础上继续优化。
 *
 * 换句话说，这一层更偏向“事实采集”而不是“策略决策”：
 * 它负责把模板、computed、effect 中出现的动态读取摊平成可检索记录，
 * 供后面的 slot/updater/codegen 阶段按各自目标重新组合。
 */
import ts from 'typescript';

import type { ComponentIR, TemplateIRNode } from '../../ir/component';
import {
  analyzeBlockDependencies,
  analyzeExpressionDependencies,
  mergeDependencies,
  parseExpressionNode,
} from './expression';
import { collectTemplateSignalDependencies } from './template';
import { buildCrossComponentAnalysis } from './cross-component';
import type { DependencyAnalysisIR, DependencyEntryIR } from './types';
import {
  createNumberSetRecord,
  createPathRecord,
  createRecordSet,
  normalizeNumberRecordSet,
  normalizePathRecord,
  normalizeRecordSet,
  pushPathValue,
  pushRecordNumberValue,
  pushRecordSetValue,
  sanitizeIdentifierToken,
} from './utils';
export const createEmptyDependencyAnalysis = (): DependencyAnalysisIR => {
  return {
    entries: [],
    signalToSlotMap: {},
    signalToUpdaterMap: {},
    computedDependencyChain: {},
    effectDependencyChain: {},
    deepPathReads: {},
    storePathReads: {},
    crossComponentAnalysis: {
      componentUsages: [],
      highFrequencyUpdaters: [],
      updaterPriorities: {},
      splitPoints: [],
    },
  };
};

export const analyzeComponentDependencies = (
  component: ComponentIR
): DependencyAnalysisIR => {
  const isCreateStoreCall = (expression: string): boolean => {
    try {
      // 这里显式剥掉包裹括号，兼容 `(createStore(...))` 之类的写法。
      let parsed = parseExpressionNode(expression);
      while (ts.isParenthesizedExpression(parsed)) {
        parsed = parsed.expression;
      }
      if (!ts.isCallExpression(parsed)) {
        return false;
      }
      const callee = parsed.expression;
      return (
        (ts.isIdentifier(callee) && callee.text === 'createStore') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createStore')
      );
    } catch {
      return false;
    }
  };

  const collectStoreBindingNames = (): Set<string> => {
    const storeNames = new Set<string>();
    component.setupBindings.forEach((binding) => {
      if (binding.kind !== 'field' || !binding.initializer) {
        return;
      }

      // `const store = createStore(...)` 直接把返回句柄提升为组件字段。
      if (isCreateStoreCall(binding.initializer)) {
        storeNames.add(binding.name);
      }
    });

    return storeNames;
  };

  const entries: DependencyEntryIR[] = [];
  const signalToSlotMap = createNumberSetRecord();
  const signalToUpdaterMap = createRecordSet();
  const computedDependencyChain = createRecordSet();
  const effectDependencyChain = createRecordSet();
  const deepPathReads = createPathRecord();
  const storePathReads = createPathRecord();
  const propNames = new Set(component.props.map((prop) => prop.name));
  const signalNames = new Set(component.signals.map((signal) => signal.name));
  const computedNames = new Set(component.computed.map((computed) => computed.name));
  const propertyReadNames = new Set([...propNames, ...computedNames]);
  // 模板里允许把 signal 直接当可读值使用，因此模板分析集合会比 block 分析再多一层 signal 名。
  const templatePropertyReadNames = new Set([...propNames, ...computedNames, ...signalNames]);
  const storeNames = collectStoreBindingNames();
  // 模板表达式允许直接读 signal / prop / computed；effect 块则更偏向成员读取场景。
  const analyzeExpression = (expression: string) =>
    analyzeExpressionDependencies(expression, templatePropertyReadNames, storeNames);
  const analyzeBlock = (body: string) =>
    analyzeBlockDependencies(body, propertyReadNames, storeNames);

  const analyzeTemplateDependenciesWithProps = (
    nodes: TemplateIRNode[],
    targetEntries: DependencyEntryIR[]
  ): void => {
    nodes.forEach((node) => {
      if (node.type === 'ExpressionIR') {
        // 文本插值天然对应单 slot updater。
        targetEntries.push({
          source: 'text',
          expression: node.expression,
          updater: `updateSlot${node.slotIndex}`,
          signalDependencies: analyzeExpression(node.expression),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'ListIR') {
        targetEntries.push({
          source: 'list',
          expression: node.expression,
          updater: `updateListSlot${node.slotIndex}`,
          signalDependencies: analyzeExpression(node.expression),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'IfIR') {
        targetEntries.push({
          source: 'condition',
          expression: node.expression,
          updater: `updateIfSlot${node.slotIndex}`,
          // 条件 updater 既依赖条件本身，也依赖 true/fallback 分支内部的动态读取。
          signalDependencies: mergeDependencies(
            analyzeExpression(node.expression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : [],
            node.fallbackChildren
              ? collectTemplateSignalDependencies(node.fallbackChildren, analyzeExpression)
              : []
          ),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'TeleportIR') {
        targetEntries.push({
          source: 'teleport',
          expression: node.targetExpression,
          updater: `updateTeleportSlot${node.slotIndex}`,
          signalDependencies: mergeDependencies(
            analyzeExpression(node.targetExpression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          ),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'DynamicIR') {
        // 动态组件真正依赖的是“组件引用 + props”这对组合值，这里先拼成一个统一表达式分析。
        const expression = `({ component: ${node.componentExpression}, props: ${node.propsExpression} })`;
        targetEntries.push({
          source: 'dynamic',
          expression,
          updater: `updateDynamicSlot${node.slotIndex}`,
          signalDependencies: mergeDependencies(
            analyzeExpression(expression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          ),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'KeepAliveIR') {
        targetEntries.push({
          source: 'dynamic',
          expression: node.payloadExpression,
          updater: `updateKeepAliveSlot${node.slotIndex}`,
          signalDependencies: mergeDependencies(
            analyzeExpression(node.payloadExpression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          ),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'BoundaryIR') {
        targetEntries.push({
          source: 'dynamic',
          // 这几类 block 在依赖层统一按“动态 payload”看待，后续阶段再按具体 slot 类型分流。
          expression: node.payloadExpression,
          updater: `updateBoundarySlot${node.slotIndex}`,
          signalDependencies: mergeDependencies(
            analyzeExpression(node.payloadExpression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          ),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'TransitionIR') {
        targetEntries.push({
          source: 'dynamic',
          expression: node.payloadExpression,
          updater: `updateTransitionSlot${node.slotIndex}`,
          signalDependencies: mergeDependencies(
            analyzeExpression(node.payloadExpression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          ),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'StaticComponentIR') {
        targetEntries.push({
          source: 'component',
          // 静态组件标签本身是常量，这里只需要记录 props 表达式带来的依赖。
          expression: node.propsExpression,
          updater: `updateComponentSlot${node.slotIndex}`,
          signalDependencies: analyzeExpression(node.propsExpression),
          slotIndex: node.slotIndex,
          path: node.path,
        });
        return;
      }

      if (node.type === 'ElementIR') {
        // 元素节点会把属性/指令拆成独立依赖条目，再继续深入其子树。
        // 这样后续 slot/updater 规划能按“最小可更新单元”消费依赖，而不是把整个元素绑成一条大依赖。
        node.dynamicAttributes.forEach((attribute) => {
          targetEntries.push({
            source: 'attribute',
            expression: attribute.expression,
            updater: `updateAttr_${node.path.join('_') || 'root'}_${sanitizeIdentifierToken(attribute.name)}`,
            signalDependencies: analyzeExpression(attribute.expression),
            attributeName: attribute.name,
            path: attribute.path,
          });
        });

        node.directives.forEach((directive) => {
          targetEntries.push({
            source: 'directive',
            expression: directive.expression,
            updater: `updateDirective_${directive.kind}_${node.path.join('_') || 'root'}_${sanitizeIdentifierToken(directive.name)}`,
            signalDependencies: analyzeExpression(directive.expression),
            path: directive.path,
            attributeName: directive.name,
          });
        });

        analyzeTemplateDependenciesWithProps(node.children, targetEntries);
      }
    });
  };

  // 先从模板根节点递归收集所有模板层依赖条目。
  analyzeTemplateDependenciesWithProps(component.template.roots, entries);

  component.computed.forEach((computed) => {
    if (!computed.expression) {
      return;
    }

    // computed 自身不对应模板 slot，但它仍要被建成独立依赖条目供依赖链分析。
    entries.push({
      source: 'computed',
      expression: computed.expression,
      updater: `updateComputed_${computed.name}`,
      signalDependencies: analyzeExpression(computed.expression),
    });
  });

  component.effects.forEach((effect) => {
    if (!effect.body) {
      return;
    }

    // effect 读取的是整段语句块，因此走 block 级分析，而不是单表达式分析。
    entries.push({
      source: 'effect',
      expression: effect.body,
      updater: `runEffect_${effect.name}`,
      signalDependencies: analyzeBlock(effect.body),
    });
  });

  entries.forEach((entry) => {
    entry.signalDependencies.forEach((dependency) => {
      if (dependency.kind === 'store-path-read') {
        // store 深路径读取单独归档，避免和普通 signal 名称空间混淆。
        pushPathValue(storePathReads, dependency.name, dependency.accessPath);
        const storeKey = `store:${dependency.name}:${dependency.accessPath.join('.')}`;
        if (entry.source === 'computed') {
          pushRecordSetValue(
            computedDependencyChain,
            entry.updater.slice('updateComputed_'.length),
            storeKey
          );
        }
        if (entry.source === 'effect') {
          pushRecordSetValue(effectDependencyChain, entry.updater.slice('runEffect_'.length), storeKey);
        }
        return;
      }

      // 这一支负责把“依赖事实”拆成多张反向索引表，供 slot 分配、updater 规划和调试展示共用。
      // 普通信号读取直接进入 signal 反向索引，供 slot/updater/codegen 后续多处复用。
      // 普通信号读取既会反向映射到 updater，也会映射到 slot 与深路径读取表。
      // `signalToSlotMap` 更偏模板视角，`signalToUpdaterMap` 更偏执行计划视角，两者故意并行维护。
      pushRecordSetValue(signalToUpdaterMap, dependency.name, entry.updater);
      pushPathValue(deepPathReads, dependency.name, dependency.accessPath);

      if (entry.slotIndex !== undefined) {
        pushRecordNumberValue(signalToSlotMap, dependency.name, entry.slotIndex);
      }

      if (entry.source === 'computed') {
        pushRecordSetValue(computedDependencyChain, entry.updater.slice('updateComputed_'.length), dependency.name);
      }

      if (entry.source === 'effect') {
        pushRecordSetValue(effectDependencyChain, entry.updater.slice('runEffect_'.length), dependency.name);
      }
    });
  });

  return {
    entries,
    // 返回前统一做归一化，把 Set / 可变结构转成更稳定、便于序列化消费的对象。
    signalToSlotMap: normalizeNumberRecordSet(signalToSlotMap),
    signalToUpdaterMap: normalizeRecordSet(signalToUpdaterMap),
    computedDependencyChain: normalizeRecordSet(computedDependencyChain),
    effectDependencyChain: normalizeRecordSet(effectDependencyChain),
    deepPathReads: normalizePathRecord(deepPathReads),
    storePathReads: normalizePathRecord(storePathReads),
    crossComponentAnalysis: buildCrossComponentAnalysis(component, propNames),
  };
};
