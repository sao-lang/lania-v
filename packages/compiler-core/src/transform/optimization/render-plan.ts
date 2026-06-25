import type { ComponentIR, TemplateIRNode } from '../../ir/component';
import { buildSlotPackingMap, rebuildRenderStaticNode } from './template';
import type { ExpressionMergeGroupIR } from './types';

/**
 * render plan 重建与表达式合并分析。
 *
 * 这个文件位于模板优化与最终 render codegen 之间，承担两类“收口”工作：
 * 1. 把优化后的模板 IR 重新整理成 `renderPlan` 所需的静态 HTML 与各类绑定表；
 * 2. 分析多个 slot 是否共享相同的 updater 表达式，为后续多 slot 合并更新做准备。
 *
 * 第一部分的核心思想是“静态骨架 + 动态占位”：
 * - 能静态落进 HTML 的内容直接串成 `staticHtml`；
 * - 需要运行时接管的节点，则按类型记录到 `textBindings` / `listBindings` /
 *   `boundaryBindings` 等数组中；
 * - 同时在静态 HTML 中留下稳定占位符，保证运行时可以按 path/slotIndex 找回位置。
 *
 * 第二部分的表达式合并分析，则试图回答一个问题：
 * “如果多个 slot 实际上依赖同一段表达式与同一组依赖，是否可以共用一个 updater？”
 * 这样做不会改变语义，但能减少运行时重复构造和调度 updater 的成本。
 */
export const rebuildRenderPlan = (nodes: TemplateIRNode[]) => {
  // 这些数组直接对应 `ComponentIR['renderPlan']` 的输出字段；
  // 遍历模板时只做结构搬运，不在这里重新解释运行时行为。
  const textBindings: ComponentIR['renderPlan']['textBindings'] = [];
  const componentBindings: ComponentIR['renderPlan']['componentBindings'] = [];
  const listBindings: ComponentIR['renderPlan']['listBindings'] = [];
  const conditionBindings: ComponentIR['renderPlan']['conditionBindings'] = [];
  const dynamicBindings: ComponentIR['renderPlan']['dynamicBindings'] = [];
  const boundaryBindings: ComponentIR['renderPlan']['boundaryBindings'] = [];
  const transitionBindings: ComponentIR['renderPlan']['transitionBindings'] = [];
  const keepAliveBindings: ComponentIR['renderPlan']['keepAliveBindings'] = [];
  const teleportBindings: ComponentIR['renderPlan']['teleportBindings'] = [];

  const renderNodes = (currentNodes: TemplateIRNode[]): string => {
    return currentNodes
      .map((node) => {
        if (node.type === 'TextIR') {
          // 纯文本可以直接并入静态 HTML，不需要生成 slot。
          return node.value;
        }

        if (node.type === 'ExpressionIR') {
          // 文本表达式改写成文本 slot 占位，运行时再把表达式结果写回对应位置。
          textBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            expression: node.expression,
          });
          return `__LANIA_SLOT_${node.slotIndex}__`;
        }

        if (node.type === 'StaticComponentIR') {
          // 静态组件标签在 CSR 里仍需一个组件 slot 承接实例化，因此留下注释占位。
          componentBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            tagName: node.tagName,
            propsExpression: node.propsExpression,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'ListIR') {
          // 列表块的静态骨架不直接内联 item 内容，而是交给 ForSlot 在运行时展开。
          listBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            expression: node.expression,
            itemTemplateHtml: node.itemTemplateHtml,
            itemTemplateHoistName: node.itemTemplateHoistName,
            itemBindingsExpression: node.itemBindingsExpression,
            keyedItemTemplateHtml: node.keyedItemTemplateHtml,
            keyedItemHoistName: node.keyedItemHoistName,
            fallbackTemplateHtml: node.fallbackTemplateHtml,
            fallbackHoistName: node.fallbackHoistName,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'IfIR') {
          // 条件块需要保留主模板、fallback 模板及其子树绑定，便于后续整块切换。
          conditionBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            expression: node.expression,
            mode: node.mode,
            templateHtml: node.templateHtml,
            hoistName: node.hoistName,
            children: node.children,
            fallbackTemplateHtml: node.fallbackTemplateHtml,
            fallbackHoistName: node.fallbackHoistName,
            fallbackChildren: node.fallbackChildren,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'DynamicIR') {
          // Dynamic block 在运行时还要决定 component / props / child payload，因此这里只记占位。
          dynamicBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            componentExpression: node.componentExpression,
            propsExpression: node.propsExpression,
            templateHtml: node.templateHtml,
            hoistName: node.hoistName,
            children: node.children,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'BoundaryIR') {
          // Boundary 除模板外还携带 payload 协议数据，供运行时边界机制消费。
          boundaryBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            componentName: node.componentName,
            templateHtml: node.templateHtml,
            hoistName: node.hoistName,
            payloadExpression: node.payloadExpression,
            fallbackTemplateHtml: node.fallbackTemplateHtml,
            fallbackHoistName: node.fallbackHoistName,
            children: node.children,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'TransitionIR') {
          // Transition 与 Boundary 的静态收集形态接近，但由不同 runtime 协议接管。
          transitionBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            componentName: node.componentName,
            templateHtml: node.templateHtml,
            hoistName: node.hoistName,
            payloadExpression: node.payloadExpression,
            fallbackTemplateHtml: node.fallbackTemplateHtml,
            fallbackHoistName: node.fallbackHoistName,
            children: node.children,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'TeleportIR') {
          // Teleport 需要把目标表达式保留下来，挂载位置与实际渲染位置由运行时协调。
          teleportBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            targetExpression: node.targetExpression,
            templateHtml: node.templateHtml,
            hoistName: node.hoistName,
            children: node.children,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        if (node.type === 'KeepAliveIR') {
          // KeepAlive 仍然表现为 block slot，但 payload 中会附带缓存语义元信息。
          keepAliveBindings.push({
            slotIndex: node.slotIndex,
            path: node.path,
            templateHtml: node.templateHtml,
            hoistName: node.hoistName,
            payloadExpression: node.payloadExpression,
            children: node.children,
          });
          return `<!--__LANIA_SLOT_${node.slotIndex}__-->`;
        }

        // 普通元素继续递归重建静态子树，只有真正动态的节点才会被前面的分支拦截。
        return rebuildRenderStaticNode(node, renderNodes);
      })
      .join('');
  };

  return {
    staticHtml: renderNodes(nodes),
    textBindings,
    componentBindings,
    listBindings,
    conditionBindings,
    dynamicBindings,
    boundaryBindings,
    transitionBindings,
    keepAliveBindings,
    teleportBindings,
    slotCount: Object.keys(buildSlotPackingMap(nodes)).length,
  };
};

