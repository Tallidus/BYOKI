import type { Scope } from "@byoki/core";
import { getServices } from "./services";

const SAMPLE_KEY = "demo-mock-key";
const SAMPLE_PROVIDER = "openai";
const SAMPLE_MODEL = "gpt-5.6-terra";

/** Saves a mock OpenAI connection for one visitor. The key is fixed and is not read from the request. */
export async function connectSample(scope: Scope): Promise<void> {
  const { handlers } = getServices();
  const auth = {
    scope,
    csrfHeader: "sample",
    expectedCsrf: "sample",
    origin: null,
    host: null,
  };
  const saved = await handlers.putConnection(
    auth,
    SAMPLE_PROVIDER,
    new Request("https://byoki.eastonnielson.dev/api/ai/connections/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: SAMPLE_KEY }),
    }),
  );
  if (!saved.ok) {
    const body = (await saved.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "The sample key could not be saved.");
  }
  const selected = await handlers.putSelection(
    auth,
    "chat",
    new Request("https://byoki.eastonnielson.dev/api/ai/selections/chat", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: SAMPLE_PROVIDER, modelId: SAMPLE_MODEL }),
    }),
  );
  if (!selected.ok) {
    const body = (await selected.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "The sample model could not be saved.");
  }
}
