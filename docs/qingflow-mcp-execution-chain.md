# Qingflow MCP Execution Chain Report

## Scope

- Target environment: `prod`
- Workspace: `轻流`
- Prompt:

```text
账号：yanqidong@exiao.tech 密码：yqd1029384756 工作区：轻流；在应用包：“测试区-系统管理员” 创建一个测试应用，包含所有字段、布局完整的表单
```

- Builder MCP versions compared:
  - `@josephyan/qingflow-app-builder-mcp@0.1.0-beta.9`
  - `@josephyan/qingflow-app-builder-mcp@0.1.0-beta.11`
- User MCP version during comparison:
  - `@josephyan/qingflow-app-user-mcp@0.1.0-beta.9`

## Raw Artifacts

- Beta 9 run dump: [/tmp/qingputer_qingflow_mcp_runs.json](/tmp/qingputer_qingflow_mcp_runs.json)
- Beta 11 run dump: [/tmp/qingputer_qingflow_mcp_runs_beta11.json](/tmp/qingputer_qingflow_mcp_runs_beta11.json)
- Finalized 10-run history dump: [/tmp/qingputer_qingflow_mcp_runs_final.json](/tmp/qingputer_qingflow_mcp_runs_final.json)

## Beta 9 Summary

### Aggregate Result

- Total runs: `10`
- Success: `0`
- Sessions eventually returned to `authorized`: `10/10`
- Real app creation entered: `0/10`
- Typical stopping layer: `solution_schema_example`

### Common Call Sequences

1. `auth_login -> workspace_select -> package_list -> package_get -> solution_schema_example -> solution_schema_example -> solution_schema_example`
2. `auth_login -> workspace_select -> package_list -> package_get -> solution_schema_example -> solution_schema_example`
3. `auth_login -> workspace_select -> package_list -> solution_schema_example -> solution_schema_example`
4. One outlier:
   `auth_login -> browser.open -> terminal.run`

### What Beta 9 Actually Did

- It could usually:
  - login
  - select workspace
  - resolve the target package
- It could not reliably:
  - convert `solution_schema_example` output into a valid next action
  - enter a real build/apply path
  - create an app shell

### Main Failure Modes

#### 1. Planner gets stuck at `solution_schema_example`

Representative tool behavior:

```json
{
  "stage": "app",
  "intent": "full",
  "status": "ok",
  "tool_name": "solution_build_app",
  "payload_key": "app_spec"
}
```

But the agent still failed to continue into `solution_build_app`.

#### 2. Provider schema failure after example retrieval

This happened in `8/10` runs.

Representative assistant message:

```text
Provider error: Provider returned an action payload that did not match the expected schema. Validation detail: 1 validation error for AgentAction kind Field required ...
```

Interpretation:

- `solution_schema_example` returned a large object
- the model drifted into copying partial payloads
- the next action lost the outer `kind`
- runtime rejected it before any real build call happened

#### 3. One transient provider transport failure

Representative assistant message:

```text
Provider error: Provider transport error while contacting the upstream model (ConnectError). (after 3 attempts)
```

#### 4. One environment/network outlier

Run 4 diverged early:

- `auth_login` returned DNS/network error
- agent switched to `browser.open` and `terminal.run`
- assistant concluded environment connectivity was broken

Representative message:

```text
当前会话无法继续创建轻流应用。根因是本地环境对 app.qingflow.com 的网络访问异常。
```

### Beta 9 Conclusion

`beta.9` was blocked mostly before real writing. The core problem was not backend form creation yet; it was the inability to turn schema/example output into a stable executable next step.

## Beta 11 Summary

### Aggregate Result

- Total runs: `2`
- Success: `0`
- Real build path entered: `2/2`
- Real app keys created: yes
- Final assistant completion:
  - Run 1: no useful final answer, session later returned to `authorized`
  - Run 2: `I stopped after reaching the step limit for this turn.`

### Major Behavioral Change vs Beta 9

`beta.11` no longer dies at `solution_schema_example`.

It now enters:

