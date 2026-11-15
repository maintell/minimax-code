export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  content: string;
  status: TodoStatus;
  priority?: string;
}

export type EventRecord =
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'warning'; text: string; code?: string }
  | { kind: 'other'; eventType: string };

export interface TodoSummary {
  total: number;
  completed: number;
  cancelled: number;
  remaining: number;
}

export function eventRecord(message: unknown): EventRecord | null;
export function summarizeTodos(todos: readonly Todo[]): TodoSummary;
