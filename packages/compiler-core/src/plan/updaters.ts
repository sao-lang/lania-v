/**
 * updater 生成。
 *
 * 根据 slot 分配结果、依赖分析结果和优化阶段的合并信息，
 * 产出运行时真正可注册的 updater 列表。
 *
 * 它在编译流程中的位置介于“分析完成”和“代码生成开始”之间，
 * 核心任务是把不同来源的数据整理成一份统一的 updater IR：
 * - slot 对应的更新动作会被转换成单 slot、条件或事件绑定 updater；
 * - 优化阶段已经合并的表达式组会生成 multi-slot updater；
 * - computed 与 effect 会保留为独立 updater，便于运行时按阶段调度。
 *
 * 这里不关心具体如何执行 DOM 更新，只负责把运行时需要知道的元信息
 * 例如触发阶段、依赖列表、关联 slot 等整理完整。
 */
import type { ComponentIR } from '../ir/component';
import type { DependencyEntryIR } from '../analysis/dependency';
import type { AllocatedSlotIR } from './slots';

export type GeneratedUpdaterKind =
  | 'single-slot'
  | 'multi-slot'
  | 'condition'
  | 'computed'
  | 'effect'
  | 'event-binding';

export interface GeneratedUpdaterIR {
  name: string;
  kind: GeneratedUpdaterKind;
  source: 'slot' | 'computed' | 'effect';
  phase: 'mount' | 'update' | 'effect';
  slotIndices: number[];
  dependencies: string[];
  expression: string;
}

export interface UpdaterGenerationIR {
  updaters: GeneratedUpdaterIR[];
  singleSlotUpdaterNames: string[];
  multiSlotUpdaterNames: string[];
  computedUpdaterNames: string[];
  effectUpdaterNames: string[];
}

export const createEmptyUpdaterGeneration = (): UpdaterGenerationIR => {
  return {
    updaters: [],
    singleSlotUpdaterNames: [],
    multiSlotUpdaterNames: [],
    computedUpdaterNames: [],
    effectUpdaterNames: [],
  };
};

const getEntryByUpdater = (
  component: ComponentIR,
  updaterName: string
): DependencyEntryIR | undefined => {
  // slot 分配阶段只知道 updater 名称，这里回查依赖分析结果补齐依赖元信息。
  return component.dependencyAnalysis.entries.find((entry) => entry.updater === updaterName);
};

// computed 以 memo 字段暴露后，读取既可能表现为调用 `this.x()`，
// 也可能表现为裸属性读取 `this.x`，两种形态都要按 computed 处理。
const isComputedDependency = (
  dependency: DependencyEntryIR['signalDependencies'][number],
  computedNames: ReadonlySet<string>
): boolean => {
  if (dependency.kind !== 'this-property-read' && dependency.kind !== 'this-signal-call') {
    return false;
  }

  return computedNames.has(dependency.name);
};

// computed 可以继续依赖 computed，因此展开必须递归到叶子 signal。
// 只展开一层会把中间 computed 名字留给 codegen，而 signalBindingMap 里没有这些名字，
// 最终既不生成 `.deps.add(...)`，运行时也就永远不会订阅到底层 signal。
const resolveLeafDependencies = (
  computedDependencyChain: Record<string, string[]>,
  computedNames: ReadonlySet<string>,
  name: string,
  chain: ReadonlySet<string> = new Set<string>()
): string[] => {
  if (!computedNames.has(name)) {
    return [name];
  }

  if (chain.has(name)) {
    // 循环引用的 computed 链在此截断，避免无限展开。
    return [];
  }

  const nextChain = new Set(chain).add(name);

  return (computedDependencyChain[name] ?? []).flatMap((dependency) =>
    resolveLeafDependencies(computedDependencyChain, computedNames, dependency, nextChain)
  );
};

