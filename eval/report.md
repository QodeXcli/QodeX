# QodeX Eval Report
Run: 2026-05-29T09:44:43.385Z
Model: glm4:latest

**0/2 passed (0%)**

- avg iterations: 1.0
- avg tool calls: 0.0
- avg wall time: 10.7s
- total cost: $0.0000

| Task | Result | Iters | Tools | Time | Notes |
|------|--------|-------|-------|------|-------|
| 01-create-file | ❌ fail | 1 | 0 | 11.1s | expected file missing: hello.txt; file not found for content check: hello.txt |
| 02-write-function | ❌ fail | 1 | 0 | 10.4s | expected file missing: sum.js; command "node -e "const {sum}=require('./sum.js'); process.exit(sum(2,3)===5?0:1)"" exited 1 (expected 0) |
