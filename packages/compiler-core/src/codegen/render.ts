/**
 * render 代码生成总入口转发层。
 *
 * 编译流水线的上游阶段通常只需要“拿到 render 相关的全部公开能力”，
 * 因此这里把真正位于 `render/` 子目录里的实现再次透出，维持稳定 API。
 */
export * from './render/index';
