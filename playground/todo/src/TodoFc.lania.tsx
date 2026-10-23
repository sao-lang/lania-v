// @ts-nocheck
import { defineComponent } from '@lania-v/runtime';
import { createMemo, createSignal } from '@lania-v/runtime/reactivity';

import type { TodoFilter, TodoItem } from './todo-shared';
import { createTodoId } from './todo-shared';

const TodoFc = defineComponent(function TodoFc() {
  const normalizeText = (value: string): string =>
    value.trim().replace(/\s+/g, ' ');

  const todos = createSignal<TodoItem[]>([
    { id: createTodoId(), text: 'FC: return TSX', completed: false },
    { id: createTodoId(), text: 'FC: list via map()', completed: true },
  ]);
  const draft = createSignal('');
  const filter = createSignal<TodoFilter>('all');

  const remainingCount = createMemo(
    () => todos().filter((item) => !item.completed).length
  );
  const filteredTodos = createMemo(() => {
    const f = filter();
    const items = todos();
    if (f === 'active') return items.filter((item) => !item.completed);
    if (f === 'completed') return items.filter((item) => item.completed);
    return items;
  });

  const addTodo = () => {
    const text = normalizeText(draft());
    if (!text) return;
    todos.set((prev) =>
      prev.concat({ id: createTodoId(), text, completed: false })
    );
    draft.set('');
  };

  const toggleTodo = (id: string) => {
    todos.set((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, completed: !item.completed } : item
      )
    );
  };

  const removeTodo = (id: string) => {
    todos.set((prev) => prev.filter((item) => item.id !== id));
  };

  const clearCompleted = () => {
    todos.set((prev) => prev.filter((item) => !item.completed));
  };

  return (
    <section className="todo-card">
      <header>
        <h3>Todo List (FC)</h3>
      </header>
      <div className="row">
        <input
          className="input"
          placeholder="What needs to be done?"
          value={draft()}
          onInput={(event) => {
            const target = event.target as HTMLInputElement | null;
            draft.set(target?.value ?? '');
          }}
          onKeyDown={(event) => {
            const keyboardEvent = event as KeyboardEvent;
            if (keyboardEvent.key === 'Enter') {
              addTodo();
            }
          }}
        />
        <button className="btn" onClick={addTodo}>
          Add
        </button>
      </div>

      <div className="filters">
        <button
          className="chip"
          aria-pressed={filter() === 'all'}
          onClick={() => {
            filter.set('all');
          }}
        >
          All
        </button>
        <button
          className="chip"
          aria-pressed={filter() === 'active'}
          onClick={() => {
            filter.set('active');
          }}
        >
          Active
        </button>
        <button
          className="chip"
          aria-pressed={filter() === 'completed'}
          onClick={() => {
            filter.set('completed');
          }}
        >
          Completed
        </button>
      </div>

      <div className="list">
        <Each
          value={filteredTodos()}
          key={(item) => item.id}
          fallback={<p className="empty">No todos</p>}
        >
          {(item) => (
            <div className="item">
              <input
                type="checkbox"
                checked={item.completed}
                onChange={() => toggleTodo(item.id)}
              />
              <span className={item.completed ? 'done' : ''}>{item.text}</span>
              <button className="danger" onClick={() => removeTodo(item.id)}>
                Delete
              </button>
            </div>
          )}
        </Each>
      </div>

      <footer className="footer">
        <span className="summary">{remainingCount()} item(s) left</span>
        <button className="btn" onClick={clearCompleted}>
          Clear completed
        </button>
      </footer>
    </section>
  );
});

export default TodoFc;
