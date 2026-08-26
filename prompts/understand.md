---
description: Align on a requirement, exploring the repository when context is missing
argument-hint: "[requirement]"
---
Before implementation, help me align on this requirement:

${ARGUMENTS:-Use the most recent requirement I provided in this conversation. If no requirement is identifiable, ask me to provide one.}

Do not begin implementation yet.

1. Restate your understanding of the goal, expected behavior, scope, constraints, and relevant non-goals. Do not invent missing requirements.
2. Decide whether the current conversation contains enough context for a reliable understanding.
3. If important details depend on the codebase, perform focused, read-only repository exploration before asking questions. Inspect only what is relevant, and do not ask me questions that the repository can answer.
4. Present your updated understanding, relevant repository findings (if any), assumptions, and remaining ambiguities or risks.
5. Ask only focused questions that materially affect the requirement, then ask me to confirm or correct your understanding.

If the context is already sufficient, skip repository exploration. Keep the discussion proportional to the requirement and respond in the same language I used. Do not edit files, run mutating commands, create a detailed implementation plan, or start implementation until I explicitly confirm the understanding in a follow-up.
