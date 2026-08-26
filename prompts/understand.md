---
description: Clarify and align on a requirement before implementation
argument-hint: "[requirement]"
---
Before implementation, help me clarify and align on this requirement:

${ARGUMENTS:-Use the most recent requirement I provided in this conversation. If no requirement is identifiable, ask me to provide one.}

Do not begin implementation yet.

1. Restate your understanding of the goal, expected behavior, scope, constraints, and relevant non-goals. Do not invent missing requirements.
2. Identify assumptions, ambiguities, conflicting interpretations, and missing context that could materially affect the requirement.
3. Ask only focused questions needed to resolve those gaps.
4. Ask me to confirm or correct your understanding before proceeding.

Keep the discussion proportional to the requirement and respond in the same language I used. Do not edit files or start implementation until I explicitly confirm the understanding in a follow-up.
