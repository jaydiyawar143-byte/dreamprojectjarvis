// ---------------------------------------------------------------------------
// Phase 19, Stage 19.1 — Computer & Browser Control contracts.
//
// Contract only. These tests pin:
//   • the closed action sets, their bounds and their refusals;
//   • that every browser action is in the existing shared-connection catalog,
//     with the access the policy states;
//   • the sensitive-action voice denylist;
//   • value-free approval summaries and bindings.
//
// Nothing here starts a browser, a desktop agent or a socket.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  BROWSER_CONTROL_ACTION_IDS,
  COMPUTER_CONTROL_ACTION_IDS,
  COMPUTER_CONTROL_ACTION_POLICY,
  COMPUTER_CONTROL_VOICE_REFUSED_TOOLS,
  ComputerControlFailureSchema,
  ComputerControlRequestSchema,
  ComputerControlResultSchema,
  bindComputerControlApproval,
  computerControlApprovalSummary,
  isComputerControlAction,
  normalizeBrowserOrigin,
  parseComputerControlRequest,
} from "../src/computer-control.js";
import {
  BROWSER_ACTION_TOOL_IDS,
  BROWSER_READ_TOOL_IDS,
  BROWSER_TOOL_IDS,
} from "../src/types/browser.js";
import {
  SHARED_CONNECTION_TOOLS,
  SHARED_INTEGRATION_CONNECTORS,
  sharedConnectionOfTool,
} from "../src/types/tenant.js";
import { VOICE_REFUSED_TOOLS, voiceToolRefusal } from "../src/voice-tool-policy.js";
import { computeParamsHash } from "../src/utils/params-hash.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

const VALID_BROWSER_REQUESTS = [
  { action: BROWSER_TOOL_IDS.navigate, url: "https://example.com/path?token=SECRET#frag" },
  { action: BROWSER_TOOL_IDS.inspect, url: "https://example.com/" },
  {
    action: BROWSER_TOOL_IDS.extract,
    url: "https://example.com/",
    selectors: { price: ".price", title: "h1" },
  },
  { action: BROWSER_TOOL_IDS.screenshot, url: "https://example.com/" },
  { action: BROWSER_TOOL_IDS.click, url: "https://example.com/", selector: "button.buy" },
  {
    action: BROWSER_TOOL_IDS.type,
    url: "https://example.com/",
    selector: 'input[name="email"]',
    text: "person@example.com",
  },
  {
    action: BROWSER_TOOL_IDS.select,
    url: "https://example.com/",
    selector: "select#country",
    value: "GB",
  },
  {
    action: BROWSER_TOOL_IDS.submit,
    url: "https://example.com/",
    selector: "button[type=submit]",
    fields: { 'input[name="email"]': "person@example.com" },
  },
  { action: BROWSER_TOOL_IDS.download, url: "https://example.com/", selector: "#download" },
  {
    action: BROWSER_TOOL_IDS.upload,
    url: "https://example.com/",
    selector: "input[type=file]",
    downloadId: UUID,
  },
] as const;

const VALID_DESKTOP_REQUESTS = [
  { action: "desktop.screen.read", display: 0 },
  { action: "desktop.input.click", x: 10, y: 20, button: "left" },
  { action: "desktop.input.type", text: "hello" },
  { action: "desktop.input.key", key: "enter" },
  { action: "desktop.session.end" },
] as const;

