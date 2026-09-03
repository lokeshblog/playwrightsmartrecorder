                    Git Push
                       │
                       ▼
                  CI Pipeline
                       │
                       ▼
                 Playwright Run
                       │
             ┌─────────┴─────────┐
             │                   │
           PASS                FAILURE
             │                   │
             ▼                   ▼
          Deploy          Failure Collector
                                  │
                   ┌──────────────┼──────────────┐
                   │              │              │
                Trace          Git Diff       Source
                   │              │              │
                   └──────────────┼──────────────┘
                                  ▼
                         Failure Classifier
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
             Flaky/Env       Test Stale       Product Bug
                 │                │                │
                 ▼                ▼                ▼
              Report       Repair Agent        Escalate
                                  │
                                  ▼
                            Modify Test
                                  │
                                  ▼
                           Run Test Again
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                       PASS              FAIL
                         │                 │
                         ▼                 ▼
                    Create PR         More analysis