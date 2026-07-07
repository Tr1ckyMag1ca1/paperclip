# DoD Phase B: Company Default Execution Policy

## Summary

Implements creation-time auto-arming of issues with a company-default execution policy. When an issue is created without an explicit execution policy and the company has a default configured, the default is automatically applied (if the issue is a work-type issue: build, implement, or content). Supports `$COMPANY_VERIFIER` sentinel resolution to the company's active Verifier agent at stamp time, so policies survive agent re-hires.

Closes: Part of fleet-wide DoD enforcement (design in `DOD-ENFORCEMENT-DESIGN.md`).

## Changes

### Schema & Migrations
- **Migration 0128** (`packages/db/src/migrations/0128_default_execution_policy.sql`): Adds `settings` jsonb column to `companies` table
- **DB Schema** (`packages/db/src/schema/companies.ts`): Adds `settings` jsonb column to Drizzle ORM model
- **Migration Journal** (`packages/db/src/migrations/meta/_journal.json`): Registers migration 0128

### Core Service
- **New Service** (`server/src/services/company-default-execution-policy.ts`): 
  - `readCompanyDefaultExecutionPolicy(db, companyId)`: Reads company settings and extracts defaultExecutionPolicy
  - `resolveCompanyDefaultExecutionPolicy(db, companyId, policy)`: Resolves `$COMPANY_VERIFIER` sentinels to active Verifier agent(s)
  - `applyCompanyDefaultExecutionPolicy(db, companyId, createInputPolicy, issueType)`: Main orchestrator
    - Returns null if createInputPolicy is explicitly null (escape hatch for meta issues)
    - Returns createInputPolicy if provided (explicit policies always win)
    - Applies company default if issue is work-type and no explicit policy
  - `findCompanyVerifier(db, companyId)`: Finds active Verifier agent by name pattern (Verifier%), most recent first

### API Integration
- **Issue Creation Route** (`server/src/routes/issues.ts`):
  - Calls `applyCompanyDefaultExecutionPolicy` before normalizing
  - Logs debug message when default is applied
  - Preserves existing actor-scheduled-by behavior
- **Company Schema** (`packages/shared/src/validators/company.ts`):
  - Adds `companySettingsSchema` with `defaultExecutionPolicy` field (nullable)
  - Extends `updateCompanySchema` to accept `settings` in PATCH body
- **Company Service** (`server/src/services/companies.ts`):
  - Adds `settings` to company selection query
  - No changes needed to update logic (settings passed through partial update)
- **Shared Types** (`packages/shared/src/types/company.ts`):
  - Adds `settings: Record<string, unknown> | null` to Company interface

### Tests & Fixtures
- **Service Tests** (`server/src/services/__tests__/company-default-execution-policy.test.ts`): 
  - create-with-default-applied
  - create-with-explicit-policy-wins  
  - create-with-null-escape-hatch
  - company-without-default-unchanged
  - sentinel-resolution
  - sentinel-with-no-verifier-warns-and-skips
- **UI/CLI Fixtures** (updated Company mock objects):
  - `cli/src/__tests__/company-delete.test.ts`
  - `ui/src/context/CompanyContext.test.tsx`
  - `ui/storybook/fixtures/paperclipData.ts`

## Behavior

### Issue Creation (POST /companies/:companyId/issues)

1. **Escape hatch: explicit null in input**
   - If request body includes `"executionPolicy": null`, skip default entirely
   - Intended for meta issues that should not be subject to DoD workflow

2. **Explicit policy wins**
   - If request body includes `"executionPolicy": { ... }`, use it as-is
   - Default is never applied

3. **Default application**
   - If no `executionPolicy` in input AND company has `settings.defaultExecutionPolicy`:
     - Check issue type: only apply if build/implement/content (or undefined)
     - Resolve `$COMPANY_VERIFIER` sentinel to active agent named like "Verifier%"
     - If no Verifier agent found, log warning and skip default (don't arm issue)
     - Otherwise, stamp normalized default onto issue
   - Log debug message: `Applied company default policy to issue (company=..., type=...)`

### Sentinel Resolution

- At stamp time (not at config time), lookup company's active Verifier agent:
  - Query: `WHERE company_id = ? AND name ILIKE 'Verifier%' AND status != 'terminated'`
  - Order by: `created_at DESC` (most recent first)
  - If found: replace `$COMPANY_VERIFIER` in all participant agentIds
  - If not found: log warning, skip stamping, return null (issue created without policy)
- Survives agent re-hires: same template works across Verifier replacements

### Config Path (PATCH /companies/:companyId)

Extended company update endpoint to accept settings:

```json
{
  "settings": {
    "defaultExecutionPolicy": {
      "mode": "normal",
      "commentRequired": true,
      "stages": [{
        "id": "<uuid>",
        "type": "review",
        "approvalsNeeded": 1,
        "participants": [{
          "id": "<uuid>",
          "type": "agent",
          "agentId": "$COMPANY_VERIFIER",  // Resolved at issue-creation time
          "userId": null
        }]
      }]
    }
  }
}
```

Board API auth required; settings field validated through existing `issueExecutionPolicySchema`.

## Testing

All existing tests pass. New tests cover:
- create-with-default-applied: default applied when no explicit policy and work-type issue
- create-with-explicit-policy-wins: explicit policy overrides default
- create-with-null-escape-hatch: explicit null skips default
- company-without-default-unchanged: issue created without policy if no default set
- sentinel-resolution: $COMPANY_VERIFIER resolved to active agent
- sentinel-with-no-verifier-warns-and-skips: warning logged, default skipped if no Verifier found

Run tests:
```bash
pnpm run typecheck    # All packages typecheck (✓ passed)
pnpm -r test         # Full test suite (includes service tests)
```

## Deviations from Spec

None. Fully implements Phase B specification from `DOD-ENFORCEMENT-DESIGN.md`:
- Per-company `default_execution_policy` in settings (jsonb) ✓
- Creation-time stamp for work issues ✓
- Escape hatch (explicit null) ✓
- Sentinel support with resolution ✓
- API to set default ✓
- Tests ✓
- Typecheck green ✓

## Next Steps

1. Land this PR upstream if acceptable (generally useful feature)
2. If landed upstream, remove fork divergence by rebasing to main
3. Populate `default_execution_policy` for active companies in Phase B ops playbook
4. Proceed to Phase C (watchdog, approval audit trail, drift monitor)

## Checklist

- [x] Branch off fork master
- [x] Migration added and numbered correctly (0128)
- [x] Schema updated (Drizzle + shared types + validators)
- [x] Service logic implements spec exactly
- [x] API route hooked in
- [x] Tests written (6 scenarios)
- [x] Typecheck passes all packages
- [x] Commit message follows repo style
- [x] Ready to PR upstream

🤖 Generated with [Claude Code](https://claude.com/claude-code)
