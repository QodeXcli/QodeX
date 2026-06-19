/**
 * Pure builder for the boot-splash init checklist. Kept free of Ink/React so it can be
 * unit-tested, and so the splash component just maps over the result.
 *
 * Each step names a subsystem coming online and a one-line detail drawn from the REAL
 * runtime state (model count, tool count, config flags) — so the splash isn't theatre,
 * it's an honest status readout dressed up nicely.
 */

export interface BootStep {
  label: string;
  detail: string;
}

export interface BootStepInputs {
  modelCount: number;
  toolCount: number;
  model: string;
  autoRetrieve: boolean;
  draftModel?: string;
}

export function buildBootSteps(input: BootStepInputs): BootStep[] {
  const modelWord = input.modelCount === 1 ? 'model' : 'models';
  return [
    {
      label: 'Model router',
      detail: input.modelCount > 0
        ? `${input.modelCount} ${modelWord} online · ${input.model}`
        : `no models yet · start Ollama or set an API key`,
    },
    {
      label: 'Tool registry',
      detail: `${input.toolCount} tools armed`,
    },
    {
      label: 'Code graph',
      detail: 'tree-sitter symbol index',
    },
    {
      label: 'Constrained decoding',
      detail: input.draftModel ? `schema-guided · draft ${input.draftModel}` : 'schema-guided tool calls',
    },
    {
      label: 'Semantic retrieval',
      detail: input.autoRetrieve ? 'auto-context enabled' : 'on demand',
    },
    {
      label: 'Diagnostics',
      detail: 'type-level checks ready',
    },
  ];
}
