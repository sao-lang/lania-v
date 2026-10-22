import type { TemplateChildNode } from '../../../ast';
import { lowerEnhancedComponent } from './lower-boundaries';
import {
  lowerComponentReferenceElement,
  lowerDynamicElement,
  lowerStaticComponentElement,
} from './lower-dynamic';
import {
  isExpressionAttributeValue,
  isListExpression,
  lowerDirective,
  lowerEvent,
  renderStaticAttributes,
} from '../helpers/template-helpers';
import type {
  DynamicAttributeIR,
  ElementIR,
  ExpressionIR,
  ListIR,
  LowerTemplateOptions,
  LowerTemplateResult,
  TemplateIRNode,
  TextIR,
} from '../types';

/**
 * 模板子节点 lowering。
 *
 * 该文件负责把 AST 层的模板子节点序列，转换为组件 IR 层的 `TemplateIRNode[]`
 * 与对应的静态 HTML 骨架。
 *
 * 这一步同时承担两个任务：
 * 1. 为运行时需要接管的位置分配 slot / boundary 索引；
 * 2. 生成一份“尽可能静态”的 HTML 模板串，供 CSR clone / SSR 复用。
 *
 * 因此它不是单纯的 AST 遍历，而是一次“结构拆分”：
 * - 静态部分直接落进 `staticHtml`；
 * - 动态部分变成 `ExpressionIR` / `ListIR` / `IfIR` / `ElementIR` 等节点；
 * - 增强组件、动态组件和组件引用则进一步委托给专门 lowering 分支。
 *
 * 因而这里也是 slot / boundary 索引向下传播的主干调度点：
 * - 每遇到一个需要运行时接管的位置，就消耗一个 slot；
 * - 每进入一个需要单独恢复生命周期的边界，就推进 boundary 索引；
 * - 最终把“模板骨架”和“动态接管点”严格对齐输出。
 */

