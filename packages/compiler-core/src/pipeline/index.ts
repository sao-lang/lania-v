import type { CompilerProgram } from '../ast';
import { analyzeComponentDependencies } from '../analysis/dependency';
import {
  generateComponentRenderCode,
  lowerProgramToComponentIR,
  type ComponentIR,
} from '../ir/component';
import {
  optimizeComponentTemplate,
  optimizeComponentUpdaters,
} from '../transform/optimization';
import {
  applyAfterAnalyzePlugins,
  applyArtifactPlugins,
  applyBeforeAnalyzePlugins,
  applyProgramPlugins,
  applyTemplateTransformPlugins,
  type CompilerPluginOptions,
} from './plugins';
import type {
  RenderCodegenResult,
  RenderRuntimeUpdaterKind,
  RenderRuntimeUpdaterPlan,
} from '../codegen/render';
import { allocateComponentSlots } from '../plan/slots';
import { generateComponentUpdaters } from '../plan/updaters';

/**
 * 编译主管线。
 *
 * 这个模块负责把“前端 AST”一路串成“可运行产物”：
 * 1. 先对整份 `CompilerProgram` 执行程序级插件，允许做预处理或补充元信息。
 * 2. 再把每个组件 lowering 成 `ComponentIR`，让模板、状态、生命周期进入统一中间表示。
 * 3. 在组件粒度上依次执行模板转换、静态优化、依赖分析、slot 分配与 updater 规划。
 * 4. 最后把 render/SSR 代码生成结果封装成 artifact，并交给产物后置插件继续加工。
 *
 * 这里刻意把每个阶段拆得比较细，原因是：
 * - 前半段偏“语义整理”，决定组件真实依赖和模板结构；
 * - 后半段偏“执行计划生成”，决定运行时需要挂载哪些 slot 与 updater；
 * - 插件钩子可以稳定插在阶段边界上，避免直接耦合到某个实现细节函数。
 */

export interface ComponentCompilationArtifact {
  component: ComponentIR;
  renderCode: RenderCodegenResult;
}

export interface CompilerPipelineResult {
  program: CompilerProgram;
  components: ComponentCompilationArtifact[];
}

const toRenderRuntimeUpdaterKind = (
  kind: ComponentIR['updaterGeneration']['updaters'][number]['kind']
): RenderRuntimeUpdaterKind | null => {
  switch (kind) {
    case 'single-slot':
    case 'multi-slot':
    case 'condition':
    case 'effect':
      return kind;
    case 'computed':
      return 'single-slot';
    case 'event-binding':
      return null;
  }
};

export const runComponentCompilerPipeline = (
  program: CompilerProgram,
  options: CompilerPluginOptions = {}
): CompilerPipelineResult => {
  const plugins = options.plugins ?? [];
  // 程序级插件最先执行，让后续 lowering/分析基于插件修正后的 AST 工作。
  applyProgramPlugins(program, plugins);

  const components = lowerProgramToComponentIR(program).map((component) => {
    // 先做模板级改写和静态优化，再进入依赖分析，保证分析基于最终 IR。
    applyTemplateTransformPlugins(component, plugins);
    optimizeComponentTemplate(component);
    applyBeforeAnalyzePlugins(component, plugins);
    component.dependencyAnalysis = analyzeComponentDependencies(component);

    // 把 store 读取路径转成 codegen 可直接消费的订阅描述：
    // key 负责唯一标识依赖边，value 则保留“实例字段 + 稳定路径”这组信息。
    //
    // 这样运行时不需要重新做依赖追踪或路径 diff，仍然沿用
    // “依赖图由编译器一次性决定”的模型。
    (() => {
      const storeBindings = component.dependencyAnalysis.storePathReads ?? {};
      const storeBindingMap: Record<string, string> = {};
      const storeNames = Object.keys(storeBindings);
      if (storeNames.length === 0) {
        component.renderPlan.storeBindingMap = {};
        return;
      }

      // 这里只保留可以稳定序列化的路径片段。
      // 一旦遇到动态下标（如 `[expr]`），就截断到最后一个静态前缀，
      // 避免在编译期为不可静态命名的深层路径生成不可靠 key。
      for (const storeName of storeNames) {
        const paths = storeBindings[storeName] ?? [];
        for (const rawPath of paths) {
          const stable: Array<string | number> = [];
          for (const segment of rawPath) {
            if (segment.startsWith('[') && segment.endsWith(']')) {
              break;
            }
            if (/^-?\d+$/.test(segment)) {
              stable.push(Number(segment));
            } else {
              stable.push(segment);
            }
          }

          if (stable.length === 0) {
            continue;
          }

          const key = `store:${storeName}:${stable.map((seg) => String(seg)).join('.')}`;
          storeBindingMap[key] = `this.${storeName}, ${JSON.stringify(stable)}`;
        }
      }

      component.renderPlan.storeBindingMap = storeBindingMap;
    })();

    applyAfterAnalyzePlugins(component, plugins);
    // slot 分配先于 updater 生成，后者需要知道每种绑定最终映射到哪些 slot。
    component.slotAllocation = allocateComponentSlots(component);
    component.updaterGeneration = generateComponentUpdaters(component);
    // 合并 updater 后需要重新生成一次，确保 render plan 看到的是最新结果。
    optimizeComponentUpdaters(component);
    component.updaterGeneration = generateComponentUpdaters(component);
    const runtimeRenderableSlotIndices = new Set(
      component.slotAllocation.slots
        .filter((slot) =>
          [
            'text',
            'component',
            'for',
            'if',
            'dynamic',
            'boundary',
            'transition',
            'keepalive',
            'teleport',
            'attribute',
            'property',
            'style',
            'class',
            'ref',
            'directive',
          ].includes(slot.type)
        )
        .map((slot) => slot.slotIndex)
    );
    component.renderPlan.runtimeUpdaters = component.updaterGeneration.updaters
      .filter((updater) =>
        updater.slotIndices.length === 0
          ? updater.kind === 'effect'
          : updater.slotIndices.every((slotIndex) =>
              runtimeRenderableSlotIndices.has(slotIndex)
            )
      )
      .flatMap((updater): RenderRuntimeUpdaterPlan[] => {
        const kind = toRenderRuntimeUpdaterKind(updater.kind);

        if (!kind) {
          return [];
        }

        if (kind === 'single-slot' && updater.slotIndices.length === 0) {
          return [];
        }

        // render 阶段只保留“能在挂载期执行”的 updater。
        // 事件绑定会走独立分配与安装流程，因此不进入 runtimeUpdaters。
        return [
          {
            name: updater.name,
            kind,
            slotIndices: updater.slotIndices,
            dependencies: updater.dependencies,
            expression: updater.expression,
            priority:
              component.dependencyAnalysis.crossComponentAnalysis
                .updaterPriorities[updater.name],
          },
        ];
      });

    const artifact = {
      component,
      renderCode: generateComponentRenderCode(component),
    };

    applyArtifactPlugins(artifact, plugins);
    return artifact;
  });

  return {
    program,
    components,
  };
};

export * from './plugins';
