/**
 * `@lania/store` 公共入口。
 *
 * 概念只有三层：
 * - **atom**：`createAtom()` 返回可读写句柄，`createDerivedAtom()` 返回派生只读句柄；
 * - **action / family**：`createAction()` 批量写入，`createAtomFamily()` 按 key 缓存原子；
 * - **store scope**：`createStore()` + `runWithStore()` 提供显式隔离（SSR / 测试 / 多实例），
 *   缺省时所有 atom 落在模块级默认 store。
 */
export {
  createAtom,
  createAction,
  createAtomFamily,
  createDerivedAtom,
  watchAtom,
  type Atom,
  type AtomOptions,
  type AtomPathSegment,
  type AtomPathUpdater,
  type AtomSetter,
  type AtomUpdater,
  type DerivedAtom,
  type WritableDerivedAtom,
} from './atom';
export {
  bindStore,
  createStore,
  getRootStore,
  getStore,
  hasExplicitStore,
  resetRootStore,
  runWithStore,
  type Store,
  type StoreAtomRecord,
  type StoreSnapshot,
} from './store';
export { persist, withHistory, withDevtools } from './middleware';
export type {
  PersistOptions,
  HistoryOptions,
  DevtoolsOptions,
} from './middleware';
