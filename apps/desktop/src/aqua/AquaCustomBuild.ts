// @effect-diagnostics nodeBuiltinImport:off -- The custom build runs a PowerShell script from the local clone.
/**
 * Aqua's custom build: reads what the running app was built from (embedded in
 * its package.json by aqua/t3code-custom.ps1) and runs that script against the
 * local clone for status, builds and installs.
 */
import * as NodeChildProcess from "node:child_process";

import { AquaBuildInfo, AquaCloneStatus, type AquaCustomStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const SCRIPT_RELATIVE_PATH = "aqua/t3code-custom.ps1";
const OUTPUT_TAIL_LINES = 20;

const AppPackageMetadata = Schema.Struct({
  t3codeCustomBuild: Schema.optional(AquaBuildInfo),
});
const decodeAppPackageMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(AppPackageMetadata),
);
const decodeCloneStatus = Schema.decodeUnknownOption(Schema.fromJsonString(AquaCloneStatus));

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("aqua-custom-build");

/** A `##kind text` line printed by the script in -Machine or -Status mode. */
export interface AquaScriptMarker {
  readonly kind: string;
  readonly text: string;
}

export interface AquaScriptResult {
  readonly exitCode: number | null;
  readonly markers: ReadonlyArray<AquaScriptMarker>;
  /** Last lines of plain output, for error messages. */
  readonly tail: ReadonlyArray<string>;
}

export class AquaCustomBuild extends Context.Service<
  AquaCustomBuild,
  {
    /** None when the running app wasn't built by the custom build script. */
    readonly buildInfo: Option.Option<AquaBuildInfo>;
    readonly scriptPath: Option.Option<string>;
    readonly logDir: string;
    readonly runScript: (
      args: ReadonlyArray<string>,
      onMarker?: (marker: AquaScriptMarker) => void,
    ) => Effect.Effect<AquaScriptResult>;
    /** Starts the script detached, so it outlives the app (used to install). */
    readonly spawnDetached: (args: ReadonlyArray<string>) => Effect.Effect<boolean>;
    readonly getStatus: (options: { readonly fetch: boolean }) => Effect.Effect<AquaCustomStatus>;
    readonly openClone: Effect.Effect<void>;
    readonly openLog: Effect.Effect<void>;
  }
>()("@t3tools/desktop/aqua/AquaCustomBuild") {}

const powershellArgs = (scriptPath: string, args: ReadonlyArray<string>) => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  scriptPath,
  ...args,
];

function runPowershell(
  scriptPath: string,
  args: ReadonlyArray<string>,
  onMarker?: (marker: AquaScriptMarker) => void,
): Promise<AquaScriptResult> {
  return new Promise((resolve) => {
    const markers: AquaScriptMarker[] = [];
    const tail: string[] = [];
    let buffer = "";
    const handleLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, "");
      const match = line.match(/^##(\w+)\s?(.*)$/);
      if (match?.[1]) {
        const marker = { kind: match[1], text: match[2] ?? "" };
        markers.push(marker);
        onMarker?.(marker);
        return;
      }
      if (line.trim().length === 0) return;
      tail.push(line);
      if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
    };
    const handleChunk = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(handleLine);
    };

    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn("powershell.exe", powershellArgs(scriptPath, args), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ exitCode: null, markers, tail: [String(error)] });
      return;
    }
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.on("error", (error) => {
      tail.push(error.message);
    });
    child.on("close", (code) => {
      if (buffer.length > 0) handleLine(buffer);
      resolve({ exitCode: code, markers, tail });
    });
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const packageJsonPath = environment.path.join(environment.appRoot, "package.json");
  const buildInfo = yield* fileSystem.readFileString(packageJsonPath).pipe(
    Effect.map((raw) =>
      decodeAppPackageMetadata(raw).pipe(
        Option.flatMap((parsed) => Option.fromNullishOr(parsed.t3codeCustomBuild)),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<AquaBuildInfo>()),
  );

  const scriptPath =
    environment.platform === "win32"
      ? Option.map(buildInfo, (info) => environment.path.join(info.repo, SCRIPT_RELATIVE_PATH))
      : Option.none<string>();
  const logDir = environment.path.join(process.env.LOCALAPPDATA ?? "", "t3code-custom");

  if (Option.isSome(buildInfo)) {
    yield* logInfo("custom build detected", {
      baseTag: buildInfo.value.baseTag,
      commit: buildInfo.value.commit,
    });
  }

  const runScript = (
    args: ReadonlyArray<string>,
    onMarker?: (marker: AquaScriptMarker) => void,
  ): Effect.Effect<AquaScriptResult> =>
    Option.match(scriptPath, {
      onNone: () =>
        Effect.succeed<AquaScriptResult>({
          exitCode: null,
          markers: [],
          tail: ["This app wasn't built from a local clone."],
        }),
      onSome: (path) => Effect.promise(() => runPowershell(path, args, onMarker)),
    });

  const spawnDetached = (args: ReadonlyArray<string>) =>
    Option.match(scriptPath, {
      onNone: () => Effect.succeed(false),
      onSome: (path) =>
        Effect.sync(() => {
          try {
            const child = NodeChildProcess.spawn("powershell.exe", powershellArgs(path, args), {
              detached: true,
              windowsHide: true,
              stdio: "ignore",
            });
            child.unref();
            return true;
          } catch {
            return false;
          }
        }),
    });

  const getStatus = Effect.fn("desktop.aqua.getStatus")(function* (options: {
    readonly fetch: boolean;
  }) {
    const build = Option.getOrNull(buildInfo);
    if (Option.isNone(scriptPath)) {
      return { build, clone: null } satisfies AquaCustomStatus;
    }
    const result = yield* runScript(options.fetch ? ["-Status"] : ["-Status", "-NoFetch"]);
    const statusMarker = result.markers.find((marker) => marker.kind === "status");
    const clone = statusMarker ? Option.getOrNull(decodeCloneStatus(statusMarker.text)) : null;
    if (clone === null) {
      yield* logWarning("clone status unavailable", {
        exitCode: result.exitCode,
        output: result.tail.join("\n").slice(0, 1024),
      });
    }
    return { build, clone } satisfies AquaCustomStatus;
  });

  const openPath = (target: string) =>
    Effect.promise(() => Electron.shell.openPath(target)).pipe(Effect.asVoid);

  return AquaCustomBuild.of({
    buildInfo,
    scriptPath,
    logDir,
    runScript,
    spawnDetached,
    getStatus,
    openClone: Option.match(buildInfo, {
      onNone: () => Effect.void,
      onSome: (info) => openPath(info.repo),
    }),
    openLog: openPath(environment.path.join(logDir, "last-run.log")),
  });
});

export const layer = Layer.effect(AquaCustomBuild, make);
