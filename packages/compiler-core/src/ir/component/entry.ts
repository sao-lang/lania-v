import type {
  CompilerProgram,
  ComponentDeclaration,
  LifecycleCallbackDeclaration,
  SetupBindingDeclaration,
} from '../../ast';
import { createEmptyDependencyAnalysis } from '../../analysis/dependency';
import {
  generateRenderCode,
  type RenderCodegenResult,
} from '../../codegen/render';
import { createEmptySlotAllocation } from '../../plan/slots';
import { createEmptyUpdaterGeneration } from '../../plan/updaters';
import { createEmptyOptimizationPass } from '../../transform/optimization';
import {
  collectRenderBoundaryBindings,
  collectRenderComponentBindings,
  collectRenderConditionBindings,
  collectRenderDynamicBindings,
  collectRenderKeepAliveBindings,
  collectRenderListBindings,
  collectRenderTeleportBindings,
  collectRenderTextBindings,
  collectRenderTransitionBindings,
} from './render-bindings';
import { lowerTemplateChildren } from './lowering/template-lowering';
import type { ComponentIR } from './types';

/**
 * 组件级 IR 入口。
 *
 * 这个模块把 AST 中的 `ComponentDeclaration` 下降为后续编译阶段统一消费的 `ComponentIR`，
 * 相当于“模板、响应式定义、生命周期元信息”汇总后的第一层中间表示入口。
 *
 * 它在整体流水线中的职责主要有三部分：
 * - 把组件声明中的 signals / computed / effects / lifecycle 等成员规范化到 IR；
 * - 调用模板 lowering，把模板子树转换成结构化模板 IR 与初始 render plan；
 * - 为后续优化、依赖分析、slot 分配、updater 生成等阶段准备默认占位数据。
 *
 * 这里刻意保持“只做结构归一化，不做行为优化”：
 * 生成的 IR 应尽量完整保留源组件语义，真正的折叠、合并、重写留给后续阶段处理。
 */
