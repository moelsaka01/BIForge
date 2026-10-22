// Scheduled refresh: where it runs is always named, and each place shows its own history.
import { useState } from "react";
import { Button, Checkbox, Input, Radio, RadioGroup } from "@fluentui/react-components";
import type { RefreshPlan, RefreshSchedule, RunRecord, RunsOn, Target } from "../../core/publish/types";
import { useEnv } from "./ShellContext";
import { usePublishUiState } from "./publishHooks";

export const WHERE_LABEL: Record<RunsOn, string> = {
  githubActions: "GitHub Actions (on GitHub's computers)",
  thisPc: "This PC (Windows Task Scheduler)",
  server: "BIForge server (the server computer)",
};

const STATUS_WORDS: Record<RunRecord["status"], string> = { refreshed: "New data", unchanged: "No change", failed: "Failed", skipped: "Did not start" };

export function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function minuteOf(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return 180;
  return Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2])));
}

export function RefreshHistory({ history }: { history: RunRecord[] }) {
  if (history.length === 0) return <div style={{ fontSize: 12 }}>No refresh has run yet.</div>;
  return (
    <ul aria-label="Refresh history" style={{ margin: "4px 0 0 0", padding: 0, listStyle: "none", fontSize: 12 }}>
      {history.slice(0, 12).map((r, i) => (
        <li key={i} style={{ padding: "2px 0", borderBottom: "1px solid var(--colorNeutralStroke2)" }}>
          <strong>{STATUS_WORDS[r.status]}</strong>
          {` · ${new Date(r.startedAt * 1000).toLocaleString()} · ${r.trigger === "scheduled" ? "scheduled" : "started by hand"}${r.attempt > 1 ? `, attempt ${r.attempt}` : ""} · ran on: ${WHERE_LABEL[r.runsOn]}`}
          <div>{r.message}</div>
        </li>
      ))}
    </ul>
  );
}

export function ScheduleFields({ plan, onChange, zone }: { plan: RefreshPlan; onChange(p: RefreshPlan): void; zone: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <RadioGroup layout="horizontal" value={plan.frequency} onChange={(_, d) => onChange({ ...plan, frequency: d.value as RefreshSchedule })} aria-label="Refresh schedule">
        <Radio value="hourly" label="Every hour" />
        <Radio value="daily" label="Every day" />
        <Radio value="weekly" label="Every week (Monday)" />
        <Radio value="manual" label="Only when I start it" />
      </RadioGroup>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {(plan.frequency === "daily" || plan.frequency === "weekly") && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {`Time of day (${zone})`}
            <Input aria-label="Time of day" style={{ width: 90 }} value={hhmm(plan.atMinute)} onChange={(_, d) => onChange({ ...plan, atMinute: minuteOf(d.value) })} />
          </label>
        )}
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Tries again after a failure
          <Input aria-label="Retries" type="number" style={{ width: 70 }} value={String(plan.retries)} min={0} max={5} onChange={(_, d) => onChange({ ...plan, retries: Math.max(0, Math.min(5, Number(d.value) || 0)) })} />
          times
        </label>
      </div>
    </div>
  );
}

const DEFAULT_PLAN: RefreshPlan = { frequency: "daily", atMinute: 180, retries: 2, retryDelaySecs: 300 };

