# Code Quality

Don't add features, refactors, helpers, or abstractions beyond what the task requires. Three similar lines of code is better than a premature abstraction.

Don't add error handling or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).

Don't design for hypothetical future requirements. The right amount of complexity is exactly what the task actually requires.