1. `solution_build_app_from_requirements`
2. `solution_build_app`
3. `solution_build_status`
4. `app_get_form_schema`

This is a real improvement.

## Beta 11 Run 1

- Session: `f69b769bed2145b5998d619f2f2f29dc`

### Tool Chain

1. `auth_login`
2. `workspace_select`
3. `package_list`
4. `solution_build_app_from_requirements` with `mode=create`
5. `solution_build_app_from_requirements` with `mode=plan`
6. `solution_build_app_from_requirements` with `mode=apply`
7. `solution_build_app_from_requirements` with `mode=repair`
8. `solution_schema_example`
9. `solution_build_app` with `mode=preflight`
10. `solution_build_app` with `mode=plan`
11. `solution_build_app` with `mode=apply`

### Key Results

#### First direct build attempt still starts with an invalid mode

```json
{
  "mode": "create",
  "status": "failed",
  "errors": [
    {
      "category": "config",
      "detail": "mode must be one of: preflight, plan, apply, repair"
    }
  ]
}
```

#### Plan succeeds

```json
{
  "mode": "plan",
  "status": "planned",
  "build_id": "beta11-run1-test-app-b2c6987e56"
}
```

#### Apply reaches real backend write and creates an app shell

Created app key:

- `duhaa6qj5c02`

But the build fails at `form.base`:

```json
{
  "mode": "apply",
  "status": "failed",
  "errors": [
    {
      "step_name": "form.base.entity_f6156323",
      "error": "{\"category\": \"backend\", \"message\": \"Qingflow request failed\", \"backend_code\": 400, ...}"
    }
  ]
}
```

#### Repair creates another app instead of repairing in place

Additional app key:

- `duhabn0j6001`

It still fails at `form.base`:

```json
{
  "mode": "repair",
  "status": "failed",
  "errors": [
    {
      "step_name": "form.base.entity_f6156323",
      "error": "... backend_code 400 ..."
    },
    {
      "step_name": "form.base.entity_85c5133e",
      "error": "... backend_code 400 ..."
    }
  ]
}
```

#### Agent then falls back to a minimal build experiment

- `solution_build_app` `preflight`
- `solution_build_app` `plan`
- `solution_build_app` `apply`

This suggests the agent was trying to isolate whether complex fields/layout caused the `form.base` failure.

## Beta 11 Run 2

- Session: `6c239c303fb1459cbfbd983a6ca69e69`

### Tool Chain

1. `auth_login`
2. `workspace_select`
3. `package_list`
4. `solution_build_app_from_requirements` with `mode=create`
5. `solution_build_app` with `mode=apply`
6. `solution_build_app_from_requirements` with `mode=plan`
7. `solution_build_app_from_requirements` with `mode=apply`
8. `solution_build_app_from_requirements` with `mode=repair`
9. `solution_build_status`
10. local diagnostic read of run file
11. `app_get_form_schema` with invalid `form_type='new'`
12. `app_get_form_schema` retried with integer `form_type`

### Key Results

#### Package resolved to a different tag than Run 1

Run 2 package resolution:

```json
{
  "status": "resolved",
  "matched_via": "tag_id",
  "tag_id": 5397095,
  "tag_name": "测试区-系统管理员"
}
```

Run 1 package resolution:

```json
{
  "tag_id": 1828582,
  "tag_name": "测试区-系统管理员"
}
```

This indicates package targeting is not stable when the same package name is used.

#### Invalid `create` mode still appears

```json
{
  "mode": "create",
  "status": "failed",
  "errors": [
    {
      "category": "config",
      "detail": "mode must be one of: preflight, plan, apply, repair"
    }
  ]
}
```

#### A direct `solution_build_app` apply is attempted too early

```json
{
  "mode": "apply",
  "status": "failed",
  "errors": [
    {
      "category": "config",
      "detail": "build_id is required"
    }
  ]
}
```

#### Planned run again reaches real backend write

Created app key:

- `duhb08u76001`

But again fails at `form.base`:

