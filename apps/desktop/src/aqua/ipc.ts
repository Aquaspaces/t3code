import { AquaCustomStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeIpcMethod } from "../ipc/DesktopIpc.ts";
import * as AquaCustomBuild from "./AquaCustomBuild.ts";
import * as AquaChannels from "./channels.ts";

export const getAquaStatus = makeIpcMethod({
  channel: AquaChannels.AQUA_GET_STATUS_CHANNEL,
  payload: Schema.Struct({ fetch: Schema.Boolean }),
  result: AquaCustomStatus,
  handler: Effect.fn("desktop.ipc.aqua.getStatus")(function* (options) {
    return yield* (yield* AquaCustomBuild.AquaCustomBuild).getStatus(options);
  }),
});

export const openAquaClone = makeIpcMethod({
  channel: AquaChannels.AQUA_OPEN_CLONE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.aqua.openClone")(function* () {
    yield* (yield* AquaCustomBuild.AquaCustomBuild).openClone;
  }),
});

export const openAquaLog = makeIpcMethod({
  channel: AquaChannels.AQUA_OPEN_LOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.aqua.openLog")(function* () {
    yield* (yield* AquaCustomBuild.AquaCustomBuild).openLog;
  }),
});