describe("Phase 19.1 — the action contract is closed and bounded", () => {
  it("accepts every declared browser action", () => {
    for (const request of VALID_BROWSER_REQUESTS) {
      const parsed = parseComputerControlRequest(request);
      expect(parsed.ok, request.action).toBe(true);
      if (parsed.ok) expect(parsed.value.action).toBe(request.action);
      expect(ComputerControlRequestSchema.safeParse(request).success, request.action).toBe(true);
    }
  });

  it("accepts every planned desktop action", () => {
    for (const request of VALID_DESKTOP_REQUESTS) {
      const parsed = parseComputerControlRequest(request);
      expect(parsed.ok, request.action).toBe(true);
      if (parsed.ok) expect(parsed.value.action).toBe(request.action);
    }
  });

  it("rejects an unknown action with a stable code", () => {
    expect(parseComputerControlRequest({ action: "browser.evaluate", script: "alert(1)" })).toEqual({
      ok: false,
      code: "UNKNOWN_ACTION",
    });
    expect(parseComputerControlRequest({ action: "desktop.command.run", command: "calc" })).toEqual({
      ok: false,
      code: "UNKNOWN_ACTION",
    });
  });

  it.each([
    ["a non-object", null],
    ["an array", []],
    ["a missing url", { action: BROWSER_TOOL_IDS.navigate }],
    ["an extra script field", { action: BROWSER_TOOL_IDS.navigate, url: "https://example.com/", script: "alert(1)" }],
    ["a non-http URL", { action: BROWSER_TOOL_IDS.navigate, url: "file:///C:/secret.txt" }],
    ["a URL with credentials", { action: BROWSER_TOOL_IDS.navigate, url: "https://user:pass@example.com/" }],
    [
      "oversized typed text",
      {
        action: BROWSER_TOOL_IDS.type,
        url: "https://example.com/",
        selector: "#email",
        text: "x".repeat(10_001),
      },
    ],
    [
      "too many submitted fields",
      {
        action: BROWSER_TOOL_IDS.submit,
        url: "https://example.com/",
        selector: "#submit",
        fields: Object.fromEntries(
          Array.from({ length: 26 }, (_, index) => [`#field-${index}`, "x"])
        ),
      },
    ],
    [
      "a path where an opaque download id belongs",
      {
        action: BROWSER_TOOL_IDS.upload,
        url: "https://example.com/",
        selector: "input[type=file]",
        downloadId: "C:\\Users\\person\\secret.txt",
      },
    ],
    [
      "an extra shell field",
      { action: "desktop.input.key", key: "enter", command: "calc.exe" },
    ],
    ["an out-of-range desktop point", { action: "desktop.input.click", x: 100_001, y: 0 }],
    ["an arbitrary key chord", { action: "desktop.input.key", key: "ctrl+alt+delete" }],
  ])("rejects %s", (_label, input) => {
    expect(parseComputerControlRequest(input)).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("refuses a submission field name that is not a selector", () => {
    expect(
      parseComputerControlRequest({
        action: BROWSER_TOOL_IDS.submit,
        url: "https://example.com/",
        selector: "#submit",
        fields: { "<script>alert(1)</script>": "x" },
      })
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("recognizes only declared actions", () => {
    for (const action of COMPUTER_CONTROL_ACTION_IDS) expect(isComputerControlAction(action)).toBe(true);
    expect(isComputerControlAction("browser.evaluate")).toBe(false);
    expect(isComputerControlAction(undefined)).toBe(false);
  });
});

describe("Phase 19.1 — result contracts carry no handles or free text", () => {
  it("accepts the bounded success results", () => {
    expect(
      ComputerControlResultSchema.safeParse({
        action: BROWSER_TOOL_IDS.navigate,
        ok: true,
        page: { url: "https://example.com/", title: "Example", status: 200 },
        redirected: false,
      }).success
    ).toBe(true);
    expect(
      ComputerControlResultSchema.safeParse({
        action: "desktop.screen.read",
        ok: true,
        artifactId: UUID,
        width: 1920,
        height: 1080,
      }).success
    ).toBe(true);
  });

  it("accepts a stable failure code and refuses a provider message", () => {
    expect(
      ComputerControlFailureSchema.safeParse({
        action: BROWSER_TOOL_IDS.navigate,
        ok: false,
        code: "NAVIGATION_REFUSED",
      }).success
    ).toBe(true);
    expect(
      ComputerControlFailureSchema.safeParse({
        action: BROWSER_TOOL_IDS.navigate,
        ok: false,
        code: "NAVIGATION_REFUSED",
        message: "the provider said something",
      }).success
    ).toBe(false);
    expect(
      ComputerControlFailureSchema.safeParse({
        action: BROWSER_TOOL_IDS.navigate,
        ok: false,
        code: "SOMETHING_ELSE",
      }).success
    ).toBe(false);
  });

  it("refuses a reported file name that is really a path", () => {
    const base = {
      action: BROWSER_TOOL_IDS.download,
      ok: true,
      downloadId: UUID,
      byteSize: 10,
      mimeType: "application/pdf",
      sourceOrigin: "https://example.com",
    };
    expect(
      ComputerControlResultSchema.safeParse({ ...base, fileName: "contract.pdf" }).success
    ).toBe(true);
    for (const fileName of ["..\\\\secret.pdf", "/etc/passwd", "C:\\\\Users\\\\person\\\\secret.pdf"]) {
      expect(
        ComputerControlResultSchema.safeParse({ ...base, fileName }).success,
        fileName
      ).toBe(false);
    }
  });

  it("refuses a raw page object smuggled into a result", () => {
    expect(
      ComputerControlResultSchema.safeParse({
        action: BROWSER_TOOL_IDS.navigate,
        ok: true,
        page: { url: "https://example.com/", title: "Example", status: 200 },
        redirected: false,
        rawPage: { cdp: "Runtime.evaluate" },
      }).success
    ).toBe(false);
  });
});

describe("Phase 19.1 — the existing shared-connection catalog covers the browser", () => {
  it("maps every browser action through the browser connector", () => {
    for (const action of BROWSER_CONTROL_ACTION_IDS) {
      const policy = COMPUTER_CONTROL_ACTION_POLICY[action];
      const use = sharedConnectionOfTool(action);
      expect(use, action).not.toBeNull();
      expect(use, action).toMatchObject({
        integration: "browser",
        connector: SHARED_INTEGRATION_CONNECTORS.browser,
        access: policy.access,
      });
      expect(policy.connector).toEqual(SHARED_INTEGRATION_CONNECTORS.browser);
      expect(policy.organizationMapped).toBe(true);
    }
  });

  it("treats reads as reads and every page-changing action as a write", () => {
    for (const action of BROWSER_READ_TOOL_IDS) {
      expect(COMPUTER_CONTROL_ACTION_POLICY[action as keyof typeof COMPUTER_CONTROL_ACTION_POLICY]).toMatchObject({
        access: "read",
        requiresApproval: false,
        voice: "allowed",
      });
    }
    for (const action of BROWSER_ACTION_TOOL_IDS) {
      expect(COMPUTER_CONTROL_ACTION_POLICY[action as keyof typeof COMPUTER_CONTROL_ACTION_POLICY]).toMatchObject({
        access: "write",
        requiresApproval: true,
        voice: "refused",
      });
    }
    expect(SHARED_CONNECTION_TOOLS[BROWSER_TOOL_IDS.navigate]!.access).toBe("read");
    expect(SHARED_CONNECTION_TOOLS[BROWSER_TOOL_IDS.submit]!.access).toBe("write");
  });

  it("keeps the desktop connector out of the operator catalog until a route reads it", () => {
    for (const action of ["desktop.screen.read", "desktop.input.click", "desktop.input.type", "desktop.input.key", "desktop.session.end"] as const) {
      expect(COMPUTER_CONTROL_ACTION_POLICY[action].organizationMapped).toBe(false);
      expect(sharedConnectionOfTool(action)).toBeNull();
    }
  });

  it("keeps desktop input approval-gated and desktop revocation free", () => {
    expect(COMPUTER_CONTROL_ACTION_POLICY["desktop.screen.read"]).toMatchObject({
      access: "read",
      requiresApproval: false,
      carriesSensitiveInput: false,
    });
    expect(COMPUTER_CONTROL_ACTION_POLICY["desktop.input.type"]).toMatchObject({
      access: "write",
      requiresApproval: true,
      carriesSensitiveInput: true,
      voice: "refused",
    });
    expect(COMPUTER_CONTROL_ACTION_POLICY["desktop.session.end"]).toMatchObject({
      requiresApproval: false,
      voice: "allowed",
    });
  });
});

describe("Phase 19.1 — voice may not start a sensitive computer action", () => {
  const expectedRefused = [
    BROWSER_TOOL_IDS.click,
    BROWSER_TOOL_IDS.type,
    BROWSER_TOOL_IDS.select,
    BROWSER_TOOL_IDS.submit,
    BROWSER_TOOL_IDS.download,
    BROWSER_TOOL_IDS.upload,
    "desktop.screen.read",
    "desktop.input.click",
    "desktop.input.type",
    "desktop.input.key",
    "desktop.app.launch",
  ];

  it("lists exactly the sensitive actions, through the one voice policy", () => {
    expect(Object.keys(COMPUTER_CONTROL_VOICE_REFUSED_TOOLS).sort()).toEqual([...expectedRefused].sort());
    for (const action of expectedRefused) {
      expect(VOICE_REFUSED_TOOLS[action], action).toBe(COMPUTER_CONTROL_VOICE_REFUSED_TOOLS[action]);
      expect(voiceToolRefusal(action, "voice"), action).toBe(COMPUTER_CONTROL_VOICE_REFUSED_TOOLS[action]);
      expect(voiceToolRefusal(action, "text"), action).toBeNull();
    }
  });

  it("still allows read-only browser actions and ending a desktop session by voice", () => {
    for (const action of BROWSER_READ_TOOL_IDS) {
      expect(VOICE_REFUSED_TOOLS[action], action).toBeUndefined();
      expect(voiceToolRefusal(action, "voice"), action).toBeNull();
    }
    expect(VOICE_REFUSED_TOOLS["desktop.session.end"]).toBeUndefined();
    expect(voiceToolRefusal("desktop.session.end", "voice")).toBeNull();
  });
});

describe("Phase 19.1 — an approval names the site and fields, never the values", () => {
  it("drops the path, query and fragment from a navigation summary", () => {
    const request = {
      action: BROWSER_TOOL_IDS.navigate,
      url: "https://Example.com:8443/private/path?token=SECRET-VALUE#fragment",
    } as const;
    const summary = computerControlApprovalSummary(request);
    expect(summary.actionSummary).toContain("https://example.com:8443");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("SECRET-VALUE");
    expect(serialized).not.toContain("/private/path");
    expect(serialized).not.toContain("fragment");
  });

  it("shows a typed field and its length, never the text", () => {
    const summary = computerControlApprovalSummary({
      action: BROWSER_TOOL_IDS.type,
      url: "https://example.com/login",
      selector: 'input[name="password"]',
      text: "hunter2",
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("input[name=…]");
    expect(summary.detailLines).toContainEqual({ label: "Characters", value: "7" });
  });

  it("shows submitted field names with attribute values removed, never a value", () => {
    const summary = computerControlApprovalSummary({
      action: BROWSER_TOOL_IDS.submit,
      url: "https://example.com/checkout",
      selector: 'button[value="pay-now"]',
      fields: {
        'input[name="password"]': "hunter2",
        'input[value="secret-in-selector"]': "also-secret",
      },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain("pay-now");
    expect(serialized).not.toContain("secret-in-selector");
    expect(serialized).toContain("input[name=…]");
  });

  it("never echoes a selected option, a download id, or desktop typed text", () => {
    expect(
      JSON.stringify(
        computerControlApprovalSummary({
          action: BROWSER_TOOL_IDS.select,
          url: "https://example.com/",
          selector: "select#country",
          value: "secret-option-value",
        })
      )
    ).not.toContain("secret-option-value");

    expect(
      JSON.stringify(
        computerControlApprovalSummary({
          action: BROWSER_TOOL_IDS.upload,
          url: "https://example.com/",
          selector: "input[type=file]",
          downloadId: UUID,
        })
      )
    ).not.toContain(UUID);

    const desktop = JSON.stringify(
      computerControlApprovalSummary({
        action: "desktop.input.type",
        text: "desktop-secret",
      })
    );
    expect(desktop).not.toContain("desktop-secret");
    expect(desktop).toContain("not shown");
  });
});

describe("Phase 19.1 — approvals bind to user, Organization, action and hash", () => {
  const request = {
    action: BROWSER_TOOL_IDS.type,
    url: "https://example.com/login",
    selector: 'input[name="password"]',
    text: "hunter2",
  } as const;

  it("binds all four facts and stores no value", () => {
    const bound = bindComputerControlApproval({
      request,
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    expect(bound.value).toMatchObject({
      action: BROWSER_TOOL_IDS.type,
      surface: "browser",
      toolId: BROWSER_TOOL_IDS.type,
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(bound.value.paramsHash).toBe(
      computeParamsHash({
        url: request.url,
        selector: request.selector,
        text: request.text,
      })
    );
    expect(bound.value.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(bound.value)).not.toContain("hunter2");
    expect(JSON.stringify(bound.value)).not.toContain(request.url);
  });

  it("fails closed without a server-resolved Organization or a user", () => {
    expect(
      bindComputerControlApproval({ request, userId: "user-1", tenantId: "" })
    ).toEqual({ ok: false, code: "ORGANIZATION_REQUIRED" });
    expect(
      bindComputerControlApproval({ request, userId: "user-1", tenantId: "   " })
    ).toEqual({ ok: false, code: "ORGANIZATION_REQUIRED" });
    expect(
      bindComputerControlApproval({ request, userId: "", tenantId: "tenant-1" })
    ).toEqual({ ok: false, code: "USER_REQUIRED" });
  });

  it("changes the hash when the exact action parameters change", () => {
    const first = bindComputerControlApproval({ request, userId: "user-1", tenantId: "tenant-1" });
    const changed = bindComputerControlApproval({
      request: { ...request, text: "hunter3" },
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(first.ok && changed.ok).toBe(true);
    if (first.ok && changed.ok) expect(first.value.paramsHash).not.toBe(changed.value.paramsHash);
  });

  it("binds a planned desktop action too", () => {
    const bound = bindComputerControlApproval({
      request: { action: "desktop.input.type", text: "hello" },
      userId: "user-1",
      tenantId: "tenant-1",
    });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.value).toMatchObject({ surface: "desktop", tenantId: "tenant-1" });
      expect(JSON.stringify(bound.value)).not.toContain("hello");
    }
  });
});

describe("Phase 19.1 — origin normalization", () => {
  it("keeps scheme, host and port only", () => {
    expect(normalizeBrowserOrigin("HTTPS://Example.COM:8443/a/b?q=1#x")).toBe(
      "https://example.com:8443"
    );
    expect(normalizeBrowserOrigin("https://example.com/")).toBe("https://example.com");
  });

  it("refuses non-http schemes and credentials", () => {
    expect(normalizeBrowserOrigin("file:///C:/secret.txt")).toBeNull();
    expect(normalizeBrowserOrigin("https://user:pass@example.com/")).toBeNull();
    expect(normalizeBrowserOrigin("not a url")).toBeNull();
  });
});
