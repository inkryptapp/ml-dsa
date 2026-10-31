/** The folder of lint fixtures, relative to the repo root. */
export const lintFixturesFolder = "packages/ml-dsa/test/fixtures/lint";

/**
 * The name of the environment variable that turns on linting of the fixtures.
 * The lint fixtures break the lint rules on purpose, so a normal lint run
 * skips them, and the lint test sets this variable to {@link lintFixturesOn}.
 */
export const lintFixturesEnvVar = "ML_DSA_LINT_FIXTURES";

/** The value of {@link lintFixturesEnvVar} that turns on linting of the fixtures. */
export const lintFixturesOn = "1";
