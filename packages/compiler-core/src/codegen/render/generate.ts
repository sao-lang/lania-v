import {
  collectChildPayloadDependencyKeys,
  collectChildPayloadHoists,
  renderChildPayloadBindings,
} from './payload';
import type { TemplateIRNode } from '../../ir/component';
import type {
  RenderCodegenOptions,
  RenderCodegenResult,
  RenderRuntimeUpdaterPlan,
} from './types';

/**
 * CSR 渲染代码生成。
 *
 * 这个模块负责把 render plan 进一步落成“真正写进组件类中的运行时代码字符串”。
 * 它和 SSR 代码生成的区别在于：
 * 1. SSR 产出的是字符串拼接表达式；
 * 2. 这里产出的是 DOM 挂载、slot 初始化、updater 注册与首轮写入逻辑。
 *
 * 输入是已经完成 lowering / slot 分配 / updater 规划后的 render plan，
 * 输出则是两部分：
 * 1. 若干静态模板 hoist 声明；
 * 2. 组件实例方法 `_renderAndMount()` 的完整源码。
 *
 * 可以把这里理解为“编译期生成运行时代码的最后一道拼装层”：
 * 前面的阶段决定“需要什么 slot / updater / payload”，
 * 这里负责决定“这些东西如何以源码形式被声明、初始化并串起来执行”。
 *
 * 另外，这里还要同时照顾 hydration 约束：
 * SSR 已经吐出去的节点结构、slot 锚点位置和 block payload 形状，
 * 都要求 CSR 初始化时按固定顺序恢复，否则首轮挂载和后续更新会错位。
 *
 * 由于这里直接输出源码字符串，任何顺序抖动都会放大成快照差异；
 * 所以实现上会尽量把 hoist、slot、updater、首轮写入拆成线性阶段，
 * 让生成结果既稳定又方便人工读回。
 */

// 统一给生成出来的多行源码做缩进，保证最终类代码仍然可读。
const indent = (source: string, level = 1): string => {
  const prefix = '  '.repeat(level);

  return source
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
};

// 编译期路径使用数字数组表示，落成源码时直接序列化为字面量数组。
const getPathExpression = (path: readonly number[]): string => `[${path.join(', ')}]`;

