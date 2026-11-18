# DSH 0.2.2-rc.5 qualification (pending)
 
Official immutable tag: [dsh-v0.2.2-rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5), published 2026-11-18 12:51:39 UTC, commit `9c2670d3bce5275e0d1610272958121af87787bb`. Base DVR: `e278b7ca1f305d27b11cb987c004d0632bf43633`.
 
## First-principles compatibility
 
The five upstream commits since rc.4 include a liveshare test clock correction, the search provider selection feature (#8707), and release version metadata/merge. The GitHub compare file list is capped at 300; the feature commit identifies changes in the web runtime, tool-web, DeepSeek search provider, settings UI, base bundle, tests and documentation. The selected route, not a model-name heuristic, drives the default: native DeepSeek routes prefer Messages search; other routes prefer Search API. Explicit configuration remains authoritative; readiness is assessed against the effective model route and execution follows Session requestContext.
 
DVR default tool-only mode must leave the user's model route untouched. Optional whole-turn routing selects vision-chain or a visual provider before Host tool admission; reverse routing restores the actual origin. Do not relabel that route as DeepSeek or override Host search settings/credentials. No product change is justified merely because an optional routed turn now gets the other native default, and no credentialed egress claim follows from simulated providers.
 
## Qualification gate
 
Preserve the minimum 0.2.1-rc.5 and recommended 0.2.2-rc.1 lanes, branch-protected contract names, RC4 manual replay and the existing refusal/Session/attachment/Settings/Desktop gates. Pin RC5 to the exact SHA in each checkout and run upstream WebRuntime, tool-web and DeepSeek provider suites. Add real upstream tool registry/executor plus DVR coordinator composition with synthetic Agent/Session and network-free providers; it tests default tool-only, text→vision→text, account route, explicit configuration and denied execution. This fixture models the Agent request publication boundary; it is not a fully live Agent search round or a real credential test.
 
Doctor exactVerified, recommended Host, package version and Node floor remain unchanged until acceptance is recorded. The npm 3.4.0 diagnostic remains advisory and distinct from the packed candidate. No local execution available; all new tests and CI are pending. No merge, publishing or migration is authorized.
