/**
 * TSX 编译器包的总入口。
 *
 * 这里是 `@lania-v/compiler-tsx` 暴露给外部调用方的公共门面，职责很简单：
 * 1. 统一转发分析、解析、编译、语法预处理等子模块能力；
 * 2. 提供一个轻量工厂函数，方便上层把当前编译器注册到统一的编译器集合中。
 *
 * 它本身不参与真实编译逻辑，但承担“稳定入口”的作用：
 * - 调用方不需要感知内部目录拆分；
 * - 后续即使子模块重构，也尽量不影响外部引用路径；
 * - 编译器注册层也可以只依赖最小元信息。
 */
export * from './analysis';
export * from './compile';
export * from './parse';
export * from './syntax';

/** 创建用于注册的编译器描述对象。 */
export const createTsxCompiler = () => ({
  // 名称作为上层选择/路由编译器实现时的稳定标识。
  name: 'compiler-tsx',
});