export const generateRenderCode = ({
  className,
  staticHtml,
  textBindings,
  componentBindings = [],
  listBindings = [],
  conditionBindings = [],
  dynamicBindings = [],
  boundaryBindings = [],
  transitionBindings = [],
  keepAliveBindings = [],
  teleportBindings = [],
  allocatedSlots = [],
  runtimeUpdaters = [],
  signalBindingMap = {},
  storeBindingMap = {},
  hoistName = `__${className}_staticTemplate`,
}: RenderCodegenOptions): RenderCodegenResult => {
  // 先根据 render plan 预计算一批局部辅助函数和分类索引，后续模板串接会更直接。
  // 某些静态模板除了 hoist 名本身，还会生成一个 `xxx_factory` 用于按需 clone childNodes。
  const getFactoryName = (templateHoistName: string): string => `${templateHoistName}_factory`;
  // 一部分特殊 block slot 会拥有“专属 updater”，这里通过 slot 反查规划结果。
  const findRuntimeUpdaterForSlot = (slotIndex: number): RenderRuntimeUpdaterPlan | undefined => {
    return runtimeUpdaters.find(
      (updater) => updater.slotIndices.length === 1 && updater.slotIndices[0] === slotIndex
    );
  };
  // 这些 slot 会在后面单独生成 payload updater，因此需要从通用 updater 声明中排除。
  const specialRuntimeUpdaterSlotIndices = new Set<number>([
    ...conditionBindings.map((binding) => binding.slotIndex),
    ...dynamicBindings.map((binding) => binding.slotIndex),
    ...boundaryBindings.map((binding) => binding.slotIndex),
    ...transitionBindings.map((binding) => binding.slotIndex),
    ...keepAliveBindings.map((binding) => binding.slotIndex),
    ...teleportBindings.map((binding) => binding.slotIndex),
  ]);
  const createRuntimeUpdaterDeclaration = (
    updaterName: string,
    expression: string,
    slotReference: string,
    dependencies: readonly string[],
    priority: string,
    ctor: 'SimpleUpdater' | 'ConditionUpdater' = 'SimpleUpdater',
    autoRegister = false
  ): string => {
    // updater 依赖既可能直接来自 signal，也可能来自 store path signal，这里统一展开。
    const dependencyLines = dependencies.flatMap((dependency) => {
      const direct = signalBindingMap[dependency];
      if (typeof direct === 'string') {
        return [`${updaterName}.deps.add(${direct});`];
      }

      const store = storeBindingMap[dependency];
      if (typeof store === 'string') {
        return [`${updaterName}.deps.add(getStorePathSignal(${store}));`];
      }

      return [];
    });

    return [
      // 生成的 updater 构造代码保持“先声明，再补依赖，再按需注册”的固定顺序。
      `const ${updaterName} = new ${ctor}(() => (${expression}), ${slotReference}, '${priority}', this._scheduler, this._slotTable);`,
      ...dependencyLines,
      ...(autoRegister ? [`this.registerRuntimeUpdater(${updaterName});`] : []),
    ].join('\n');
  };
  // 所有 hoist 在这里一次性铺平，后续方法体只引用名字，不再关心模板来源细节。
  // 所有需要复用的静态 HTML 模板都在方法外 hoist，避免每次实例化时重复创建 template。
  //
  // 同一条条件绑定可能同时出现在顶层与嵌套收集结果中，这里按 hoist 名去重，
  // 避免生成重复的 const 声明（esbuild / tsc 都会直接报错）。
  const emittedHoistNames = new Set<string>([hoistName]);
  const uniqueConditionHoists = conditionBindings.filter((binding) => {
    if (emittedHoistNames.has(binding.hoistName)) {
      return false;
    }
    emittedHoistNames.add(binding.hoistName);
    return true;
  });
  // 子 payload 的 hoist 收集必须与上面的主 hoist 共享同一份去重集合：
  // 嵌套 block 的模板名会同时出现在 `conditionBindings` 与 children 里，
  // 两边各自去重仍会产生重复的 const 声明。
  const collectUniqueChildPayloadHoists = (nodes: readonly TemplateIRNode[]): string[] =>
    collectChildPayloadHoists(nodes, emittedHoistNames);

  // 其它 binding 类型（list / dynamic / boundary / transition / keepAlive / teleport）
  // 也会 hoist 各自的模板名，先统一登记，后续子 payload 收集才不会重复。
  const rememberHoist = (name: string | undefined): void => {
    if (name) {
      emittedHoistNames.add(name);
    }
  };
  listBindings.forEach((binding) => {
    rememberHoist(binding.fallbackHoistName);
    rememberHoist(binding.keyedItemHoistName);
    rememberHoist(binding.itemTemplateHoistName);
  });
  [...dynamicBindings, ...boundaryBindings, ...transitionBindings, ...keepAliveBindings, ...teleportBindings].forEach(
    (binding) => rememberHoist(binding.hoistName)
  );
  const hoists = [
    `const ${hoistName} = createStaticTemplate(${JSON.stringify(staticHtml)});`,
    ...uniqueConditionHoists.map(
      (binding) =>
        `const ${binding.hoistName} = createStaticTemplate(${JSON.stringify(binding.templateHtml)});
const ${getFactoryName(binding.hoistName)} = () => [...${binding.hoistName}.clone().childNodes];`
    ),
    ...uniqueConditionHoists
      .filter((binding) => binding.fallbackTemplateHtml && binding.fallbackHoistName)
      .filter((binding) => {
        if (emittedHoistNames.has(binding.fallbackHoistName!)) {
          return false;
        }
        emittedHoistNames.add(binding.fallbackHoistName!);
        return true;
      })
      .map(
        (binding) =>
          `const ${binding.fallbackHoistName} = createStaticTemplate(${JSON.stringify(binding.fallbackTemplateHtml)});
const ${getFactoryName(binding.fallbackHoistName!)} = () => [...${binding.fallbackHoistName}.clone().childNodes];`
      ),
    ...listBindings
      .filter((binding) => binding.fallbackTemplateHtml && binding.fallbackHoistName)
      .map(
        (binding) =>
          `const ${binding.fallbackHoistName} = createStaticTemplate(${JSON.stringify(binding.fallbackTemplateHtml)});
const ${getFactoryName(binding.fallbackHoistName!)} = () => [...${binding.fallbackHoistName}.clone().childNodes];`
      ),
    ...listBindings
      .filter((binding) => binding.keyedItemTemplateHtml && binding.keyedItemHoistName)
      .map(
        (binding) =>
          `const ${binding.keyedItemHoistName} = createStaticTemplate(${JSON.stringify(binding.keyedItemTemplateHtml!)});`
      ),
    ...listBindings
      .filter((binding) => binding.itemTemplateHtml && binding.itemTemplateHoistName)
      .map(
        (binding) =>
          `const ${binding.itemTemplateHoistName} = createStaticTemplate(${JSON.stringify(binding.itemTemplateHtml!)});`
      ),
    ...dynamicBindings.map(
      (binding) =>
        `const ${binding.hoistName} = createStaticTemplate(${JSON.stringify(binding.templateHtml)});
const ${getFactoryName(binding.hoistName)} = () => [...${binding.hoistName}.clone().childNodes];`
    ),
    ...boundaryBindings.map(
      (binding) =>
        `const ${binding.hoistName} = createStaticTemplate(${JSON.stringify(binding.templateHtml)});
const ${getFactoryName(binding.hoistName)} = () => [...${binding.hoistName}.clone().childNodes];`
    ),
    ...boundaryBindings
      .filter((binding) => binding.fallbackTemplateHtml && binding.fallbackHoistName)
      .map(
        (binding) =>
          `const ${binding.fallbackHoistName} = createStaticTemplate(${JSON.stringify(binding.fallbackTemplateHtml!)});
const ${getFactoryName(binding.fallbackHoistName!)} = () => [...${binding.fallbackHoistName!}.clone().childNodes];`
      ),
    ...transitionBindings.map(
      (binding) =>
        `const ${binding.hoistName} = createStaticTemplate(${JSON.stringify(binding.templateHtml)});
const ${getFactoryName(binding.hoistName)} = () => [...${binding.hoistName}.clone().childNodes];`
    ),
    ...transitionBindings
      .filter((binding) => binding.fallbackTemplateHtml && binding.fallbackHoistName)
      .map(
        (binding) =>
          `const ${binding.fallbackHoistName} = createStaticTemplate(${JSON.stringify(binding.fallbackTemplateHtml!)});
const ${getFactoryName(binding.fallbackHoistName!)} = () => [...${binding.fallbackHoistName!}.clone().childNodes];`
      ),
    ...keepAliveBindings.map(
      (binding) =>
        `const ${binding.hoistName} = createStaticTemplate(${JSON.stringify(binding.templateHtml)});
const ${getFactoryName(binding.hoistName)} = () => [...${binding.hoistName}.clone().childNodes];`
    ),
    ...teleportBindings.map(
      (binding) =>
        `const ${binding.hoistName} = createStaticTemplate(${JSON.stringify(binding.templateHtml)});
const ${getFactoryName(binding.hoistName)} = () => [...${binding.hoistName}.clone().childNodes];`
    ),
    ...collectUniqueChildPayloadHoists(
      conditionBindings.flatMap((binding) => [
        ...(binding.children ?? []),
        ...(binding.fallbackChildren ?? []),
      ])
    ),
    ...collectUniqueChildPayloadHoists(dynamicBindings.flatMap((binding) => binding.children ?? [])),
    ...collectUniqueChildPayloadHoists(boundaryBindings.flatMap((binding) => binding.children ?? [])),
    ...collectUniqueChildPayloadHoists(transitionBindings.flatMap((binding) => binding.children ?? [])),
    ...collectUniqueChildPayloadHoists(keepAliveBindings.flatMap((binding) => binding.children ?? [])),
    ...collectUniqueChildPayloadHoists(teleportBindings.flatMap((binding) => binding.children ?? [])),
  ];

  // 以下各组声明负责把“编译期 slot 规划”翻译成“运行时 slot 实例化代码”。
  const textSlotDeclarations = textBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveTextSlotNode(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new TextSlot(slot${binding.slotIndex}Node, ${binding.slotIndex}));`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const listSlotDeclarations = listBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new ForSlot(`,
      `  slot${binding.slotIndex}Node,`,
      `  ${binding.slotIndex},`,
      binding.fallbackHoistName
        ? `  ${getFactoryName(binding.fallbackHoistName)},`
        : '  undefined,',
      `));`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      // hydration 时优先复用 SSR 产出的现有节点，而不是立即重写列表内容。
      `  slot${binding.slotIndex}.hydrate(readHydrationSlotNodes(mounted, ${binding.slotIndex}));`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const componentSlotDeclarations = componentBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new ComponentSlot(slot${binding.slotIndex}Node, ${JSON.stringify(binding.tagName)}, ${binding.slotIndex}));`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const conditionSlotDeclarations = conditionBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new IfSlot(slot${binding.slotIndex}Node, ${binding.hoistName}, ${binding.slotIndex}, ${binding.fallbackHoistName ?? 'undefined'}));`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      `  slot${binding.slotIndex}.hydrate(readHydrationSlotNodes(mounted, ${binding.slotIndex}), Boolean(${binding.expression}));`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const teleportSlotDeclarations = teleportBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new TeleportSlot(slot${binding.slotIndex}Node, ${binding.hoistName}, ${binding.slotIndex}));`,
      `const slot${binding.slotIndex}HydratedNodes = readTeleportNodes(mounted, ${binding.slotIndex}, ${binding.targetExpression});`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      // Teleport 的 hydration 节点不在当前位置，需要去目标容器里重新读回。
      `  slot${binding.slotIndex}.hydrate(slot${binding.slotIndex}HydratedNodes, ${binding.targetExpression});`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const dynamicSlotDeclarations = dynamicBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new DynamicSlot(slot${binding.slotIndex}Node, ${binding.hoistName}, ${binding.slotIndex}));`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      // 动态块 hydration 先复用 SSR 节点，后续再交给 payload/updater 接管组件切换。
      `  slot${binding.slotIndex}.hydrate(readHydrationSlotNodes(mounted, ${binding.slotIndex}));`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const boundarySlotDeclarations = boundaryBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new BoundarySlot(slot${binding.slotIndex}Node, ${binding.hoistName}, ${binding.slotIndex}, ${binding.fallbackHoistName ?? 'undefined'}));`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      // Boundary 在 hydration 时不仅接回已有节点，还要顺手恢复运行时继续下钻所需的 payload 绑定。
      `  slot${binding.slotIndex}.hydrate(readHydrationSlotNodes(mounted, ${binding.slotIndex}), { __lania_boundary: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const transitionSlotDeclarations = transitionBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new BoundarySlot(slot${binding.slotIndex}Node, ${binding.hoistName}, ${binding.slotIndex}, ${binding.fallbackHoistName ?? 'undefined'}));`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      // Transition 与 Boundary 共用 block payload 外壳，差别主要体现在 payload 内容和运行时消费方式。
      `  slot${binding.slotIndex}.hydrate(readHydrationSlotNodes(mounted, ${binding.slotIndex}), { __lania_boundary: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const keepAliveSlotDeclarations = keepAliveBindings.map((binding) => {
    return [
      `const slot${binding.slotIndex}Node = resolveSlotAnchor(mounted, ${binding.slotIndex}, [${binding.path.join(', ')}]);`,
      `const slot${binding.slotIndex} = this.registerSlot(new KeepAliveSlot(slot${binding.slotIndex}Node, ${binding.hoistName}, ${binding.slotIndex}));`,
      `if (hasHydrationSlot(mounted, ${binding.slotIndex})) {`,
      // KeepAlive 先拿回已有 DOM，再由后续 updater 决定是否替换、缓存或复用子树。
      `  slot${binding.slotIndex}.hydrate(readHydrationSlotNodes(mounted, ${binding.slotIndex}));`,
      `}`,
      `this._slots[${binding.slotIndex}] = slot${binding.slotIndex}.node;`,
    ].join('\n');
  });
  const interactiveSlots = allocatedSlots.filter((slot) =>
    ['attribute', 'property', 'style', 'class', 'event', 'ref', 'directive'].includes(slot.type)
  );
  // 这类 slot 直接指向真实 DOM 节点，初始化阶段只需解析路径并构造对应包装器。
  const interactiveSlotDeclarations = interactiveSlots.map((slot) => {
    const pathExpression = getPathExpression(slot.path);

    switch (slot.type) {
      case 'attribute':
        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
          `const slot${slot.slotIndex} = this.registerSlot(new AttrSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.name ?? '')}, ${slot.slotIndex}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node;`,
        ].join('\n');
      case 'property':
        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as Element | HTMLElement;`,
          `const slot${slot.slotIndex} = this.registerSlot(new PropSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.name ?? '')}, ${slot.slotIndex}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node as unknown as Node;`,
        ].join('\n');
      case 'style':
        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
          `const slot${slot.slotIndex} = this.registerSlot(new StyleSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.name ?? '')}, ${slot.slotIndex}, ${JSON.stringify(slot.unit ?? '')}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node;`,
        ].join('\n');
      case 'class':
        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
          `const slot${slot.slotIndex} = this.registerSlot(new ClassSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.name ?? '')}, ${slot.slotIndex}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node;`,
        ].join('\n');
      case 'event':
        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
          `const slot${slot.slotIndex} = this.registerSlot(new EventSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.eventName ?? slot.name ?? 'click')}, ${slot.slotIndex}, ${slot.listener ? JSON.stringify(slot.listener) : 'undefined'}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node as unknown as Node;`,
        ].join('\n');
      case 'ref':
        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression});`,
          `const slot${slot.slotIndex} = this.registerSlot(new RefSlot(slot${slot.slotIndex}Node, ${slot.slotIndex}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node as unknown as Node;`,
        ].join('\n');
      case 'directive':
        if (slot.directiveKind === 'model') {
          return [
            `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
            `const slot${slot.slotIndex} = this.registerSlot(new ModelBindingSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.name ?? 'value')}, ${slot.slotIndex}, ${JSON.stringify(slot.modifiers ?? [])}));`,
            `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node;`,
          ].join('\n');
        }

        if (slot.directiveKind === 'use') {
          return [
            `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
            `const slot${slot.slotIndex} = this.registerSlot(new UseDirectiveSlot(slot${slot.slotIndex}Node, ${slot.slotIndex}));`,
            `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node;`,
          ].join('\n');
        }

        return [
          `const slot${slot.slotIndex}Node = resolveMountedTemplateNode(mounted, ${pathExpression}) as HTMLElement;`,
          `const slot${slot.slotIndex} = this.registerSlot(new DirectiveBindingSlot(slot${slot.slotIndex}Node, ${JSON.stringify(slot.directiveKind === 'html' ? 'html' : (slot.name ?? 'value'))}, ${slot.slotIndex}));`,
          `this._slots[${slot.slotIndex}] = slot${slot.slotIndex}.node;`,
        ].join('\n');
      default:
        return '';
    }
  });
  const slotDeclarations: string[] = [];
  const declaredSlotIndices = new Set<number>();

  const processSlotDeclaration = (declaration: string): void => {
    const match = declaration.match(/const\s+slot(\d+)(Node|)/);
    if (match) {
      const index = Number(match[1]);
      if (declaredSlotIndices.has(index)) {
        // 不同绑定阶段可能尝试声明同一个 slot，这里按 slotIndex 去重，防止生成重复变量。
        return;
      }
      declaredSlotIndices.add(index);
    }
    // 去重后仍保留首次出现顺序，避免最终 `_renderAndMount()` 中 slot 声明跳来跳去。
    slotDeclarations.push(declaration);
  };

  textSlotDeclarations.forEach(processSlotDeclaration);
  componentSlotDeclarations.forEach(processSlotDeclaration);
  listSlotDeclarations.forEach(processSlotDeclaration);
  conditionSlotDeclarations.forEach(processSlotDeclaration);
  dynamicSlotDeclarations.forEach(processSlotDeclaration);
  boundarySlotDeclarations.forEach(processSlotDeclaration);
  transitionSlotDeclarations.forEach(processSlotDeclaration);
  keepAliveSlotDeclarations.forEach(processSlotDeclaration);
  teleportSlotDeclarations.forEach(processSlotDeclaration);
  interactiveSlotDeclarations.forEach(processSlotDeclaration);

  // slot 声明顺序刻意按“文本 -> block -> 交互”的线性阶段输出，方便调试生成结果。
  // 完成去重后的 slot 声明会原样插入 `_renderAndMount()`，保持生成结果线性可读。
  const finalSlotDeclarations = slotDeclarations.join('\n');

  // block 类 slot 的 updater 并不是简单把值写入文本/属性，而是写入结构化 payload。
  const payloadRuntimeUpdaterDeclarations = conditionBindings
    .map((binding) => {
      const updater = findRuntimeUpdaterForSlot(binding.slotIndex);
      if (!updater) {
        // 某些 block slot 可能没有独立 runtime updater，首轮写入即可覆盖其需求。
        return '';
      }

      const truthyBindings = binding.children ? `[${renderChildPayloadBindings(binding.children).join(', ')}]` : '[]';
      const falsyBindings = binding.fallbackChildren ? `[${renderChildPayloadBindings(binding.fallbackChildren).join(', ')}]` : '[]';
      const payloadDependencies = [
        ...updater.dependencies,
        ...collectChildPayloadDependencyKeys(
          [...(binding.children ?? []), ...(binding.fallbackChildren ?? [])],
          signalBindingMap,
          storeBindingMap
        ),
      ];
      return createRuntimeUpdaterDeclaration(
        updater.name,
        // `IfSlot` 的 payload 既要包含条件值，也要包含真/假分支子绑定描述。
        `({ __lania_if: "block", when: ${binding.expression}, mode: ${binding.mode ? JSON.stringify(binding.mode) : 'undefined'}, truthyBindings: ${truthyBindings}, falsyBindings: ${falsyBindings} })`,
        `slot${binding.slotIndex}`,
        payloadDependencies,
        updater.priority ?? 'high',
        'ConditionUpdater',
        true
      );
    })
    // 各类 block slot 分组串接，而不是先拍平成一个列表，目的是保持生成结果与 slot 声明顺序一致。
    .concat(
      dynamicBindings.map((binding) => {
        const updater = findRuntimeUpdaterForSlot(binding.slotIndex);
        if (!updater) {
          return '';
        }

        const payloadDependencies = [
          ...updater.dependencies,
          ...collectChildPayloadDependencyKeys(binding.children ?? [], signalBindingMap, storeBindingMap),
        ];
        return createRuntimeUpdaterDeclaration(
          updater.name,
          // 动态组件在运行时需要同时拿到组件引用、props 和子绑定 payload。
          `({ __lania_dynamic: "block", component: ${binding.componentExpression}, props: ${binding.propsExpression}, childBindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] })`,
          `slot${binding.slotIndex}`,
          payloadDependencies,
          updater.priority ?? 'normal',
          'SimpleUpdater',
          true
        );
      })
    )
    .concat(
      boundaryBindings.map((binding) => {
        const updater = findRuntimeUpdaterForSlot(binding.slotIndex);
        if (!updater) {
          return '';
        }

        const payloadDependencies = [
          ...updater.dependencies,
          ...collectChildPayloadDependencyKeys(binding.children ?? [], signalBindingMap, storeBindingMap),
        ];
        return createRuntimeUpdaterDeclaration(
          updater.name,
          `({ __lania_boundary: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] })`,
          `slot${binding.slotIndex}`,
          payloadDependencies,
          updater.priority ?? 'normal',
          'SimpleUpdater',
          true
        );
      })
    )
    .concat(
      transitionBindings.map((binding) => {
        const updater = findRuntimeUpdaterForSlot(binding.slotIndex);
        if (!updater) {
          return '';
        }

        const payloadDependencies = [
          ...updater.dependencies,
          ...collectChildPayloadDependencyKeys(binding.children ?? [], signalBindingMap, storeBindingMap),
        ];
        return createRuntimeUpdaterDeclaration(
          updater.name,
          `({ __lania_boundary: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] })`,
          `slot${binding.slotIndex}`,
          payloadDependencies,
          updater.priority ?? 'normal',
          'SimpleUpdater',
          true
        );
      })
    )
    .concat(
      keepAliveBindings.map((binding) => {
        const updater = findRuntimeUpdaterForSlot(binding.slotIndex);
        if (!updater) {
          return '';
        }

        const payloadDependencies = [
          ...updater.dependencies,
          ...collectChildPayloadDependencyKeys(binding.children ?? [], signalBindingMap, storeBindingMap),
        ];
        return createRuntimeUpdaterDeclaration(
          updater.name,
          `({ __lania_keepalive: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] })`,
          `slot${binding.slotIndex}`,
          payloadDependencies,
          updater.priority ?? 'normal',
          'SimpleUpdater',
          true
        );
      })
    )
    .concat(
      teleportBindings.map((binding) => {
        const updater = findRuntimeUpdaterForSlot(binding.slotIndex);
        if (!updater) {
          return '';
        }

        const payloadDependencies = [
          ...updater.dependencies,
          ...collectChildPayloadDependencyKeys(binding.children ?? [], signalBindingMap, storeBindingMap),
        ];
        return createRuntimeUpdaterDeclaration(
          updater.name,
          `({ __lania_teleport: "block", target: ${binding.targetExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] })`,
          `slot${binding.slotIndex}`,
          payloadDependencies,
          updater.priority ?? 'normal',
          'SimpleUpdater',
          true
        );
      })
    )
    .filter((declaration) => declaration.length > 0)
    .join('\n');

  // 过滤掉已经被“专属 payload updater”接管的条目，剩余的才走通用 updater 声明逻辑。
  const declaredRuntimeUpdaters = runtimeUpdaters.filter(
    (updater) =>
      updater.slotIndices.length === 0 ||
      !updater.slotIndices.some((slotIndex) => specialRuntimeUpdaterSlotIndices.has(slotIndex))
  );

  const runtimeUpdaterDeclarations = declaredRuntimeUpdaters
    .map((updater) => {
      const slotReference =
        updater.slotIndices.length === 1
          ? `slot${updater.slotIndices[0]}`
          // 多 slot updater 会同时驱动多个目标，构造函数接收的是 slot 引用数组。
          : `[${updater.slotIndices.map((slotIndex) => `slot${slotIndex}`).join(', ')}]`;
      const ctor =
        updater.kind === 'condition'
          ? 'ConditionUpdater'
          : updater.kind === 'multi-slot'
            ? 'MultiSlotUpdater'
            : updater.kind === 'effect'
              ? 'EffectUpdater'
              : 'SimpleUpdater';
      // effect updater 的表达式本身是语句块，其它 updater 默认是可直接返回的表达式。
      // 对象字面量开头的表达式必须补括号，否则箭头函数体会被解析成语句块。
      const updaterExpression = updater.expression.trim();
      const normalizedExpression = updaterExpression.startsWith('{')
        ? `(${updaterExpression})`
        : updaterExpression;
      const evaluate =
        updater.kind === 'effect'
          ? `() => {
${indent(updater.expression, 1)}
}`
          : `() => ${normalizedExpression}`;
      const ctorArgs =
        updater.kind === 'effect'
          ? `${evaluate}, 'low', this._scheduler`
          : `${evaluate}, ${slotReference}, '${updater.priority ?? (updater.kind === 'condition' ? 'high' : 'normal')}', this._scheduler, this._slotTable`;
      // 依赖挂接阶段继续沿用 signal/store 两套来源，避免 codegen 层丢失分析阶段的细分结果。
      const dependencyLines = updater.dependencies.flatMap((dependency) => {
        const direct = signalBindingMap[dependency];
        if (typeof direct === 'string') {
          return [`${updater.name}.deps.add(${direct});`];
        }

        const store = storeBindingMap[dependency];
        if (typeof store === 'string') {
          return [`${updater.name}.deps.add(getStorePathSignal(${store}));`];
        }

        return [];
      });

      // 统一输出“声明 -> 依赖挂接”格式，便于调试生成代码时直接肉眼比对。
      return [
        `const ${updater.name} = new ${ctor}(${ctorArgs});`,
        ...dependencyLines,
      ].join('\n');
    })
    .join('\n');

  // 首次挂载时的“立即写入”代码。
  // 它和 updater 的区别在于：这里负责初次把当前状态渲染到 DOM，
  // 后续状态变化才交给 updater 调度。
  const renderBindingsBody = textBindings
    .map((binding) => `slot${binding.slotIndex}.write(${binding.expression});`)
    .concat(
      componentBindings.map((binding) => `slot${binding.slotIndex}.write(${binding.propsExpression});`)
    )
    .concat(
      listBindings.map((binding) => {
        const expression =
          binding.itemTemplateHoistName && binding.itemBindingsExpression
            ? `({ __lania_for: "slots", items: ${binding.expression}, template: ${binding.itemTemplateHoistName}, bindings: ${binding.itemBindingsExpression} })`
            : binding.expression;
        return `if (!hasHydrationSlot(mounted, ${binding.slotIndex})) {
  // SSR 已经吐出真实内容时，首轮挂载不应再无条件重写列表。
  slot${binding.slotIndex}.write(${expression});
}`;
      })
    )
    .concat(
      conditionBindings.map((binding) => {
        const truthyBindings = binding.children ? `[${renderChildPayloadBindings(binding.children).join(', ')}]` : '[]';
        const falsyBindings = binding.fallbackChildren ? `[${renderChildPayloadBindings(binding.fallbackChildren).join(', ')}]` : '[]';
        return `if (!hasHydrationSlot(mounted, ${binding.slotIndex})) {
  slot${binding.slotIndex}.write({ __lania_if: "block", when: ${binding.expression}, truthyBindings: ${truthyBindings}, falsyBindings: ${falsyBindings} });
}`;
      })
    )
    .concat(
      dynamicBindings.map(
        (binding) =>
          `if (!hasHydrationSlot(mounted, ${binding.slotIndex}) || readHydrationSlotNodes(mounted, ${binding.slotIndex}).length === 0) {
  // 动态块即使处于 hydration，也要防守“SSR 没有留下可复用子节点”的情况。
  slot${binding.slotIndex}.write({ __lania_dynamic: "block", component: ${binding.componentExpression}, props: ${binding.propsExpression}, childBindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });
}`
      )
    )
    .concat(
      boundaryBindings.map(
        (binding) =>
          `if (!hasHydrationSlot(mounted, ${binding.slotIndex}) || readHydrationSlotNodes(mounted, ${binding.slotIndex}).length === 0) {
  slot${binding.slotIndex}.write({ __lania_boundary: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });
}`
      )
    )
    .concat(
      transitionBindings.map(
        (binding) =>
          `if (!hasHydrationSlot(mounted, ${binding.slotIndex}) || readHydrationSlotNodes(mounted, ${binding.slotIndex}).length === 0) {
  slot${binding.slotIndex}.write({ __lania_boundary: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });
}`
      )
    )
    .concat(
      keepAliveBindings.map(
        (binding) =>
          `slot${binding.slotIndex}.write({ __lania_keepalive: "block", payload: ${binding.payloadExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });`
      )
    )
    .concat(
      teleportBindings.map(
        (binding) =>
          `if (!hasHydrationSlot(mounted, ${binding.slotIndex}) || slot${binding.slotIndex}HydratedNodes.length === 0) {
  slot${binding.slotIndex}.write({ __lania_teleport: "block", target: ${binding.targetExpression}, bindings: [${renderChildPayloadBindings(binding.children ?? []).join(', ')}] });
}`
      )
    )
    .concat(
      interactiveSlots.map((slot) => {
        if (slot.type === 'event') {
          if (slot.eventEntries && slot.eventEntries.length > 0) {
            // 提示性修饰符（`.debounce` / `.throttle`）需要独立监听，这里按条目逐条包装。
            const hint = slot.eventEntries[0]!;
            return `slot${slot.slotIndex}.write(withEventHint(${slot.expression}, ${JSON.stringify(hint)}, ${JSON.stringify(slot.modifiers ?? [])}));`;
          }

          // 事件处理器在编译期已拆出修饰符，这里重新包装成运行时可执行 listener。
          return `slot${slot.slotIndex}.write(withEventModifiers(${slot.expression}, ${JSON.stringify(slot.modifiers ?? [])}));`;
        }

        if (slot.type === 'directive' && slot.directiveKind === 'model') {
          // `model` 指令最终仍表现为“把值写给绑定 slot”，不额外包对象。
          return `slot${slot.slotIndex}.write(${slot.expression});`;
        }

        if (slot.type === 'directive' && slot.directiveKind === 'use') {
          // `use` 指令需要同时保留指令名和值，运行时据此调用 action/use 协议。
          return `slot${slot.slotIndex}.write({ name: ${JSON.stringify(slot.name ?? '')}, value: ${slot.expression} });`;
        }

        return `slot${slot.slotIndex}.write(${slot.expression});`;
      })
    )
    .join('\n');
  // hydration 场景下，首轮写入前需要先把已有 updater 恢复到调度系统中。
  const restoreHydrationUpdaterCalls = declaredRuntimeUpdaters
    .map((updater) => `this.registerRuntimeUpdater(${updater.name});`)
    .join('\n');

  // `_renderAndMount()` 是最终写进组件类的方法主体：
  // 1. 先挂载或 hydration 静态模板；
  // 2. 再声明 slot 与 updater；
  // 3. 恢复 hydration 依赖关系；
  // 4. 最后执行一次初始写入。
  const methodLines = [
    'protected _renderAndMount(): void {',
    '  const mounted = mountStaticTemplate(this.renderRoot, ' + hoistName + ', { hydrate: true });',
    '  reflectInitialProps(this);',
    finalSlotDeclarations ? indent(finalSlotDeclarations) : '',
    payloadRuntimeUpdaterDeclarations ? indent(payloadRuntimeUpdaterDeclarations) : '',
    runtimeUpdaterDeclarations ? indent(runtimeUpdaterDeclarations) : '',
    '  const applyInitialBindings = () => {',
    renderBindingsBody ? indent(renderBindingsBody, 2) : '',
    '  };',
    '  const restoreHydrationSignalUpdaters = () => {',
    restoreHydrationUpdaterCalls ? indent(restoreHydrationUpdaterCalls, 2) : '',
    '  };',
    '  restoreHydrationSignalUpdaters();',
    '  applyInitialBindings();',
    '}',
  ].filter((line) => line.length > 0);

  const method = methodLines.join('\n');
  const code = [...hoists, '', method].join('\n');

  return {
    hoistName,
    hoists,
    method,
    code,
  };
};
