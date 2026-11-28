"""AI-written Remotion animations: contract reader, models, agent and storage.

Why: this package holds everything the backend needs for the animation feature (design section
6). Importing it must stay cheap because `app.main` loads it on every start, even with the
feature off. Only `agent`, `verifier_client` and `store` may import `langgraph` or `boto3`, and
only inside functions, so this file has no imports at all (Requirement 41.1).
"""
