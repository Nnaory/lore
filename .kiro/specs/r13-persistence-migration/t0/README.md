# T0 measurement script

`measure-project-size.test.ts` generates three real projects through the staged AI routes (analyze → plan → stories with `previousSummaries`), plays story 1 with the `StoryViewer` recipe, and prints sizes for the record, campaign, each story, materials, campaign_state and the PUT state body. It lives here, outside `frontend/tests`, so it never runs in the suite.

Run from `frontend/` (PowerShell), with a Gemini key that has credit:

```powershell
New-Item -ItemType Directory tests\_t0
Copy-Item ..\.kiro\specs\r13-persistence-migration\t0\measure-project-size.test.ts tests\_t0\
$env:AI_PROVIDER = 'google'; $env:GOOGLE_API_KEY = '<key>'; $env:T0_MEASURE = '1'; $env:T0_OUT = "$env:TEMP\t0-results.json"
npx vitest run tests/_t0/measure-project-size.test.ts --testTimeout=1800000
Remove-Item tests\_t0\measure-project-size.test.ts; Remove-Item tests\_t0
```

Then replace the lower-bound table under "Body size limits" in `design.md`, and the `# TODO(T0)` constants in `backend/app/projects.py` if a limit changes.

Last run (20 Nov 2026): Gemini answered HTTP 402 "prepayment credits are depleted", so only the dummy-provider lower bound was recorded.
