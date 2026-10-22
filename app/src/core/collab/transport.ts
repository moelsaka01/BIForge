import type { CollabTransport, SyncReply, SyncRequest } from "./coEdit";
import type { CollabApi, CollabContext } from "./types";

/** The sync operation of a co-editing session over whatever carries it (server, host or guest of a direct session). */
export function collabTransport(api: CollabApi, ctx: CollabContext): CollabTransport {
  return {
    async sync(req: SyncRequest): Promise<SyncReply> {
      const blob = new Uint8Array(req.stateVector.length + req.update.length);
      blob.set(req.stateVector, 0);
      blob.set(req.update, req.stateVector.length);
      const a = await api.call(ctx, "collab.sync", { svLen: req.stateVector.length, seed: req.seed, summary: req.summary }, blob);
      const meta = a.meta as { seeded: boolean; empty: boolean; svLen: number };
      return { stateVector: a.blob.slice(0, meta.svLen), update: a.blob.slice(meta.svLen), seeded: meta.seeded, empty: meta.empty };
    },
  };
}
