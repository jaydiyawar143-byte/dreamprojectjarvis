"use client";

// ---------------------------------------------------------------------------
// Phase 19.6 — Computer Control.
//
// Where a person pairs a Windows computer and drives it by hand. Chat can ask
// for an approved application or for typing (Stage 19.7); clicks and named keys
// are only ever asked for here. Everything the page shows and every control it
// draws is decided by the server; the page never decides who may pair, confirm,
// revoke or command.
//
//   • Pair: an Owner/Admin chooses one of the Organizations the server says they
//     administer, generates a one-time code and types it into the JARVIS Desktop
//     Agent. The server decides again when the code is asked for. The device
//     stays pending until its user TYPES the fingerprint the computer shows —
//     comparing, not clicking through.
//   • Consent happens on the computer only. This page shows whether control is
//     allowed, until when, and can end it — it can never start it.
//   • A command — a click, a key, typed text, opening an approved application —
//     becomes an approval the person approves here; typing is then verified
//     again with Windows Hello on the computer, for that command, or it does not
//     run. The exact text is shown before it is approved. It comes from this
//     browser: the server keeps no copy to send back.
//   • JARVIS cannot see the computer's screen (D4), and the page never implies
//     it can.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Laptop, ShieldAlert, ShieldCheck } from "lucide-react";

import {
  confirmDesktopCommand,
  confirmDesktopDevice,
  createDesktopPairingCode,
  endDesktopSession,
  listDesktopCommands,
  listDesktopDevices,
  listDesktopOrganizations,
  requestDesktopCommand,
  revokeDesktopDevice,
  type DesktopCommand,
  type DesktopCommandInput,
  type DesktopCommandRequestResult,
  type DesktopDevice,
  type DesktopOrganization,
  type DesktopPairingCode,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { Panel } from "@/components/dashboard/panel";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, StatusDot } from "@/components/ui/primitives";

