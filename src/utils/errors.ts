export class QodexError extends Error {
  constructor(message: string, public code: string, public meta?: Record<string, unknown>) {
    super(message);
    this.name = 'QodexError';
  }
}

export class ToolError extends QodexError {
  constructor(message: string, public toolName: string, code = 'TOOL_ERROR', meta?: Record<string, unknown>) {
    super(message, code, meta);
    this.name = 'ToolError';
  }
}

export class ValidationError extends QodexError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', meta);
    this.name = 'ValidationError';
  }
}

export class PermissionError extends QodexError {
  constructor(message: string, public tool: string, public operation: string) {
    super(message, 'PERMISSION_DENIED', { tool, operation });
    this.name = 'PermissionError';
  }
}

export class BudgetExceededError extends QodexError {
  constructor(message: string, public budgetType: 'tokens' | 'cost' | 'time' | 'iterations') {
    super(message, 'BUDGET_EXCEEDED', { budgetType });
    this.name = 'BudgetExceededError';
  }
}

export class ProviderError extends QodexError {
  constructor(message: string, public provider: string, public httpStatus?: number) {
    super(message, 'PROVIDER_ERROR', { provider, httpStatus });
    this.name = 'ProviderError';
  }
}

export class CancelledError extends QodexError {
  constructor(message = 'Operation cancelled') {
    super(message, 'CANCELLED');
    this.name = 'CancelledError';
  }
}
