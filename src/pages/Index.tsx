import { useState, useRef } from "react";
import Icon from "@/components/ui/icon";

const SEO_AUDIT_URL = "https://functions.poehali.dev/9a197765-2fec-4128-9ac3-c3ca4c59de1b";

type CheckStatus = "ok" | "warning" | "error";

interface Check {
  category: string;
  id: string;
  status: CheckStatus;
  title: string;
  message: string;
  weight: number;
}

interface Performance {
  score: number | null;
  lcp: string | null;
  cls: string | null;
  fcp: string | null;
  tbt: string | null;
}

interface AuditResult {
  url: string;
  score: number;
  checks: Check[];
  performance: Performance | null;
  ai_recommendations: string | null;
  checked_at: number;
}

interface HistoryItem {
  url: string;
  score: number;
  checked_at: number;
}

const STATUS_CONFIG: Record<CheckStatus, { icon: string; color: string; bg: string; label: string }> = {
  ok: { icon: "CheckCircle2", color: "text-emerald-600", bg: "bg-emerald-50", label: "ОК" },
  warning: { icon: "AlertTriangle", color: "text-amber-600", bg: "bg-amber-50", label: "Внимание" },
  error: { icon: "XCircle", color: "text-red-600", bg: "bg-red-50", label: "Проблема" },
};