export const lowerComponentDeclarationToIR = (
  program: CompilerProgram,
  component: ComponentDeclaration
): ComponentIR => {
  // 模板 lowering 从根 children 开始，初始路径、slot、boundary 计数都置零。
  const template = lowerTemplateChildren(component.template.children, [], 0, 0);
  // 生命周期先转成 Set，后面生成布尔位时可以 O(1) 判断是否声明。
  const lifecycle = new Set(component.lifecycleHooks);
  const resourceSignalBindingMap = (() => {
    const tupleNames = new Set<string>();
    const map: Record<string, string> = {};

    component.setupBindings.forEach((binding) => {
      if (binding.kind !== 'field' || !binding.initializer) {
        return;
      }

      // `createResource(...)` 会先落成 setup tuple，第一轮先把 tuple 变量名记下来。
      if (/^createResource\s*\(/.test(binding.initializer.trim())) {
        tupleNames.add(binding.name);
      }
    });

    component.setupBindings.forEach((binding) => {
      if (binding.kind !== 'field' || !binding.initializer) {
        return;
      }

      const tupleMatch = binding.initializer
        .trim()
        .match(/^(?:this\.)?(__setup_tuple_\d+)\[(\d+)\]$/);
      if (!tupleMatch || !tupleNames.has(tupleMatch[1]!)) {
        return;
      }

      if (tupleMatch[2] === '0') {
        // tuple[0] 对应 resource signal 本体。
        map[binding.name] = `this.${binding.name}`;
      }

      if (tupleMatch[2] === '1') {
        // tuple[1] 暴露的是 resource 的辅助状态对象，这里展开成 loading/error 两个绑定入口。
        map[`${binding.name}.loading`] = `this.${binding.name}.loading`;
        map[`${binding.name}.error`] = `this.${binding.name}.error`;
      }
    });

    return map;
  })();
  const signalBindingMap = Object.fromEntries([
    // 普通信号默认绑定到组件实例字段，供 render 计划和表达式求值阶段复用。
    ...component.signals.map((signal) => [signal.name, `this.${signal.name}`]),
    ...component.signals
      .filter((signal) => signal.signalKind === 'property')
      // property signal 额外暴露底层 prop 存储字段，便于运行时代码区分读取来源。
      .map((signal) => [signal.name, `this.__prop_${signal.name}`]),
    ...Object.entries(resourceSignalBindingMap),
  ]);

  return {
    type: 'ComponentIR',
    name: component.name,
    sourceKind: program.sourceKind,
    props: component.signals
      .filter((signal) => signal.signalKind === 'property')
      // property signal 进入 props 列表，供类定义和属性声明代码生成使用。
      // 具体选项（default / attribute / reflect / converter / validator）不再固化进 IR，
      // 而是由运行时从 `static __laniaOptions` 求值，避免编译器只能吃字面量。
      .map((signal) => ({
        name: signal.name,
        initializer: signal.initializer,
      })),
    signals: component.signals
      .filter((signal) => signal.signalKind !== 'property')
      // 非 property signal 则继续保留为组件内部响应式状态。
      .map((signal) => ({
        name: signal.name,
        initializer: signal.initializer,
        order: signal.order,
      })),
    computed: component.computed.map((computed) => ({
      name: computed.name,
      expression: computed.expression,
    })),
    effects: component.effects.map((effect) => ({
      name: effect.name,
      body: effect.body,
    })),
    lifecycle: {
      connected: lifecycle.has('connectedCallback'),
      disconnected: lifecycle.has('disconnectedCallback'),
      adopted: lifecycle.has('adoptedCallback'),
      attributeChanged: lifecycle.has('attributeChangedCallback'),
      willUpdate: lifecycle.has('willUpdate'),
      updated: lifecycle.has('updated'),
      firstUpdated: lifecycle.has('firstUpdated'),
    },
    lifecycleCallbacks: component.lifecycleCallbacks.map(
      (callback: LifecycleCallbackDeclaration) => ({
        hook: callback.hook,
        params: callback.params,
        body: callback.body,
      })
    ),
    setupBindings: component.setupBindings.map(
      (binding: SetupBindingDeclaration) => ({
        name: binding.name,
        kind: binding.kind,
        params: binding.params,
        body: binding.body,
        initializer: binding.initializer,
        order: binding.order,
      })
    ),
    formAssociated: component.formAssociated ?? false,
    optionsSource: component.optionsSource,
    template: {
      type: 'TemplateIR',
      roots: template.nodes,
      slotCount: template.nextSlotIndex,
      boundaryCount: template.nextBoundaryIndex,
    },
    renderPlan: {
      // render plan 先承接 lowering 阶段已经能直接得出的静态结构与绑定索引。
      staticHtml: template.staticHtml,
      textBindings: collectRenderTextBindings(template.nodes),
      componentBindings: collectRenderComponentBindings(template.nodes),
      listBindings: collectRenderListBindings(template.nodes),
      conditionBindings: collectRenderConditionBindings(template.nodes),
      dynamicBindings: collectRenderDynamicBindings(template.nodes),
      boundaryBindings: collectRenderBoundaryBindings(template.nodes),
      transitionBindings: collectRenderTransitionBindings(template.nodes),
      keepAliveBindings: collectRenderKeepAliveBindings(template.nodes),
      teleportBindings: collectRenderTeleportBindings(template.nodes),
      runtimeUpdaters: [],
      signalBindingMap,
      storeBindingMap: {},
    },
    // 下游阶段都会在已有 IR 基础上填充这些字段，这里先提供明确的空结构。
    optimizationPass: createEmptyOptimizationPass(),
    dependencyAnalysis: createEmptyDependencyAnalysis(),
    slotAllocation: createEmptySlotAllocation(),
    updaterGeneration: createEmptyUpdaterGeneration(),
  };
};

export const lowerProgramToComponentIR = (
  program: CompilerProgram
): ComponentIR[] => {
  // 程序级 lowering 只是把每个组件声明独立映射为组件 IR，保持一对一关系。
  return program.body.map((component) =>
    lowerComponentDeclarationToIR(program, component)
  );
};

export const generateComponentRenderCode = (
  component: ComponentIR
): RenderCodegenResult => {
  // 代码生成阶段只消费已经整理好的 renderPlan / slot / updater 信息，不再回看原 AST。
  return generateRenderCode({
    className: component.name,
    staticHtml: component.renderPlan.staticHtml,
    textBindings: component.renderPlan.textBindings,
    componentBindings: component.renderPlan.componentBindings,
    listBindings: component.renderPlan.listBindings,
    conditionBindings: component.renderPlan.conditionBindings,
    dynamicBindings: component.renderPlan.dynamicBindings,
    boundaryBindings: component.renderPlan.boundaryBindings,
    transitionBindings: component.renderPlan.transitionBindings,
    keepAliveBindings: component.renderPlan.keepAliveBindings,
    teleportBindings: component.renderPlan.teleportBindings,
    allocatedSlots: component.slotAllocation.slots,
    runtimeUpdaters: component.renderPlan.runtimeUpdaters,
    signalBindingMap: component.renderPlan.signalBindingMap,
    storeBindingMap: component.renderPlan.storeBindingMap,
  });
};
