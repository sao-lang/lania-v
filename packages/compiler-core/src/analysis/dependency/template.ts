import type { TemplateIRNode } from '../../ir/component';
import type { ExpressionDependency } from './types';
import { mergeDependencies } from './expression';

/**
 * 模板依赖收集。
 *
 * 这个文件负责从模板 IR 中递归提取“哪些表达式会在运行时读取响应式值”，
 * 并把这些表达式交给上层的 `analyzeExpression()` 做实际依赖分析。
 *
 * 它本身不解析 JavaScript/TypeScript 语法，只负责：
 * 1. 找出每类模板节点上真正需要分析的表达式字段；
 * 2. 递归向下遍历子树；
 * 3. 用 `mergeDependencies()` 把多处分析结果合并去重。
 */

// 沿着模板树递归收集 signal 依赖。不同 IR 节点携带表达式的字段不同，这里统一展开。
export const collectTemplateSignalDependencies = (
  nodes: TemplateIRNode[],
  analyzeExpression: (expression: string) => ExpressionDependency[]
): ExpressionDependency[] => {
  return mergeDependencies(
    ...nodes.map((node) => {
      switch (node.type) {
        case 'ExpressionIR':
          return analyzeExpression(node.expression);
          // 文本表达式和列表 iterable 都直接由单个表达式驱动。
        case 'ListIR':
          return analyzeExpression(node.expression);
          // `IfIR` 既依赖条件表达式，也依赖 truthy/fallback 两侧子树里的表达式。
        case 'IfIR':
          // `IfIR` 既依赖条件表达式，也依赖 truthy/fallback 两侧子树里的表达式。
          // 真分支承载了 `When` 内的全部 DOM，漏掉它会让块内绑定完全失去依赖订阅。
          return mergeDependencies(
            analyzeExpression(node.expression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : [],
            node.fallbackChildren
              ? collectTemplateSignalDependencies(node.fallbackChildren, analyzeExpression)
              : []
          );
        case 'DynamicIR':
          // 动态组件的依赖来自组件引用、props 表达式以及其子绑定子树。
          return mergeDependencies(
            analyzeExpression(`({ component: ${node.componentExpression}, props: ${node.propsExpression} })`),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          );
        case 'TeleportIR':
          // Teleport 目标表达式和其内部子树都可能继续访问响应式值。
          return mergeDependencies(
            analyzeExpression(node.targetExpression),
            node.children ? collectTemplateSignalDependencies(node.children, analyzeExpression) : []
          );
        case 'StaticComponentIR':
          return analyzeExpression(node.propsExpression);
        case 'ElementIR':
          // 原生元素上的动态 attribute / directive 都会贡献依赖。
          return mergeDependencies(
            ...node.dynamicAttributes.map((attribute) => analyzeExpression(attribute.expression)),
            ...node.directives.map((directive) => analyzeExpression(directive.expression)),
            collectTemplateSignalDependencies(node.children, analyzeExpression)
          );
        case 'BoundaryIR':
        case 'TransitionIR':
          // 这里当前只继续向子树递归，不分析 payload 本身；payload 依赖由其它分析层负责。
          return collectTemplateSignalDependencies(node.children, analyzeExpression);
        default:
          return [];
      }
    })
  );
};
