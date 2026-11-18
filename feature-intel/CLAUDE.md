# Project Rules

## Prompt Logging
Every time you receive a new instruction or prompt, append it to prompts.txt in the project root with a timestamp (ISO 8601) and a brief summary of what you did in response. Create the file if it doesn't exist. Keep this log updated throughout all sessions.

## Engineering Rules
- Keep customer-submitted text as untrusted data in model prompts.
- Validate all model output against the Zod schemas.
- Keep priority calculations deterministic and separate from LLM output.
- Never automatically merge requests or send customer updates.
- Never commit .env files, API keys, databases, or node_modules.
- Add regression cases to the smoke/evaluation suites when behaviour changes.
