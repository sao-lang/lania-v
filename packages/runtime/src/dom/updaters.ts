import type { Signal } from '../reactivity/signal';
import {
  type JobPriority,
  defaultScheduler,
  type Scheduler,
} from '../reactivity/scheduler';
import { SlotTable } from './slot-table';
import type { Slot } from './slots';
import { emitDevtoolsEvent, hasDevtoolsSubscribers, isDevEnvironment } from '../core/debug';

/**
 * DOM updater 抽象：把“计算”与“提交到 slot/DOM”拆开。
 *
 * 这层位于 signal 依赖收集与具体 slot 写入之间，负责把一次响应式更新整理成：
 * - `deps`：由编译产物注入的依赖 signal 集合；
 * - `attach/detach`：将当前 updater 订阅到这些 signal；
 * - `compute()`：计算最新值；
 * - `commit()`：把结果写入一个或多个 slot；
 * - `slotTable`：可选的脏位表，用于批量 flush 时做增量执行。
 *
 * 不同 updater 的差异主要体现在“计算函数”和“要写入多少 slot”，调度协议保持一致。
 */

export interface Updater {
  debugId: number;
  deps: Set<Signal<any>>;
  slots: Slot[];
  priority: JobPriority;
  dirty: boolean;
  run(): void;
  attach(): void;
  detach(): void;
}

let nextUpdaterDebugId = 1;

export abstract class BaseUpdater<T = unknown> implements Updater {
  readonly debugId = nextUpdaterDebugId++;
  readonly deps = new Set<Signal<any>>();
  dirty = false;
  private attached = false;
  private hasCommitted = false;
  private previousValue: unknown = undefined;
  private readonly job = () => {
    this.markDirty();
    // signal 通知时已经入队过一次，这里直接执行，避免再排队一轮。
    this.run();
  };

  constructor(
    public readonly slots: Slot[],
    public readonly priority: JobPriority = 'normal',
    protected readonly scheduler: Scheduler = defaultScheduler,
    protected readonly slotTable?: SlotTable
  ) {}

  protected markDirty(): void {
    this.dirty = true;
    // 额外把 slot 索引标记到表里，便于外层容器按脏位裁剪 flush 范围。
    const slotTable = this.slotTable;

    if (slotTable) {
      for (let index = 0; index < this.slots.length; index += 1) {
        slotTable.markDirty(this.slots[index]!.index);
      }
    }
  }

  protected scheduleRun(): void {
    // signal 类更新默认走 scheduler 的 signal 通道，和 effect/lifecycle 分桶。
    this.scheduler.scheduleSignal(() => this.run(), this.priority);
  }

  run(): void {
    // 统一执行“先算值、再提交”，子类只需覆写 compute/commit 的局部差异。
    this.emitRunDebugEvent();
    const nextValue = this.compute();

    if (this.hasCommitted && Object.is(this.previousValue, nextValue)) {
      // slot 层本身也会做等值判断，但走到那里已经付出了求值与字符串转换成本。
      this.dirty = false;
      return;
    }

    this.hasCommitted = true;
    this.previousValue = nextValue;
    this.commit(nextValue);
  }

  attach(): void {
    if (this.attached) {
      return;
    }

    this.attached = true;

    for (const signal of this.deps) {
      // 每个 updater 都把同一个 job 注册到依赖 signal，上游变更时统一进入调度器。
      signal.updaters.add(this.job);
    }
  }

  detach(): void {
    if (!this.attached) {
      return;
    }

    this.attached = false;

    for (const signal of this.deps) {
      signal.updaters.delete(this.job);
    }
  }

  protected abstract compute(): T;

  protected emitRunDebugEvent(): void {
    if (!isDevEnvironment() || !hasDevtoolsSubscribers()) {
      return;
    }

    emitDevtoolsEvent('updater-run', {
      updaterId: this.debugId,
      updaterKind: this.constructor.name,
      dependencyIds: [...this.deps].map((signal) => signal.debugId),
      slots: this.slots.map((slot) => ({ type: slot.type, index: slot.index })),
    });
  }

  protected writeSlot(slot: Slot, value: unknown): void {
    if (isDevEnvironment() && hasDevtoolsSubscribers()) {
      emitDevtoolsEvent('slot-write', {
        updaterId: this.debugId,
        slotType: slot.type,
        slotIndex: slot.index,
      });
    }

    slot.write(value);
  }

  protected commit(_value: T): void {
    this.dirty = false;

    for (const slot of this.slots) {
      this.slotTable?.clearDirty(slot.index);
    }
  }
}

export class SimpleUpdater<T = unknown> extends BaseUpdater<T> {
  constructor(
    private readonly evaluate: () => T,
    slot: Slot<T>,
    priority: JobPriority = 'normal',
    scheduler: Scheduler = defaultScheduler,
    slotTable?: SlotTable
  ) {
    super([slot], priority, scheduler, slotTable);
  }

  protected compute(): T {
    return this.evaluate();
  }

  protected override commit(value: T): void {
    // 单槽位路径直接写第一个 slot，是最常见的文本/属性更新场景。
    this.writeSlot(this.slots[0], value);
    super.commit(value);
  }
}

export class MultiSlotUpdater<T = unknown> extends BaseUpdater<T> {
  constructor(
    private readonly evaluate: () => T,
    slots: Slot<T>[],
    priority: JobPriority = 'normal',
    scheduler: Scheduler = defaultScheduler,
    slotTable?: SlotTable
  ) {
    super(slots, priority, scheduler, slotTable);
  }

  protected compute(): T {
    return this.evaluate();
  }

  protected override commit(value: T): void {
    // 一个求值结果广播到多个 slot，适合同值多点复用的编译产物。
    for (const slot of this.slots) {
      this.writeSlot(slot, value);
    }

    super.commit(value);
  }
}

export class ConditionUpdater<T = unknown> extends BaseUpdater<T> {
  constructor(
    private readonly evaluate: () => T,
    slot: Slot<T>,
    priority: JobPriority = 'high',
    scheduler: Scheduler = defaultScheduler,
    slotTable?: SlotTable
  ) {
    super([slot], priority, scheduler, slotTable);
  }

  protected compute(): T {
    return this.evaluate();
  }

  protected override commit(value: T): void {
    this.writeSlot(this.slots[0], value);
    super.commit(value);
  }
}

export class EffectUpdater extends BaseUpdater<void> {
  /** 供宿主识别 effect 型 updater（effect 需要在挂载后先执行一次）。 */
  readonly kind = 'effect' as const;

  constructor(
    private readonly effect: () => void,
    priority: JobPriority = 'low',
    scheduler: Scheduler = defaultScheduler
  ) {
    super([], priority, scheduler);
  }

  protected override scheduleRun(): void {
    // effect 单独进入 effect 队列，确保其时序晚于普通 signal 提交。
    this.scheduler.scheduleEffect(() => this.run(), this.priority);
  }

  override run(): void {
    // effect 的返回值恒为 undefined，不能沿用基类的等值短路，否则只会执行一次。
    this.emitRunDebugEvent();
    this.dirty = false;
    this.effect();
  }

  protected compute(): void {}
}
