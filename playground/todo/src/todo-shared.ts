export type TodoFilter = 'all' | 'active' | 'completed';

export interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

export const createTodoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

