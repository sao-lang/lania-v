/**
 * 收敛增强组件相关的类型守卫。
 *
 * 运行时通过内部 symbol 标记判断一个值是否来自增强组件工厂。
 */
import {
  ENHANCED_COMPONENT_KIND,
  type EnhancedComponentDefinition,
} from '../types';

// 仅接受被 `defineEnhancedComponent()` 打过标记的函数。
export const isEnhancedDef = (
  value: unknown
): value is EnhancedComponentDefinition<string, Record<string, unknown>> => {
  return (
    typeof value === 'function' &&
    (value as { [ENHANCED_COMPONENT_KIND]?: unknown })[
      ENHANCED_COMPONENT_KIND
    ] === true
  );
};
