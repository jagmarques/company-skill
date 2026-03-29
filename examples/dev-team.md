# Development Team — Feature Sprint

## Backend (Lead: Tech Lead)
- Tech Lead — architecture, PR reviews, technical decisions
- Backend Dev A — API endpoints, business logic
- Backend Dev B — database, migrations, caching
- DevOps — deployment, monitoring, CI/CD

## Frontend (Lead: Frontend Lead)
- Frontend Lead — component architecture, state management
- Frontend Dev A — pages, routing, forms
- Frontend Dev B — design system, accessibility

## Quality (Lead: QA Engineer)
- QA Engineer — test plans, E2E tests, regression
- Security Reviewer — OWASP checks, dependency audit

## Priorities
1. [URGENT] Fix production 500 errors on /api/checkout
2. [URGENT] Deploy hotfix for payment gateway timeout
3. [IMPORTANT] Implement user dashboard redesign
4. [RESEARCH] Evaluate migration from REST to GraphQL

## Rules
- All PRs need Tech Lead or Frontend Lead approval
- Security Reviewer must approve anything touching auth or payments
- QA Engineer runs E2E suite before every deploy
