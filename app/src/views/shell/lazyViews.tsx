import { lazy, Suspense, type ComponentProps } from "react";
import type { ReportView as ReportViewType } from "../report/ReportView";
import type { PowerQueryEditor as PowerQueryEditorType } from "../pq/PowerQueryEditor";

// The report canvas (ECharts) and the Power Query editor are the two largest parts of the app and are not needed on
// the start screen, so they load on first use. The unit tests alias this module to lazyViews.eager.ts.
const ReportViewLazy = lazy(() => import("../report/ReportView").then((m) => ({ default: m.ReportView })));
const PowerQueryEditorLazy = lazy(() => import("../pq/PowerQueryEditor").then((m) => ({ default: m.PowerQueryEditor })));

export function ReportView(props: ComponentProps<typeof ReportViewType>) {
  return (
    <Suspense fallback={<div className="empty-note">Loading the report…</div>}>
      <ReportViewLazy {...props} />
    </Suspense>
  );
}

export function PowerQueryEditor(props: ComponentProps<typeof PowerQueryEditorType>) {
  return (
    <Suspense fallback={null}>
      <PowerQueryEditorLazy {...props} />
    </Suspense>
  );
}
