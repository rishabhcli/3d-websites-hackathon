# Support matrix

Every row is a claim and must acquire regenerable evidence before release. Unknown means unsupported, not assumed working.

## Host prerequisites

- The declared local host families are macOS and Linux; the current CI host is Ubuntu 24.04. Native Windows is not currently supported.
- `lsof` and POSIX `ps` must be executable from `PATH` and support the process-command, process-start-time, process-working-directory, and TCP-listener queries used by the ownership contract.
- `bootstrap` probes the process query shapes against its own process, exercises the exact listener-query shape on a non-reserved port, and fails before dependency installation when either executable is missing, emits diagnostics, exits unexpectedly, or returns unparseable output.
- Debian and Ubuntu hosts provide these executables through the `lsof` and `procps` packages. CI installs both packages explicitly rather than relying on the runner image.

| Surface               | Current declared state                                                | Behaviour outside the declaration                                   | Evidence                                          |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| Local toolchain       | macOS/Linux, Node 24.19.0, pnpm 11.20.0, functional `lsof` and `ps`   | `bootstrap` refuses unsupported hosts, tools, and versions          | bootstrap host-tool tests and output, CI workflow |
| Local services        | Declared host families, literal `127.0.0.1`, ports 4100-4103          | lifecycle fails closed without ownership proof                      | `dev:preflight`, `dev:health`, integration suite  |
| Browser rendering     | Unqualified; WebGL2 capability probe only                             | semantic gallery is shown when the qualified context is unavailable | E2E evidence pending                              |
| Reduced motion        | Direct station cuts in the calibration surface                        | semantic descriptions remain available                              | E2E evidence pending                              |
| Keyboard              | Native observation-station buttons                                    | no drag-only workflow is claimed                                    | E2E evidence pending                              |
| Screen reader         | Three textual station descriptions mirror current calibration meaning | no silhouette-equivalence claim exists yet                          | accessibility audit pending                       |
| Mobile/touch          | Unqualified                                                           | semantic content remains readable; 3D performance is not claimed    | device evidence pending                           |
| WebGPU                | Not implemented or claimed                                            | WebGL2/semantic path only                                           | implementation pending                            |
| Production deployment | Not yet in production                                                 | no deployment claim is shown                                        | GOAL.md §5 audit pending                          |