export const lowerTemplateChildren = (
  children: TemplateChildNode[],
  parentPath: number[],
  nextSlotIndex: number,
  nextBoundaryIndex: number,
  startDomIndex = 0,
  options: LowerTemplateOptions = {}
): LowerTemplateResult => {
  const nodes: TemplateIRNode[] = [];
  const htmlParts: string[] = [];
  let slotIndex = nextSlotIndex;
  let boundaryIndex = nextBoundaryIndex;
  let domIndex = startDomIndex;

  // 这里按同层 children 顺序扫描，同时维护静态 DOM 位置和动态 slot/boundary 计数。
  children.forEach((child) => {
    // path 描述的是“当前节点在静态模板树里的逻辑位置”，供后续运行时精准定位。
    const path = [...parentPath, domIndex];

    if (child.type === 'TextNode') {
      const textNode: TextIR = {
        type: 'TextIR',
        path,
        value: child.value,
      };

      nodes.push(textNode);
      // 纯文本既进入 IR，也直接进入静态 HTML 骨架。
      htmlParts.push(child.value);
      domIndex += 1;
      return;
    }

    if (child.type === 'ExpressionNode') {
      if (isListExpression(child.expression)) {
        // 裸表达式如果被识别为列表语义，会直接下沉为 `ListIR`，占一个 comment slot。
        const listNode: ListIR = {
          type: 'ListIR',
          path,
          slotIndex,
          expression: child.expression,
        };

        nodes.push(listNode);
        htmlParts.push(`<!--__LANIA_SLOT_${slotIndex}__-->`);
        slotIndex += 1;
        domIndex += 1;
        return;
      }

      // 普通文本插值在静态模板里先落成占位文本，运行时再由 TextSlot 接管。
      const expressionNode: ExpressionIR = {
        type: 'ExpressionIR',
        path,
        slotIndex,
        expression: child.expression,
      };

      nodes.push(expressionNode);
      htmlParts.push(`__LANIA_SLOT_${slotIndex}__`);
      slotIndex += 1;
      domIndex += 1;
      return;
    }

    const loweredEnhancedComponent = lowerEnhancedComponent(
      {
        child,
        path,
        parentPath,
        slotIndex,
        boundaryIndex,
        domIndex,
      },
      lowerTemplateChildren,
      options
    );

    if (loweredEnhancedComponent) {
      // `<When>` / `<Teleport>` / `<KeepAlive>` 等增强组件有独立 lowering 规则，优先处理。
      // 返回值里会显式带回新的 slot/boundary 游标，父流程只负责继续向后推进。
      nodes.push(...loweredEnhancedComponent.nodes);
      htmlParts.push(loweredEnhancedComponent.staticHtml);
      slotIndex = loweredEnhancedComponent.nextSlotIndex;
      boundaryIndex = loweredEnhancedComponent.nextBoundaryIndex;
      domIndex += loweredEnhancedComponent.renderedRootCount;
      return;
    }

    if (child.tagName === 'component') {
      // 保留字 `<component>` 代表动态组件占位，单独走动态组件 lowering。
      const dynamicNode = lowerDynamicElement(
        child,
        path,
        slotIndex,
        lowerTemplateChildren
      );

      if (dynamicNode) {
        nodes.push(dynamicNode);
        htmlParts.push(`<!--__LANIA_SLOT_${slotIndex}__-->`);
        slotIndex += 1;
        domIndex += 1;
        return;
      }
    }

    const staticComponentNode = lowerStaticComponentElement(
      child,
      path,
      slotIndex
    );

    if (staticComponentNode) {
      // 静态组件标签会转成组件 slot，自身在父模板里表现为一个 block 占位。
      nodes.push(staticComponentNode);
      htmlParts.push(`<!--__LANIA_SLOT_${slotIndex}__-->`);
      slotIndex += 1;
      domIndex += 1;
      return;
    }

    const referencedComponentNode = lowerComponentReferenceElement(
      child,
      path,
      slotIndex,
      lowerTemplateChildren
    );

    if (referencedComponentNode) {
      // 对组件引用表达式也同样只在父模板中保留一个占位 slot。
      nodes.push(referencedComponentNode);
      htmlParts.push(`<!--__LANIA_SLOT_${slotIndex}__-->`);
      slotIndex += 1;
      domIndex += 1;
      return;
    }

    // 普通原生元素继续拆成“静态属性 + 动态属性 + 事件 + 指令 + 子节点”五部分。
    const staticAttributes = Object.fromEntries(
      child.attributes
        .filter((attribute) => attribute.static)
        .map((attribute) => {
          if (attribute.value === null) {
            return [attribute.name, true];
          }

          return [attribute.name, attribute.value as string];
        })
    );
    const dynamicAttributes = child.attributes.reduce<DynamicAttributeIR[]>(
      (attributes, attribute) => {
        if (attribute.static || !isExpressionAttributeValue(attribute.value)) {
          return attributes;
        }

        // 动态属性保留原表达式与路径，运行时再借助对应 slot 写入。
        attributes.push({
          name: attribute.name,
          expression: attribute.value.expression,
          path,
        });

        return attributes;
      },
      []
    );
    const hasHtmlDirective = child.directives.some(
      (directive) => directive.kind === 'html'
    );
    const loweredChildren = hasHtmlDirective
      ? {
          // `html` 指令会整体接管 innerHTML，因此常规 children 在这里直接视为空。
          nodes: [],
          staticHtml: '',
          nextSlotIndex: slotIndex,
          nextBoundaryIndex: boundaryIndex,
          renderedRootCount: 0,
        }
      : lowerTemplateChildren(
          child.children,
          path,
          slotIndex,
          boundaryIndex,
          0
        );
    const elementNode: ElementIR = {
      type: 'ElementIR',
      tagName: child.tagName,
      path,
      staticAttributes,
      dynamicAttributes,
      events: child.events.map((event) => lowerEvent(event, path)),
      directives: child.directives.map((directive) =>
        lowerDirective(directive, path)
      ),
      children: loweredChildren.nodes,
    };

    nodes.push(elementNode);
    // 原生元素的静态骨架可以完整内联进模板 HTML，动态部分再由 IR 节点补足。
    // 子树返回的 nextSlotIndex / nextBoundaryIndex 会在这里向上传递，保证整棵树编号连续。
    htmlParts.push(
      `<${child.tagName}${renderStaticAttributes(staticAttributes)}>${loweredChildren.staticHtml}</${child.tagName}>`
    );
    slotIndex = loweredChildren.nextSlotIndex;
    boundaryIndex = loweredChildren.nextBoundaryIndex;
    domIndex += 1;
  });

  return {
    nodes,
    // `staticHtml` 是同层所有节点拼接后的骨架模板，后续会被 hoist 成静态模板字符串。
    staticHtml: htmlParts.join(''),
    nextSlotIndex: slotIndex,
    nextBoundaryIndex: boundaryIndex,
    renderedRootCount: domIndex - startDomIndex,
  };
};
