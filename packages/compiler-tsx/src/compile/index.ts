/**
 * TSX 编译阶段的公共导出入口。
 *
 * 这个文件把 `compile` 目录下的核心能力收敛成单一门面：
 * 1. 错误封装工具，负责把解析/流水线异常统一折叠成带源码定位的诊断；
 * 2. 函数组件编译入口，负责从 TSX 源码走到组件 IR 与类代码；
 * 3. 模块输出组装器，负责把编译产物包装成最终 ES 模块文本。
 *
 * 对外部调用方来说，这里代表“TSX 编译子系统”的稳定 API 边界。
 */
// 统一暴露 compile 子系统下的公开能力，隐藏内部文件拆分。
export * from './errors';
export * from './function-component';
export * from './module-output';
