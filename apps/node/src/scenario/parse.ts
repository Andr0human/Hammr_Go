// The scenario zod schema and parser live in @hammr/shared so the browser
// dashboard can validate scenarios client-side using the exact same rules
// the controller enforces. This file is a re-export for back-compat with
// existing imports inside the controller, generator CLI, and unit tests.
export { parseScenario, scenarioSchema, type ParsedScenario } from '@hammr/shared';
