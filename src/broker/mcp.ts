// MCP tool server at /mcp (spec section 7.3). Stateless: one server and transport per request.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { BudgetError, type JobRegistry, type JobState, type Prices } from "./budget.ts";
import { AGENT_PATHS, APP_VERSION, BROKER, MAX_PAGES_PER_TOOL_CALL, TOOLS } from "../shared/constants.ts";
import {
  describeFigure,
  ocrPages,
  parseLayout,
  type GoogleClients,
  type GoogleConfig,
  type ToolContext,
} from "./tools.ts";

export interface McpDeps {
  registry: JobRegistry;
  prices: Prices;
  jobsDir: string;
  cacheDir: string;
  google?: GoogleConfig;
  clients?: Partial<GoogleClients>;
}

const per1000 = (usd: number | undefined) =>
  `$${((usd ?? 0) * 1000).toFixed(2)} per 1,000 pages ($${(usd ?? 0).toFixed(4)} per page)`;

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function refused(e: unknown) {
  const message = e instanceof BudgetError ? `${e.code}: ${e.message}` : `error: ${(e as Error).message}`;
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: BROKER.containerName, version: APP_VERSION });
  const p = ctx.prices.tools;
  const doc = z.string().describe("Document file name as in /in, for example contract.pdf");
  const pages = z
    .array(z.number().int().min(1))
    .min(1)
    .max(MAX_PAGES_PER_TOOL_CALL)
    .describe(`1-based page numbers, at most ${MAX_PAGES_PER_TOOL_CALL}`);

  server.registerTool(
    TOOLS.ocr,
    {
      title: "OCR PDF pages (paid)",
      description: [
        `Google Document AI Enterprise OCR on chosen pages of a PDF, or on an image file (one page). Price: ${per1000(p[TOOLS.ocr]?.perPage)}. Cached pages are free.`,
        "Use it for scanned pages or pages whose text layer is missing or broken (pdftotext gives little or garbled text).",
        `Writes ${AGENT_PATHS.enriched}/<doc>/ocr/NNNN.txt and NNNN.json (confidence).`,
      ].join(" "),
      inputSchema: { doc, pages },
    },
    async (args) => {
      try {
        return ok(await ocrPages(ctx, args));
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool(
    TOOLS.layout,
    {
      title: "Parse tables and layout (paid)",
      description: [
        `Google Document AI Layout Parser on chosen pages of a PDF, or on an image file (one page). Price: ${per1000(p[TOOLS.layout]?.perPage)}. Cached pages are free.`,
        "Use it for tables that are hard to read from plain text: scrambled columns, merged cells, or tables on scanned pages (it does OCR too).",
        `Writes ${AGENT_PATHS.enriched}/<doc>/layout/NNNN.md, NNNN.tables/t1.csv and NNNN.figures.json.`,
      ].join(" "),
      inputSchema: { doc, pages },
    },
    async (args) => {
      try {
        return ok(await parseLayout(ctx, args));
      } catch (e) {
        return refused(e);
      }
    },
  );

  const fig = p[TOOLS.figure];
  server.registerTool(
    TOOLS.figure,
    {
      title: "Read a chart or picture (paid)",
      description: [
        "Gemini vision answers one precise question about a picture: a PDF page (give doc and page) or an image you made (give image).",
        `Price: about $${(fig?.estimatePerCall ?? 0.01).toFixed(4)} per call; it takes seconds.`,
        "Use it early for any chart, diagram or picture. It is much faster than rebuilding values from SVG paths or pixel colors.",
        `If a page holds many charts or is very tall, crop the one you need into an image under ${AGENT_PATHS.output} (pdftoppm -x -y -W -H, or Pillow) and pass that path as image.`,
        "The answer is a model reading of pixels: say so in your answer.",
      ].join(" "),
      inputSchema: {
        doc: doc.optional(),
        page: z.number().int().min(1).optional().describe("1-based page number, with doc"),
        image: z
          .string()
          .optional()
          .describe(
            `Path of a PNG, JPEG or WebP image under ${AGENT_PATHS.output}, for example ${AGENT_PATHS.output}/chart.png`,
          ),
        question: z
          .string()
          .min(1)
          .max(1000)
          .describe("A precise question, for example: What is the 2024 value of the blue bar labelled Revenue?"),
      },
    },
    async (args) => {
      try {
        return ok(await describeFigure(ctx, args));
      } catch (e) {
        return refused(e);
      }
    },
  );

  server.registerTool(
    TOOLS.budget,
    {
      title: "Budget status (free)",
      description:
        "Shows the job budget, the money spent so far (LLM and tools) and the money left. Free. Call it before a large tool call.",
      inputSchema: {},
    },
    async () => {
      const s = ctx.registry.summary(ctx.job);
      return ok({
        budgetUsd: s.budgetUsd,
        spentUsd: s.spentUsd,
        leftUsd: s.leftUsd,
        llmUsd: s.llmUsd,
        toolsUsd: s.toolsUsd,
        allowCloudTools: s.allowCloudTools,
        toolCalls: s.calls
          .filter((c) => c.kind === "tool")
          .map((c) => ({ tool: c.tool, doc: c.doc, pages: c.pages, usd: c.usd, cacheHit: c.cacheHit, error: c.error })),
        llmCalls: s.calls.filter((c) => c.kind === "llm").length,
      });
    },
  );
  return server;
}

export function createMcpHandler(deps: McpDeps) {
  return async (job: JobState, req: Request): Promise<Response> => {
    const ctx: ToolContext = {
      job,
      registry: deps.registry,
      prices: deps.prices,
      jobsDir: deps.jobsDir,
      cacheDir: deps.cacheDir,
      google: deps.google,
      clients: deps.clients,
    };
    const server = buildServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    void server.close();
    return res;
  };
}