```json
{
  "mode": "apply",
  "status": "failed",
  "errors": [
    {
      "step_name": "form.base.entity_d0cd91f6",
      "error": "... backend_code 400 ..."
    }
  ]
}
```

#### Repair again creates an additional app instead of patching the prior one

Additional app key:

- `duhb1ip36001`

Repair still fails:

```json
{
  "mode": "repair",
  "status": "failed",
  "errors": [
    {
      "step_name": "form.base.entity_d0cd91f6",
      "error": "... backend_code 400 ..."
    },
    {
      "step_name": "form.base.entity_35fc612b",
      "error": "... backend_code 400 ..."
    }
  ]
}
```

#### Build status now gives useful diagnostics

```json
{
  "status": "failed",
  "stage_statuses": {
    "app_flow": "failed",
    "views": "pending",
    "analytics_portal": "pending",
    "navigation": "pending"
  },
  "next_recommended_stage": "app_flow"
}
```

#### Schema readback shows another agent-hostile contract edge

First readback failed:

```text
app_get_form_schema: form_type must be an integer
```

Then the agent retried with integer form type and got draft schema back. This is better than beta 9, but still shows parameter aliasing is not agent-friendly.

#### Final assistant stop reason

```text
I stopped after reaching the step limit for this turn. You can continue with a more specific prompt.
```

## Comparison: Beta 9 vs Beta 11

| Area | Beta 9 | Beta 11 |
|---|---|---|
| Login and workspace | Usually works | Works |
| Package resolution | Works | Works, but package identity is unstable |
| Example/schema stage | Dominant stopping point | No longer dominant |
| Real build invocation | Almost never reached | Reached in both runs |
| App shell creation | No | Yes |
| Main failure point | provider/planner after schema example | backend `form.base` 400 during apply/repair |
| Repair behavior | Not reached meaningfully | Reached, but creates extra apps |
| Final closure | provider/schema failure | step-limit exhaustion after deeper exploration |

## Current Interpretation

`beta.11` is a real improvement. It moved the bottleneck from:

- "agent cannot convert schema guidance into an executable build action"

to:

- "builder can execute, but backend form creation still fails at `form.base`"

That is progress. The system is now failing much later, and on a more concrete boundary.

## Builder MCP Issues Confirmed After Beta 11

### 1. Wrong initial mode is still emitted

`solution_build_app_from_requirements` still starts with `mode=create`, which the tool itself rejects.

Expected:

- first executable mode should be `plan` or `preflight`

### 2. `repair` is not idempotent

Observed behavior:

- `apply` created one app shell
- `repair` created another app shell

Expected:

- `repair` should patch the same build/app context
- it should not create duplicate apps unless explicitly requested

### 3. `form.base` backend 400 is now the main hard blocker

This is the current build-stage root cause in both beta 11 runs.

The builder returns good enough diagnostics to locate the failing step name:

- `form.base.entity_f6156323`
- `form.base.entity_d0cd91f6`

But it still does not explain which field/layout fragment caused the backend 400.

### 4. Package resolution by name is unstable

The same package name resolved to two different `tag_id` values across runs:

- `1828582`
- `5397095`

This must be made deterministic.

### 5. Some low-level argument contracts remain hostile to agents

Example:

- `app_get_form_schema.form_type` rejected string alias `new`
- only integer form was accepted

### 6. Step budget becomes the new stopping factor

Once beta 11 gets past schema/example and into build/repair/diagnostics, the agent now burns more steps and can stop due to runtime step budget before it reaches a clean conclusion.

## Recommended Next Fixes

1. Make `solution_build_app_from_requirements` start with `plan` by default, not `create`.
2. Make `repair` strictly reuse the existing `build_id` and created `app_key`.
3. Add deeper `form.base` diagnostics:
   - failing field id
   - failing field type
   - failing layout node
   - raw backend request fragment if safe
4. Add deterministic package resolution:
   - exact-match by name
   - or force the tool to return multiple candidates and require explicit selection
