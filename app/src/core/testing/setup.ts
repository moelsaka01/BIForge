// Runs before every test file. The jsdom UI tests wait for async UI changes (waitFor / findBy*); the default of one
// second is too tight when many test files run in parallel on a busy machine, which made them fail only in the full run.
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: 8000 });
}

export {};
