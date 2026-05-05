---
name: research-workflow
description: Read-only research and planning workflow for Nostr git repository work before builder, QA, or triager handoff.
---

Use this skill when a researcher agent is investigating uncertainty, comparing options, reading repo history/events, or producing a plan for later worker handoff.

## Intent

The researcher reduces ambiguity before expensive implementation or validation work begins.

The output is a research brief, not a patch.

Default sequence:

1. Restate the question and the target repository context.
2. Inspect local files, docs, tests, issue threads, and relevant Nostr repo events.
3. Gather external or upstream references only when the task requires them.
4. Separate confirmed facts from inferences.
5. Compare options and risks when more than one path is plausible.
6. Recommend the next worker handoff and verification strategy.

## Boundaries

Hard rules:

- do not edit product code unless the orchestrator explicitly assigned an edit task
- do not commit
- do not publish PR events
- do not mark issues applied or closed
- do not bypass the managed repo context

Allowed when explicitly assigned:

- publish a concise repo comment with findings
- publish non-authoritative labels or status notes through `openteam repo publish ...`
- use browser inspection for research when the question depends on live UI behavior

## Primary tools

- Use local repo inspection first.
- Use `nak git ...` and read-only `nak req` / `nak fetch` commands for Nostr repo events.
- Use `openteam repo policy` to understand the active repo relay policy.
- Use `openteam repo publish ...` only for assigned repo-side writes.
- Use agent-browser when the task needs live app or documentation inspection; use Playwright MCP only as the fallback when agent-browser is unavailable or blocked.

## Brief Format

Return findings in this structure:

```text
Question:
<one sentence>

Answer:
<short answer, including confidence>

Evidence:
- <file/event/command/doc and what it proves>

Options:
- <option, tradeoff, risk>

Recommended Next Action:
<builder/qa/triager/no-action handoff and exact task wording>

Verification Plan:
- <checks the next worker should run>

Open Questions:
- <only unresolved questions that materially affect the decision>
```

If the task is specifically planning, make the `Recommended Next Action` section the implementation plan.

## Decision Rules

- Hand off to `builder` when the next step is code change.
- Hand off to `qa` when the next step is behavior verification or reproduction through a real flow.
- Hand off to `triager` when the next step is issue classification, labeling, or intake hygiene.
- Recommend no action when evidence shows the request is already satisfied or not worth pursuing.

## Anti-patterns

- broad research dumps with no recommendation
- presenting guesses as facts
- changing code "just to check"
- asking builder to investigate the same uncertainty again
- publishing repo-visible state when a local handoff brief is enough
