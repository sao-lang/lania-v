/**
 * 增强组件标记的运行时判定。
 *
 * 运行时（slot 层）需要在不解剖组件实现的前提下判断「这是不是一个增强组件」，
 * 因此把标记符号与判定函数放在 runtime；`@lania-v/runtime/advanced` 在定义组件时打上同一个标记。
 */
export const ENHANCED_COMPONENT_KIND = Symbol.for('lania.enhanced-component');

export interface EnhancedMarked {
  readonly displayName?: string;
  readonly [ENHANCED_COMPONENT_KIND]?: true;
}

/** 判断一个值是否是增强组件定义（When / Each / Transition / Boundary 等）。 */
export const isEnhancedDef = <T extends object = object>(
  value: unknown
): value is EnhancedMarked & T => {
  return (
    value !== null &&
    (typeof value === 'function' || typeof value === 'object') &&
    (value as EnhancedMarked)[ENHANCED_COMPONENT_KIND] === true
  );
};
