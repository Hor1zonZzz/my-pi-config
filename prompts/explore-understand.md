---
description: Explore the repository, then clarify and align on a requirement
argument-hint: "[requirement]"
---
Before implementation, explore the repository and help me clarify and align on this requirement:

${ARGUMENTS:-Use the most recent requirement I provided in this conversation. If no requirement is identifiable, ask me to provide one before exploring.}

Do not begin implementation yet.

1. Perform focused, read-only repository exploration to find the code, configuration, documentation, conventions, and existing behavior relevant to the requirement. Inspect only what is useful, and do not ask me questions that the repository can answer.
2. Restate your updated understanding of the goal, expected behavior, scope, constraints, and relevant non-goals. Do not invent missing requirements.
3. Present the relevant repository findings, assumptions, ambiguities, conflicting interpretations, and risks.
4. Ask only focused questions that materially affect the requirement.
5. Ask me to confirm or correct your understanding before proceeding.

Keep the exploration and discussion proportional to the requirement and respond in the same language I used. Use only read-only tools and commands: do not edit files, run mutating commands, or start implementation until I explicitly confirm the understanding in a follow-up.
