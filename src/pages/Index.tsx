import { useState, useRef, useEffect, useCallback } from "react";
import Icon from "@/components/ui/icon";

type MessageRole = "user" | "agent";

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  files?: string[];
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
}

interface ApiConnection {
  id: string;
  name: string;
  icon: string;
  connected: boolean;
  description: string;
}

const INITIAL_APIS: ApiConnection[] = [
  { id: "openai", name: "OpenAI", icon: "Sparkles", connected: false, description: "GPT-4, DALL·E, Whisper" },
  { id: "google", name: "Google Sheets", icon: "Table", connected: false, description: "Чтение и запись таблиц" },
  { id: "notion", name: "Notion", icon: "FileText", connected: false, description: "База знаний и страницы" },
  { id: "telegram", name: "Telegram Bot", icon: "Send", connected: false, description: "Уведомления и боты" },
  { id: "airtable", name: "Airtable", icon: "Database", connected: false, description: "Структурированные данные" },
  { id: "webhook", name: "Webhook", icon: "Globe", connected: false, description: "Произвольный HTTP-запрос" },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1 py-2">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-[blink_1.2s_0s_infinite]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-[blink_1.2s_0.2s_infinite]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-[blink_1.2s_0.4s_infinite]" />
    </div>
  );
}

type Tab = "chat" | "files" | "api";

