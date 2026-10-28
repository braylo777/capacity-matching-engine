# Deploys

| When (CT) | Worker version | Deployment | Rollback point |
| --- | --- | --- | --- |
| 2026-10-28 09:48 | 9583e97f-e418-4c66-a528-dce9da7c9cc7 | f28622d4-7d61-408d-a7d3-fedddcb1a0c9 | First deploy. To take it offline without deleting, disable the workers.dev route; later deploys roll back to this version id. |

Post-deploy check (09:48 CT): `/` and `/app.js` 200; headless Chrome render shows trial balance $0.00 ✓.
