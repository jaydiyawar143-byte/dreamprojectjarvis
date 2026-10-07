// ---------------------------------------------------------------------------
// Phase 13 — this process's operational log and error monitor.
//
// One of each, created here and handed to whatever reports: the composition
// root, the HTTP error handler, the shutdown controller, the confirmation
// service. Nothing else in the API constructs its own.
//
// THE MONITOR'S SINK IS CHOSEN HERE. Today it is the local one — every report
// becomes a structured `monitor_exception` / `monitor_message` log line, which
// needs no account, no network and no vendor. To send reports to a hosted
// service, give `createErrorMonitor` a sink for it on the line below; nothing
// that reports would change.
// ---------------------------------------------------------------------------

import { hostname } from "node:os";
import { createErrorMonitor, logMonitorSink } from "./error-monitor.js";
import { createOperationalLog } from "./operational-log.js";

export const operationalLog = createOperationalLog({
  service: "jarvis-api",
  // In a container this is the container id, which is what tells two
  // instances' lines apart.
  instance: hostname(),
});

export const errorMonitor = createErrorMonitor(logMonitorSink(operationalLog), {
  onSinkFailure: (reason) => operationalLog.warn("monitor_sink_failed", { reason }),
});

export {
  createOperationalLog,
  writeRecord,
  type OperationalLog,
  type LogLevel,
} from "./operational-log.js";
export {
  createErrorMonitor,
  logMonitorSink,
  noopMonitorSink,
  type ErrorMonitor,
  type MonitorEvent,
  type MonitorSeverity,
  type MonitorSink,
} from "./error-monitor.js";