export default function Index() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "0",
      role: "agent",
      content: "Привет. Я готов к работе. Загрузите файлы для анализа или подключите внешние API — и мы начнём.",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [apis, setApis] = useState<ApiConnection[]>(INITIAL_APIS);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const sendMessage = useCallback((text: string, fileNames?: string[]) => {
    if (!text.trim() && !fileNames?.length) return;
    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: text,
      timestamp: new Date(),
      files: fileNames,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    setTimeout(() => {
      const response = fileNames?.length
        ? "Файл получен. Начинаю анализ структуры данных."
        : "Понял. Анализирую запрос и формирую ответ на основе доступных данных.";
      const agentMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "agent",
        content: response,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, agentMsg]);
      setIsTyping(false);
    }, 1400);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleFileChange = (fileList: FileList | null) => {
    if (!fileList) return;
    const newFiles: UploadedFile[] = Array.from(fileList).map((f) => ({
      id: Date.now().toString() + Math.random(),
      name: f.name,
      size: f.size,
      type: f.type,
    }));
    setFiles((prev) => [...prev, ...newFiles]);
    const names = newFiles.map((f) => f.name);
    sendMessage(
      `Загружен${newFiles.length > 1 ? "о" : ""} ${newFiles.length} файл${newFiles.length > 1 ? "а" : ""}: ${names.join(", ")}`,
      names
    );
    setActiveTab("chat");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileChange(e.dataTransfer.files);
  };

  const toggleApi = (id: string) => {
    setApis((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        const next = { ...a, connected: !a.connected };
        if (next.connected) {
          sendMessage(`Подключён API: ${a.name}`);
          setActiveTab("chat");
        }
        return next;
      })
    );
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "chat", label: "Чат", icon: "MessageSquare" },
    { id: "files", label: "Файлы", icon: "Paperclip" },
    { id: "api", label: "API", icon: "Zap" },
  ];

  return (
    <div className="h-screen flex flex-col bg-background font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-5 h-14 border-b border-border bg-white/80 backdrop-blur-sm shrink-0 z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
          >
            <Icon
              name={sidebarOpen ? "PanelLeftClose" : "PanelLeft"}
              size={16}
              className="text-muted-foreground"
            />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-foreground flex items-center justify-center">
              <Icon name="Bot" size={14} className="text-background" />
            </div>
            <span className="text-sm font-medium tracking-tight">Агент</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="text-xs text-muted-foreground">Онлайн</span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="w-52 border-r border-border bg-white shrink-0 flex flex-col animate-slide-in">
            <nav className="p-3 flex flex-col gap-0.5">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors w-full text-left ${
                    activeTab === tab.id
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  <Icon name={tab.icon} size={15} />
                  {tab.label}
                  {tab.id === "files" && files.length > 0 && (
                    <span className="ml-auto text-[10px] bg-foreground text-background rounded-full px-1.5 py-0.5 font-mono">
                      {files.length}
                    </span>
                  )}
                  {tab.id === "api" && apis.filter((a) => a.connected).length > 0 && (
                    <span className="ml-auto text-[10px] bg-emerald-500 text-white rounded-full px-1.5 py-0.5 font-mono">
                      {apis.filter((a) => a.connected).length}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="mt-auto p-3 border-t border-border">
              <div className="text-[11px] text-muted-foreground/50 font-mono">v1.0.0</div>
            </div>
          </aside>
        )}

        {/* Main */}
        <main className="flex-1 flex flex-col overflow-hidden">

          {/* Chat tab */}
          {activeTab === "chat" && (
            <>
              <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
                {messages.map((msg, i) => (
                  <div
                    key={msg.id}
                    className="flex gap-3 animate-fade-in"
                    style={{ animationDelay: `${i * 0.03}s` }}
                  >
                    <div
                      className={`w-7 h-7 rounded-lg shrink-0 flex items-center justify-center mt-0.5 ${
                        msg.role === "agent"
                          ? "bg-foreground"
                          : "bg-muted border border-border"
                      }`}
                    >
                      <Icon
                        name={msg.role === "agent" ? "Bot" : "User"}
                        size={13}
                        className={msg.role === "agent" ? "text-background" : "text-muted-foreground"}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1.5">
                        <span className="text-xs font-medium">
                          {msg.role === "agent" ? "Агент" : "Вы"}
                        </span>
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {msg.timestamp.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed text-foreground">{msg.content}</p>
                      {msg.files && msg.files.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {msg.files.map((f) => (
                            <span
                              key={f}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-xs font-mono text-muted-foreground"
                            >
                              <Icon name="File" size={11} />
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isTyping && (
                  <div className="flex gap-3 animate-fade-in">
                    <div className="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center mt-0.5 bg-foreground">
                      <Icon name="Bot" size={13} className="text-background" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="mb-1">
                        <span className="text-xs font-medium">Агент</span>
                      </div>
                      <TypingIndicator />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-border bg-white px-5 py-4">
                <form onSubmit={handleSubmit} className="flex gap-2 items-end">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-9 h-9 flex items-center justify-center rounded-lg border border-border hover:bg-muted transition-colors shrink-0 mb-0.5"
                    title="Загрузить файл"
                  >
                    <Icon name="Paperclip" size={15} className="text-muted-foreground" />
                  </button>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Введите запрос..."
                    rows={1}
                    className="flex-1 resize-none bg-muted rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-foreground/10 transition-all placeholder:text-muted-foreground/50 min-h-[38px] max-h-32"
                    style={{ lineHeight: "1.5" }}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    className="w-9 h-9 flex items-center justify-center rounded-lg bg-foreground text-background hover:bg-foreground/80 transition-colors disabled:opacity-30 shrink-0 mb-0.5"
                  >
                    <Icon name="ArrowUp" size={15} />
                  </button>
                </form>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileChange(e.target.files)}
                />
              </div>
            </>
          )}

          {/* Files tab */}
          {activeTab === "files" && (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-lg">
                <h2 className="text-sm font-medium mb-1">Файлы и данные</h2>
                <p className="text-xs text-muted-foreground mb-5">Загрузите файлы для анализа агентом</p>

                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer transition-all ${
                    isDragging
                      ? "border-foreground bg-muted/60"
                      : "border-border hover:border-foreground/30 hover:bg-muted/30"
                  }`}
                >
                  <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                    <Icon name="Upload" size={18} className="text-muted-foreground" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium">Перетащите файлы сюда</p>
                    <p className="text-xs text-muted-foreground mt-0.5">или нажмите для выбора</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 justify-center">
                    {["CSV", "JSON", "XLSX", "PDF", "TXT"].map((ext) => (
                      <span key={ext} className="px-2 py-0.5 rounded-md bg-muted text-[11px] font-mono text-muted-foreground">
                        {ext}
                      </span>
                    ))}
                  </div>
                </div>

                {files.length > 0 && (
                  <div className="mt-5 space-y-2">
                    <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider mb-3">
                      Загружено ({files.length})
                    </p>
                    {files.map((f) => (
                      <div
                        key={f.id}
                        className="flex items-center gap-3 p-3 rounded-xl bg-white border border-border group animate-fade-in"
                      >
                        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                          <Icon name="File" size={14} className="text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{f.name}</p>
                          <p className="text-[11px] text-muted-foreground font-mono">{formatBytes(f.size)}</p>
                        </div>
                        <button
                          onClick={() => removeFile(f.id)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Icon name="X" size={13} className="text-muted-foreground" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileChange(e.target.files)}
                />
              </div>
            </div>
          )}

          {/* API tab */}
          {activeTab === "api" && (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-lg">
                <h2 className="text-sm font-medium mb-1">Внешние API</h2>
                <p className="text-xs text-muted-foreground mb-5">Подключите сервисы для получения данных</p>
                <div className="space-y-2">
                  {apis.map((api, i) => (
                    <div
                      key={api.id}
                      className="flex items-center gap-4 p-4 rounded-xl bg-white border border-border animate-fade-in"
                      style={{ animationDelay: `${i * 0.05}s` }}
                    >
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                          api.connected ? "bg-foreground" : "bg-muted"
                        }`}
                      >
                        <Icon
                          name={api.icon}
                          size={16}
                          className={api.connected ? "text-background" : "text-muted-foreground"}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{api.name}</p>
                        <p className="text-xs text-muted-foreground">{api.description}</p>
                      </div>
                      <button
                        onClick={() => toggleApi(api.id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          api.connected
                            ? "bg-muted text-muted-foreground hover:bg-muted/80"
                            : "bg-foreground text-background hover:bg-foreground/80"
                        }`}
                      >
                        {api.connected ? "Отключить" : "Подключить"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
