// ---------------------------------------------------------------------------
// Phase 18, Stage 18.4 — the planning vocabulary: trigger kinds, integration
// categories, and how each is said. Browser-safe (no runtime import), so the
// Automations page reads the same lists the server checks against.
// ---------------------------------------------------------------------------

import type { LibraryIntegrationCategory, LibraryTriggerKind } from "./automation-inspection.js";

export const LIBRARY_TRIGGER_KINDS: readonly LibraryTriggerKind[] = [
  "webhook",
  "schedule",
  "manual",
  "form",
  "chat",
  "sub_workflow",
  "error_handler",
  "email",
  "n8n_event",
  "app_event",
];

export const LIBRARY_INTEGRATION_CATEGORIES: readonly LibraryIntegrationCategory[] = [
  "messaging",
  "email",
  "spreadsheet",
  "database",
  "crm",
  "storage",
  "calendar",
  "ai",
  "http",
  "code",
  "logic",
  "social",
  "payments",
  "project_management",
];

export const TRIGGER_LABEL: Readonly<Record<LibraryTriggerKind, string>> = {
  webhook: "a webhook",
  schedule: "a schedule",
  manual: "a manual start",
  form: "a form submission",
  chat: "a chat message",
  sub_workflow: "another workflow calling it",
  error_handler: "a workflow failing",
  email: "an incoming email",
  n8n_event: "an n8n event",
  app_event: "an app event",
};

export const CATEGORY_LABEL: Readonly<Record<LibraryIntegrationCategory, string>> = {
  messaging: "messaging",
  email: "email",
  spreadsheet: "spreadsheets",
  database: "a database",
  crm: "a CRM",
  storage: "file storage",
  calendar: "a calendar",
  ai: "AI",
  http: "HTTP",
  code: "code",
  logic: "logic",
  social: "social media",
  payments: "payments",
  project_management: "project management",
};
