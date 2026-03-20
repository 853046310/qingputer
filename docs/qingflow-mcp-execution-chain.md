# Qingflow MCP Execution Chain Report

## Scope

- Target environment: `prod`
- Workspace: `轻流`
- Prompt:

```text
账号：<redacted> 密码：<redacted> 工作区：轻流；在应用包：“测试区-系统管理员” 创建一个测试应用，包含所有字段、布局完整的表单
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

## Beta 12 Validation (5 real backend runs, customer order form)

Prompt:

- `账号：<redacted> 密码：<redacted> 工作区：轻流；在应用包：“测试区-系统管理员” 搭建一个全字段的客户订单表单、布局优美。`

Raw artifacts:

- `/tmp/qingputer_qingflow_customer_order_runs_beta12.json`
- `/tmp/qingputer_qingflow_customer_order_runs_beta12_final.json`

### Overall result

- `0/5` runs fully satisfied the requirement
- `3/5` runs entered real build/apply/repair flows
- `2/5` runs failed immediately because `package_list` returned no matching package at all
- `2/5` runs ended with provider-side schema drift after re-entering `solution_schema_example`
- `1/5` run ended with a useful assistant diagnosis that explicitly recommended stopping high-level repair and switching to a hand-authored `solution_build_app`

### Repeated patterns

#### Pattern A: package lookup instability

Observed in run 2 and run 5:

- `package_list` returned `0` packages
- builder reported:
  - `package_name '测试区-系统管理员' was not found`

This is inconsistent with other runs in the same workspace and same package name.

#### Pattern B: “all fields” is now partially understood, but still wrong

Observed in run 3 and run 4 plan output:

- `field_count = 17`
- `all_fields_mode = true`
- recognized field types included:
  - `text`
  - `long_text`
  - `number`
  - `amount`
  - `date`
  - `datetime`
  - `member`
  - `department`
  - `single_select`
  - `multi_select`
  - `phone`
  - `email`
  - `address`
  - `attachment`
  - `boolean`
  - `relation`
  - `subtable`

This is progress over the previous “one title field” failure, but it is still not production-safe:

- it still forces layout to `grouped`
- it treats “布局优美” as grouped layout, not a richer layout spec
- it includes `relation` and `subtable`, which later become the main failure source

#### Pattern C: high-level repair still does not converge

Observed in run 3:

- repeated `repair` attempts kept failing
- assistant diagnosis explicitly said the tool kept regenerating incompatible `relation/subtable` structures
- latest draft app still had only system base fields
- `formQuestions = 0`

This is a stronger signal than previous runs:

- the problem is no longer just “can it create an app”
- the problem is “can it converge to a usable business form from a high-level natural-language build loop”

#### Pattern D: schema example still destabilizes the planner

Observed in run 1 and run 4:

- after build/apply/repair, the agent fell back into `solution_schema_example`
- first with invalid intent values such as `form` or `repair`
- then with `intent=minimal`
- finally the provider failed with:
  - `Provider returned an action payload that did not match the expected schema`

So the old “example payload too large / too agent-hostile” problem is still active.

### Run-level summary

#### Run 1

- Entered build flow
- Created app shells:
  - `duhngrqv6002`
  - `duhniv8f6002`
- Then fell back to `solution_schema_example`
- Ended in provider action schema failure

#### Run 2

- Did not enter creation
- `package_list` returned no matching package
- Assistant correctly stopped and asked for package confirmation

#### Run 3

- Entered full build flow
- Created app shells including:
  - `duhoidsv5c01`
  - `duhojsc75c01`
  - `duhoul2v6001`
- Assistant concluded:
  - stop repeating `solution_build_app_from_requirements`
  - switch to explicit flattened `solution_build_app`
  - avoid `section / relation / subtable`
- This is the most useful diagnostic run

#### Run 4

- Entered build flow
- Created app shells:
  - `duhpa92r6001`
  - `duhpc3ir6002`
- Read back `app_get_base` and `app_get_form_schema`
- Then returned to `solution_schema_example`
- Ended in provider action schema failure

#### Run 5

- Same as run 2
- `package_list` returned no matching package
- Assistant stopped and asked for confirmation

### New confirmed issues from the customer-order prompt

1. `package_list` is nondeterministic across identical live runs.
   - Same workspace, same package name
   - sometimes package exists
   - sometimes zero packages are returned

2. Requirements parsing is improved but still unsafe.
   - it now recognizes “all fields”
   - but it over-expands into `relation` and `subtable`
   - and still downgrades aesthetics to plain grouped layout

3. High-level `solution_build_app_from_requirements` is still not convergent for rich forms.
   - it can create shells
   - but cannot reliably finish a usable form spec from natural language alone

4. `solution_schema_example` is still a destabilizing fallback.
   - it remains easy for the planner to enter with invalid intent values
   - and it can still trigger provider-side schema drift

### Updated recommendation

For rich form-generation tasks like “全字段客户订单表单、布局优美”, the current best path is:

1. Use high-level requirements mode only for rough planning.
2. Stop before repeated repair loops.
3. Switch to explicit `solution_build_app` with a flattened, hand-authored app spec.
4. Exclude advanced structures by default:
   - `relation`
   - `subtable`
5. Make layout explicit instead of relying on “优美 / 完整 / grouped” interpretation.

## Beta 15 Validation (3 real backend runs, same customer-order prompt)

Prompt:

- `账号：<redacted> 密码：<redacted> 工作区：轻流；在应用包：“测试区-系统管理员” 搭建一个全字段的客户订单表单、布局优美。`

Raw artifact:

- `/tmp/qingputer_qingflow_customer_order_runs_beta15.json`

### Version shape changed materially

This version is not just an incremental patch. The exposed builder surface is much smaller and more opinionated.

Observed tool count:

- `qingflow-app-builder-mcp`: `15` tools
- `qingflow-app-user-mcp`: `39` tools

Builder tool set now centers around:

- `package_resolve`
- `app_resolve`
- `app_read`
- `app_schema_apply`
- `app_layout_apply`
- `app_flow_apply`
- `app_views_apply`
- `app_publish_verify`

So beta 15 looks like a redesigned “low-level apply pipeline” rather than the older solution-heavy builder.

### Real run outcome

- `0/3` runs reached form creation
- `0/3` runs created any new `app_key`
- `3/3` runs failed before package/app modification

### What happened

#### Run 1

- `auth_login` failed with network/DNS style error:
  - `nodename nor servname provided, or not known`
- browser fallback to `https://app.qingflow.com` failed with:
  - `ERR_CONNECTION_CLOSED`