const createSlotUpdater = (
  component: ComponentIR,
  slot: AllocatedSlotIR
): GeneratedUpdaterIR => {
  const entry = getEntryByUpdater(component, slot.updater);
  const computedNames = new Set(component.computed.map((computed) => computed.name));

  if (slot.type === 'event') {
    // 事件绑定只在挂载期执行，不参与 signal 驱动更新。
    // 因此事件 slot 虽然也进入统一 updater 清单，但 phase 固定为 mount。
    return {
      name: slot.updater,
      kind: 'event-binding',
      source: 'slot',
      phase: 'mount',
      slotIndices: [slot.slotIndex],
      dependencies: [],
      expression: slot.expression ?? '',
    };
  }

  if (slot.type === 'if') {
    // 条件插槽单独标成 condition，便于 render 阶段选择专用 updater 实现。
    return {
      name: slot.updater,
      kind: 'condition',
      source: 'slot',
      phase: 'update',
      slotIndices: [slot.slotIndex],
      dependencies: (() => {
        const dependencies = new Set<string>();
        const computedDependencyChain = component.dependencyAnalysis.computedDependencyChain;

        (entry?.signalDependencies ?? []).forEach((dependency) => {
          if (isComputedDependency(dependency, computedNames)) {
            // 条件依赖读到 computed 时递归展开成底层 signal 链，避免运行时只订阅表层 computed 名称。
            resolveLeafDependencies(
              computedDependencyChain,
              computedNames,
              dependency.name
            ).forEach((signalName) => dependencies.add(signalName));
            return;
          }

          if (dependency.kind === 'store-path-read') {
            // store 依赖保留为带路径前缀的键，便于后续区分普通 signal。
            dependencies.add(`store:${dependency.name}:${dependency.accessPath.join('.')}`);
            return;
          }

          dependencies.add(dependency.name);
        });

        return [...dependencies];
      })(),
      expression: slot.expression ?? '',
    };
  }

  return {
    name: slot.updater,
    kind: 'single-slot',
    source: 'slot',
    phase: 'update',
    slotIndices: [slot.slotIndex],
    dependencies: (() => {
      const dependencies = new Set<string>();
      const computedDependencyChain = component.dependencyAnalysis.computedDependencyChain;

      (entry?.signalDependencies ?? []).forEach((dependency) => {
        if (isComputedDependency(dependency, computedNames)) {
          // 单 slot updater 也遵循同样的递归 computed 依赖展开规则。
          resolveLeafDependencies(
            computedDependencyChain,
            computedNames,
            dependency.name
          ).forEach((signalName) => dependencies.add(signalName));
          return;
        }

        if (dependency.kind === 'store-path-read') {
          dependencies.add(`store:${dependency.name}:${dependency.accessPath.join('.')}`);
          return;
        }

        dependencies.add(dependency.name);
      });

      return [...dependencies];
    })(),
    expression: slot.expression ?? '',
  };
};

const createComputedUpdater = (entry: DependencyEntryIR): GeneratedUpdaterIR => {
  return {
    name: entry.updater,
    kind: 'computed',
    source: 'computed',
    phase: 'update',
    slotIndices: [],
    dependencies: entry.signalDependencies.map((dependency) => {
      if (dependency.kind === 'store-path-read') {
        return `store:${dependency.name}:${dependency.accessPath.join('.')}`;
      }
      // computed updater 直接保留依赖分析阶段得到的信号名。
      return dependency.name;
    }),
    expression: entry.expression,
  };
};

const createEffectUpdater = (entry: DependencyEntryIR): GeneratedUpdaterIR => {
  return {
    name: entry.updater,
    kind: 'effect',
    source: 'effect',
    phase: 'effect',
    slotIndices: [],
    dependencies: entry.signalDependencies.map((dependency) => {
      if (dependency.kind === 'store-path-read') {
        return `store:${dependency.name}:${dependency.accessPath.join('.')}`;
      }
      return dependency.name;
    }),
    expression: entry.expression,
  };
};

export const generateComponentUpdaters = (
  component: ComponentIR
): UpdaterGenerationIR => {
  // 优化阶段已合并的 slot，不再生成单独 updater。
  const mergedSlotIndices = new Set(
    component.optimizationPass.expressionMerges.flatMap((group) => group.slotIndices)
  );
  // 多 slot merge 直接转成运行时可消费的 updater 描述，保留优化阶段已有依赖结果。
  const mergedUpdaters = component.optimizationPass.expressionMerges.map((group) => ({
    name: group.updaterName,
    kind: 'multi-slot' as const,
    source: 'slot' as const,
    phase: 'update' as const,
    slotIndices: group.slotIndices,
    dependencies: group.dependencies,
    expression: group.expression,
  }));
  // 未被合并的 slot 继续按单 slot 规则生成 updater。
  const slotUpdaters = component.slotAllocation.slots
    .filter((slot) => !mergedSlotIndices.has(slot.slotIndex))
    .map((slot) => createSlotUpdater(component, slot));
  // computed / effect 不对应具体 slot，但也需要进入同一份运行时 updater 清单。
  const computedUpdaters = component.dependencyAnalysis.entries
    .filter((entry) => entry.source === 'computed')
    .map((entry) => createComputedUpdater(entry));
  const effectUpdaters = component.dependencyAnalysis.entries
    .filter((entry) => entry.source === 'effect')
    .map((entry) => createEffectUpdater(entry));
  const updaters = [
    ...slotUpdaters,
    ...mergedUpdaters,
    ...computedUpdaters,
    ...effectUpdaters,
  ];
  // 最终这份 updaters 列表就是代码生成阶段的“执行计划真相源”，
  // slot、computed、effect 都被压平成统一描述，便于后续按 phase/kind 分发。

  return {
    updaters,
    // 这些名称索引主要给代码生成和调试展示使用，因此统一排序保证稳定输出。
    singleSlotUpdaterNames: updaters
      .filter((updater) => updater.kind === 'single-slot')
      .map((updater) => updater.name)
      .sort(),
    multiSlotUpdaterNames: updaters
      .filter((updater) => updater.kind === 'multi-slot')
      .map((updater) => updater.name)
      .sort(),
    computedUpdaterNames: updaters
      .filter((updater) => updater.kind === 'computed')
      .map((updater) => updater.name)
      .sort(),
    effectUpdaterNames: updaters
      .filter((updater) => updater.kind === 'effect')
      .map((updater) => updater.name)
      .sort(),
  };
};
