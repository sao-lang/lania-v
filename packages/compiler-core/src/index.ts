/**
 * compiler-core 对外导出入口。
 *
 * 这里是 `@lania-v/compiler-core` 的门面模块，职责很单纯：
 * - 统一转发 AST、IR、分析、转换、规划、代码生成与诊断相关能力；
 * - 尽量让上层调用方只依赖这一层，而不是深入子目录引用内部模块；
 * - 暴露一个极简的 `createCompilerCore()`，方便宿主侧做能力探测或注册。
 *
 * 因为这里承担的是“统一出口”职责，所以本文件不放业务逻辑，
 * 只负责稳定地组织导出边界。
 */
export * from './ast';
export * from './codegen';
export * from './diagnostics';
export * from './ir';
export * from './analysis';
export * from './transform';
export * from './pipeline';
export * from './plan';
export * from './pipeline/plugins';
export * from './report';

/** 创建 compiler-core 的基础标识对象。 */
export const createCompilerCore = () => ({
  name: 'compiler-core',
});