export function ThisPcRefresh({ target, publisherName }: { target: Target; publisherName: string }) {
  const env = useEnv();
  const { state } = usePublishUiState();
  const info = state.localRefresh;
  const [plan, setPlan] = useState<RefreshPlan>(info?.plan ?? DEFAULT_PLAN);
  return (
    <section aria-label="Refresh on this PC" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <strong>Where it runs: {WHERE_LABEL.thisPc}.</strong> {info?.needs ?? "This PC must be on and you must be signed in at the scheduled time. The sources are read where they are."}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        Windows Task Scheduler starts BIForge without a window at the time you choose. It reloads every source (files, databases with the credentials stored in Windows Credential Manager, queries), and when the data changed it publishes the next version to {`"${target.label}"`}. It publishes the report as it is when you turn this on; turn it on again to use a changed report. Nothing leaves this PC except what the destination receives.
      </div>
      {info?.enabled ? (
        <>
          <div role="status">
            {`Scheduled refresh on this PC is on (${info.plan?.frequency}${info.plan && (info.plan.frequency === "daily" || info.plan.frequency === "weekly") ? ` at ${hhmm(info.plan.atMinute)} local time` : ""}, ${info.plan?.retries} retries). `}
            {info.task ? (info.task.exists ? `Task Scheduler: ${info.task.status || "registered"}${info.task.nextRun ? `, next run ${info.task.nextRun}` : ""}.` : info.plan?.frequency === "manual" ? "No task is registered: it runs only when you start it." : "The task is missing from Task Scheduler; turn the schedule on again.") : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button disabled={state.busy || info.running} onClick={() => void env.run("publish.localRefresh.run")}>
              Refresh now on this PC
            </Button>
            <Button onClick={() => void env.run("publish.localRefresh.disable")}>Turn off on this PC</Button>
          </div>
        </>
      ) : (
        <>
          <ScheduleFields plan={plan} onChange={setPlan} zone="your local time" />
          <div>
            <Button appearance="primary" disabled={state.busy || publisherName.trim() === ""} onClick={() => void env.run("publish.localRefresh.enable", { publisherName, plan })}>
              Turn on scheduled refresh on this PC
            </Button>
          </div>
          {target.status !== "published" && <div role="note">Publish the report to this destination once first; the schedule publishes the next versions.</div>}
        </>
      )}
      {info && info.history.length > 0 && <RefreshHistory history={info.history} />}
    </section>
  );
}

export function ServerRefresh({ target, publisherName }: { target: Target; publisherName: string }) {
  const env = useEnv();
  const { ui, state } = usePublishUiState();
  const info = state.serverRefresh;
  const { files, blocked } = ui.refreshCandidates();
  const [plan, setPlan] = useState<RefreshPlan>(info?.plan ?? DEFAULT_PLAN);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [sure, setSure] = useState(false);
  const tables = picked ?? files.map((f) => f.table);
  const chosen = files.filter((f) => tables.includes(f.table));
  return (
    <section aria-label="Refresh on the server" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <strong>Where it runs: {WHERE_LABEL.server}.</strong> {info?.needs ?? "The server must stay on. It reads the files in the report's source folder on the server and the files copied with the bundle."}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        The server reloads the source files and keeps the new data next to your published report; the published package itself is not changed and a new version you publish replaces the refreshed data. A file with the same name in the report&apos;s source folder on the server (or one you put there with the button below) replaces the copy that was sent. Files on this PC are not reachable from the server.
      </div>
      {info?.hasBundle ? (
        <>
          <div role="status">
            {`Scheduled refresh on the server is ${info.enabled ? "on" : "off"} (${info.plan.frequency}${info.plan.frequency === "daily" || info.plan.frequency === "weekly" ? ` at ${hhmm(info.plan.atMinute)} UTC` : ""}, ${info.plan.retries} retries).${info.refreshedAt ? ` The server last refreshed the data at ${info.refreshedAt}.` : ""}`}
          </div>
          <div style={{ fontSize: 12 }}>{`Source folder on the server: ${info.sourceFolder}${info.sources.length ? ` (${info.sources.join(", ")})` : " (empty)"}`}</div>
          <ScheduleFields
            plan={info.plan}
            zone="UTC"
            onChange={(p) => {
              void env.run("host.refresh.schedule", { connection: target.settings.connection, workspace: target.settings.workspace, report: target.settings.report, enabled: info.enabled, plan: p });
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button disabled={state.busy || info.running} onClick={() => void env.run("publish.serverRefresh.run")}>
              Refresh now on the server
            </Button>
            <Button onClick={() => void env.run("publish.serverRefresh.source")}>Put a source file on the server…</Button>
            <Button onClick={() => void env.run("publish.refresh.disable")}>Turn off on the server</Button>
          </div>
          <RefreshHistory history={info.history} />
        </>
      ) : (
        <>
          {blocked.map((b) => (
            <div key={b.table} role="note">{`${b.table}: cannot be refreshed there. ${b.reason}`}</div>
          ))}
          {files.length === 0 ? (
            <div role="note">None of the published tables has a source file the server could reload.</div>
          ) : (
            <>
              <div>Source files to send to the server (whole files, including columns that are not published):</div>
              {files.map((f) => (
                <Checkbox
                  key={f.table}
                  label={`${f.table}: ${f.path}`}
                  checked={tables.includes(f.table)}
                  onChange={(_, d) => {
                    setPicked(d.checked === true ? [...tables, f.table] : tables.filter((t) => t !== f.table));
                    setSure(false);
                  }}
                />
              ))}
              <ScheduleFields plan={plan} onChange={setPlan} zone="UTC" />
              <Checkbox label="I understand these whole files are stored on the server, readable by its administrator, including columns that are not published." checked={sure} onChange={(_, d) => setSure(d.checked === true)} />
              <div>
                <Button
                  appearance="primary"
                  disabled={!sure || chosen.length === 0 || state.busy || publisherName.trim() === ""}
                  onClick={() => void env.run("publish.refresh.enable", { publisherName, schedule: plan.frequency, tables, confirmed: chosen.map((f) => f.path), atMinute: plan.atMinute, retries: plan.retries })}
                >
                  Turn on scheduled refresh on the server
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
