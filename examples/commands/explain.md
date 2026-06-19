---
description: Explain what a symbol does using the code graph
argument-hint: <symbol-name>
allowed-tools: [code_graph_explain_symbol, code_graph_find_callers, code_graph_find_references, read_file]
mode: plan
---
Explain `{{ARGUMENTS}}` in this codebase.

1. Use `code_graph_explain_symbol` to fetch the definition, signature, and leading docstring.
2. Use `code_graph_find_callers` to see who calls it (top 10 sites).
3. If it's a type/interface, also run `code_graph_find_references` to see usage shape.
4. Write a 2-4 sentence summary covering: what it does, where it sits in the architecture,
   and one notable invariant or caveat from the implementation.

Be concise. Don't dump full source unless something subtle requires it.
