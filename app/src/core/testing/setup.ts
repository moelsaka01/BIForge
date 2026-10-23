// Runs before every test file. The jsdom UI tests wait for async UI changes (waitFor / findBy*); the default of one
// second is too tight when many test files run in parallel on a busy machine, which made them fail only in the full run.
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  // The race behind the load-only failures ("Unable to find an accessible element with the role ..."): Fluent's dialogs hand
  // focus to tabster, whose modalizer marks the dialog surface (or the app root, while another dialog is closing) aria-hidden
  // for a few ticks. Under load that window is long enough for a role query to run inside it and skip the whole dialog.
  // jsdom has no real focus timing, so the tests query roles across that transient state instead of racing it.
  configure({ asyncUtilTimeout: 8000, defaultHidden: true });
}

export {};
