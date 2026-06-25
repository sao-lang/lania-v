/**
 * diagnostics 导出入口。
 *
 * 当前 `compiler-core` 内部只公开诊断源映射相关能力，
 * 这里保留单独入口是为了让上层模块依赖稳定路径，而不是直接耦合实现文件。
 */
export * from './source';