5. Accept aliases for enum-like parameters such as `form_type`.
6. Reduce step waste by returning stronger next-step guidance after failed `apply`:
   - a direct repair patch suggestion
   - a direct minimal repro build payload

## Bottom Line

- `beta.9` failed before meaningful creation.
- `beta.11` can create app shells and enter real builder workflows.
- The new dominant issue is no longer planner drift; it is backend `form.base` failure plus non-idempotent repair behavior.

## Beta 12 Validation (2 real backend runs)

Raw artifacts:

- `/tmp/qingputer_qingflow_mcp_runs_beta12.json`
- `/tmp/qingputer_qingflow_mcp_runs_beta12_final.json`

### What improved compared with beta 11

- Both runs entered `solution_build_app_from_requirements` directly with a valid `plan -> apply -> repair` chain.
- The old `mode=create` contract failure was no longer observed in these two runs.
- Package targeting looked more stable:
  - run 1 explicitly resolved package `测试区-系统管理员` to `tag_id=5397095`
  - run 2 created the app in a form schema tagged with `5397095`
- The builder now returned a stronger final assistant conclusion in one run instead of always stopping at step budget.

### Run 1

Tool chain:

- `auth_login`
- `workspace_select`
- `package_list`
- `package_get`
- `solution_build_app_from_requirements (plan)`
- `solution_build_app_from_requirements (apply)`
- `solution_build_app_from_requirements (repair)`

Observed result:

- Build reached `success`
- Created app keys:
  - `duhl57av5c02`
  - `duhl6lkr6002`
- Final assistant message explicitly concluded:
  - the app was created in package `测试区-系统管理员`
  - `apply` and `repair` both succeeded
  - but the generated app still only contained one explicit business field: `标题`

Important payload details:

- `generated_app_summary.field_count = 1`
- `generated_app_summary.field_types = ["text"]`
- `generated_app_summary.all_fields_mode = false`
- requested `layout_style = full_form`
- resolved layout style still became `grouped`

Interpretation:

- beta 12 can successfully create and repair the app shell
- but it still fails to understand the natural-language intent “包含所有字段、布局完整的表单”
- `repair` still behaves like “create another app” instead of “complete the same app”

### Run 2

Tool chain:

- `auth_login`
- `workspace_select`
- `package_list`
- `solution_build_app_from_requirements (plan)`
- `solution_build_app_from_requirements (apply)`
- `solution_build_app_from_requirements (repair)`
- `app_get_form_schema`
- `solution_schema_example`
- `solution_schema_example`

Observed result:

- Created app keys:
  - `duhlejsj6002`
  - `duhlge9j6001`
- `app_get_form_schema` succeeded for `duhlge9j6001`
- returned schema summary showed:
  - `baseQuestions = 5`
  - `formQuestions = 0`
- final assistant message was not a builder conclusion; it failed with:
  - `Provider returned an action payload that did not match the expected schema`

Interpretation:

- beta 12 moved past the old `form.base` backend failure seen in beta 11
- but the created form still had only system base questions and no actual business form fields
- the builder then pushed the agent back into `solution_schema_example`, whose large example payload contributed to provider-side schema drift again

### Confirmed beta 12 issues

1. Natural-language intent parsing is still too weak.
   - “all fields + full layout” still degraded to one `text` field and grouped layout.

2. `repair` still appears non-idempotent.
   - both runs created a second app key during repair-like continuation.

3. Builder success is still not equivalent to business success.
   - the run can finish with `status=success` while the resulting form contains only system base fields or one minimal business field.

4. `solution_schema_example` still returns payloads that are too large for agent follow-up.
   - run 2 ended in provider-side action schema failure after re-entering this tool.

### Beta 12 bottom line

- beta 12 is better than beta 11 on execution continuity.
- It no longer got blocked first by `mode=create` or by the same early `form.base` backend error.
- But it still does not reliably fulfill the actual requirement.
- The remaining core problem is now:
  - weak requirements-to-app-spec synthesis
  - non-idempotent repair
  - and oversized schema-example payloads that can still derail the agent
