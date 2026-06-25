import type { Signal } from '../reactivity/signal';
import {
  type JobPriority,
  defaultScheduler,
  type Scheduler,
} from '../reactivity/scheduler';
import { SlotTable } from './slot-table';
import type { Slot } from './slots';

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
  deps: Set<Signal<any>>;
  slots: Slot[];
  priority: JobPriority;
  dirty: boolean;
  run(): void;
  attach(): void;
  detach(): void;
}

export abstract class BaseUpdater<T = unknown> implements Updater {
  readonly deps = new Set<Signal<any>>();
  dirty = false;
  private attached = false;
  private readonly job = () => {
    this.markDirty();
    this.scheduleRun();
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
    this.slotTable?.markDirtySlots(this.slots.map((slot) => slot.index));
  }

  protected scheduleRun(): void {
    // signal 类更新默认走 scheduler 的 signal 通道，和 effect/lifecycle 分桶。
    this.scheduler.scheduleSignal(() => this.run(), this.priority);
  }

  run(): void {
    // 统一执行“先算值、再提交”，子类只需覆写 compute/commit 的局部差异。
    const nextValue = this.compute();
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
    this.slots[0].write(value);
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
      slot.write(value);
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
    this.slots[0].write(value);
    super.commit(value);
  }
}

export class EffectUpdater extends BaseUpdater<void> {
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

  protected compute(): void {
    this.effect();
  }
}
