/**
 * 提供增强组件定义的轻量工厂。
 *
 * 这些辅助方法只负责打标和类型收窄，不引入额外运行时行为。
 */
import {
  ENHANCED_COMPONENT_KIND,
  type EachComponentDefinition,
  type EnhancedComponentDefinition,
  type EnhancedRenderable,
} from '../types';

// 每个增强组件都被包装成带 displayName 和内部标记的函数对象。
export const defineEnhancedComponent = <
  TName extends string,
  TProps extends object,
  TResult,
>(
  name: TName,
  render: (props: TProps) => TResult
): EnhancedComponentDefinition<TName, TProps, TResult> => {
  const component = Object.assign(render, {
    displayName: name,
    [ENHANCED_COMPONENT_KIND]: true as const,
  });

  return component as EnhancedComponentDefinition<TName, TProps, TResult>;
};

// `Each` 需要单独暴露泛型签名，因此通过断言补回专用定义。
export const asEachDefinition = <TResult>(
  component: unknown
): EachComponentDefinition<TResult> => {
  return component as EachComponentDefinition<TResult>;
};

export type { EnhancedRenderable };