export const analyzeExpressionMerges = (component: ComponentIR): ExpressionMergeGroupIR[] => {
  const groups = new Map<string, ExpressionMergeGroupIR>();

  component.slotAllocation.slots.forEach((slot) => {
    if (
      slot.type === 'event' ||
      slot.type === 'teleport' ||
      slot.type === 'dynamic' ||
      slot.type === 'transition' ||
      slot.type === 'if'
    ) {
      // 这些 slot 语义更偏“结构块”或“副作用入口”，不适合参与简单表达式合并。
      return;
    }

    const updater = component.updaterGeneration.updaters.find(
      (candidate) =>
        candidate.slotIndices.length === 1 &&
        candidate.slotIndices[0] === slot.slotIndex &&
        candidate.source === 'slot' &&
        candidate.phase === 'update'
    );

    if (!updater) {
      return;
    }

    // 用“表达式源码 + 依赖集合”作为 key，表示这两个条件都相同时才可视为同一组更新逻辑。
    const key = `${updater.expression}__${updater.dependencies.join(',')}`;
    const existing = groups.get(key);

    if (existing) {
      // 已存在同构 updater 组时，只需要把新的 slotIndex 并入即可。
      existing.slotIndices.push(slot.slotIndex);
      return;
    }

    groups.set(key, {
      updaterName: `updateMergedSlots_${slot.slotIndex}`,
      expression: updater.expression,
      dependencies: updater.dependencies,
      slotIndices: [slot.slotIndex],
    });
  });

  return [...groups.values()]
    // 单个 slot 没有合并价值，只保留真正“一对多”的共享 updater 组。
    .filter((group) => group.slotIndices.length > 1)
    .map((group) => ({
      ...group,
      // 输出阶段会把 slot 顺序编码进 updaterName，先排序以保证命名稳定、可预测。
      slotIndices: group.slotIndices.sort((left, right) => left - right),
      updaterName: `updateMergedSlots_${group.slotIndices.sort((left, right) => left - right).join('_')}`,
    }));
};
