/**
 * render 子模块导出入口。
 *
 * 这里保持最薄的一层转发，目的是把 render codegen 对外暴露的类型定义与
 * 生成函数收拢到同一个导入路径，避免上层调用方关心内部文件拆分细节。
 */
export * from './types';
export * from './generate';
