/**
 * 编译器产物专用入口。
 *
 * 目前只需要一个能力：把 atom 句柄直接交给 updater 作为依赖。
 * 之所以单独开 entry，是为了不让这类实现细节出现在用户的公共 import 面上。
 */
export { getAtomDependency } from './internal-helpers';
