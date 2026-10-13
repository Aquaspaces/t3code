/**
 * Update button for Aqua's custom build. Instead of a release feed, it asks the
 * local clone whether a newer nightly or newer custom commits exist, builds the
 * app from the clone ("download"), and runs the built installer ("install").
 *
 * Apps not built by aqua/t3code-custom.ps1 get the stock DesktopUpdates.
 */
import type {
  AquaBuildInfo,
  AquaCloneStatus,
  DesktopUpdateReleaseNote,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "../updates/updateMachine.ts";
import * as AquaCustomBuild from "./AquaCustomBuild.ts";

const STARTUP_CHECK_DELAY = "30 seconds";
const POLL_INTERVAL = "30 minutes";
/** Progress stays below this until the script reports the build is done. */
const ESTIMATED_PROGRESS_CEILING = 95;
const PROGRESS_TICK = "5 seconds";

interface BuildProgress {
  readonly percent: number;
  readonly estimateSeconds: number;
  readonly stage: string | null;
  readonly startedAt: number;
}

const decodeBuildResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

type Action = "check" | "download" | "install";

const { logInfo, logError } = DesktopObservability.makeComponentLogger("aqua-custom-updates");

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const versionOfTag = (tag: string) => tag.replace(/^v/, "");

/** Custom commits in the clone that the running app doesn't have yet. Compared
    by subject because rebasing onto a new nightly changes every SHA. */
function unbuiltCommits(build: AquaBuildInfo, clone: AquaCloneStatus) {
  const built = new Set(build.commits.map((commit) => commit.subject));
  return clone.customCommits.filter((commit) => !built.has(commit.subject));
}

function describeCloneProblem(clone: AquaCloneStatus): string | null {
  if (clone.error) return clone.error;
  if (!clone.repoFound) return `Couldn't find the clone at ${clone.repo}.`;
  if (clone.newestNightlyTag === null) return "Couldn't find an upstream nightly tag.";
  return null;
}

function releaseNotesFor(
  build: AquaBuildInfo,
  clone: AquaCloneStatus,
): ReadonlyArray<DesktopUpdateReleaseNote> {
  const notes: DesktopUpdateReleaseNote[] = [];
  const pending = unbuiltCommits(build, clone);
  if (pending.length > 0) {
    notes.push({
      version: "Your changes",
      items: pending.map((commit) => commit.subject),
      totalItems: pending.length,
    });
  }
  if (clone.newestNightlyTag !== null && clone.newestNightlyTag !== build.baseTag) {
    notes.push({
      version: versionOfTag(clone.newestNightlyTag),
      items: [
        `New upstream nightly (you're on ${versionOfTag(build.baseTag)}). Your changes are applied on top.`,
      ],
      totalItems: 1,
    });
  }
  return notes;
}

function makeCustomUpdates(build: AquaBuildInfo) {
  return Effect.gen(function* () {
    const aqua = yield* AquaCustomBuild.AquaCustomBuild;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const desktopState = yield* DesktopState.DesktopState;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;

    const stateRef = yield* Ref.make<DesktopUpdateState>({
      ...createInitialDesktopUpdateState(
        environment.appVersion,
        environment.runtimeInfo,
        "nightly",
      ),
      enabled: true,
      status: "idle",
    });
    const actionRef = yield* Ref.make<Option.Option<Action>>(Option.none());
    const stateChanges = yield* PubSub.unbounded<DesktopUpdateState>();
    const stateMutex = yield* Semaphore.make(1);
    const runtimeContext = yield* Effect.context<never>();

    const setState = (next: DesktopUpdateState) =>
      stateMutex
        .withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(stateRef, next);
            yield* PubSub.publish(stateChanges, next);
          }),
        )
        .pipe(Effect.andThen(electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, next)));
    const updateState = (f: (state: DesktopUpdateState) => DesktopUpdateState) =>
      Ref.get(stateRef).pipe(Effect.flatMap((state) => setState(f(state))));

    const tryStart = (action: Action) =>
      Ref.modify(actionRef, (current) =>
        Option.isSome(current) ? [false, current] : [true, Option.some(action)],
      );
    const finish = Ref.set(actionRef, Option.none());

    const check = Effect.fn("desktop.aqua.updates.check")(function* (reason: string) {
      if (!(yield* tryStart("check"))) return false;
      return yield* Effect.gen(function* () {
        const startedAt = yield* currentIsoTimestamp;
        yield* updateState((state) =>
          state.status === "downloaded"
            ? state
            : reduceDesktopUpdateStateOnCheckStart(state, startedAt),
        );
        const status = yield* aqua.getStatus({ fetch: true });
        const checkedAt = yield* currentIsoTimestamp;
        const state = yield* Ref.get(stateRef);
        const clone = status.clone;
        const problem =
          clone === null ? "Couldn't read the clone's status." : describeCloneProblem(clone);
        if (clone === null || problem !== null) {
          yield* setState(reduceDesktopUpdateStateOnCheckFailure(state, problem ?? "", checkedAt));
          return true;
        }
        const newTag = clone.newestNightlyTag ?? build.baseTag;
        const hasUpdate = newTag !== build.baseTag || unbuiltCommits(build, clone).length > 0;
        if (!hasUpdate) {
          yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
        } else {
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(
              state,
              versionOfTag(newTag),
              checkedAt,
              releaseNotesFor(build, clone),
            ),
          );
        }
        yield* logInfo("checked clone", { reason, hasUpdate, newTag });
        return true;
      }).pipe(Effect.ensuring(finish));
    });

    const download = Effect.gen(function* () {
      if (!(yield* tryStart("download"))) {
        return { accepted: false, completed: false, state: yield* Ref.get(stateRef) };
      }
      return yield* Effect.gen(function* () {
        yield* updateState(reduceDesktopUpdateStateOnDownloadStart);
        const state0 = yield* Ref.get(stateRef);
        const runFork = Effect.runForkWith(runtimeContext);
        // The script reports coarse stages; between them, creep toward the next
        // one using its estimate of how long the build takes.
        const progressRef = yield* Ref.make<BuildProgress | null>(null);
        const applyProgress = Effect.gen(function* () {
          const progress = yield* Ref.get(progressRef);
          if (progress === null) return;
          const now = yield* Clock.currentTimeMillis;
          const fraction =
            progress.estimateSeconds > 0 && progress.percent < ESTIMATED_PROGRESS_CEILING
              ? Math.min((now - progress.startedAt) / 1000 / progress.estimateSeconds, 1)
              : 0;
          const percent = Math.floor(
            progress.percent + (ESTIMATED_PROGRESS_CEILING - progress.percent) * fraction,
          );
          const state = yield* Ref.get(stateRef);
          if (
            state.status === "downloading" &&
            (state.downloadPercent !== percent || state.message !== progress.stage)
          ) {
            yield* setState({ ...state, downloadPercent: percent, message: progress.stage });
          }
        });
        const onMarker = (marker: AquaCustomBuild.AquaScriptMarker) => {
          if (marker.kind !== "progress") return;
          const match = marker.text.match(/^(\d+)\s+(\d+)\s*(.*)$/);
          if (!match) return;
          const percent = Number(match[1]);
          const estimateSeconds = Number(match[2]);
          const stage = match[3] || null;
          runFork(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((startedAt) =>
                Ref.set(progressRef, { percent, estimateSeconds, stage, startedAt }),
              ),
              Effect.andThen(applyProgress),
            ),
          );
        };
        const ticker = yield* applyProgress.pipe(
          Effect.delay(PROGRESS_TICK),
          Effect.forever,
          Effect.forkChild,
        );
        const result = yield* aqua
          .runScript(["-Build", "-Machine"], onMarker)
          .pipe(Effect.ensuring(Fiber.interrupt(ticker)));

        const resultMarker = result.markers.find((marker) => marker.kind === "result");
        const errorMarker = result.markers.find((marker) => marker.kind === "error");
        if (result.exitCode !== 0 || !resultMarker) {
          const message =
            errorMarker?.text ||
            result.tail.at(-1) ||
            `The build script exited with code ${String(result.exitCode)}.`;
          yield* updateState((state) => reduceDesktopUpdateStateOnDownloadFailure(state, message));
          yield* logError("custom build failed", {
            exitCode: result.exitCode,
            output: result.tail.join("\n").slice(0, 2048),
          });
          return { accepted: true, completed: false, state: yield* Ref.get(stateRef) };
        }
        const version = decodeBuildResult(resultMarker.text).pipe(
          Option.map((parsed) => parsed.version),
          Option.getOrElse(() => state0.availableVersion ?? versionOfTag(build.baseTag)),
        );
        yield* updateState((state) => reduceDesktopUpdateStateOnDownloadComplete(state, version));
        yield* logInfo("custom build ready", { version });
        return { accepted: true, completed: true, state: yield* Ref.get(stateRef) };
      }).pipe(Effect.ensuring(finish));
    }).pipe(Effect.withSpan("desktop.aqua.updates.download"));

    const install = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if ((yield* Ref.get(desktopState.quitting)) || state.downloadedVersion === null) {
        return { accepted: false, completed: false, failed: false, state };
      }
      if (!(yield* tryStart("install"))) {
        return { accepted: false, completed: false, failed: false, state };
      }
      const started = yield* aqua.spawnDetached(["-InstallBuilt", "-WaitPid", String(process.pid)]);
      if (!started) {
        yield* finish;
        yield* updateState((current) =>
          reduceDesktopUpdateStateOnInstallFailure(current, "Couldn't start the installer."),
        );
        return { accepted: true, completed: false, failed: true, state: yield* Ref.get(stateRef) };
      }
      yield* Ref.set(desktopState.quitting, true);
      const instances = yield* pool.list;
      yield* Effect.forEach(
        instances,
        (instance) => instance.stop({ timeout: Duration.seconds(5) }),
        { concurrency: "unbounded" },
      );
      yield* electronApp.quit;
      return { accepted: true, completed: false, failed: false, state: yield* Ref.get(stateRef) };
    }).pipe(Effect.withSpan("desktop.aqua.updates.install"));

    const logPollerFailure = (poller: string) => (cause: unknown) =>
      logError("custom update poller failed", {
        poller,
        cause: DesktopUpdates.describeUpdateErrorCause(cause),
      });

    return DesktopUpdates.DesktopUpdates.of({
      getState: Ref.get(stateRef),
      isActionActive: Ref.get(actionRef).pipe(Effect.map(Option.isSome)),
      isInstallActive: Ref.get(actionRef).pipe(
        Effect.map((action) => Option.isSome(action) && action.value === "install"),
      ),
      subscribe: stateMutex.withPermits(1)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(stateChanges);
          const latest = yield* Ref.get(stateRef);
          return { latest, changes: Stream.fromSubscription(subscription) };
        }),
      ),
      emitState: Ref.get(stateRef).pipe(
        Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
      ),
      disabledReason: Effect.succeedNone,
      configure: Effect.gen(function* () {
        yield* Effect.sleep(STARTUP_CHECK_DELAY).pipe(
          Effect.andThen(check("startup")),
          Effect.catchCause(logPollerFailure("startup")),
          Effect.forkScoped,
        );
        yield* Effect.sleep(POLL_INTERVAL).pipe(
          Effect.andThen(check("poll")),
          Effect.forever,
          Effect.catchCause(logPollerFailure("poll")),
          Effect.forkScoped,
        );
      }),
      // The custom build always follows nightly.
      setChannel: () => Ref.get(stateRef),
      check: (reason) =>
        check(reason).pipe(
          Effect.flatMap((checked) =>
            Ref.get(stateRef).pipe(Effect.map((state) => ({ checked, state }))),
          ),
        ),
      download,
      install: install.pipe(
        Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
      ),
      installPrepared: (expectedVersion) =>
        Ref.get(stateRef).pipe(
          Effect.flatMap((state) =>
            state.downloadedVersion === expectedVersion
              ? install
              : Effect.succeed({ accepted: false, completed: false, failed: false, state }),
          ),
        ),
    });
  });
}

/** Provides DesktopUpdates: the clone-based updater for custom builds, the
    stock one otherwise. */
export const layer = Layer.effect(
  DesktopUpdates.DesktopUpdates,
  Effect.gen(function* () {
    const aqua = yield* AquaCustomBuild.AquaCustomBuild;
    if (Option.isNone(aqua.buildInfo) || Option.isNone(aqua.scriptPath)) {
      return yield* DesktopUpdates.make;
    }
    return yield* makeCustomUpdates(aqua.buildInfo.value);
  }),
);
