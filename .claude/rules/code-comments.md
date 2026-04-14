# Code Comments

A comment is a statement of intent. It declares what code is *supposed* to do — the why behind the what. It is not a description of what the code does; the code already says that.

Write a comment only when it adds information the code cannot convey on its own: non-obvious constraints, domain rules, invariants that must be maintained, or deliberate choices that look like mistakes.

Comments in this codebase serve double duty as prompt context for future AI sessions. Before writing a comment, ask: would this help a future AI understand intent, or is it noise that crowds the context window? A comment that restates the code is worse than no comment — it's a second place where the truth must be maintained, and it dilutes the signal.

Docstrings should explain the function's contract at a high level. Don't restate the signature. Don't enumerate implementation steps. Explain what it does and, if non-obvious, why it exists.

Never write comments that describe changes you made. Comments should be evergreen statements of intent, not a changelog.
