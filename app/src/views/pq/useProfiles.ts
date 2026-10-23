import { useEffect, useState } from "react";
import type { ColumnProfile, MApi } from "../../core/queries/types";

export interface ProfilesState {
  profiles: Record<string, ColumnProfile>;
  error: string | null;
  loading: boolean;
}

const none: ProfilesState = { profiles: {}, error: null, loading: false };

/** Column profiles of the selected step, loaded only while one of the profile views is on. */
export function useProfiles(m: MApi, query: string | null, step: string | null, texts: Record<string, string>, enabled: boolean, all: boolean, version: number, reloadKey: number, ready: boolean): ProfilesState {
  const [state, setState] = useState<ProfilesState>(none);
  useEffect(() => {
    if (!enabled || !query || !ready) {
      setState(none);
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    m.profile(texts, query, step, all ? null : 1000).then(
      (list) => live && setState({ profiles: Object.fromEntries(list.map((p) => [p.name, p])), error: null, loading: false }),
      (e) => live && setState({ profiles: {}, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
    // texts changes whenever the draft version changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, enabled, query, step, all, version, reloadKey, ready]);
  return state;
}