- terminal diagnostics confirmed:
  - DNS lookup failure / NXDOMAIN
  - HTTPS connection failure
- assistant correctly stopped and reported external network blockage

#### Run 2

- Same as run 1
- `auth_login` failed with the same network category error
- browser and terminal fallback again confirmed connectivity failure
- assistant again stopped instead of looping blindly

#### Run 3

- `qingflow-app-builder-mcp.auth_login` failed differently:
  - backend error `49300`
- `qingflow-app-user-mcp.auth_login` also failed
- the agent then explored browser login pages and reached the DingTalk / Qingflow login flow
- it determined the visible path was QR-code login rather than an email/password form
- assistant stopped with a more specific diagnosis:
  - not a single-MCP config problem
  - likely login-method / backend / auth contract mismatch

### Evaluation

#### What is better

1. Much better failure containment.
   - beta 15 stops early when login/network/auth is impossible.
   - it no longer burns many steps generating app shells and then failing later.

2. Better diagnosis quality.
   - it used MCP, browser, and terminal as independent checks.
   - the final assistant messages were materially more useful than earlier versions.

3. Clearer tool surface.
   - the builder now looks more composable and explicit.
   - this is a good direction for robust agents.

#### What is worse or still unresolved

1. We did not get far enough to validate actual build quality.
   - because all three runs failed before package/app operations
   - so beta 15 may be better architecturally, but this run did not prove the build path yet

2. Authentication behavior is now the primary blocker.
   - sometimes DNS/network style failure
   - sometimes backend `49300`
   - these need clarification before builder quality can be judged fairly

3. Browser fallback is still not enough to complete login.
   - the reachable login path appears centered on DingTalk QR auth
   - that is not directly automatable from the supplied email/password pair

### Beta 15 bottom line

- beta 15 looks like a genuinely new builder generation, not a small patch.
- The redesign seems directionally correct:
  - fewer tools
  - clearer applies
  - earlier stop conditions
  - better diagnostics
- But in this environment, the version is currently blocked at authentication / connectivity, so it has **not yet proven** that it can build the requested form better than beta 12.

### Recommended next verification

To evaluate beta 15 fairly, the next test should avoid password-login ambiguity:

1. use `auth_use_token` with a valid token and `ws_id`
2. confirm `auth_whoami`
3. run the same customer-order request again
4. then judge:
   - package resolution quality
   - schema apply quality
   - layout apply quality
   - publish / verify quality

## Beta 15 Validation (3 real backend runs after token/workspace injection)

Setup:

- builder/user MCP default profiles were already logged in
- `workspace_select(ws_id=40013)` was applied directly to both beta 15 stdio MCP servers
- then the Qingputer runtime MCP connections were refreshed

Prompt:

- `已配置可用的轻流登录态，并已选中工作区“轻流”（ws_id=40013）。请在应用包“测试区-系统管理员”中搭建一个全字段的客户订单表单，布局优美。`

Raw artifact:

- `/tmp/qingputer_qingflow_customer_order_runs_beta15_token.json`

### High-level result

- `1/3` runs produced a materially useful business result
- `2/3` runs still failed on package attach flow
- The new dominant blocker is no longer login:
  - it is now `failed to attach app to package`

### What beta 15 proved after token-based auth

#### 1. The new builder pipeline is real

The runtime used the new low-level chain, not the old solution-heavy path:

- `package_resolve`
- `app_resolve`
- `app_schema_apply`
- `app_read`
- `app_layout_apply`

That means the redesign is genuinely being exercised.

#### 2. Full-field app creation can now succeed

In run 2, beta 15 successfully created:

- app title: `客户订单`
- app key: `duosjfg7eo02`
- field count: `30`

The assistant explicitly confirmed:

- app created
- fields complete
- customer / order / product / delivery / payment / remark / attachment fields present

This is the first version in these experiments that actually produced a strong “businessly useful” app outcome for this prompt.

#### 3. But package attachment is still broken

The same successful run also showed:

- `tag_ids = []`
- app was not mounted into package `测试区-系统管理员`
- earlier `app_schema_apply` calls failed with:
  - `failed to attach app to package`

So the created app exists, but package placement is still broken.

### Run-level summary

#### Run 1

- `package_resolve` succeeded
- `app_resolve` said app not found
- `app_schema_apply` failed repeatedly with:
  - `failed to attach app to package`
- agent then tried browser fallback
- final conclusion: stop and report package attach blocker plus missing browser login state

#### Run 2

- `package_resolve` succeeded with:
  - `tag_id = 1828582`
  - `match_mode = exact`
- first `app_schema_apply` revealed contract tightening:
  - `serial` is not an accepted field type
  - payload requires `name` instead of `title`
- after corrections, a new app was created:
  - `duosjfg7eo02`
- readback later showed:
  - `30` fields now exist
- then `app_layout_apply` failed because:
  - every layout section requires `section_id`
  - current app readback still had `layout.sections = []`
  - field `sectionId = null`
- final conclusion:
  - schema creation succeeded
  - package attach failed
  - layout beautification failed

#### Run 3

- Same pattern as run 1
- repeated `app_schema_apply` attach failure
- agent again fell back to browser and detected login page
- no app was created

### New confirmed beta 15 issues

1. `auth_use_token` still looks wrong at the tool contract level.
   - direct MCP call returned `404 Not Found`
   - but existing persisted login + `workspace_select` worked
   - so token-based setup is possible in practice, but not cleanly exposed

2. `app_schema_apply` mixes two concerns:
   - app creation / schema write
   - package attachment
   - when package attach fails, it can block or partially fail otherwise valid schema work

3. Package attachment is the main hard blocker now.
   - this is the most important beta 15 issue

4. `app_layout_apply` is not sufficient for first-time “beautiful layout” generation.
   - it requires `section_id`
   - but there is no obvious companion flow for creating new sections first

5. Field schema contract is stricter, but still under-documented for agents.
   - `serial` is not allowed
   - `name` is required
   - `title` is rejected

### Fair evaluation of beta 15

Compared with beta 12:

- better:
  - clearer low-level builder surface
  - less planner drift
  - can genuinely build a 30-field customer-order app

- worse or still blocked:
  - package attach is not reliable
  - beautified layout still cannot be finished from current MCP surface
  - token auth contract itself still looks incomplete (`auth_use_token` returned 404)

### Bottom line

Beta 15 is the first version that looks architecturally promising **and** can produce a useful app body when auth is out of the way.  
But it is not yet complete enough for the full requirement:

- full-field app body: **yes, partially proven**
- mount into target package: **not reliable**
- pretty multi-section layout: **not yet supported cleanly**
