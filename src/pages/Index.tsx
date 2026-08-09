import { useState, useRef, useEffect } from "react";
import Icon from "@/components/ui/icon";

const SEO_AUDIT_URL = "https://functions.poehali.dev/9a197765-2fec-4128-9ac3-c3ca4c59de1b";
const SEO_FIX_URL = "https://functions.poehali.dev/86e7b82e-7c9f-4d69-bff2-a122974a40b0";
const SEO_HISTORY_URL = "https://functions.poehali.dev/f0013ee2-1706-4c7a-b43b-ade1f5f53e43";

type CheckStatus = "ok" | "warning" | "error";

interface Check {
  category: string;
  id: string;
  status: CheckStatus;
  title: string;
  message: string;
  weight: number;
  fixable?: boolean;
}

interface Performance {
  score: number | null;
  lcp: string | null;
  cls: string | null;
  fcp: string | null;
  tbt: string | null;
}

interface AuditResult {
  audit_id: number | null;
  url: string;
  score: number;
  checks: Check[];
  performance: Performance | null;
  ai_recommendations: string | null;
  wp_available: boolean;
  checked_at: number;
}

interface HistoryAudit {
  id: number;
  url: string;
  score: number;
  wp_available: boolean;
  checked_at: string;
  fixes_count: number;
}

interface HistoryFix {
  id: number;
  check_id: string;
  fix_type: string;
  old_value: string;
  new_value: string;
  status: string;
  message: string;
  applied_at: string;
}

type FixState = "idle" | "applying" | "done" | "failed";

