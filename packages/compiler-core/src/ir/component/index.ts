/**
 * 组件 IR 子模块导出入口。
 *
 * 这里统一转发组件级 IR 的类型定义和入口 lowering 能力，
 * 让后续阶段只依赖这一层公共路径即可访问组件 IR 结构。
 */
export * from './types';
export * from './entry';
