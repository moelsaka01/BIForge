import type { DaxApi, QueryOutcome } from "../dax/types";
import type { Session } from "../session/session";

/**
 * The DAX API the views use. While a server report is open for viewing, queries go to that server (it applies the
 * member's data roles); otherwise they run in the local engine. Checking and the function catalog stay local.
 */
export function routedDax(session: Session, local: DaxApi): DaxApi {
  return {
    catalog: () => local.catalog(),
    check: (documents, expression) => local.check(documents, expression),
    query(documents, query) {
      const server = session.getSnapshot().viewing?.server;
      if (!server || !session.host) return local.query(documents, query);
      return session.host.op<QueryOutcome>(server.connectionId, "query", { workspace: server.workspaceId, report: server.reportId, query });
    },
  };
}
