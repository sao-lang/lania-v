/**
 * 增强组件判定。
 *
 * 标记符号与判定函数由 runtime 提供（slot 层也需要它），这里只做再导出，
 * 保证 advanced 内部引用路径稳定。
 */
export {
  ENHANCED_COMPONENT_KIND,
  isEnhancedDef,
} from '../../../component/enhanced-marker';
