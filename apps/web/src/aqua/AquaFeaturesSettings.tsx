import type { AquaCustomStatus } from "@t3tools/contracts";
import {
  CheckIcon,
  FileTextIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { AQUA_FEATURES, isAquaFeatureEnabled } from "./features";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: AquaCustomStatus }
  | { readonly kind: "failed"; readonly message: string };

const shortSha = (sha: string) => sha.slice(0, 7);
const versionOfTag = (tag: string) => tag.replace(/^v/, "");

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CheckBadge({
  ok,
  okLabel = "OK",
  badLabel,
}: {
  ok: boolean;
  okLabel?: string;
  badLabel: string;
}) {
  return ok ? (
    <Badge variant="success">
      <CheckIcon className="size-3" />
      {okLabel}
    </Badge>
  ) : (
    <Badge variant="warning">
      <TriangleAlertIcon className="size-3" />
      {badLabel}
    </Badge>
  );
}

export function AquaFeaturesSettingsPanel() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.aqua;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [checking, setChecking] = useState(bridge !== undefined);
  const customFeatures = useClientSettings((settings) => settings.customFeatures);
  const updateClientSettings = useUpdateClientSettings();

  const refresh = useCallback(
    (fetch: boolean) => {
      if (!bridge) return Promise.resolve();
      return bridge.getStatus({ fetch }).then(
        (status) => setLoad({ kind: "ready", status }),
        (error: unknown) =>
          setLoad({
            kind: "failed",
            message: error instanceof Error ? error.message : "Couldn't read the clone's status.",
          }),
      );
    },
    [bridge],
  );

  useEffect(() => {
    void refresh(false).finally(() => setChecking(false));
  }, [refresh]);

  const status = load.kind === "ready" ? load.status : null;
  const build = status?.build ?? null;
  const clone = status?.clone ?? null;
  const builtSubjects = new Set(build?.commits.map((commit) => commit.subject) ?? []);
  const pendingCommits =
    clone?.customCommits.filter((commit) => !builtSubjects.has(commit.subject)) ?? [];
  const bundledIds = new Set(AQUA_FEATURES.map((feature) => feature.id));
  const unbuiltFeatures = clone?.features.filter((feature) => !bundledIds.has(feature.id)) ?? [];

  const unavailableMessage: ReactNode = !bridge
    ? "Open T3 Code's desktop app to check your custom build."
    : load.kind === "failed"
      ? load.message
      : status !== null && build === null
        ? "This copy of T3 Code wasn't built from your clone, so there's nothing to compare. Run aqua/t3code-custom.ps1 -Install in X:/t3code to build it."
        : undefined;

  return (
    <SettingsPageContainer>
      <SettingsSection title="This build">
        <SettingsUnavailableGroup message={unavailableMessage}>
          <SettingsRow
            title="Built from your clone"
            description={
              build
                ? `Nightly ${versionOfTag(build.baseTag)} with ${build.commits.length} of your changes. Built ${formatDate(build.builtAt)} from ${shortSha(build.commit)} on ${build.branch}.`
                : load.kind === "loading"
                  ? "Checking..."
                  : "No custom build info in this app."
            }
            status={build ? <CheckBadge ok badLabel="" /> : undefined}
          />
        </SettingsUnavailableGroup>
      </SettingsSection>

      {build ? (
        <SettingsSection
          title="Install check"
          headerAction={
            <Button
              size="xs"
              variant="ghost"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                void refresh(true).finally(() => setChecking(false));
              }}
            >
              <RefreshCwIcon className={checking ? "animate-spin" : undefined} />
              {checking ? "Checking GitHub..." : "Check again"}
            </Button>
          }
        >
          {clone === null ? (
            <SettingsRow
              title="Clone"
              description={checking ? "Checking..." : "Couldn't read the clone's status."}
            />
          ) : (
            <>
              <SettingsRow
                title="Clone found"
                description={clone.error ?? clone.repo}
                status={
                  <CheckBadge ok={clone.repoFound && clone.error === null} badLabel="Missing" />
                }
                control={
                  <Button size="sm" variant="outline" onClick={() => void bridge?.openClone()}>
                    <FolderOpenIcon />
                    Open folder
                  </Button>
                }
              />
              <SettingsRow
                title="Ready to build"
                description={
                  clone.branch !== build.branch
                    ? `The clone has ${clone.branch ?? "no branch"} checked out. Switch to ${build.branch} so updates can build it.`
                    : clone.dirty
                      ? "The clone has uncommitted changes. Commit or stash them so updates can build it."
                      : `On ${build.branch} with no uncommitted changes.`
                }
                status={
                  <CheckBadge
                    ok={clone.branch === build.branch && !clone.dirty}
                    badLabel="Needs attention"
                  />
                }
              />
              <SettingsRow
                title="Newest nightly"
                description={
                  clone.newestNightlyTag === null
                    ? "Couldn't find an upstream nightly tag."
                    : clone.newestNightlyTag === build.baseTag
                      ? `Running the newest nightly, ${versionOfTag(build.baseTag)}.`
                      : `Running ${versionOfTag(build.baseTag)}. ${versionOfTag(clone.newestNightlyTag)} is out; use the update button to build it.`
                }
                status={
                  <CheckBadge
                    ok={clone.newestNightlyTag === build.baseTag}
                    badLabel="Update available"
                  />
                }
              />
              <SettingsRow
                title="All your changes installed"
                description={
                  pendingCommits.length === 0
                    ? `All ${clone.customCommits.length} of your changes are in this build.`
                    : `${pendingCommits.length} of your changes aren't in this build yet. Use the update button to build them.`
                }
                status={
                  <CheckBadge
                    ok={pendingCommits.length === 0}
                    badLabel={`${pendingCommits.length} missing`}
                  />
                }
              />
              <SettingsRow
                title="Pushed to GitHub"
                description={
                  clone.pushed
                    ? `Your fork on GitHub matches the clone's ${build.branch} branch.`
                    : `The clone's ${build.branch} branch and your fork on GitHub differ. The next update pushes it.`
                }
                status={<CheckBadge ok={clone.pushed} badLabel="Not pushed" />}
              />
              <SettingsRow
                title="Daily sync"
                description={
                  clone.scheduledTask
                    ? "Syncs and builds at 05:00. It installs only when T3 Code is closed."
                    : 'The "T3 Code custom sync" scheduled task is missing, so nothing syncs while you\'re away.'
                }
                status={<CheckBadge ok={clone.scheduledTask} badLabel="Missing" />}
                control={
                  <Button size="sm" variant="outline" onClick={() => void bridge?.openLog()}>
                    <FileTextIcon />
                    Last build log
                  </Button>
                }
              />
            </>
          )}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Features">
        {AQUA_FEATURES.map((feature) => (
          <SettingsRow
            key={feature.id}
            title={feature.name}
            description={feature.description}
            control={
              feature.locked ? (
                <Badge variant="secondary">Always on</Badge>
              ) : (
                <Switch
                  checked={isAquaFeatureEnabled(customFeatures, feature.id)}
                  aria-label={`Turn ${feature.name} on or off`}
                  onCheckedChange={(checked) =>
                    updateClientSettings({
                      customFeatures: { ...customFeatures, [feature.id]: Boolean(checked) },
                    })
                  }
                />
              )
            }
          />
        ))}
        {unbuiltFeatures.map((feature) => (
          <SettingsRow
            key={feature.id}
            title={feature.name}
            description={feature.description}
            control={<Badge variant="warning">Not in this build yet</Badge>}
          />
        ))}
      </SettingsSection>

      {build ? (
        <SettingsSection title="Your changes">
          {pendingCommits.map((commit) => (
            <SettingsRow
              key={commit.sha}
              title={commit.subject}
              description={shortSha(commit.sha)}
              control={<Badge variant="warning">Not built yet</Badge>}
            />
          ))}
          {build.commits.map((commit) => (
            <SettingsRow
              key={commit.sha}
              title={commit.subject}
              description={shortSha(commit.sha)}
            />
          ))}
          {build.commits.length === 0 && pendingCommits.length === 0 ? (
            <SettingsRow
              title="No changes yet"
              description="Commit to the aqua branch in X:/t3code."
            />
          ) : null}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
