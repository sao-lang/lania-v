/**
 * slot 分配。
 *
 * 这个阶段的目标，是把模板里所有“需要运行时定位/更新”的位置统一编号。
 * 编号后的结果会被后续 updater 规划、render codegen 和运行时挂载共同消费。
 *
 * 分配策略分成两类：
 * - 模板级 slot：例如文本插值、条件块、列表块、动态组件等，索引在 lowering 阶段就已确定；
 * - 运行时附加 slot：例如动态 attribute、事件、指令，这些只在当前阶段顺序追加。
 *
 * 这样既能保持模板结构的稳定索引，又能为非模板绑定补足统一的寻址入口。
 *
 * 由于后续 render/codegen/runtime 都以 slotIndex 作为共同坐标，
 * 这里不仅是在“编号”，也是在建立组件更新系统的最小寻址单元。
 * 同时，属性/事件/指令节点会在这里被原地写回 `slotIndex`，
 * 这样后续阶段就不必再次从模板树反查“这个绑定最终落在哪个 slot 上”。
 *
 * 因此实现会优先保证索引稳定、无冲突、可读，而不是追求复杂的压缩策略。
 */
import type {
  ComponentIR,
  DirectiveIR,
  DynamicAttributeIR,
  ElementIR,
  EventIR,
  TemplateIRNode,
} from '../ir/component';

export type AllocatedSlotType =
  | 'text'
  | 'attribute'
  | 'property'
  | 'style'
  | 'class'
  | 'event'
  | 'component'
  | 'if'
  | 'for'
  | 'dynamic'
  | 'boundary'
  | 'transition'
  | 'keepalive'
  | 'teleport'
  | 'ref'
  | 'directive';

export interface AllocatedSlotIR {
  slotIndex: number;
  type: AllocatedSlotType;
  path: number[];
  name?: string;
  expression?: string;
  updater: string;
  directiveKind?: DirectiveIR['kind'];
  eventName?: string;
  modifiers?: string[];
  listener?: {
    once?: boolean;
    capture?: boolean;
    passive?: boolean;
  };
  unit?: string;
  componentEvent?: boolean;
  /** 同一条事件声明拆分出的附加回调（`.debounce` / `.throttle` 等），为空表示单条监听。 */
  eventEntries?: string[];
}

export interface SlotAllocationIR {
  slots: AllocatedSlotIR[];
  totalSlots: number;
}

export const createEmptySlotAllocation = (): SlotAllocationIR => {
  return {
    slots: [],
    totalSlots: 0,
  };
};

const getPathToken = (path: number[]): string => {
  // 根路径统一收敛成固定 token，生成的方法名更稳定、可读。
  return path.length > 0 ? path.join('_') : 'root';
};

