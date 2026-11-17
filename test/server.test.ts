import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inputNames, opencodeConfig, parseAgentEvent } from "../src/server/task.ts";
import { runArgs } from "../src/server/docker.ts";
import { ENV, IMAGES } from "../src/shared/constants.ts";

describe("agent container", () => {
  test("is hardened and gets secrets by name only", () => {
    const args = runArgs({
      name: "n",
      image: IMAGES.agent,
      network: "none",
      mounts: [{ host: "/h/in", container: "/in", readOnly: true }],
      env: { [ENV.jobToken]: "secret" },
      runtime: "runc",
      timeoutMs: 1,
    });
    const s = args.join(" ");
    for (const f of [
      "--read-only",
      "--tmpfs /tmp",
      "--memory 4g",
      "--pids-limit 256",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--runtime runc",
    ])
      assert.ok(s.includes(f), f);
    assert.ok(s.includes("type=bind,source=/h/in,target=/in,readonly"));
    assert.ok(args.includes(ENV.jobToken));
    assert.ok(!s.includes("secret"));
  });

  test("OpenCode talks only to the broker, text-only, with the token from env", () => {
    const cfg = JSON.parse(opencodeConfig("deepseek-v4.1-flash", "http://broker:7700"));
    assert.equal(cfg.model, "broker/deepseek-v4.1-flash");
    assert.deepEqual(cfg.provider.broker.options, {
      baseURL: "http://broker:7700/llm/v1",
      apiKey: `{env:${ENV.jobToken}}`,
    });
    assert.deepEqual(cfg.provider.broker.models["deepseek-v4.1-flash"].modalities, {
      input: ["text"],
      output: ["text"],
    });
    assert.equal(cfg.mcp.docreader.url, "http://broker:7700/mcp");
  });
});

describe("file names", () => {
  test("any name becomes a safe, unique name", () => {
    assert.deepEqual(inputNames(["/a/Par\u00e1metros 2025.xlsx", "/b/report.pdf", "/c/report.pdf", "/d/.hidden"]), [
      "Parametros_2025.xlsx",
      "report.pdf",
      "report-2.pdf",
      "hidden",
    ]);
  });
});

const line = (o: object) => JSON.stringify({ timestamp: 1, sessionID: "s", ...o });

describe("agent events", () => {
  test("OpenCode JSON lines become simple events", () => {
    assert.deepEqual(parseAgentEvent(line({ type: "reasoning", part: { text: "look at the sheet" } })), {
      kind: "thinking",
      at: 1,
      text: "look at the sheet",
    });
    assert.deepEqual(parseAgentEvent(line({ type: "text", part: { text: "Done." } })), {
      kind: "text",
      at: 1,
      text: "Done.",
    });
    assert.deepEqual(
      parseAgentEvent(
        line({
          type: "tool_use",
          part: {
            tool: "shell",
            state: {
              status: "completed",
              title: "shell",
              input: { command: "ls /in" },
              output: "a.pdf",
              time: { start: 10, end: 25 },
            },
          },
        }),
      ),
      {
        kind: "tool",
        at: 1,
        tool: "shell",
        title: "shell",
        status: "completed",
        input: '{\n "command": "ls /in"\n}',
        output: "a.pdf",
        durationMs: 15,
      },
    );
    assert.deepEqual(
      parseAgentEvent(
        line({ type: "step_finish", part: { tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3 } } } }),
      ),
      {
        kind: "step",
        at: 1,
        tokens: { input: 5, output: 2, reasoning: 1, cacheRead: 3 },
      },
    );
    assert.equal(parseAgentEvent(line({ type: "error", error: { message: "boom" } }))?.kind, "error");
  });
  test("other lines are ignored; long outputs are cut", () => {
    assert.equal(parseAgentEvent("not json"), undefined);
    assert.equal(parseAgentEvent(line({ type: "step_start", part: {} })), undefined);
    const e = parseAgentEvent(
      line({ type: "tool_use", part: { tool: "read", state: { input: {}, output: "x".repeat(10_000) } } }),
    );
    assert.ok(e?.kind === "tool" && e.output.length < 4100 && e.output.endsWith("more characters)"));
  });
});
