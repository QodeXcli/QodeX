import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

// In-memory todo store keyed by sessionId
const todoStore = new Map<string, TodoItem[]>();

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'low' | 'medium' | 'high';
}

export function getTodos(sessionId: string): TodoItem[] {
  return todoStore.get(sessionId) ?? [];
}

export function clearTodos(sessionId: string): void {
  todoStore.delete(sessionId);
}

const TodoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

const WriteSchema = z.object({
  todos: z.array(TodoSchema).describe('Complete list of todos. This REPLACES the existing todos. Always send the full list.'),
});

export class TodoWriteTool extends Tool<z.infer<typeof WriteSchema>> {
  name = 'todo_write';
  description = 'Update the visible todo list. Use this to track multi-step work. Set status to "in_progress" for the active item, "completed" when done. Always include ALL todos (this replaces the list). Use ids like "1", "2", etc. Update frequently — after every meaningful step.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = WriteSchema;

  // Tolerate two common model mistakes without loosening the schema:
  //  - `todos` passed as a JSON STRING (double-encoded args) → parse it
  //  - numeric `id`s → stringify
  coerceArgs(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const a: any = { ...(raw as any) };
    if (typeof a.todos === 'string') {
      try { a.todos = JSON.parse(a.todos); } catch { /* leave for zod to report */ }
    }
    if (Array.isArray(a.todos)) {
      a.todos = a.todos.map((t: any) =>
        t && typeof t === 'object' && typeof t.id === 'number' ? { ...t, id: String(t.id) } : t,
      );
    }
    return a;
  }

  async execute(args: z.infer<typeof WriteSchema>, ctx: ToolContext): Promise<ToolResult> {
    todoStore.set(ctx.sessionId, args.todos);

    if (args.todos.length === 0) {
      return { content: 'Todo list cleared.' };
    }

    const lines = args.todos.map(t => {
      const marker = t.status === 'completed' ? '[x]'
        : t.status === 'in_progress' ? '[>]'
        : t.status === 'cancelled' ? '[-]'
        : '[ ]';
      const pri = t.priority ? ` (${t.priority})` : '';
      return `  ${marker} ${t.content}${pri}`;
    });
    return {
      content: `Todo list updated (${args.todos.length} items):\n${lines.join('\n')}`,
      metadata: { count: args.todos.length },
    };
  }
}

const ReadSchema = z.object({});

export class TodoReadTool extends Tool<z.infer<typeof ReadSchema>> {
  name = 'todo_read';
  description = 'Read the current todo list. Use to remind yourself what is in progress and what remains.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ReadSchema;

  async execute(_args: z.infer<typeof ReadSchema>, ctx: ToolContext): Promise<ToolResult> {
    const todos = todoStore.get(ctx.sessionId) ?? [];
    if (todos.length === 0) {
      return { content: 'Todo list is empty. Use todo_write to plan tasks.' };
    }
    const lines = todos.map(t => {
      const marker = t.status === 'completed' ? '[x]'
        : t.status === 'in_progress' ? '[>]'
        : t.status === 'cancelled' ? '[-]'
        : '[ ]';
      return `  ${marker} ${t.content}`;
    });
    return { content: `Current todos:\n${lines.join('\n')}` };
  }
}