const sanitizeIdentifierToken = (value: string): string => {
  // 属性名、事件名可能带符号字符，先清洗成合法标识符片段再拼 updater 名。
  const normalized = value.replace(/[^a-zA-Z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'token';
};

const getMaxTemplateSlotIndex = (nodes: TemplateIRNode[]): number => {
  let max = -1;

  nodes.forEach((node) => {
    if (node.type === 'ExpressionIR') {
      max = Math.max(max, node.slotIndex);
      return;
    }

    if (
      node.type === 'ListIR' ||
      node.type === 'IfIR' ||
      node.type === 'TeleportIR' ||
      node.type === 'DynamicIR' ||
      node.type === 'BoundaryIR' ||
      node.type === 'TransitionIR' ||
      node.type === 'KeepAliveIR' ||
      node.type === 'StaticComponentIR'
    ) {
      max = Math.max(max, node.slotIndex);
      return;
    }

    if (node.type === 'ElementIR') {
      // 元素本身没有模板 slot，但其子树里可能还包含可更新节点。
      max = Math.max(max, getMaxTemplateSlotIndex(node.children));
    }
  });

  return max;
};

const allocateAttributeSlot = (
  attribute: DynamicAttributeIR,
  element: ElementIR,
  slotIndex: number
): AllocatedSlotIR => {
  // 这里会把分配结果回写到节点上，供后续 updater/codegen 直接复用。
  attribute.slotIndex = slotIndex;

  return {
    slotIndex,
    type: 'attribute',
    path: attribute.path,
    name: attribute.name,
    expression: attribute.expression,
    // Attribute names can contain `-` (e.g. aria-*, data-*); keep updater names JS-identifier-safe.
    updater: `updateAttr_${getPathToken(element.path)}_${sanitizeIdentifierToken(attribute.name)}`,
  };
};

const allocateDirectiveSlot = (
  directive: DirectiveIR,
  element: ElementIR,
  slotIndex: number
): AllocatedSlotIR => {
  directive.slotIndex = slotIndex;

  const type =
    // 指令种类需要被归一到运行时认识的 slot 类型上，便于后续生成 updater。
    directive.kind === 'style'
      ? 'style'
      : directive.kind === 'class'
        ? 'class'
        : directive.kind === 'bind'
          ? 'property'
          : directive.kind === 'ref'
            ? 'ref'
            : 'directive';

  return {
    slotIndex,
    type,
    path: directive.path,
    name: directive.name,
    expression: directive.expression,
    updater: `updateDirective_${directive.kind}_${getPathToken(element.path)}_${sanitizeIdentifierToken(directive.name)}`,
    directiveKind: directive.kind,
    modifiers: directive.modifiers,
    unit: directive.unit,
  };
};

const allocateEventSlot = (
  event: EventIR,
  element: ElementIR,
  slotIndex: number,
  entryIndex = 0
): AllocatedSlotIR => {
  const hint = event.hints?.[entryIndex];

  if (entryIndex === 0) {
    event.slotIndex = slotIndex;
  }

  return {
    slotIndex,
    type: 'event',
    path: event.path,
    name: event.name,
    eventName: event.name,
    expression: event.expression,
    updater:
      entryIndex === 0
        ? `attachEvent_${getPathToken(element.path)}_${event.name}`
        : `attachEvent_${getPathToken(element.path)}_${event.name}_${entryIndex}`,
    // 附加监听只负责提示包装，过滤类修饰符仍由首个 slot 承担，避免副作用重复执行。
    modifiers: entryIndex === 0 ? event.modifiers : [],
    listener: entryIndex === 0 ? event.listener : undefined,
    eventEntries: hint ? [hint] : undefined,
    componentEvent: event.component,
  };
};

const allocateTemplateSlots = (
  nodes: TemplateIRNode[],
  allocated: AllocatedSlotIR[],
  nextSlotIndexRef: { value: number }
): void => {
  nodes.forEach((node) => {
    // 模板级 slot 已经在 lowering 时确定索引，这里只负责转成统一分配记录。
    if (node.type === 'ExpressionIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'text',
        path: node.path,
        expression: node.expression,
        updater: `updateSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'ListIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'for',
        path: node.path,
        expression: node.expression,
        updater: `updateListSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'IfIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'if',
        path: node.path,
        expression: node.expression,
        updater: `updateIfSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'TeleportIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'teleport',
        path: node.path,
        expression: node.targetExpression,
        updater: `updateTeleportSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'DynamicIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'dynamic',
        path: node.path,
        // 动态组件运行时至少需要组件定义和 props 两块输入，因此这里合成一个表达式载荷。
        expression: `({ component: ${node.componentExpression}, props: ${node.propsExpression} })`,
        updater: `updateDynamicSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'BoundaryIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'boundary',
        path: node.path,
        // Boundary/Transition/KeepAlive 都把 payload 表达式当作该 block 的主更新输入。
        expression: node.payloadExpression,
        updater: `updateBoundarySlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'TransitionIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'transition',
        path: node.path,
        // Transition 在 slot 分配层与 Boundary 一样先只保留 payload，具体语义差异留给 codegen/runtime。
        expression: node.payloadExpression,
        updater: `updateTransitionSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'KeepAliveIR') {
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'keepalive',
        path: node.path,
        // KeepAlive 的缓存/复用策略发生在运行时，这里只负责给它预留稳定的 slot 坐标。
        expression: node.payloadExpression,
        updater: `updateKeepAliveSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type === 'StaticComponentIR') {
      // 静态组件虽然标签已知，但 props 仍要占一个可更新 slot。
      allocated.push({
        slotIndex: node.slotIndex,
        type: 'component',
        path: node.path,
        name: node.tagName,
        expression: node.propsExpression,
        updater: `updateComponentSlot${node.slotIndex}`,
      });
      return;
    }

    if (node.type !== 'ElementIR') {
      return;
    }

    // 非文本类运行时绑定统一在尾部追加索引，避免与模板 slot 冲突。
    // 这让 lowering 阶段产出的结构性 slot 与后续追加的交互 slot 共用一套线性编号空间。
    node.dynamicAttributes.forEach((attribute) => {
      allocated.push(allocateAttributeSlot(attribute, node, nextSlotIndexRef.value));
      nextSlotIndexRef.value += 1;
    });

    node.events.forEach((event) => {
      // 事件 slot 也放在线性表里，便于 codegen 统一按 slot 索引恢复 listener。
      // 一个事件声明可能展开成多条监听（如 `.debounce` / `.throttle`），逐条独立编号。
      const entryCount = Math.max(1, event.hints?.length ?? 1);

      for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
        allocated.push(allocateEventSlot(event, node, nextSlotIndexRef.value, entryIndex));
        nextSlotIndexRef.value += 1;
      }
    });

    node.directives.forEach((directive) => {
      allocated.push(allocateDirectiveSlot(directive, node, nextSlotIndexRef.value));
      nextSlotIndexRef.value += 1;
    });

    allocateTemplateSlots(node.children, allocated, nextSlotIndexRef);
  });
};

export const allocateComponentSlots = (component: ComponentIR): SlotAllocationIR => {
  const slots: AllocatedSlotIR[] = [];
  const nextSlotIndexRef = {
    // 附加 slot 一律从“现有模板 slot 的最大值 + 1”开始，保证不和 lowering 结果冲突。
    value: getMaxTemplateSlotIndex(component.template.roots) + 1,
  };

  // 递归遍历模板树，把模板 slot 与交互 slot 汇总到同一个线性表中。
  // 后续代码生成只认这张统一 slot 表，不再区分它最初来自模板节点还是运行时绑定。
  allocateTemplateSlots(component.template.roots, slots, nextSlotIndexRef);

  // 最终输出按 slotIndex 排序，保证代码生成与调试展示具有稳定顺序。
  slots.sort((left, right) => left.slotIndex - right.slotIndex);

  return {
    slots,
    totalSlots: slots.length,
  };
};
