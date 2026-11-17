// Money and work for one request: the model's calls and tokens, and each paid tool call. Updates live.
import type { Usage } from "../shared/types.ts";

const formatUsd = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
const formatTokens = (n: number) =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function UsagePanel({ usage, running }: { usage: Usage | null; running: boolean }) {
  if (!usage) return null;
  const total = usage.llmUsd + usage.toolsUsd;
  const { llm } = usage;
  return (
    <section className="usage">
      <header>
        <strong>Usage{running && <span className="muted"> (live)</span>}</strong>
        <span>
          {formatUsd(total)} <span className="muted">of {formatUsd(usage.budgetUsd)} budget</span>
        </span>
      </header>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Detail</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Model <code>{usage.model}</code>
            </td>
            <td>
              {llm.calls} calls &middot; {formatTokens(llm.promptTokens)} tokens in ({formatTokens(llm.cachedTokens)}{" "}
              cached) &middot; {formatTokens(llm.completionTokens)} out
            </td>
            <td className="num">{formatUsd(usage.llmUsd)}</td>
          </tr>
          {usage.toolCalls.map((t, i) => (
            <tr key={i} className={t.error ? "failed" : undefined}>
              <td>
                <code>{t.tool}</code>
              </td>
              <td>
                {t.doc}
                {t.pages?.length ? `, pages ${t.pages.join(", ")}` : ""}
                {t.durationMs !== undefined && ` \u00b7 ${(t.durationMs / 1000).toFixed(1)}s`}
                {t.cacheHit && " \u00b7 from cache"}
                {t.error && ` \u00b7 failed: ${t.error}`}
              </td>
              <td className="num">{formatUsd(t.usd)}</td>
            </tr>
          ))}
          {usage.toolCalls.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                No paid tools used.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Total</td>
            <td className="num">{formatUsd(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