const STATUS_CONFIG: Record<CheckStatus, { icon: string; color: string; bg: string }> = {
  ok: { icon: "CheckCircle2", color: "text-emerald-600", bg: "bg-emerald-50" },
  warning: { icon: "AlertTriangle", color: "text-amber-600", bg: "bg-amber-50" },
  error: { icon: "XCircle", color: "text-red-600", bg: "bg-red-50" },
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

function formatDate(iso: string | number) {
  const d = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
  return d.toLocaleString("ru", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
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

type View = "audit" | "history";

export default function Index() {
  const [view, setView] = useState<View>("audit");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [filter, setFilter] = useState<"all" | CheckStatus>("all");
  const [fixStates, setFixStates] = useState<Record<string, FixState>>({});
  const [fixMessages, setFixMessages] = useState<Record<string, string>>({});

  const [historyAudits, setHistoryAudits] = useState<HistoryAudit[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedAuditId, setExpandedAuditId] = useState<number | null>(null);
  const [auditFixes, setAuditFixes] = useState<Record<number, HistoryFix[]>>({});

  const inputRef = useRef<HTMLInputElement>(null);

  const runAudit = async (e?: React.FormEvent, overrideUrl?: string) => {
    e?.preventDefault();
    const target = (overrideUrl ?? url).trim();
    if (!target || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setFixStates({});
    setFixMessages({});
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
      }
    } catch {
      setError("Не удалось выполнить проверку. Проверьте адрес сайта и попробуйте снова.");
    } finally {
      setLoading(false);
    }
  };

  const applyFix = async (check: Check) => {
    if (!result?.audit_id) return;
    setFixStates((prev) => ({ ...prev, [check.id]: "applying" }));
    try {
      // Для alt-текстов на страницах с большим количеством изображений
      // фикс применяется пачками (иначе функция не укладывается в таймаут),
      // поэтому дозапрашиваем оставшиеся картинки, пока не будет done: true.
      let offset = 0;
      let lastMessage = "";
      let anySuccess = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch(SEO_FIX_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audit_id: result.audit_id,
            check_id: check.id,
            ...(check.id === "alt" ? { image_offset: offset, image_limit: 6 } : {}),
          }),
        });
        const data = await res.json();
        if (!data.success && !data.done) {
          setFixStates((prev) => ({ ...prev, [check.id]: "failed" }));
          setFixMessages((prev) => ({ ...prev, [check.id]: data.error || data.message || "Не удалось исправить" }));
          return;
        }
        anySuccess = anySuccess || data.success;
        lastMessage = data.message || "Исправлено";
        if (check.id !== "alt" || data.done || !data.next_offset) break;
        offset = data.next_offset;
      }
      setFixStates((prev) => ({ ...prev, [check.id]: anySuccess ? "done" : "failed" }));
      setFixMessages((prev) => ({ ...prev, [check.id]: lastMessage }));
    } catch {
      setFixStates((prev) => ({ ...prev, [check.id]: "failed" }));
      setFixMessages((prev) => ({ ...prev, [check.id]: "Ошибка соединения" }));
    }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch(SEO_HISTORY_URL);
      const data = await res.json();
      setHistoryAudits(data.audits || []);
    } catch {
      setHistoryAudits([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadAuditFixes = async (auditId: number) => {
    if (auditFixes[auditId]) {
      setExpandedAuditId(expandedAuditId === auditId ? null : auditId);
      return;
    }
    try {
      const res = await fetch(`${SEO_HISTORY_URL}?audit_id=${auditId}`);
      const data = await res.json();
      setAuditFixes((prev) => ({ ...prev, [auditId]: data.fixes || [] }));
      setExpandedAuditId(auditId);
    } catch {
      setAuditFixes((prev) => ({ ...prev, [auditId]: [] }));
      setExpandedAuditId(auditId);
    }
  };

  useEffect(() => {
    if (view === "history") loadHistory();
  }, [view]);

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
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView("audit")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              view === "audit" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon name="SearchCheck" size={13} />
            Проверка
          </button>
          <button
            onClick={() => setView("history")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              view === "history" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon name="History" size={13} />
            История
          </button>
          {view === "audit" && result && (
            <button
              onClick={() => { setResult(null); setUrl(""); setError(null); inputRef.current?.focus(); }}
              className="ml-2 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
            >
              <Icon name="Plus" size={13} />
              Новая
            </button>
          )}
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* AUDIT VIEW */}
        {view === "audit" && (
          <>
            {!result && !loading && (
              <div className="animate-fade-in">
                <h1 className="text-2xl font-medium tracking-tight mb-2">Технический SEO-аудит сайта</h1>
                <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
                  Проверю мета-теги, заголовки, robots.txt, sitemap.xml, HTTPS, скорость загрузки,
                  structured data и битые ссылки — и смогу сразу исправить найденные проблемы на сайте WordPress.
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

                <div className="mt-10 grid grid-cols-3 gap-3">
                  {[
                    { icon: "Tags", label: "Мета-теги и заголовки" },
                    { icon: "Gauge", label: "Скорость и Core Web Vitals" },
                    { icon: "Wand2", label: "Исправление одним кликом" },
                  ].map((f) => (
                    <div key={f.label} className="p-4 rounded-xl bg-white border border-border">
                      <Icon name={f.icon} size={16} className="text-muted-foreground mb-2" />
                      <p className="text-xs text-muted-foreground leading-snug">{f.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {loading && (
              <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
                <div className="w-10 h-10 rounded-full border-2 border-muted border-t-foreground animate-spin mb-4" />
                <p className="text-sm text-muted-foreground">Сканирую {url}...</p>
              </div>
            )}

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

                {!result.wp_available && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2.5">
                    <Icon name="Info" size={13} />
                    Автоисправление недоступно: доступ к WordPress не настроен или страница не распознана
                  </div>
                )}

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
                          const fixState = fixStates[check.id] ?? "idle";
                          const fixMsg = fixMessages[check.id];
                          return (
                            <div key={check.id} className="flex items-start gap-3 p-4">
                              <div className={`w-6 h-6 rounded-md ${cfg.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                                <Icon name={cfg.icon} size={13} className={cfg.color} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium">{check.title}</p>
                                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{check.message}</p>
                                {fixMsg && (
                                  <p className={`text-xs mt-1.5 flex items-center gap-1 ${fixState === "done" ? "text-emerald-600" : "text-red-600"}`}>
                                    <Icon name={fixState === "done" ? "CheckCircle2" : "AlertCircle"} size={11} />
                                    {fixMsg}
                                  </p>
                                )}
                              </div>
                              {check.fixable && fixState !== "done" && (
                                <button
                                  onClick={() => applyFix(check)}
                                  disabled={fixState === "applying"}
                                  className="shrink-0 px-3 py-1.5 rounded-lg bg-foreground text-background text-xs font-medium hover:bg-foreground/80 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                                >
                                  {fixState === "applying" ? (
                                    <>
                                      <div className="w-3 h-3 rounded-full border-2 border-background/30 border-t-background animate-spin" />
                                      Чиню...
                                    </>
                                  ) : (
                                    <>
                                      <Icon name="Wand2" size={12} />
                                      Исправить
                                    </>
                                  )}
                                </button>
                              )}
                              {fixState === "done" && (
                                <span className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-600 text-xs font-medium flex items-center gap-1.5">
                                  <Icon name="Check" size={12} />
                                  Готово
                                </span>
                              )}
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
          </>
        )}

        {/* HISTORY VIEW */}
        {view === "history" && (
          <div className="animate-fade-in">
            <h1 className="text-2xl font-medium tracking-tight mb-2">История проверок</h1>
            <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
              Все выполненные проверки и внесённые автоматические исправления.
            </p>

            {historyLoading && (
              <div className="flex justify-center py-16">
                <div className="w-8 h-8 rounded-full border-2 border-muted border-t-foreground animate-spin" />
              </div>
            )}

            {!historyLoading && historyAudits.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-16">Проверок пока не было</p>
            )}

            <div className="space-y-2">
              {historyAudits.map((a) => (
                <div key={a.id} className="bg-white border border-border rounded-xl overflow-hidden">
                  <button
                    onClick={() => loadAuditFixes(a.id)}
                    className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
                  >
                    <span className={`text-sm font-semibold font-mono w-8 shrink-0 ${scoreColor(a.score)}`}>{a.score}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{a.url}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">{formatDate(a.checked_at)}</p>
                    </div>
                    {a.fixes_count > 0 && (
                      <span className="text-[11px] bg-emerald-50 text-emerald-600 rounded-full px-2 py-0.5 font-mono shrink-0">
                        {a.fixes_count} исправлено
                      </span>
                    )}
                    <Icon
                      name="ChevronDown"
                      size={14}
                      className={`text-muted-foreground shrink-0 transition-transform ${expandedAuditId === a.id ? "rotate-180" : ""}`}
                    />
                  </button>
                  {expandedAuditId === a.id && (
                    <div className="border-t border-border bg-muted/20 p-4 animate-fade-in">
                      {(auditFixes[a.id]?.length ?? 0) === 0 ? (
                        <p className="text-xs text-muted-foreground">Исправлений по этой проверке не было</p>
                      ) : (
                        <div className="space-y-2">
                          {auditFixes[a.id].map((f) => (
                            <div key={f.id} className="flex items-start gap-2.5 text-xs">
                              <Icon
                                name={f.status === "success" ? "CheckCircle2" : "XCircle"}
                                size={13}
                                className={f.status === "success" ? "text-emerald-600 mt-0.5 shrink-0" : "text-red-600 mt-0.5 shrink-0"}
                              />
                              <div className="min-w-0">
                                <p className="font-medium">{f.check_id} · {formatDate(f.applied_at)}</p>
                                <p className="text-muted-foreground mt-0.5">{f.message}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}