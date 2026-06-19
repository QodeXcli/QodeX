# Backend Architecture — reference

## Layer boundaries (the rule that makes it look senior)
Business logic must not live inside framework glue. Dependencies point inward.

```
HTTP / framework  →  application/service layer  →  domain (entities, rules)  →  data access
(views, routers,     (use-cases, orchestration,    (pure business logic,        (ORM, repos,
 serializers)         transactions)                 no framework imports)        queries)
```

- A view/route handler should: parse+validate input → call ONE service function → shape the
  response. No business rules, no multi-step ORM choreography in the view.
- Services own use-cases and transactions. Domain logic is testable without HTTP or a DB.
- Data access is isolated so the query strategy can change without touching business rules.

## Django layout (DRF / FastAPI-style services)
```
project/
  config/            settings (split base/dev/prod), urls, asgi/wsgi
  apps/
    <domain>/
      models.py        # data model + DB constraints + indexes
      selectors.py     # read queries (return querysets/DTOs) — no writes
      services.py      # write use-cases, transactions, business rules
      serializers.py   # input validation + output shaping (DRF)
      views.py         # thin: validate → service/selector → respond
      urls.py
      tests/           # test_services, test_api, factories
```
- `services.py` / `selectors.py` split (read vs write) keeps views thin and logic testable —
  the HackSoft "Django styleguide" pattern. Views never call the ORM directly for anything
  non-trivial.
- Settings split by environment; secrets via env (django-environ / os.environ), never committed.

## Node layout (Express / Nest / Fastify)
```
src/
  modules/<domain>/
    <domain>.controller.ts   # HTTP in/out only
    <domain>.service.ts      # use-cases, transactions
    <domain>.repository.ts   # data access (Prisma/TypeORM/Knex)
    <domain>.schema.ts       # zod/class-validator input + output types
    <domain>.test.ts
  shared/      errors, logging, config (env-validated), middleware
  main.ts
```
- Validate env at boot (zod) and fail fast. One typed error class hierarchy → one error mapper.

## Data model checklist
- Right types (don't store numbers/dates as strings). Money = integer minor units or Decimal.
- Indexes on every FK and every column you filter/sort/join on. Composite indexes match query
  order. Don't over-index writes-heavy tables.
- DB-level constraints (UNIQUE, CHECK, NOT NULL, FK ON DELETE) — not just app validation.
- Avoid N+1: Django `select_related` (FK) / `prefetch_related` (M2M/reverse); Node eager
  includes or a dataloader for GraphQL. Verify with query logging, don't assume.

## Migration safety (non-negotiable)
- Additive + reversible. `ALTER TABLE ADD` over drop-and-recreate. Never lose data.
- Two-step for risky changes: (1) add nullable column + backfill in a data migration, (2) make
  non-null/drop-old in a later deploy. Same for renames (add-new → dual-write → backfill → drop).
- Backfills are separate from schema changes and are batched/idempotent on large tables.

## API contract checklist
- Resources/operations named consistently; plural nouns for REST collections.
- One error envelope everywhere: `{ error: { code, message, details? } }`. Stable machine codes.
- Correct status: 200/201/204, 400 validation, 401 vs 403, 404, 409 conflict, 422, 429, 5xx.
- Pagination on every list (cursor for large/append-only; offset for small admin lists).
- Versioning (URL `/v1/` or header) from day one. Idempotency keys for unsafe retries.
- Validate at the boundary (serializers/pydantic/zod); never trust client input downstream.

## Security checklist (OWASP-grade defaults)
- SQL: ORM or parameterized queries only — never string-concatenated SQL.
- Authz on EVERY endpoint, and per-object where ownership matters (no IDOR).
- Secrets from env/secret manager; nothing sensitive in code, logs, or error responses.
- CSRF protection for cookie/session auth; least-privilege CORS allow-list.
- Rate-limit auth + expensive endpoints. Hash passwords with bcrypt/argon2. Sign/expire tokens.
- Validate + bound all input sizes; reject unexpected fields.

## Performance (measure, then act)
- Cache at the right layer (per-request, query/result cache, or HTTP cache) with explicit
  invalidation. Don't cache to mask an N+1 — fix the query.
- Connection pooling; async I/O where it removes a real wait (don't make everything async by
  reflex). Paginate. Stream large responses. Profile before optimizing; keep the script.
