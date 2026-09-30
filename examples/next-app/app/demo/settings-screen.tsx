"use client";

import { useMemo } from "react";
import { AIConnectionsSettings, createConnectionsClient } from "@byoki/react";

export function SettingsScreen({ csrfToken }: { csrfToken: string }) {
  const client = useMemo(() => createConnectionsClient({ baseUrl: "/api/ai", csrfToken }), [csrfToken]);
  return <AIConnectionsSettings client={client} />;
}
