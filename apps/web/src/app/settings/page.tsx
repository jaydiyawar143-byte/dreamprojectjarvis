"use client";

// ---------------------------------------------------------------------------
// UI V2 — Settings.
//
// Everything here is READ-ONLY except the one preference the client genuinely
// owns: whether replies are spoken aloud. That is a browser-side setting in the
// voice store, not server state, so it is the only control that can honestly be
// offered — there is no profile-update, no workspace and no permission-editing
// endpoint on this API, and inventing one would be exactly the fabrication the
// brief forbids.
//
// The voice section restates the locked approval rule, because Settings is
// where an operator goes looking for a way to turn it off. There isn't one.
// ---------------------------------------------------------------------------

import { getVoiceStatus, isNotDeployed, type VoiceStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResource } from "@/lib/use-resource";
import { useVoiceStore } from "@/lib/voice/voice-store";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { Panel } from "@/components/dashboard/panel";
import { ErrorState, LoadingState } from "@/components/dashboard/states";
import { Badge, Button, StatusDot } from "@/components/ui/primitives";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sys-line/50 py-3 last:border-0">
      <span className="font-mono text-[0.62rem] uppercase tracking-hud text-sys-dim">{label}</span>
      <span className="text-sm text-sys-text">{children}</span>
    </div>
  );
}

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const autoSpeak = useVoiceStore((s) => s.autoSpeak);
  const toggleAutoSpeak = useVoiceStore((s) => s.toggleAutoSpeak);

  const voice = useResource<VoiceStatus>(getVoiceStatus, [], {
    fallbackError: "Could not read voice settings.",
  });

  const voiceNotDeployed = voice.loaded && isNotDeployed({ code: voice.errorCode ?? "", message: "" });

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="Your account and this deployment's configuration. Most values are set on the server and shown here read-only."
      />

      <div className="grid gap-4">
        <Panel title="Profile" description="Read from your session">
          {user ? (
            <>
              <Row label="Name">{user.name}</Row>
              <Row label="Email">{user.email}</Row>
              <Row label="Role">
                <Badge tone="info">{user.role}</Badge>
              </Row>
              <Row label="Member since">{new Date(user.createdAt).toLocaleDateString()}</Row>
            </>
          ) : (
            <LoadingState lines={3} />
          )}
        </Panel>

        <Panel
          title="Voice"
          description="Speech in and out. The approval rule below is fixed and cannot be changed from here."
        >
          {voice.loading && !voice.loaded && <LoadingState lines={2} />}

          {voiceNotDeployed && (
            <p className="text-sm text-sys-dim">
              Voice is not enabled on this deployment. Set VOICE_ENABLED and an OpenAI key on the
              server to turn it on.
            </p>
          )}

          {!voiceNotDeployed && voice.error && (
            <ErrorState message={voice.error} onRetry={() => void voice.reload()} />
          )}

          {voice.data && (
            <>
              <Row label="Status">
                <StatusDot tone={voice.data.enabled ? "ok" : "neutral"} label={voice.data.enabled ? "Enabled" : "Disabled"} />
              </Row>
              <Row label="Speech to text">{voice.data.sttModel}</Row>
              <Row label="Text to speech">{voice.data.ttsModel}</Row>
              <Row label="Voice">{voice.data.voice}</Row>
              <Row label="Speak replies aloud">
                <Button
                  variant={autoSpeak ? "primary" : "secondary"}
                  size="sm"
                  aria-pressed={autoSpeak}
                  onClick={toggleAutoSpeak}
                >
                  {autoSpeak ? "On" : "Off"}
                </Button>
              </Row>
              <Row label="Can approve actions">
                <Badge tone="danger" title="This is a fixed policy, not a preference.">
                  Never
                </Badge>
              </Row>
              <p className="pt-3 text-xs leading-relaxed text-sys-dim">
                Voice can read a proposed action aloud but can never confirm one. Speech recognition
                is lossy in exactly the way that matters — a misheard &ldquo;no&rdquo; would execute
                an irreversible change — so every write is confirmed on screen.
              </p>
            </>
          )}
        </Panel>

        <Panel title="Session" description="This browser">
          <Row label="Token storage">Session storage, cleared when the tab closes</Row>
          <Row label="Access token lifetime">15 minutes, refreshed automatically</Row>
          <div className="pt-3">
            <Button variant="danger" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </Panel>
      </div>
    </PageContainer>
  );
}