const KEYS = ["enter", "tab", "escape", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright"] as const;
/** The owner's list. The server refuses any other id, and the agent refuses it again. */
const APPS = [
  { id: "notepad", label: "Notepad" },
  { id: "calculator", label: "Calculator" },
  { id: "edge", label: "Microsoft Edge" },
  { id: "chrome", label: "Google Chrome" },
  { id: "explorer", label: "File Explorer" },
] as const;
const SCOPE_LABEL: Record<string, string> = {
  "desktop.input.click": "click",
  "desktop.input.key": "keys",
  "desktop.input.type": "typing (Windows Hello each time)",
  "desktop.app.launch": "open an application",
};
const FINAL: ReadonlySet<DesktopCommand["status"]> = new Set(["succeeded", "not_executed", "unknown", "expired"]);
const COMMAND_STATUS: Record<DesktopCommand["status"], { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  issued: { label: "Waiting for the computer", tone: "neutral" },
  delivered: { label: "On the computer", tone: "neutral" },
  succeeded: { label: "Done", tone: "ok" },
  not_executed: { label: "Not done", tone: "warn" },
  unknown: { label: "Outcome unknown — not retried", tone: "danger" },
  expired: { label: "Expired — never reached the computer", tone: "warn" },
};
/** Why a computer did not act. Each means nothing was done. */
const RESULT_REASON: Record<string, string> = {
  APP_NOT_INSTALLED: "not installed there",
  LAUNCH_FAILED: "Windows could not start it",
  HELLO_FAILED: "Windows Hello was not verified",
  HELLO_UNAVAILABLE: "Windows Hello is not set up",
  SESSION_LOCKED: "the computer was locked",
  GRANT_INACTIVE: "control had ended",
  COMMAND_EXPIRED: "it took too long",
  NO_TARGET: "no suitable window had focus",
  ELEVATED_TARGET: "the window runs as administrator",
  OUT_OF_BOUNDS: "that position is off the screen",
  BUSY: "the computer was busy",
  INVALID_COMMAND: "the computer refused it",
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ComputerControlPage() {
  const devices = useResource<DesktopDevice[]>(listDesktopDevices, []);
  const disabled = devices.loaded && devices.error !== null && devices.errorCode === "NOT_FOUND";

  return (
    <PageContainer>
      <PageHeader
        title="Computer Control"
        description="Pair a Windows computer and control it one approved action at a time. JARVIS cannot see the computer's screen."
      />

      {devices.loading && !devices.loaded && <LoadingState lines={3} />}

      {disabled && (
        <Panel title="Not enabled on this server">
          <EmptyState
            title="Desktop control is switched off"
            message="An operator enables it with DESKTOP_AGENT_ENABLED=true and the settings in the deployment guide. Until then nothing can be paired or controlled."
          />
        </Panel>
      )}

      {devices.error && !disabled && <ErrorState message={devices.error} onRetry={() => void devices.reload()} />}

      {devices.loaded && !devices.error && (
        <div className="space-y-5">
          <PairingPanel onChanged={() => void devices.reload()} />
          {(devices.data ?? []).length === 0 ? (
            <Panel title="Computers">
              <EmptyState title="No computers paired" message="Generate a pairing code, then enter it in the JARVIS Desktop Agent on the computer." />
            </Panel>
          ) : (
            (devices.data ?? []).map((device) => <DevicePanel key={device.id} device={device} onChanged={() => void devices.reload()} />)
          )}
          <SafetyPanel />
        </div>
      )}
    </PageContainer>
  );
}

function PairingPanel({ onChanged }: { onChanged: () => void }) {
  const organizations = useResource<DesktopOrganization[]>(listDesktopOrganizations, []);
  const [chosen, setChosen] = useState("");
  const [pairing, setPairing] = useState<DesktopPairingCode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offered = organizations.data ?? [];
  // One Organization needs no choosing. Several do, with nothing picked for the
  // person: a computer stays with the Organization it is paired to.
  const organizationId = offered.length === 1 ? offered[0]!.id : offered.some((o) => o.id === chosen) ? chosen : "";

  const generate = async () => {
    setBusy(true);
    setMessage(null);
    const res = await createDesktopPairingCode(organizationId);
    setBusy(false);
    if (res.success && res.data) {
      setPairing(res.data);
      onChanged();
    } else {
      setMessage(res.error?.message ?? "A pairing code could not be created.");
      void organizations.reload();
    }
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <KeyRound size={15} className="text-sys-dim" aria-hidden="true" />
          Pair a computer
        </span>
      }
      description="Owners and admins of an Organization can pair their own Windows 11 computer. The code works once, for ten minutes."
    >
      <div className="space-y-3">
        {organizations.loading && !organizations.loaded && <LoadingState lines={1} />}
        {organizations.error && <ErrorState message={organizations.error} onRetry={() => void organizations.reload()} />}
        {organizations.loaded && !organizations.error && offered.length === 0 && (
          <EmptyState title="Nothing to pair with" message="Only an owner or admin of an Organization can pair a computer." />
        )}
        {!organizations.error && offered.length > 0 && (
          <>
            {offered.length === 1 ? (
              <p className="text-sm text-sys-text/85" data-testid="pairing-organization">
                This computer will belong to {offered[0]!.name}.
              </p>
            ) : (
              <select
                aria-label="Organization"
                className="rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm text-sys-text"
                value={organizationId}
                onChange={(e) => setChosen(e.target.value)}
              >
                <option value="">Choose an Organization</option>
                {offered.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
            <Button variant="primary" onClick={() => void generate()} disabled={busy || organizationId === ""} data-testid="generate-pairing-code">
              Generate pairing code
            </Button>
          </>
        )}
        {pairing && (
          <div className="space-y-1" data-testid="pairing-code">
            <p className="font-mono text-lg tracking-wider text-sys-text">{pairing.code}</p>
            <p className="text-xs text-sys-dim">
              Enter it in the JARVIS Desktop Agent before {time(pairing.expiresAt)}. It is shown once and is not stored.
              Then confirm the computer below by typing the fingerprint it shows.
            </p>
            <p className="text-xs text-sys-dim">
              After pairing, the computer shows the server key it trusts. It must be <span className="font-mono text-sys-text">{pairing.serverKeyId}</span>; if
              it is not, revoke the computer.
            </p>
          </div>
        )}
        {message && <p className="text-xs text-sys-danger">{message}</p>}
      </div>
    </Panel>
  );
}

function DevicePanel({ device, onChanged }: { device: DesktopDevice; onChanged: () => void }) {
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const act = async (work: () => Promise<{ success: boolean; error?: { message: string } }>) => {
    setMessage(null);
    const res = await work();
    if (!res.success) setMessage(res.error?.message ?? "That did not work; nothing was changed.");
    onChanged();
  };

  const statusTone = device.status === "active" ? "ok" : device.status === "pending" ? "warn" : "neutral";
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Laptop size={15} className="text-sys-dim" aria-hidden="true" />
          {device.displayName}
        </span>
      }
      description={`${device.userLabel} · ${device.organizationLabel} · agent ${device.agentVersion} · Windows build ${device.windowsBuild}`}
      action={<StatusDot tone={statusTone} label={device.status} />}
    >
      <div className="space-y-3" data-testid={`device-${device.id}`}>
        <p className="font-mono text-xs text-sys-dim">Fingerprint {device.fingerprint}</p>

        {device.status === "pending" && device.mine && (
          <div className="space-y-2">
            <p className="text-sm text-sys-text/85">
              Type the fingerprint the JARVIS Desktop Agent shows on that computer. Confirm only if it is the computer you are pairing.
            </p>
            <input
              aria-label="Fingerprint shown on the computer"
              className="w-full rounded border border-sys-line bg-white/[0.03] px-2 py-1 font-mono text-sm text-sys-text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            />
            <Button
              variant="primary"
              disabled={typed.trim().length === 0}
              onClick={() => void act(() => confirmDesktopDevice(device.id, typed))}
              data-testid="confirm-fingerprint"
            >
              Confirm this computer
            </Button>
          </div>
        )}

        {device.status === "active" && (
          <div className="flex flex-wrap items-center gap-2">
            {device.grant ? (
              <>
                <Badge tone="info">Control allowed until {time(device.grant.expiresAt)}</Badge>
                {device.grant.scope.map((s) => (
                  <Badge key={s}>{SCOPE_LABEL[s] ?? s}</Badge>
                ))}
                <Button size="sm" onClick={() => void act(() => endDesktopSession(device.id))} data-testid="end-session">
                  End session now
                </Button>
              </>
            ) : (
              <p className="text-xs text-sys-dim">
                Control is not allowed. It can only be allowed on the computer itself, in the JARVIS Desktop Agent.
              </p>
            )}
          </div>
        )}

        {device.status === "active" && device.mine && device.grant && <CommandPanel device={device} />}

        {device.canRevoke && (
          <div className="flex items-center gap-2 pt-1">
            {confirmRevoke ? (
              <>
                <span className="text-xs text-sys-danger">Revoke this computer? It can never be used again without pairing anew.</span>
                <Button size="sm" variant="danger" onClick={() => void act(() => revokeDesktopDevice(device.id))} data-testid="confirm-revoke">
                  Revoke
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setConfirmRevoke(true)} data-testid="revoke">
                Revoke…
              </Button>
            )}
          </div>
        )}
        {message && <p className="text-xs text-sys-danger">{message}</p>}
      </div>
    </Panel>
  );
}

function CommandPanel({ device }: { device: DesktopDevice }) {
  const allowed = device.grant?.scope ?? [];
  const [action, setAction] = useState<DesktopCommandInput["action"]>(allowed[0] as DesktopCommandInput["action"]);
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [key, setKey] = useState<string>("enter");
  const [text, setText] = useState("");
  const [app, setApp] = useState<string>(APPS[0].id);
  const [pending, setPending] = useState<DesktopCommandRequestResult | null>(null);
  /** The words awaiting approval, shown back exactly. Held here and nowhere else. */
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [commands, setCommands] = useState<DesktopCommand[]>([]);

  const refresh = useCallback(async () => {
    const res = await listDesktopCommands(device.id);
    if (res.success && res.data) setCommands(res.data);
  }, [device.id]);

  useEffect(() => {
    void refresh();
    const open = commands.some((c) => !FINAL.has(c.status));
    if (!open) return undefined;
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh, commands]);

  const input = (): DesktopCommandInput | null => {
    if (action === "desktop.input.click") {
      const px = Number(x);
      const py = Number(y);
      return Number.isInteger(px) && Number.isInteger(py) && px >= 0 && py >= 0 ? { action, x: px, y: py } : null;
    }
    if (action === "desktop.input.key") return { action, key };
    if (action === "desktop.app.launch") return { action, app };
    return text.length > 0 ? { action, text } : null;
  };

  const ask = async () => {
    const request = input();
    if (!request) return;
    setMessage(null);
    const res = await requestDesktopCommand(device.id, request);
    if (res.success && res.data) {
      setPending(res.data);
      setPendingText(request.action === "desktop.input.type" ? request.text : null);
      setText("");
    } else {
      setMessage(res.error?.message ?? "That command could not be requested.");
    }
  };

  const approve = async () => {
    if (!pending) return;
    const res = await confirmDesktopCommand(device.id, pending.approvalId);
    setPending(null);
    setPendingText(null);
    if (!res.success) setMessage(res.error?.message ?? "The command was not sent.");
    await refresh();
  };

  return (
    <div className="space-y-3 rounded border border-sys-line bg-white/[0.02] p-3" data-testid="command-panel">
      <p className="text-xs text-sys-dim">
        One action at a time. Click positions are pixels counted from the top-left corner of that computer's whole desktop (all its screens together) — JARVIS cannot see its screen.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Action"
          className="rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm text-sys-text"
          value={action}
          onChange={(e) => setAction(e.target.value as DesktopCommandInput["action"])}
        >
          {allowed.map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        {action === "desktop.input.click" && (
          <>
            <input aria-label="X" className="w-24 rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm" value={x} onChange={(e) => setX(e.target.value)} placeholder="x" />
            <input aria-label="Y" className="w-24 rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm" value={y} onChange={(e) => setY(e.target.value)} placeholder="y" />
          </>
        )}
        {action === "desktop.input.key" && (
          <select aria-label="Key" className="rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm" value={key} onChange={(e) => setKey(e.target.value)}>
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        {action === "desktop.app.launch" && (
          <select aria-label="Application" className="rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm" value={app} onChange={(e) => setApp(e.target.value)}>
            {APPS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        {action === "desktop.input.type" && (
          <input
            aria-label="Text to type"
            type="text"
            autoComplete="off"
            className="min-w-[14rem] flex-1 rounded border border-sys-line bg-white/[0.03] px-2 py-1 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Text to type"
          />
        )}
        <Button onClick={() => void ask()} disabled={!input()} data-testid="request-command">
          Request
        </Button>
      </div>

      {pending && (
        <div className="space-y-2" data-testid="pending-command">
          <p className="text-sm text-sys-text">{pending.summary}</p>
          <ul className="text-xs text-sys-dim">
            {pending.detailLines.map((line) => (
              <li key={line.label}>
                {line.label}: {line.value}
              </li>
            ))}
          </ul>
          {pendingText !== null && (
            <div data-testid="exact-text">
              <p className="text-xs text-sys-dim">Text to be typed, exactly:</p>
              <p className="whitespace-pre-wrap break-words rounded border border-sys-line bg-white/[0.03] px-2 py-1 font-mono text-sm text-sys-text">{pendingText}</p>
            </div>
          )}
          {pending.requiresHello && (
            <p className="flex items-center gap-1 text-xs text-sys-text/85" data-testid="hello-notice">
              <ShieldCheck size={12} aria-hidden="true" />
              After you approve, click into the window where the text should go: JARVIS waits 6 seconds. Windows Hello then names that window. Verify only if it is the right one. Without it, nothing is typed.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void approve()} data-testid="approve-command">
              Approve and send
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setPendingText(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && <p className="text-xs text-sys-danger">{message}</p>}

      {commands.length > 0 && (
        <ul className="space-y-1" data-testid="command-history">
          {commands.slice(0, 5).map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs text-sys-dim">
              <span className="font-mono">{SCOPE_LABEL[c.action] ?? c.action}</span>
              <StatusDot tone={COMMAND_STATUS[c.status].tone} label={COMMAND_STATUS[c.status].label} />
              {c.status === "not_executed" && c.resultCode && <span>{RESULT_REASON[c.resultCode] ?? "nothing was done"}</span>}
              <span>{time(c.issuedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SafetyPanel() {
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert size={15} className="text-sys-dim" aria-hidden="true" />
          What JARVIS can and cannot do on a computer
        </span>
      }
    >
      <ul className="space-y-1 text-xs leading-relaxed text-sys-dim">
        <li>It can click, press Enter, Tab, Escape, Backspace, Delete and the arrow keys, type approved text and open approved applications (Notepad, Calculator, Microsoft Edge, Google Chrome, File Explorer) — only while control is allowed on the computer.</li>
        <li>You approve every action before it runs. Typing also needs Windows Hello on the computer, every time, and a computer without Windows Hello cannot be typed into. JARVIS never types passwords, codes or credentials.</li>
        <li>It cannot see the screen, run any other program, shell command or script, open or change files, use the clipboard, or act in windows that run as administrator.</li>
        <li>Control ends when it expires, when the computer locks, signs out or restarts, or when someone presses Ctrl+Alt+Shift+F12 at the keyboard.</li>
        <li>If the computer does not answer, the outcome is recorded as unknown and the command is never sent again.</li>
      </ul>
    </Panel>
  );
}
