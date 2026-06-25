/**
 * 转换与优化阶段模块导出。
 *
 * 这一层聚合的是“AST/源码进入 IR 之前或之中”的处理能力：
 * - `parse-typescript-source` 提供源码到 TypeScript AST 的基础解析能力；
 * - `optimization` 则承接模板/render plan 相关的静态优化逻辑。
 *
 * 文件本身保持极薄，只负责对外暴露稳定入口，避免上层依赖具体目录布局。
 */
export * from './parse-typescript-source';
export * from './optimization';
