import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AIConnectionsSettings } from "../src/settings.js";
import type { ConnectionsClient, ConnectionsView, UsageView } from "../src/client.js";

const view: ConnectionsView = {
  appName: "Garage Assistant",
  notices: {
    capabilityDoesNotLimitKey: "A capability only controls routing.",
    hostOperatesKey: "This app's server receives your key.",
    localDeletionDoesNotRevoke: "Removing a connection here does not revoke the provider key.",
    estimatedInThisApp: "Estimated in this app.",
    budgetIsBestEffort: "Budget checks are best effort.",
    testMaySpendQuota: "Testing may spend quota.",
  },
  capabilities: [
    {
      id: "chat",
      description: "Answers questions about vehicle repairs.",
      required: true,
      userCanChooseModel: true,
      providers: ["openai"],
      selection: null,
      selectionIssue: null,
    },
  ],
  providers: [
    {
      id: "openai",
      status: "disconnected",
      keyUrl: "https://platform.openai.com/api-keys",
      usageUrl: "https://platform.openai.com/usage",
      billingUrl: "https://platform.openai.com/settings/organization/billing",
      linksReviewedAt: "2026-09-25",
      testMaySpendQuota: false,
    },
  ],
  limits: { requestTimeoutMs: 30000, maxOutputTokens: 512, budget: { warnAtUsd: 1 } },
  observedSpendUsd: 0,
  observedSpendHasUnknown: false,
};

const usage: UsageView = {
  label: "Estimated in this app.",
  from: "2026-08-26T00:00:00.000Z",
  to: "2026-09-25T00:00:00.000Z",
  requests: 0,
  successes: 0,
  failures: 0,
  estimatedCost: null,
  estimationStatus: "unknown",
  observedKnownUsd: 0,
  units: [],
  budgetNotice: "Budget checks are best effort.",
};

function client(): ConnectionsClient {
  return {
    getConnections: vi.fn(async () => view),
    getUsage: vi.fn(async () => usage),
    getModels: vi.fn(async () => ({ models: [], warnings: [] })),
    putKey: vi.fn(async () => undefined),
    deleteKey: vi.fn(async () => undefined),
    testKey: vi.fn(async () => ({ ok: true, testMaySpendQuota: false })),
    putSelection: vi.fn(async () => undefined),
  };
}

describe("AIConnectionsSettings", () => {
  it("shows purpose, a password key field, and unknown cost", async () => {
    render(<AIConnectionsSettings client={client()} />);
    expect(await screen.findByRole("heading", { name: "Garage Assistant" })).toBeTruthy();
    expect(screen.getByLabelText("API key")).toHaveProperty("type", "password");
    expect(screen.getByText(/A capability only controls routing/)).toBeTruthy();
    expect(screen.getByText(/Cost unavailable/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Get a OpenAI key" })).toBeTruthy();
  });

  it("reloads usage when refreshToken changes", async () => {
    const api = client();
    const { rerender } = render(<AIConnectionsSettings client={api} refreshToken={0} />);
    expect(await screen.findByRole("heading", { name: "Garage Assistant" })).toBeTruthy();
    expect(api.getUsage).toHaveBeenCalledTimes(1);
    rerender(<AIConnectionsSettings client={api} refreshToken={1} />);
    await waitFor(() => expect(api.getUsage).toHaveBeenCalledTimes(2));
  });
});
