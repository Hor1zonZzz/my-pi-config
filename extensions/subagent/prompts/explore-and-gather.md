---
description: Explore a repository with parallel scouts and gather context across its major directories
---
Use the `subagent` tool with `action: "block"` and the `tasks` parameter to dispatch multiple `scout` agents in parallel.

Divide the repository into distinct directories or subsystems and give each scout a focused, non-overlapping scope. Ask the scouts to identify the purpose of their assigned area, important entry points and symbols, key dependencies and data flows, relevant configuration or tests, and any risks or unknowns. Require concise findings with concrete file paths and clearly distinguish verified facts from inferences.

After all scouts complete, synthesize their findings into one repository context map that explains how the explored areas fit together, highlights the files most relevant to the user's goal, and identifies any context that still needs investigation. Do not modify files.

Prioritize this focus when provided: $@