function scoreColor(score: number) {
  if (score >= 80) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function scoreRing(score: number) {
  if (score >= 80) return "stroke-emerald-500";
  if (score >= 50) return "stroke-amber-500";
  return "stroke-red-500";
}

function ScoreRing({ score }: { score: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg className="w-28 h-28 -rotate-90" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={radius} fill="none" stroke="currentColor" strokeWidth="7" className="text-muted" />
        <circle
          cx="48"
          cy="48"
          r={radius}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`${scoreRing(score)} transition-all duration-1000 ease-out`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-semibold ${scoreColor(score)}`}>{score}</span>
        <span className="text-[10px] text-muted-foreground font-mono">/ 100</span>
      </div>
    </div>
  );
}

export default function Index() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [filter, setFilter] = useState<"all" | CheckStatus>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  const runAudit = async (e?: React.FormEvent, overrideUrl?: string) => {
    e?.preventDefault();
    const target = (overrideUrl ?? url).trim();
    if (!target || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(SEO_AUDIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
        setHistory((prev) => [
          { url: data.url, score: data.score, checked_at: data.checked_at },
          ...prev.filter((h) => h.url !== data.url),
        ].slice(0, 8));
      }
    } catch {
      setError("Не удалось выполнить проверку. Проверьте адрес сайта и попробуйте снова.");
    } finally {
      setLoading(false);
    }
  };

  const filteredChecks = result?.checks.filter((c) => filter === "all" || c.status === filter) ?? [];

  const counts = result
    ? {
        ok: result.checks.filter((c) => c.status === "ok").length,
        warning: result.checks.filter((c) => c.status === "warning").length,
        error: result.checks.filter((c) => c.status === "error").length,
      }
    : { ok: 0, warning: 0, error: 0 };

  const grouped = filteredChecks.reduce<Record<string, Check[]>>((acc, c) => {
    (acc[c.category] ||= []).push(c);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-background font-sans">
      {/* Header */}
      <header className="flex items-center justify-between px-6 h-14 border-b border-border bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-foreground flex items-center justify-center">
            <Icon name="SearchCheck" size={14} className="text-background" />
          </div>
          <span className="text-sm font-medium tracking-tight">SEO Аудит</span>
        </div>
        {result && (
          <button
            onClick={() => { setResult(null); setUrl(""); setError(null); inputRef.current?.focus(); }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
          >
            <Icon name="Plus" size={13} />
            Новая проверка
          </button>
        )}
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Hero / input */}
        {!result && !loading && (
          <div className="animate-fade-in">
            <h1 className="text-2xl font-medium tracking-tight mb-2">Технический SEO-аудит сайта</h1>
            <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
              Проверю мета-теги, заголовки, robots.txt, sitemap.xml, HTTPS, скорость загрузки,
              structured data и битые ссылки — и дам рекомендации по исправлению.
            </p>

            <form onSubmit={runAudit} className="flex gap-2">
              <div className="flex-1 relative">
                <Icon name="Globe" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="example.com"
                  autoFocus
                  className="w-full bg-white border border-border rounded-xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 focus:ring-foreground/10 focus:border-foreground/30 transition-all placeholder:text-muted-foreground/50"
                />
              </div>
              <button
                type="submit"
                disabled={!url.trim()}
                className="px-5 py-3 rounded-xl bg-foreground text-background text-sm font-medium hover:bg-foreground/80 transition-colors disabled:opacity-30 flex items-center gap-2 shrink-0"
              >
                Проверить
                <Icon name="ArrowRight" size={15} />
              </button>
            </form>

            {error && (
              <div className="mt-4 flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2.5 animate-fade-in">
                <Icon name="AlertCircle" size={14} />
                {error}
              </div>
            )}

            {history.length > 0 && (
              <div className="mt-10">
                <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider mb-3">
                  Недавние проверки
                </p>
                <div className="space-y-1.5">
                  {history.map((h) => (
                    <button
                      key={h.url}
                      onClick={() => { setUrl(h.url); runAuditFor(h.url); }}
                      className="w-full flex items-center gap-3 p-3 rounded-xl bg-white border border-border hover:border-foreground/20 transition-colors text-left"
                    >
                      <span className={`text-sm font-semibold font-mono w-8 shrink-0 ${scoreColor(h.score)}`}>{h.score}</span>
                      <span className="text-sm truncate flex-1">{h.url}</span>
                      <Icon name="ChevronRight" size={14} className="text-muted-foreground shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-10 grid grid-cols-3 gap-3">
              {[
                { icon: "Tags", label: "Мета-теги и заголовки" },
                { icon: "Gauge", label: "Скорость и Core Web Vitals" },
                { icon: "Link2", label: "Ссылки и индексация" },
              ].map((f) => (
                <div key={f.label} className="p-4 rounded-xl bg-white border border-border">
                  <Icon name={f.icon} size={16} className="text-muted-foreground mb-2" />
                  <p className="text-xs text-muted-foreground leading-snug">{f.label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
            <div className="w-10 h-10 rounded-full border-2 border-muted border-t-foreground animate-spin mb-4" />
            <p className="text-sm text-muted-foreground">Сканирую {url}...</p>
          </div>
        )}

        {/* Result */}
        {result && !loading && (
          <div className="animate-fade-in space-y-6">
            {/* Score card */}
            <div className="bg-white border border-border rounded-2xl p-6 flex items-center gap-6">
              <ScoreRing score={result.score} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground font-mono mb-1 truncate">{result.url}</p>
                <p className="text-base font-medium mb-3">
                  {result.score >= 80 ? "Отличный технический SEO" : result.score >= 50 ? "Есть, что улучшить" : "Требует внимания"}
                </p>
                <div className="flex items-center gap-4 text-xs">
                  <span className="flex items-center gap-1.5 text-emerald-600"><Icon name="CheckCircle2" size={13} />{counts.ok} ок</span>
                  <span className="flex items-center gap-1.5 text-amber-600"><Icon name="AlertTriangle" size={13} />{counts.warning} внимание</span>
                  <span className="flex items-center gap-1.5 text-red-600"><Icon name="XCircle" size={13} />{counts.error} проблем</span>
                </div>
              </div>
            </div>

            {/* Performance */}
            {result.performance && result.performance.score !== null && (
              <div className="bg-white border border-border rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Icon name="Gauge" size={15} className="text-muted-foreground" />
                  <span className="text-sm font-medium">Скорость загрузки (мобильные)</span>
                  <span className={`ml-auto text-lg font-semibold ${scoreColor(result.performance.score)}`}>
                    {result.performance.score}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: "LCP", value: result.performance.lcp },
                    { label: "FCP", value: result.performance.fcp },
                    { label: "CLS", value: result.performance.cls },
                    { label: "TBT", value: result.performance.tbt },
                  ].map((m) => (
                    <div key={m.label} className="text-center p-2.5 rounded-lg bg-muted">
                      <p className="text-[10px] text-muted-foreground font-mono mb-0.5">{m.label}</p>
                      <p className="text-xs font-medium">{m.value ?? "—"}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AI recommendations */}
            {result.ai_recommendations && (
              <div className="bg-white border border-border rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Icon name="Sparkles" size={15} className="text-muted-foreground" />
                  <span className="text-sm font-medium">Рекомендации ИИ</span>
                </div>
                <div className="text-sm leading-relaxed text-foreground whitespace-pre-line">
                  {result.ai_recommendations}
                </div>
              </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-1.5">
              {([
                { id: "all", label: "Все", count: result.checks.length },
                { id: "error", label: "Проблемы", count: counts.error },
                { id: "warning", label: "Внимание", count: counts.warning },
                { id: "ok", label: "ОК", count: counts.ok },
              ] as const).map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    filter === f.id ? "bg-foreground text-background" : "bg-white border border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f.label} <span className="font-mono opacity-60">{f.count}</span>
                </button>
              ))}
            </div>

            {/* Checks by category */}
            <div className="space-y-5">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider mb-2 px-1">
                    {category}
                  </p>
                  <div className="bg-white border border-border rounded-xl divide-y divide-border overflow-hidden">
                    {items.map((check) => {
                      const cfg = STATUS_CONFIG[check.status];
                      return (
                        <div key={check.id} className="flex items-start gap-3 p-4">
                          <div className={`w-6 h-6 rounded-md ${cfg.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                            <Icon name={cfg.icon} size={13} className={cfg.color} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">{check.title}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{check.message}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {filteredChecks.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">Нет проверок в этой категории</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  function runAuditFor(u: string) {
    setUrl(u);
    runAudit(undefined, u);
  }
}