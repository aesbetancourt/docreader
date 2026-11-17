import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { JobRegistry, type Prices } from "../src/broker/budget.ts";
import { LlmProxy, SESSION_HEADER } from "../src/broker/llm.ts";
import { adminHandler, publicHandler, type BrokerDeps } from "../src/broker/server.ts";
import { BROKER, ROUTES } from "../src/shared/constants.ts";

const prices: Prices = {
  asOf: "2026-11-15",
  llm: { m1: { inputPerMTok: 1_000, outputPerMTok: 1_000, source: "test" } },
  llmDefault: { inputPerMTok: 1, outputPerMTok: 1, source: "test" },
  tools: {},
};

// Fake upstream: replies OK; reports the usage the test asks for.
let last: { headers: Headers; body: Record<string, any> } = { headers: new Headers(), body: {} };
const upstream = serve({
  port: 0,
  fetch: async (req) => {
    if (req.headers.get("authorization") !== "Bearer real-key") return new Response("bad key", { status: 401 });
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1" }] });
    last = { headers: req.headers, body: (await req.json()) as Record<string, any> };
    const usage = last.body.fakeUsage ?? { prompt_tokens: 10, completion_tokens: 2 };
    if (last.body.stream) {
      const events = [
        { choices: [{ delta: { content: "O" } }] },
        { choices: [{ delta: { content: "K" } }] },
        { choices: [], usage },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage });
  },
});
after(() => upstream.close());
const upstreamUrl = () => `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

function setup() {
  const registry = new JobRegistry(prices);
  const llm = new LlmProxy({ upstreamBaseUrl: upstreamUrl(), apiKey: "real-key", models: [] }, registry, prices);
  const deps: BrokerDeps = { registry, llm, adminToken: "admin" };
  return { registry, admin: adminHandler(deps), pub: publicHandler(deps) };
}

const adminCall = (
  h: (r: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token = "admin",
) =>
  h(
    new Request(`http://b${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

const chat = (
  h: (r: Request) => Promise<Response>,
  token: string,
  opts: { stream?: boolean; usage?: object; headers?: Record<string, string> } = {},
) =>
  h(
    new Request(`http://b${ROUTES.chatCompletions}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...opts.headers },
      body: JSON.stringify({
        model: "m1",
        stream: !!opts.stream,
        messages: [{ role: "user", content: "reply with OK" }],
        ...(opts.usage ? { fakeUsage: opts.usage } : {}),
      }),
    }),
  );

describe("broker", () => {
  test("the admin API needs the admin token", async () => {
    assert.equal((await adminCall(setup().admin, "POST", ROUTES.adminJobs, {}, "wrong")).status, 401);
  });

  test("register, call, read spend, revoke", async () => {
    const { admin, pub } = setup();
    const created = await adminCall(admin, "POST", ROUTES.adminJobs, {
      jobId: "j1",
      docs: [{ name: "c.pdf", sha256: "a".repeat(64) }],
      budgetUsd: 1,
      allowCloudTools: true,
    });
    assert.equal(created.status, 201);
    const { token } = (await created.json()) as { token: string };
    const res = await chat(pub, token);
    assert.equal(((await res.json()) as any).choices[0].message.content, "OK");
    const state = (await (await adminCall(admin, "GET", `${ROUTES.adminJobs}/j1`)).json()) as any;
    assert.equal(state.llmUsd, 0.012);
    await adminCall(admin, "DELETE", `${ROUTES.adminJobs}/j1`);
    assert.equal((await chat(pub, token)).status, 401);
  });

  test("streaming passes chunks through and records usage", async () => {
    const { registry, pub } = setup();
    const { token } = registry.create({ jobId: "j2", docs: [], budgetUsd: 1, allowCloudTools: true });
    const text = await (await chat(pub, token, { stream: true })).text();
    assert.match(text, /"content":"K"/);
    assert.deepEqual(last.body.stream_options, { include_usage: true });
    assert.equal(registry.get("j2")!.llmUsd, 0.012);
  });

  test("the upstream-reported cost wins over prices.json", async () => {
    const { registry, pub } = setup();
    const { token } = registry.create({ jobId: "j3", docs: [], budgetUsd: 1, allowCloudTools: true });
    await (
      await chat(pub, token, {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 900 },
          opencode: { list_cost: 0.0007 },
        },
      })
    ).text();
    assert.equal(registry.get("j3")!.llmUsd, 0.0007);
  });

  test("an exhausted budget returns 402", async () => {
    const { registry, pub } = setup();
    const { token } = registry.create({ jobId: "j4", docs: [], budgetUsd: 0.01, allowCloudTools: true });
    await (await chat(pub, token)).text();
    const res = await chat(pub, token);
    assert.equal(res.status, 402);
    assert.match(((await res.json()) as any).error.message, /Budget exhausted/);
  });

  test("upstream gets a stable session header and the broker user agent", async () => {
    const { registry, pub } = setup();
    const { token } = registry.create({ jobId: "j5", docs: [], budgetUsd: 1, allowCloudTools: true });
    await (await chat(pub, token)).text();
    assert.equal(last.headers.get(SESSION_HEADER), "docreader-j5");
    assert.equal(last.headers.get("user-agent"), BROKER.userAgent);
    await (await chat(pub, token, { headers: { [SESSION_HEADER]: "ses_abc123" } })).text();
    assert.equal(last.headers.get(SESSION_HEADER), "ses_abc123");
  });

  test("a wrong token returns 401", async () => {
    assert.equal((await chat(setup().pub, "nope")).status, 401);
  });
});
