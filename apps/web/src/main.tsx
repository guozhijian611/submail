import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Activity,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  FileText,
  Forward,
  Inbox,
  KeyRound,
  Languages,
  Lock,
  LogOut,
  Mail,
  MailOpen,
  MessageSquareText,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  UserPlus,
  Users,
  Wrench,
  X
} from "lucide-react";
import "./styles.css";
import { detectMailProvider, MailProviderIcon, type IncomingProtocol, type MailAuthMode } from "./mailProviders";
import { prepareEmailHtml } from "./emailHtml";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
const sessionTokenKey = "submail.sessionToken";
const invisibleHostCharacters = /[\u200B-\u200D\u2060\uFEFF]/gu;
const FlyfishAttachmentViewer = React.lazy(() => import("./FlyfishAttachmentViewer"));
const translationLanguageOptions = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"]
] as const;

function normalizeMailboxHostInput(value: unknown): string {
  return String(value ?? "").replace(invisibleHostCharacters, "").trim();
}

type Admin = {
  id: string;
  email: string;
  name: string;
};

type Session = {
  token: string;
  expiresAt: string;
};

type SetupStatus = {
  requiresSetup: boolean;
  envAdminConfigured: boolean;
  mcpApiKeyConfigured: boolean;
  databaseDriver?: "sqlite" | "mysql";
};

type Account = {
  id: string;
  email: string;
  display_name: string;
  notes: string;
  aliases: AccountAlias[];
  username: string;
  incoming_protocol: IncomingProtocol;
  auth_mode: MailAuthMode;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  sync_status: string;
  last_sync_at: string | null;
  sync_cursor_uid: number;
  sync_uid_validity: string | null;
};

type AccountAlias = {
  id: string;
  email: string;
  display_name: string;
  reply_to: string;
  send_enabled: boolean;
  verification_status: "unverified" | "pending" | "verified";
  verification_expires_at: string | null;
  verified_at: string | null;
};

type Message = {
  id: string;
  account_id: string;
  subject: string;
  sender_name: string | null;
  sender_email: string | null;
  recipients: string;
  snippet: string;
  text_body: string;
  html_body: string | null;
  sent_at: string | null;
  updated_at?: string;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_deleted: number;
  folder: string;
  remote_mailbox?: string | null;
  remote_uid_validity?: string | null;
  message_id?: string | null;
  in_reply_to?: string | null;
  reference_ids?: string;
};

type MailFolder = "INBOX" | "STARRED" | "SENT" | "DRAFTS" | "ARCHIVED" | "TRASH";

type ComposerPrefill = {
  accountId?: string;
  fromAliasId?: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
};

type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  call_count: number;
  created_at: string;
  account_ids?: string[];
  expires_at?: string | null;
  revoked_at?: string | null;
  daily_send_limit?: number;
  key?: string;
};

type AiSettings = {
  enabled: boolean;
  base_url: string;
  model: string;
  temperature: number;
  system_prompt: string;
  api_key_configured: boolean;
  updated_at: string | null;
};

type TranslationProvider = "google" | "libretranslate" | "custom";

type TranslationSettings = {
  enabled: boolean;
  provider: TranslationProvider;
  endpoint: string;
  default_target_language: string;
  auto_translate_english_on_open: boolean;
  api_key_configured: boolean;
  updated_at: string | null;
};

type AssistantResult = {
  kind: "summary" | "reply" | "translation";
  messageId: string;
  title: string;
  text: string;
};

type SettingsTab = "mail" | "integrations" | "access";
type ActiveView = "mail" | "sync" | "attachments";

type McpLog = {
  id: string;
  tool_name: string;
  input_json: string;
  status: string;
  created_at: string;
};

type Attachment = {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size: number;
  content_id: string | null;
  storage_path: string | null;
  created_at: string;
  message_subject?: string;
  sender_email?: string | null;
  sent_at?: string | null;
};

type AttachmentSettings = {
  max_size_bytes: number;
  retention_days: number;
  updated_at: string | null;
};

type EmailDisplaySettings = {
  load_external_resources_by_default: boolean;
  updated_at: string | null;
};

type AttachmentPreview = {
  attachment: Attachment;
  file?: File;
  error?: string;
};

type SearchCriteria = {
  query: string;
  sender: string;
  dateFrom: string;
  dateTo: string;
  hasAttachment: boolean;
  folder: MailFolder;
  accountId: string;
};

type SavedSearch = {
  id: string;
  name: string;
  criteria: SearchCriteria;
  created_at: string;
  updated_at: string;
};

type SyncSettings = {
  enabled: boolean;
  interval_minutes: number;
  initial_limit: number;
  retry_max_attempts: number;
  retry_delay_minutes: number;
  concurrency_limit: number;
  retention_days: number;
  last_run_at: string | null;
  next_run_at: string | null;
};

type SyncRun = {
  id: string;
  account_id: string | null;
  trigger_type: string;
  status: string;
  imported: number;
  error: string | null;
  attempts: number;
  next_retry_at: string | null;
  started_at: string;
  finished_at: string | null;
};

type State = {
  authChecked: boolean;
  setupStatus?: SetupStatus;
  admin?: Admin;
  admins: Admin[];
  accounts: Account[];
  messages: Message[];
  selectedMessageIds: string[];
  attachments: Attachment[];
  selectedAttachments: Attachment[];
  savedSearches: SavedSearch[];
  apiKeys: ApiKey[];
  mcpLogs: McpLog[];
  syncSettings?: SyncSettings;
  attachmentSettings?: AttachmentSettings;
  emailDisplaySettings?: EmailDisplaySettings;
  syncRuns: SyncRun[];
  aiSettings?: AiSettings;
  translationSettings?: TranslationSettings;
  selectedSyncRun?: SyncRun;
  selectedMessage?: Message;
  selectedThreadMessages: Message[];
  conversationMode: boolean;
  query: string;
  searchSender: string;
  searchDateFrom: string;
  searchDateTo: string;
  searchHasAttachment: boolean;
  activeSavedSearchId?: string;
  attachmentQuery: string;
  attachmentTypeFilter: string;
  syncRunStatusFilter: string;
  syncRunTriggerFilter: string;
  syncRunAccountFilter: string;
  activeView: ActiveView;
  activeFolder: MailFolder;
  inboxUnreadCount: number;
  messagePage: number;
  messagePageSize: number;
  messageTotal: number;
  attachmentPage: number;
  attachmentPageSize: number;
  attachmentTotal: number;
  syncRunPage: number;
  syncRunPageSize: number;
  syncRunTotal: number;
  selectedAccountId?: string;
  isComposerOpen: boolean;
  isAccountDialogOpen: boolean;
  isAdminDialogOpen: boolean;
  isPasswordDialogOpen: boolean;
  isSettingsOpen: boolean;
  isAdvancedSearchOpen: boolean;
  settingsTab: SettingsTab;
  isSavedSearchDialogOpen: boolean;
  resettingAdmin?: Admin;
  attachmentPreview?: AttachmentPreview;
  composerDraft?: Message;
  composerPrefill?: ComposerPrefill;
  editingAccount?: Account;
  busyText?: string;
  operationNotice?: {
    key: string;
    message: string;
    tone: "loading" | "success" | "error";
  };
  assistantBusy?: string;
  assistantError?: string;
  assistantResult?: AssistantResult;
  integrationMessage?: string;
  aiApiKeyInput: string;
  translationApiKeyInput: string;
  clearAiApiKey: boolean;
  clearTranslationApiKey: boolean;
  newApiKey?: string;
  mcpKeyName: string;
  mcpKeyScopes: string[];
  mcpKeyAllAccounts: boolean;
  mcpKeyAccountIds: string[];
  mcpKeyExpiresAt: string;
  mcpKeyDailySendLimit: number;
  mcpKeyMessage?: string;
};

function OperationToast({ notice, onClose }: {
  notice?: State["operationNotice"];
  onClose: () => void;
}) {
  if (!notice) return null;
  return (
    <div className={`operationToast ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live="polite">
      <span className="operationToastIcon">
        {notice.tone === "loading" ? <RefreshCw className="spin" size={18} /> : notice.tone === "success" ? <Check size={19} /> : <CircleAlert size={19} />}
      </span>
      <span>{notice.message}</span>
      {notice.tone !== "loading" && <button type="button" aria-label="关闭操作提示" onClick={onClose}><X size={16} /></button>}
    </div>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem(sessionTokenKey);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = `请求失败 (${response.status})`;
    try {
      const payload = JSON.parse(raw) as {
        error?: unknown;
        details?: Array<{ path?: unknown; message?: unknown }>;
        requestId?: unknown;
      };
      if (typeof payload.error === "string" && payload.error.trim()) message = payload.error;
      const details = payload.details
        ?.map((detail) => [detail.path, detail.message].filter(Boolean).join(": "))
        .filter(Boolean);
      if (details?.length) message += `：${details.join("；")}`;
      if (typeof payload.requestId === "string" && payload.requestId) message += `（请求 ${payload.requestId}）`;
    } catch {
      if (raw.trim()) message = raw.trim();
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function generateAdminPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = new Uint32Array(length);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function AuthGate({ setupStatus, onAuthed }: { setupStatus?: SetupStatus; onAuthed: (admin: Admin, session: Session) => void }) {
  const requiresSetup = Boolean(setupStatus?.requiresSetup);
  const [error, setError] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const path = requiresSetup ? "/api/setup/admin" : "/api/auth/login";
    const payload = requiresSetup
      ? {
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password")
        }
      : {
          email: form.get("email"),
          password: form.get("password")
        };
    try {
      const result = await api<{ admin: Admin; session: Session }>(path, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      localStorage.setItem(sessionTokenKey, result.session.token);
      onAuthed(result.admin, result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败");
    }
  }

  return (
    <main className="authScreen">
      <form className="authCard" onSubmit={submit}>
        <div className="brand authBrand">
          <div className="brandMark"><img src="/submail-logo.png" alt="" aria-hidden="true" /></div>
          <div>
            <strong>Submail</strong>
            <span>{requiresSetup ? "初始化管理员" : "管理员登录"}</span>
          </div>
        </div>
        {requiresSetup && <label>管理员名称<input name="name" required defaultValue="管理员" /></label>}
        <label>管理员邮箱<input name="email" type="email" required placeholder="admin@example.com" /></label>
        <label>
          <span className="authFieldHeader">
            <span>密码{requiresSetup ? "（至少 8 位）" : ""}</span>
            {requiresSetup && (
              <button
                type="button"
                className="generatePasswordButton"
                onClick={() => {
                  setPassword(generateAdminPassword());
                  setShowPassword(true);
                }}
              >
                <Sparkles size={13} /> 随机生成
              </button>
            )}
          </span>
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            required
            minLength={requiresSetup ? 8 : 1}
            autoComplete={requiresSetup ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {requiresSetup && (
          <p className="authHint">
            <strong>数据库：</strong>{setupStatus?.databaseDriver === "mysql" ? "MySQL" : "SQLite"}。
            数据库模式已在部署初始化时确定；如需更改，请在产生业务数据前重新配置部署。
          </p>
        )}
        {setupStatus?.envAdminConfigured && !requiresSetup && <p className="authHint">已从环境变量初始化管理员。</p>}
        {error && <p className="authError">{error}</p>}
        <button className="composeButton">
          <Lock size={16} /> {requiresSetup ? "创建管理员" : "登录"}
        </button>
      </form>
    </main>
  );
}

function formatDate(value: string | null) {
  if (!value) return "未同步";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightTerms(text: string, terms: string[]) {
  const cleanTerms = Array.from(new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 2)));
  if (cleanTerms.length === 0) return text;
  const pattern = new RegExp(`(${cleanTerms.map(escapeRegExp).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => {
    const matched = cleanTerms.some((term) => part.toLowerCase() === term.toLowerCase());
    return matched ? <mark key={`${part}-${index}`}>{part}</mark> : part;
  });
}

function searchHighlightTerms(state: State) {
  return [
    state.query,
    ...state.query.split(/\s+/),
    state.searchSender
  ];
}

function syncRunStatusLabel(status: string) {
  const labels: Record<string, string> = {
    ok: "成功",
    error: "失败",
    running: "运行中",
    skipped: "已跳过",
    retry_scheduled: "等待重试",
    cancelled: "已取消"
  };
  return labels[status] ?? status;
}

function syncRunTriggerLabel(trigger: string) {
  const labels: Record<string, string> = {
    manual: "单账号手动",
    manual_all: "全账号手动",
    scheduled: "定时同步"
  };
  return labels[trigger] ?? trigger;
}

function syncRunStatusClass(status: string) {
  if (status === "ok") return "okText";
  if (status === "running" || status === "retry_scheduled") return "warnText";
  return "errorText";
}

function formatDuration(startedAt: string, finishedAt: string | null) {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "未知";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function accountLabel(accounts: Account[], accountId: string | null) {
  if (!accountId) return "全局任务";
  const account = accounts.find((item) => item.id === accountId);
  return account ? `${account.display_name} · ${account.email}` : accountId;
}

const mcpScopeOptions = [
  { value: "mcp:accounts:read", label: "账号读取" },
  { value: "mcp:mail:read", label: "邮件读取" },
  { value: "mcp:mail:send", label: "邮件发送" },
  { value: "mcp:ai:use", label: "AI 能力" },
  { value: "mcp:translate:use", label: "翻译能力" },
  { value: "mcp:log", label: "调用日志" }
];

const defaultMcpScopes = ["mcp:accounts:read", "mcp:mail:read"];

const mcpToolNames = [
  "list_accounts",
  "search_mail",
  "read_mail",
  "send_mail",
  "summarize_mail",
  "draft_reply",
  "compose_mail",
  "translate_mail"
];

function mcpScopeLabel(scope: string) {
  return mcpScopeOptions.find((item) => item.value === scope)?.label ?? scope;
}

const folderLabels: Record<MailFolder, string> = {
  INBOX: "收件箱",
  STARRED: "星标",
  SENT: "已发送",
  DRAFTS: "草稿",
  ARCHIVED: "已归档",
  TRASH: "垃圾箱"
};

function Sidebar({ state, setState, navigate, onSync }: {
  state: State;
  setState: (value: Partial<State>) => void;
  navigate: (value: Partial<State>) => void;
  onSync: () => void;
}) {
  const navItems: Array<{ folder: MailFolder; icon: React.ReactNode; count?: number }> = [
    { folder: "INBOX", icon: <Inbox size={16} />, count: state.inboxUnreadCount },
    { folder: "STARRED", icon: <Star size={16} /> },
    { folder: "SENT", icon: <Send size={16} /> },
    { folder: "DRAFTS", icon: <FileText size={16} /> },
    { folder: "ARCHIVED", icon: <Archive size={16} /> },
    { folder: "TRASH", icon: <Trash2 size={16} /> }
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brandMark">
          <img src="/submail-logo.png" alt="" aria-hidden="true" />
        </div>
        <div>
          <strong>Submail</strong>
          <span>聚合邮件管理</span>
        </div>
      </div>

      <button className="primaryAction" onClick={() => setState({ isAccountDialogOpen: true, editingAccount: undefined })}>
        <Plus size={16} /> 添加邮箱
      </button>

      <nav className="navGroup">
        {navItems.map((item) => (
          <button
            className={`navItem ${state.activeView === "mail" && state.activeFolder === item.folder ? "active" : ""}`}
            key={item.folder}
            onClick={() => navigate({ activeView: "mail", activeFolder: item.folder, messagePage: 1, selectedMessageIds: [] })}
          >
            {item.icon} {folderLabels[item.folder]} {item.count ? <span>{item.count}</span> : null}
          </button>
        ))}
      </nav>

      <div className="sectionTitle managementTitle">管理</div>
      <nav className="navGroup managementNav">
        <button className={`navItem ${state.activeView === "sync" ? "active" : ""}`} onClick={() => navigate({ activeView: "sync" })}>
          <Activity size={16} /> 同步任务
        </button>
        <button className={`navItem ${state.activeView === "attachments" ? "active" : ""}`} onClick={() => navigate({ activeView: "attachments" })}>
          <Paperclip size={16} /> 附件管理
        </button>
      </nav>

      <div className="accountSection">
        <div className="sectionTitle">邮箱账号</div>
        {state.accounts.map((account) => (
          <button
            className={`accountItem ${state.selectedAccountId === account.id ? "selected" : ""}`}
            key={account.id}
            onClick={() => navigate({ activeView: "mail", selectedAccountId: state.selectedAccountId === account.id ? undefined : account.id, messagePage: 1, selectedMessageIds: [] })}
          >
            <MailProviderIcon email={account.email} size={24} />
            <span>{account.display_name}</span>
            <small>{account.email}</small>
          </button>
        ))}
      </div>

      <button className="secondaryAction" onClick={onSync}>
        <RefreshCw size={15} /> 同步邮箱
      </button>
    </aside>
  );
}

function Toolbar({
  state,
  setState,
  onSearch,
  onClearSearch,
  onSaveSearch,
  onApplySavedSearch,
  onDeleteSavedSearch,
  onLogout
}: {
  state: State;
  setState: (value: Partial<State>) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onSaveSearch: () => void;
  onApplySavedSearch: (id: string) => void;
  onDeleteSavedSearch: () => void;
  onLogout: () => void;
}) {
  const hasAccounts = state.accounts.length > 0;
  return (
    <header className="toolbar">
      <div className="toolbarMain">
        <div className="searchBox">
          <Search size={17} />
          <input
            value={state.query}
            placeholder={hasAccounts ? "搜索发件人、主题或正文" : "添加邮箱后可搜索邮件"}
            disabled={!hasAccounts}
            onChange={(event) => setState({ query: event.target.value, activeSavedSearchId: undefined })}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSearch();
            }}
          />
        </div>
        <button className="toolbarButton" onClick={onSearch} disabled={!hasAccounts}>搜索</button>
        <button
          className={`toolbarButton filterToggle ${state.isAdvancedSearchOpen ? "active" : ""}`}
          onClick={() => setState({ isAdvancedSearchOpen: !state.isAdvancedSearchOpen })}
          disabled={!hasAccounts}
          aria-expanded={state.isAdvancedSearchOpen}
        >
          <SlidersHorizontal size={15} /> 筛选
        </button>
        <button className="toolbarIcon" title="设置" onClick={() => setState({ isSettingsOpen: true })}><Settings size={18} /></button>
        <button className="toolbarIcon" title="退出登录" onClick={onLogout}><LogOut size={18} /></button>
        <button
          className="composeButton"
          disabled={!hasAccounts}
          title={hasAccounts ? "写邮件" : "请先添加邮箱"}
          onClick={() => setState({ isComposerOpen: true, composerDraft: undefined, composerPrefill: undefined })}
        >
          <MessageSquareText size={17} /> 写邮件
        </button>
      </div>
      {state.isAdvancedSearchOpen && hasAccounts && (
        <div className="searchFiltersPanel">
          <div className="advancedSearch">
            <label>发件人<input value={state.searchSender} onChange={(event) => setState({ searchSender: event.target.value, activeSavedSearchId: undefined })} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="邮箱或名称" /></label>
            <label>开始<input type="date" value={state.searchDateFrom} onChange={(event) => setState({ searchDateFrom: event.target.value, activeSavedSearchId: undefined })} /></label>
            <label>结束<input type="date" value={state.searchDateTo} onChange={(event) => setState({ searchDateTo: event.target.value, activeSavedSearchId: undefined })} /></label>
            <label className="filterCheck"><input type="checkbox" checked={state.searchHasAttachment} onChange={(event) => setState({ searchHasAttachment: event.target.checked, activeSavedSearchId: undefined })} /> 仅附件</label>
            <button className="toolbarButton" onClick={onClearSearch}>清空</button>
          </div>
          <div className="savedSearchBar">
            <select value={state.activeSavedSearchId ?? ""} onChange={(event) => onApplySavedSearch(event.target.value)}>
              <option value="">保存的搜索条件</option>
              {state.savedSearches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button className="toolbarButton" onClick={onSaveSearch}><Plus size={14} /> 保存当前条件</button>
            <button className="toolbarButton dangerButton" onClick={onDeleteSavedSearch} disabled={!state.activeSavedSearchId}><Trash2 size={14} /> 删除</button>
          </div>
        </div>
      )}
    </header>
  );
}

function ManagementToolbar({ title, description, onSettings, onLogout }: { title: string; description: string; onSettings: () => void; onLogout: () => void }) {
  return (
    <header className="toolbar managementToolbar">
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="toolbarMain">
        <button className="toolbarIcon" title="设置" onClick={onSettings}><Settings size={18} /></button>
        <button className="toolbarIcon" title="退出登录" onClick={onLogout}><LogOut size={18} /></button>
      </div>
    </header>
  );
}

function NumberStepper({ value, min, max, onChange, ariaLabel, suffix }: { value: number; min: number; max: number; onChange: (value: number) => void; ariaLabel: string; suffix: string }) {
  const clamp = (next: number) => Math.max(min, Math.min(max, Number.isFinite(next) ? Math.round(next) : min));
  return (
    <span className="numberStepper">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label={`${ariaLabel}减少`}>−</button>
      <input aria-label={ariaLabel} inputMode="numeric" value={value} onChange={(event) => onChange(clamp(Number(event.target.value.replace(/\D/g, ""))))} />
      <span>{suffix}</span>
      <button type="button" onClick={() => onChange(clamp(value + 1))} disabled={value >= max} aria-label={`${ariaLabel}增加`}>＋</button>
    </span>
  );
}

function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="paginationBar">
      <span>共 {total} 条 · 第 {Math.min(page, totalPages)} / {totalPages} 页</span>
      <div>
        <button className="toolbarButton" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
        <button className="toolbarButton" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>下一页</button>
      </div>
    </div>
  );
}

function attachmentDisplayName(attachment: Attachment): string {
  const mime = attachment.content_type.split(";", 1)[0].toLowerCase();
  if (mime === "message/rfc822" && (!attachment.filename || attachment.filename.toLowerCase() === "attachment")) return "原始邮件.eml";
  return attachment.filename || "未命名附件";
}

function attachmentKindLabel(attachment: Attachment): string {
  const mime = attachment.content_type.split(";", 1)[0].toLowerCase();
  if (mime === "message/rfc822") return "原始邮件";
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "图片";
  if (mime.startsWith("audio/")) return "音频";
  if (mime.startsWith("video/")) return "视频";
  if (mime.startsWith("text/") || ["application/json", "application/xml", "application/csv"].includes(mime)) return "文本";
  return "文件";
}

function SyncRunsPage({ state, onFilterChange, onPageChange, onRunAll, onOpenDetails, onCancel, onDelete, onCleanup }: {
  state: State;
  onFilterChange: (patch: Partial<State>) => void;
  onPageChange: (page: number) => void;
  onRunAll: () => void;
  onOpenDetails: (run: SyncRun) => void;
  onCancel: (run: SyncRun) => void;
  onDelete: (run: SyncRun) => void;
  onCleanup: () => void;
}) {
  const syncingAll = state.operationNotice?.key === "sync-all" && state.operationNotice.tone === "loading";
  return (
    <main className="managementPage">
      <div className="managementPageHeader">
        <div><h1>同步任务</h1><p>查看定时与手动同步记录、错误原因和重试状态。</p></div>
        <div className="managementHeaderActions">
          <button className="toolbarButton" onClick={onCleanup}><Trash2 size={15} /> 清理超过 {state.syncSettings?.retention_days ?? 30} 天记录</button>
          <button className="composeButton" onClick={onRunAll} disabled={syncingAll}><RefreshCw className={syncingAll ? "spin" : undefined} size={16} /> {syncingAll ? "同步中" : "全部同步"}</button>
        </div>
      </div>
      <div className="managementCard">
        <div className="syncRunFilters">
          <select value={state.syncRunStatusFilter} onChange={(event) => onFilterChange({ syncRunStatusFilter: event.target.value })}>
            <option value="">全部状态</option><option value="running">运行中</option><option value="retry_scheduled">等待重试</option><option value="ok">成功</option><option value="error">失败</option><option value="skipped">已跳过</option><option value="cancelled">已取消</option>
          </select>
          <select value={state.syncRunTriggerFilter} onChange={(event) => onFilterChange({ syncRunTriggerFilter: event.target.value })}>
            <option value="">全部来源</option><option value="manual">单账号手动</option><option value="manual_all">全账号手动</option><option value="scheduled">定时同步</option>
          </select>
          <select value={state.syncRunAccountFilter} onChange={(event) => onFilterChange({ syncRunAccountFilter: event.target.value })}>
            <option value="">全部账号</option>{state.accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name}</option>)}
          </select>
        </div>
        <div className="managementRows">
          {state.syncRuns.length === 0 && <p className="emptyText">暂无同步记录</p>}
          {state.syncRuns.map((run) => (
            <div className="syncRunPageRow" key={run.id}>
              <div><strong>{syncRunStatusLabel(run.status)}</strong><span>{run.trigger_type} · {run.attempts} 次</span></div>
              <div><strong>{run.imported} 封</strong><span>{formatDate(run.started_at)}</span></div>
              {run.error && <p>{run.error}</p>}
              <div className="rowActions">
                <button className="accountAction" onClick={() => onOpenDetails(run)}><FileText size={14} /> 详情</button>
                {run.status === "retry_scheduled" && <button className="accountAction danger" onClick={() => onCancel(run)} title="取消重试"><Trash2 size={14} /></button>}
                {run.status !== "running" && <button className="accountAction danger" onClick={() => onDelete(run)} title="删除记录"><Trash2 size={14} /></button>}
              </div>
            </div>
          ))}
        </div>
        <Pagination page={state.syncRunPage} pageSize={state.syncRunPageSize} total={state.syncRunTotal} onChange={onPageChange} />
      </div>
    </main>
  );
}

function AttachmentsPage({ state, setState, onFilterChange, onPageChange, onPreview, onDownload, onSaveSettings, onCleanup }: {
  state: State;
  setState: (value: Partial<State>) => void;
  onFilterChange: (patch?: Partial<State>) => void;
  onPageChange: (page: number) => void;
  onPreview: (attachment: Attachment) => void;
  onDownload: (attachment: Attachment) => void;
  onSaveSettings: () => void;
  onCleanup: () => void;
}) {
  return (
    <main className="managementPage">
      <div className="managementPageHeader"><div><h1>附件管理</h1><p>使用 Flyfish Viewer 在线预览；只有“下载”按钮会保存到本机。</p></div><button className="toolbarButton" onClick={onCleanup}><Trash2 size={15} /> 立即清理过期附件</button></div>
      <div className="managementCard">
        <div className="attachmentPageFilters">
          <input value={state.attachmentQuery} onChange={(event) => setState({ attachmentQuery: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") onFilterChange(); }} placeholder="搜索文件名、邮件主题、发件人" />
          <select value={state.attachmentTypeFilter} onChange={(event) => onFilterChange({ attachmentTypeFilter: event.target.value })}>
            <option value="">全部类型</option><option value="image">图片</option><option value="text">文本</option><option value="pdf">PDF</option><option value="archive">压缩包</option><option value="other">其他</option>
          </select>
          <button className="toolbarButton" onClick={() => onFilterChange()}><Search size={15} /> 搜索</button>
        </div>
        {state.attachmentSettings && (
          <div className="attachmentLimitRow">
            <div className="attachmentLimitCopy"><strong>单附件上限</strong><small>超过限制的附件不会保存到本地</small></div>
            <NumberStepper ariaLabel="单附件上限" suffix="MB" min={1} max={25} value={Math.round(state.attachmentSettings.max_size_bytes / 1024 / 1024)} onChange={(value) => setState({ attachmentSettings: { ...state.attachmentSettings!, max_size_bytes: value * 1024 * 1024 } })} />
            <div className="attachmentLimitCopy"><strong>自动删除</strong><small>0 天表示永久保留</small></div>
            <NumberStepper ariaLabel="附件保留天数" suffix="天" min={0} max={3650} value={state.attachmentSettings.retention_days} onChange={(value) => setState({ attachmentSettings: { ...state.attachmentSettings!, retention_days: value } })} />
            <button className="secondaryAction compactAction" onClick={onSaveSettings}><Check size={14} /> 保存策略</button>
          </div>
        )}
        <div className="managementRows attachmentPageRows">
          {state.attachments.length === 0 && <p className="emptyText">暂无附件</p>}
          {state.attachments.map((attachment) => (
            <div className="attachmentPageRow" key={attachment.id}>
              <button className="attachmentPreviewButton" onClick={() => onPreview(attachment)}>
                <FileText size={18} />
                <span><strong>{attachmentDisplayName(attachment)}</strong><small>{attachmentKindLabel(attachment)} · {formatSize(attachment.size)}</small></span>
              </button>
              <div className="attachmentMessageMeta"><strong>{attachment.message_subject || "(无主题)"}</strong><span>{attachment.sender_email || "未知发件人"} · {formatDate(attachment.sent_at ?? null)}</span></div>
              <button className="secondaryAction" onClick={() => onDownload(attachment)}><Download size={14} /> 下载</button>
            </div>
          ))}
        </div>
        <Pagination page={state.attachmentPage} pageSize={state.attachmentPageSize} total={state.attachmentTotal} onChange={onPageChange} />
      </div>
    </main>
  );
}

function FirstRunEmpty({ onAddAccount, onOpenIntegrations }: { onAddAccount: () => void; onOpenIntegrations: () => void }) {
  return (
    <section className="firstRunEmpty">
      <div className="firstRunHero">
        <div className="firstRunMark"><img src="/submail-logo.png" alt="" aria-hidden="true" /></div>
        <div>
          <span className="eyebrow">开始使用 Submail</span>
          <h1>先连接你的第一个邮箱</h1>
          <p>添加邮箱后即可同步收件箱、集中搜索邮件，并通过网页、API 或 MCP 安全发信。</p>
        </div>
      </div>
      <div className="firstRunActions">
        <button className="composeButton" onClick={onAddAccount}><Plus size={16} /> 添加邮箱</button>
        <button className="secondaryAction" onClick={onOpenIntegrations}><Sparkles size={16} /> 配置 AI 与翻译</button>
      </div>
      <div className="firstRunSteps">
        <div><Mail size={18} /><strong>1. 连接邮箱</strong><span>填写 IMAP/POP3、SMTP 和授权码</span></div>
        <div><RefreshCw size={18} /><strong>2. 自动同步</strong><span>增量收取邮件并建立搜索索引</span></div>
        <div><ShieldCheck size={18} /><strong>3. 安全调用</strong><span>按账号和权限签发 MCP / API Key</span></div>
      </div>
    </section>
  );
}

const virtualMessageRowHeight = 116;
const virtualMessageOverscan = 3;

function MessageList({
  state,
  onSelectMessage,
  onToggleSelection,
  onTogglePageSelection,
  onMarkAllRead,
  onBulkRead,
  onBulkDelete,
  onPageChange
}: {
  state: State;
  onSelectMessage: (message: Message) => void;
  onToggleSelection: (id: string) => void;
  onTogglePageSelection: () => void;
  onMarkAllRead: () => void;
  onBulkRead: () => void;
  onBulkDelete: () => void;
  onPageChange: (page: number) => void;
}) {
  const terms = searchHighlightTerms(state);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(640);
  const selectedIds = React.useMemo(() => new Set(state.selectedMessageIds), [state.selectedMessageIds]);
  const allPageSelected = state.messages.length > 0 && state.messages.every((message) => selectedIds.has(message.id));
  const firstVisibleIndex = Math.max(0, Math.floor(scrollTop / virtualMessageRowHeight) - virtualMessageOverscan);
  const visibleCount = Math.ceil(viewportHeight / virtualMessageRowHeight) + virtualMessageOverscan * 2;
  const lastVisibleIndex = Math.min(state.messages.length, firstVisibleIndex + visibleCount);
  const visibleMessages = state.messages.slice(firstVisibleIndex, lastVisibleIndex);
  const markingAllRead = state.operationNotice?.key === "mark-all-inbox-read" && state.operationNotice.tone === "loading";

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateHeight = () => setViewportHeight(viewport.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [state.messagePage, state.activeFolder, state.selectedAccountId, state.query]);

  return (
    <section className="messageList">
      <div className="listHeader">
        <div>
          <h1>{state.query ? "搜索结果" : folderLabels[state.activeFolder]}</h1>
          <p>共 {state.messageTotal} 封邮件，当前第 {state.messagePage} 页</p>
        </div>
        <span>{state.busyText ?? "实时索引"}</span>
      </div>
      <div className="messageBatchBar">
        <label className="batchSelectAll">
          <input type="checkbox" checked={allPageSelected} onChange={onTogglePageSelection} />
          全选本页
        </label>
        <span>已选 {state.selectedMessageIds.length} 封</span>
        {state.activeFolder === "INBOX" ? (
          <button className="toolbarButton" disabled={state.inboxUnreadCount === 0 || markingAllRead} onClick={onMarkAllRead}>
            <MailOpen size={15} /> {markingAllRead ? "正在全部标记…" : "收件箱全部已读"}
          </button>
        ) : null}
        <button className="toolbarButton" disabled={state.selectedMessageIds.length === 0} onClick={onBulkRead}>
          <MailOpen size={15} /> 批量已读
        </button>
        <button className="toolbarButton dangerButton" disabled={state.selectedMessageIds.length === 0} onClick={onBulkDelete}>
          {state.activeFolder === "TRASH" ? <Inbox size={15} /> : <Trash2 size={15} />}
          {state.activeFolder === "TRASH" ? "批量恢复" : "移入垃圾箱"}
        </button>
      </div>

      <div className="virtualMessageViewport" ref={viewportRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div className="virtualMessageCanvas" style={{ height: state.messages.length * virtualMessageRowHeight }}>
          {visibleMessages.map((message, visibleIndex) => {
            const index = firstVisibleIndex + visibleIndex;
            return (
              <div className="virtualMessageRow" key={message.id} style={{ height: virtualMessageRowHeight, transform: `translateY(${index * virtualMessageRowHeight}px)` }}>
                <label className="messageSelect" title="选择邮件">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(message.id)}
                    aria-label={`选择：${message.subject}`}
                    onChange={() => onToggleSelection(message.id)}
                  />
                </label>
                <button
                  className={`messageRow ${state.selectedMessage?.id === message.id ? "selected" : ""} ${message.is_read ? "" : "unread"}`}
                  onClick={() => onSelectMessage(message)}
                >
                  <div className="rowTop">
                    <strong>{!message.is_read && <span className="unreadBadge">未读</span>}{message.is_starred ? "★ " : ""}{highlightTerms(message.sender_name || message.sender_email || "未知发件人", terms)}</strong>
                    <time>{formatDate(message.sent_at)}</time>
                  </div>
                  <div className="rowSubject">{highlightTerms(message.subject, terms)}</div>
                  <p>{highlightTerms(message.snippet, terms)}</p>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <Pagination page={state.messagePage} pageSize={state.messagePageSize} total={state.messageTotal} onChange={onPageChange} />
    </section>
  );
}

function messageSenderLabel(message: Message, account?: Account): string {
  if (message.folder === "Sent") return `${message.sender_name || account?.display_name || "我"} <${message.sender_email || account?.email || "未知"}>`;
  const name = message.sender_name?.trim();
  return name ? `${name} <${message.sender_email || "未知"}>` : message.sender_email || "未知发件人";
}

function messageRecipientLabel(message: Message): string {
  return parseRecipientText(message) || "未记录收件人";
}

function MessageAddressDetails({ message, account }: { message: Message; account?: Account }) {
  return (
    <dl className="messageAddressDetails">
      <div><dt>发件人</dt><dd>{messageSenderLabel(message, account)}</dd></div>
      <div><dt>收件人</dt><dd>{messageRecipientLabel(message)}</dd></div>
      <div><dt>邮箱账号</dt><dd>{account ? `${account.display_name} · ${account.email}` : "未知账号"}</dd></div>
    </dl>
  );
}

async function fetchAttachmentFile(attachment: Attachment): Promise<File> {
  const token = localStorage.getItem(sessionTokenKey);
  const response = await fetch(`${apiBaseUrl}/api/attachments/${encodeURIComponent(attachment.id)}/content`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined
  });
  if (!response.ok) throw new Error("附件内容加载失败");
  const blob = await response.blob();
  const filename = attachmentDisplayName(attachment);
  return new File([blob], filename, { type: attachment.content_type || blob.type || "application/octet-stream" });
}

function AttachmentViewerSurface({ attachment, compact = false }: { attachment: Attachment; compact?: boolean }) {
  const [file, setFile] = React.useState<File>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    let active = true;
    fetchAttachmentFile(attachment)
      .then((loaded) => { if (active) setFile(loaded); })
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : "附件内容加载失败"); });
    return () => { active = false; };
  }, [attachment.id]);
  if (error) return <p className="emptyText">{error}</p>;
  if (!file) return <div className="viewerLoading">正在加载 {attachmentDisplayName(attachment)}…</div>;
  return (
    <React.Suspense fallback={<div className="viewerLoading">正在启动在线预览…</div>}>
      <FlyfishAttachmentViewer
        file={file}
        filename={attachmentDisplayName(attachment)}
        contentType={attachment.content_type}
        className={compact ? "flyfishViewer inlineFlyfishViewer" : "flyfishViewer"}
      />
    </React.Suspense>
  );
}

function EmailBody({ message, compact = false, loadExternalResourcesByDefault = false }: {
  message: Message;
  compact?: boolean;
  loadExternalResourcesByDefault?: boolean;
}) {
  const [remoteChoice, setRemoteChoice] = React.useState<"ask" | "blocked" | "allowed">(
    loadExternalResourcesByDefault ? "allowed" : "ask"
  );
  const [frameHeight, setFrameHeight] = React.useState(compact ? 180 : 260);
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const frameCleanupRef = React.useRef<(() => void) | undefined>(undefined);
  const html = message.html_body?.trim();
  const prepared = React.useMemo(
    () => html ? prepareEmailHtml(html, remoteChoice === "allowed", compact) : undefined,
    [compact, html, remoteChoice]
  );

  React.useEffect(() => () => frameCleanupRef.current?.(), []);

  React.useEffect(() => {
    frameCleanupRef.current?.();
    frameCleanupRef.current = undefined;
    setFrameHeight(compact ? 180 : 240);
  }, [compact, prepared?.srcDoc]);

  React.useEffect(() => {
    setRemoteChoice(loadExternalResourcesByDefault ? "allowed" : "ask");
  }, [loadExternalResourcesByDefault, message.id]);

  function resizeFrame() {
    const contentDocument = frameRef.current?.contentDocument;
    if (!contentDocument) return;
    const root = contentDocument.documentElement;
    const body = contentDocument.body;
    const naturalHeight = Math.ceil(Math.max(
      root.scrollHeight,
      root.offsetHeight,
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      body?.getBoundingClientRect().height ?? 0
    ));
    const nextHeight = Math.min(Math.max(naturalHeight, compact ? 180 : 240), compact ? 900 : 100_000);
    setFrameHeight((current) => current === nextHeight ? current : nextHeight);
  }

  function frameLoaded() {
    frameCleanupRef.current?.();
    const contentDocument = frameRef.current?.contentDocument;
    const contentWindow = frameRef.current?.contentWindow;
    if (!contentDocument || !contentWindow) return;
    let active = true;
    let animationFrame = 0;
    const scheduleResize = () => {
      if (!active) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(resizeFrame);
    };
    const observer = new ResizeObserver(scheduleResize);
    if (contentDocument.body) observer.observe(contentDocument.body);
    const images = Array.from(contentDocument.images);
    for (const image of images) {
      image.addEventListener("load", scheduleResize);
      image.addEventListener("error", scheduleResize);
    }
    contentWindow.addEventListener("resize", scheduleResize);
    const settleTimer = window.setTimeout(scheduleResize, 250);
    void contentDocument.fonts?.ready.then(scheduleResize);
    scheduleResize();
    frameCleanupRef.current = () => {
      active = false;
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
      contentWindow.removeEventListener("resize", scheduleResize);
      for (const image of images) {
        image.removeEventListener("load", scheduleResize);
        image.removeEventListener("error", scheduleResize);
      }
    };
  }

  if (!prepared) {
    return <div className={`plainEmailBody ${compact ? "compact" : ""}`}>{message.text_body || message.snippet || "（无正文）"}</div>;
  }

  return (
    <div className={`emailHtmlBody ${compact ? "compact" : ""}`}>
      {prepared.externalResourceCount > 0 && (
        <div className={`remoteResourceNotice ${remoteChoice}`}>
          <ShieldCheck size={18} />
          <div>
            <strong>{remoteChoice === "allowed" ? "已加载外部资源" : "外部资源已阻止"}</strong>
            <span>
              {remoteChoice === "allowed"
                ? `${loadExternalResourcesByDefault ? "已按系统默认设置" : "已按你的选择"}加载 ${prepared.externalResourceCount} 项外部图片或样式。`
                : `邮件包含 ${prepared.externalResourceCount} 项外部图片或样式，加载可能向发件人暴露你的 IP 和阅读时间。`}
            </span>
          </div>
          <div className="remoteResourceActions">
            {remoteChoice === "ask" && <button type="button" className="toolbarButton" onClick={() => setRemoteChoice("blocked")}>继续阻止</button>}
            {remoteChoice !== "allowed" && <button type="button" className="toolbarButton primary" onClick={() => setRemoteChoice("allowed")}>加载外部资源</button>}
            {remoteChoice === "allowed" && <button type="button" className="toolbarButton" onClick={() => setRemoteChoice("blocked")}>重新阻止</button>}
            {remoteChoice === "blocked" && <span className="remoteChoiceConfirmed"><Check size={14} /> 已保持阻止</span>}
          </div>
        </div>
      )}
      <iframe
        ref={frameRef}
        className={`emailHtmlFrame ${compact ? "compact" : ""}`}
        title={`邮件正文：${message.subject}`}
        srcDoc={prepared.srcDoc}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        scrolling={compact || frameHeight >= 100_000 ? "auto" : "no"}
        style={{ height: frameHeight }}
        onLoad={frameLoaded}
      />
    </div>
  );
}

function Preview({
  message,
  threadMessages,
  accounts,
  loadExternalResourcesByDefault,
  conversationMode,
  onToggleConversation,
  attachments,
  onPreviewAttachment,
  onDownloadAttachment,
  onUpdateMessageState,
  onEditDraft,
  onSendDraft,
  onDeleteDraft,
  onReply,
  onForward,
  onSummarize,
  onSuggestReply,
  onTranslate,
  onUseSuggestedReply,
  assistantBusy,
  assistantError,
  assistantResult
}: {
  message?: Message;
  threadMessages: Message[];
  accounts: Account[];
  loadExternalResourcesByDefault: boolean;
  conversationMode: boolean;
  onToggleConversation: () => void;
  attachments: Attachment[];
  onPreviewAttachment: (attachment: Attachment) => void;
  onDownloadAttachment: (attachment: Attachment) => void;
  onUpdateMessageState: (message: Message, patch: Partial<{ isRead: boolean; isStarred: boolean; isArchived: boolean; isDeleted: boolean }>) => void;
  onEditDraft: (message: Message) => void;
  onSendDraft: (message: Message) => void;
  onDeleteDraft: (message: Message) => void;
  onReply: (message: Message) => void;
  onForward: (message: Message) => void;
  onSummarize: (message: Message) => void;
  onSuggestReply: (message: Message) => void;
  onTranslate: (message: Message) => void;
  onUseSuggestedReply: (message: Message, text: string) => void;
  assistantBusy?: string;
  assistantError?: string;
  assistantResult?: AssistantResult;
}) {
  if (!message) {
    return (
      <section className="preview emptyPreview">
        <Mail size={38} />
        <h2>选择一封邮件</h2>
        <p>在左侧列表中打开邮件，正文、来源账号和操作会显示在这里。</p>
      </section>
    );
  }
  const account = accounts.find((item) => item.id === message.account_id);
  const remoteSpecialFolder = Boolean(message.remote_mailbox) && (message.folder === "Archive" || message.folder === "Trash");
  const originalEmailAttachments = attachments.filter((attachment) => attachment.content_type.split(";", 1)[0].toLowerCase() === "message/rfc822");
  return (
    <section className="preview">
      <div className="previewHeader">
        <div>
          <h2>{message.subject}</h2>
          <p>{message.sender_name || message.sender_email} · {formatDate(message.sent_at)}</p>
          <MessageAddressDetails message={message} account={account} />
        </div>
        <div className="previewActions">
          {threadMessages.length > 1 && (
            <button className={`toolbarButton ${conversationMode ? "active" : ""}`} onClick={onToggleConversation}>
              <MessageSquareText size={16} /> {conversationMode ? "仅看当前邮件" : `展开对话 · ${threadMessages.length}`}
            </button>
          )}
          {message.folder === "Drafts" ? (
            message.remote_mailbox ? (
              <span className="remoteDraftBadge" title="远端草稿同步为只读，避免本地编辑覆盖服务商版本">远端草稿 · 只读</span>
            ) : (
              <>
                <button className="toolbarButton" onClick={() => onEditDraft(message)}><MessageSquareText size={16} /> 编辑</button>
                <button className="composeButton" onClick={() => onSendDraft(message)}><Send size={16} /> 发送</button>
                <button className="toolbarIcon" title="删除草稿" onClick={() => onDeleteDraft(message)}><Trash2 size={18} /></button>
              </>
            )
          ) : (
            <>
              <button className="toolbarButton" onClick={() => onReply(message)}><Reply size={16} /> 回复</button>
              <button className="toolbarButton" onClick={() => onForward(message)}><Forward size={16} /> 转发</button>
              <button className="toolbarButton" disabled={Boolean(assistantBusy)} onClick={() => onSummarize(message)}><Sparkles size={16} /> AI 总结</button>
              <button className="toolbarButton" disabled={Boolean(assistantBusy)} onClick={() => onSuggestReply(message)}><MessageSquareText size={16} /> 推荐回信</button>
              <button className="toolbarButton" disabled={Boolean(assistantBusy)} onClick={() => onTranslate(message)}><Languages size={16} /> 翻译</button>
              <button className="toolbarButton" onClick={() => onUpdateMessageState(message, { isRead: !message.is_read })}>
                <MailOpen size={16} /> {message.is_read ? "标为未读" : "标为已读"}
              </button>
              <button className={`toolbarIcon ${message.is_starred ? "activeIcon" : ""}`} title={message.is_starred ? "取消星标" : "星标"} onClick={() => onUpdateMessageState(message, { isStarred: !message.is_starred })}>
                <Star size={18} />
              </button>
              {remoteSpecialFolder ? (
                <span className="remoteDraftBadge" title="远端归档和垃圾箱目录当前只同步读取，避免本地状态与服务商目录冲突">远端目录 · 只读</span>
              ) : (
                <>
                  <button className="toolbarIcon" title={message.is_archived ? "移回收件箱" : "归档"} onClick={() => onUpdateMessageState(message, { isArchived: !message.is_archived })}>
                    <Archive size={18} />
                  </button>
                  <button className="toolbarIcon" title={message.is_deleted ? "恢复" : "删除"} onClick={() => onUpdateMessageState(message, { isDeleted: !message.is_deleted })}>
                    {message.is_deleted ? <Inbox size={18} /> : <Trash2 size={18} />}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {assistantBusy && <div className="assistantPanel loading"><Sparkles size={16} /> {assistantBusy}</div>}
      {assistantError && <div className="assistantPanel error" role="alert">{assistantError}</div>}
      {assistantResult?.messageId === message.id && (
        <div className="assistantPanel result">
          <div className="assistantPanelHeader">
            <strong>{assistantResult.title}</strong>
            {assistantResult.kind === "reply" && (
              <button className="composeButton" onClick={() => onUseSuggestedReply(message, assistantResult.text)}>带入回复编辑器</button>
            )}
          </div>
          <pre>{assistantResult.text}</pre>
        </div>
      )}
      {threadMessages.length > 1 && (
        <div className="conversationToolbar">
          <div><MessageSquareText size={17} /><span><strong>邮件对话</strong><small>按邮件线程与同一往来联系人聚合，共 {threadMessages.length} 封</small></span></div>
          <button className="secondaryAction" onClick={onToggleConversation}>{conversationMode ? "收起其他邮件" : "展开完整对话"}</button>
        </div>
      )}
      {conversationMode && threadMessages.length > 1 ? (
        <div className="conversationThread">
          {threadMessages.map((threadMessage) => {
            const threadAccount = accounts.find((item) => item.id === threadMessage.account_id);
            return (
              <article className={`conversationMessage ${threadMessage.folder === "Sent" ? "outgoing" : "incoming"} ${threadMessage.id === message.id ? "current" : ""}`} key={threadMessage.id}>
                <header><strong>{threadMessage.folder === "Sent" ? "已发送" : "已接收"}</strong><time>{formatDate(threadMessage.sent_at)}</time></header>
                <h3>{threadMessage.subject}</h3>
                <MessageAddressDetails message={threadMessage} account={threadAccount} />
                <EmailBody key={threadMessage.id} message={threadMessage} compact loadExternalResourcesByDefault={loadExternalResourcesByDefault} />
              </article>
            );
          })}
        </div>
      ) : (
        <EmailBody key={message.id} message={message} loadExternalResourcesByDefault={loadExternalResourcesByDefault} />
      )}
      {originalEmailAttachments.map((attachment) => (
        <section className="inlineOriginalEmail" key={attachment.id}>
          <div><strong>原始邮件自动预览</strong><span>{attachmentDisplayName(attachment)}</span></div>
          <AttachmentViewerSurface attachment={attachment} compact />
        </section>
      ))}
      {attachments.length > 0 && (
        <div className="attachmentStrip">
          <h3>附件</h3>
          {attachments.map((attachment) => (
            <div className="attachmentItemRow" key={attachment.id}>
              <button className="attachmentItem" onClick={() => onPreviewAttachment(attachment)}>
                <FileText size={15} />
                <span>{attachmentDisplayName(attachment)}</span>
                <small>{attachmentKindLabel(attachment)} · {formatSize(attachment.size)}</small>
              </button>
              <button className="rowAction" onClick={() => onDownloadAttachment(attachment)} title="下载附件"><Download size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Inspector({
  state,
  createMcpKey,
  deleteMcpKey,
  copyNewMcpKey,
  openAdminDialog,
  openPasswordDialog,
  openResetAdminDialog,
  syncAccount,
  testAccount,
  editAccount,
  deleteAccount,
  saveEmailDisplaySettings,
  saveSyncSettings,
  runAllSync,
  cancelSyncRun,
  openSyncRunDetails,
  saveAttachmentSettings,
  previewAttachment,
  saveAiSettings,
  testAiSettings,
  saveTranslationSettings,
  testTranslationSettings,
  setState,
  downloadAttachment
}: {
  state: State;
  createMcpKey: () => void;
  deleteMcpKey: (id: string) => void;
  copyNewMcpKey: () => void;
  openAdminDialog: () => void;
  openPasswordDialog: () => void;
  openResetAdminDialog: (admin: Admin) => void;
  syncAccount: (id: string) => void;
  testAccount: (account: Account) => void;
  editAccount: (account: Account) => void;
  deleteAccount: (account: Account) => void;
  saveEmailDisplaySettings: () => void;
  saveSyncSettings: () => void;
  runAllSync: () => void;
  cancelSyncRun: (run: SyncRun) => void;
  openSyncRunDetails: (run: SyncRun) => void;
  saveAttachmentSettings: () => void;
  previewAttachment: (attachment: Attachment) => void;
  saveAiSettings: () => void;
  testAiSettings: () => void;
  saveTranslationSettings: () => void;
  testTranslationSettings: () => void;
  setState: (value: Partial<State>) => void;
  downloadAttachment: (attachment: Attachment) => void;
}) {
  const syncSettings = state.syncSettings;
  const syncingAll = state.operationNotice?.key === "sync-all" && state.operationNotice.tone === "loading";
  const mcpRemoteEndpoint = `${window.location.origin}/mcp`;
  const sendApiEndpoint = `${window.location.origin}/api/send`;
  return (
    <aside className="inspector">
      {state.settingsTab === "mail" && <>
      <div className="panel syncStatusPanel">
        <div className="panelTitle"><ShieldCheck size={16} /> 同步状态</div>
        {state.accounts.map((account) => (
          <div className="statusRow" key={account.id}>
            <span>{account.display_name}</span>
            <small>{account.sync_status === "error" ? "同步失败" : `${formatDate(account.last_sync_at)} · UID ${account.sync_cursor_uid || 0}`}</small>
            <button className="rowAction" disabled={state.operationNotice?.key === `sync:${account.id}` && state.operationNotice.tone === "loading"} onClick={() => syncAccount(account.id)} title="立即同步"><RefreshCw className={state.operationNotice?.key === `sync:${account.id}` && state.operationNotice.tone === "loading" ? "spin" : undefined} size={13} /></button>
          </div>
        ))}
      </div>

      <div className="panel accountSettingsPanel">
        <div className="panelTitle"><Mail size={16} /> 邮箱账号</div>
        {state.accounts.map((account) => (
          <div className="accountManageRow" key={account.id}>
            <MailProviderIcon email={account.email} size={34} />
            <div className="accountManageDetails">
              <span>{account.display_name}</span>
              <small>{account.email} · {account.incoming_protocol?.toUpperCase() ?? "IMAP"}</small>
              {account.aliases.length > 0 && <small>{account.aliases.length} 个自有地址：{account.aliases.map((alias) => alias.email).join("、")}</small>}
              {account.notes && <small className="accountNote">{account.notes}</small>}
            </div>
            <div className="accountActions">
              <button type="button" className="accountAction" onClick={() => editAccount(account)}><Settings size={14} /> 编辑</button>
              <button type="button" className="accountAction" disabled={state.operationNotice?.key === `test:${account.id}` && state.operationNotice.tone === "loading"} onClick={() => testAccount(account)}><Wrench size={14} /> {state.operationNotice?.key === `test:${account.id}` && state.operationNotice.tone === "loading" ? "测试中" : "测试"}</button>
              <button type="button" className="accountAction danger" onClick={() => deleteAccount(account)} title="删除邮箱"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {state.accounts.length === 0 && <p className="emptyText">暂无邮箱账号</p>}
      </div>

      <div className="panel emailDisplaySettingsPanel">
        <div className="panelTitle"><MailOpen size={16} /> 邮件阅读偏好</div>
        {state.emailDisplaySettings ? (
          <div className="emailDisplaySettingsForm">
            <button
              type="button"
              className={`settingsSwitch ${state.emailDisplaySettings.load_external_resources_by_default ? "on" : ""}`}
              role="switch"
              aria-checked={state.emailDisplaySettings.load_external_resources_by_default}
              onClick={() => setState({
                emailDisplaySettings: {
                  ...state.emailDisplaySettings!,
                  load_external_resources_by_default: !state.emailDisplaySettings!.load_external_resources_by_default
                }
              })}
            >
              <span className="settingsSwitchTrack" aria-hidden="true"><span /></span>
              <span className="settingsSwitchCopy">
                <strong>默认加载外部资源</strong>
                <small>新打开的 HTML 邮件将自动显示远程图片和样式</small>
              </span>
            </button>
            <p className="privacyHint"><ShieldCheck size={15} /> 加载外部资源可能向发件人暴露 IP 和阅读时间；邮件内仍可单独重新阻止。</p>
            <button className="secondaryAction" onClick={saveEmailDisplaySettings}><Check size={15} /> 保存阅读偏好</button>
          </div>
        ) : <p className="emptyText">正在加载阅读偏好…</p>}
      </div>

      <div className="panel scheduleSettingsPanel">
        <div className="panelTitle"><Clock3 size={16} /> 定时同步</div>
        {syncSettings && (
          <div className="syncSettingsForm">
            <label className="switchLine">
              <input
                type="checkbox"
                checked={syncSettings.enabled}
                onChange={(event) => setState({ syncSettings: { ...syncSettings, enabled: event.target.checked } })}
              />
              <span>启用定时同步</span>
            </label>
            <div className="syncFieldGrid">
              <label className="syncField">
                <span>同步间隔</span>
                <span className="numberControl">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={syncSettings.interval_minutes}
                    onChange={(event) => setState({ syncSettings: { ...syncSettings, interval_minutes: Number(event.target.value) } })}
                  />
                  <small>分钟</small>
                </span>
              </label>
              <label className="syncField">
                <span>首次同步数量</span>
                <span className="numberControl">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={syncSettings.initial_limit}
                    onChange={(event) => setState({ syncSettings: { ...syncSettings, initial_limit: Number(event.target.value) } })}
                  />
                  <small>封</small>
                </span>
              </label>
              <label className="syncField">
                <span>失败重试次数</span>
                <span className="numberControl">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={syncSettings.retry_max_attempts}
                    onChange={(event) => setState({ syncSettings: { ...syncSettings, retry_max_attempts: Number(event.target.value) } })}
                  />
                  <small>次</small>
                </span>
              </label>
              <label className="syncField">
                <span>重试间隔</span>
                <span className="numberControl">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={syncSettings.retry_delay_minutes}
                    onChange={(event) => setState({ syncSettings: { ...syncSettings, retry_delay_minutes: Number(event.target.value) } })}
                  />
                  <small>分钟</small>
                </span>
              </label>
              <label className="syncField">
                <span>并发账号上限</span>
                <span className="numberControl">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={syncSettings.concurrency_limit}
                    onChange={(event) => setState({ syncSettings: { ...syncSettings, concurrency_limit: Number(event.target.value) } })}
                  />
                  <small>个</small>
                </span>
              </label>
              <label className="syncField">
                <span>任务记录保留</span>
                <span className="numberControl">
                  <input type="number" min={1} max={3650} value={syncSettings.retention_days} onChange={(event) => setState({ syncSettings: { ...syncSettings, retention_days: Number(event.target.value) } })} />
                  <small>天</small>
                </span>
              </label>
            </div>
            <div className="syncScheduleMeta">
              <div>
                <span>上次同步</span>
                <small>{formatDate(syncSettings.last_run_at)}</small>
              </div>
              <div>
                <span>下次同步</span>
                <small>{formatDate(syncSettings.next_run_at)}</small>
              </div>
            </div>
            <div className="buttonRow">
              <button className="secondaryAction" onClick={saveSyncSettings}><Check size={15} /> 保存</button>
              <button className="secondaryAction" onClick={runAllSync} disabled={syncingAll}><RefreshCw className={syncingAll ? "spin" : undefined} size={15} /> {syncingAll ? "同步中" : "全部同步"}</button>
            </div>
          </div>
        )}
      </div>

      </>}

      {state.settingsTab === "integrations" && <>
        <div className="panel integrationPanel">
          <div className="panelTitle"><Sparkles size={16} /> AI 邮件助手</div>
          <p className="panelDescription">支持 OpenAI 兼容的第三方 API。邮件内容会发送到你配置的服务商。</p>
          {state.aiSettings ? (
            <div className="integrationForm">
              <label className="switchLine">
                <input type="checkbox" checked={state.aiSettings.enabled} onChange={(event) => setState({ aiSettings: { ...state.aiSettings!, enabled: event.target.checked } })} />
                <span>启用 AI 功能</span>
              </label>
              <label>API 地址<input value={state.aiSettings.base_url} onChange={(event) => setState({ aiSettings: { ...state.aiSettings!, base_url: event.target.value } })} placeholder="https://api.openai.com/v1" /></label>
              <label>模型<input value={state.aiSettings.model} onChange={(event) => setState({ aiSettings: { ...state.aiSettings!, model: event.target.value } })} placeholder="gpt-4.1-mini" /></label>
              <label>温度<input type="number" min={0} max={2} step={0.1} value={state.aiSettings.temperature} onChange={(event) => setState({ aiSettings: { ...state.aiSettings!, temperature: Number(event.target.value) } })} /></label>
              <label>API Key<input type="password" autoComplete="off" value={state.aiApiKeyInput} onChange={(event) => setState({ aiApiKeyInput: event.target.value, clearAiApiKey: false })} placeholder={state.aiSettings.api_key_configured ? "已保存，留空则不修改" : "请填写 API Key"} /></label>
              {state.aiSettings.api_key_configured && (
                <label className="filterCheck"><input type="checkbox" checked={state.clearAiApiKey} onChange={(event) => setState({ clearAiApiKey: event.target.checked, aiApiKeyInput: "" })} /> 清除已保存的 Key</label>
              )}
              <label>系统提示词<textarea rows={6} value={state.aiSettings.system_prompt} onChange={(event) => setState({ aiSettings: { ...state.aiSettings!, system_prompt: event.target.value } })} /></label>
              <div className="buttonRow">
                <button className="secondaryAction" onClick={saveAiSettings}><Check size={15} /> 保存 AI 配置</button>
                <button className="secondaryAction" onClick={testAiSettings}><Wrench size={15} /> 保存并测试</button>
              </div>
            </div>
          ) : <p className="emptyText">AI 配置加载中</p>}
        </div>

        <div className="panel integrationPanel">
          <div className="panelTitle"><Languages size={16} /> 邮件翻译</div>
          <p className="panelDescription">Google 为默认免费通道。使用翻译会将正文发送给对应第三方。</p>
          {state.translationSettings ? (
            <div className="integrationForm">
              <label className="switchLine">
                <input type="checkbox" checked={state.translationSettings.enabled} onChange={(event) => setState({ translationSettings: { ...state.translationSettings!, enabled: event.target.checked } })} />
                <span>启用翻译</span>
              </label>
              <label>服务商
                <select value={state.translationSettings.provider} onChange={(event) => setState({ translationSettings: { ...state.translationSettings!, provider: event.target.value as TranslationProvider } })}>
                  <option value="google">Google 免费翻译</option>
                  <option value="libretranslate">LibreTranslate</option>
                  <option value="custom">自定义接口</option>
                </select>
              </label>
              {state.translationSettings.provider !== "google" && (
                <label>接口地址<input value={state.translationSettings.endpoint} onChange={(event) => setState({ translationSettings: { ...state.translationSettings!, endpoint: event.target.value } })} placeholder="https://translate.example.com/translate" /></label>
              )}
              <label>默认目标语言
                <select value={state.translationSettings.default_target_language} onChange={(event) => setState({ translationSettings: { ...state.translationSettings!, default_target_language: event.target.value } })}>
                  {!translationLanguageOptions.some(([value]) => value === state.translationSettings!.default_target_language) ? (
                    <option value={state.translationSettings.default_target_language}>{state.translationSettings.default_target_language}</option>
                  ) : null}
                  {translationLanguageOptions.map(([value, label]) => <option key={value} value={value}>{label} · {value}</option>)}
                </select>
              </label>
              <label className="switchLine">
                <input
                  type="checkbox"
                  disabled={!state.translationSettings.enabled}
                  checked={state.translationSettings.auto_translate_english_on_open}
                  onChange={(event) => setState({ translationSettings: { ...state.translationSettings!, auto_translate_english_on_open: event.target.checked } })}
                />
                <span>打开明确识别为英文的邮件时自动翻译</span>
              </label>
              <p className="translationPrivacyHint"><ShieldCheck size={15} /> 自动翻译会把邮件正文发送给当前翻译服务商；默认关闭，原文始终先显示。</p>
              {state.translationSettings.provider !== "google" && (
                <label>API Key<input type="password" autoComplete="off" value={state.translationApiKeyInput} onChange={(event) => setState({ translationApiKeyInput: event.target.value, clearTranslationApiKey: false })} placeholder={state.translationSettings.api_key_configured ? "已保存，留空则不修改" : "可选 API Key"} /></label>
              )}
              {state.translationSettings.api_key_configured && state.translationSettings.provider !== "google" && (
                <label className="filterCheck"><input type="checkbox" checked={state.clearTranslationApiKey} onChange={(event) => setState({ clearTranslationApiKey: event.target.checked, translationApiKeyInput: "" })} /> 清除已保存的 Key</label>
              )}
              <div className="buttonRow">
                <button className="secondaryAction" onClick={saveTranslationSettings}><Check size={15} /> 保存翻译配置</button>
                <button className="secondaryAction" onClick={testTranslationSettings}><Wrench size={15} /> 保存并测试</button>
              </div>
            </div>
          ) : <p className="emptyText">翻译配置加载中</p>}
        </div>
        {state.integrationMessage && <div className="panel integrationNotice" role="status">{state.integrationMessage}</div>}
      </>}

      {state.settingsTab === "access" && <>

      <div className="panel">
        <div className="panelTitle"><Users size={16} /> 管理员</div>
        {state.admins.map((admin) => (
          <div className="accountManageRow" key={admin.id}>
            <div>
              <span>{admin.name}</span>
              <small>{admin.email}</small>
            </div>
            <div className="rowActions">
              {state.admin?.id !== admin.id && (
                <button className="rowAction" onClick={() => openResetAdminDialog(admin)} title="重置密码"><Lock size={13} /></button>
              )}
            </div>
          </div>
        ))}
        <button className="secondaryAction fullWidth" onClick={openAdminDialog}>
          <UserPlus size={15} /> 新增管理员
        </button>
        <button className="secondaryAction fullWidth" onClick={openPasswordDialog}>
          <Lock size={15} /> 修改密码
        </button>
      </div>

      <div className="panel">
        <div className="panelTitle"><Wrench size={16} /> MCP 与发信 API</div>
        <div className="mcpEndpointBox">
          <span>MCP 远程端点</span>
          <code>{mcpRemoteEndpoint}</code>
          <span>HTTP 发信端点</span>
          <code>POST {sendApiEndpoint}</code>
          <small>请求头：<code>Authorization: Bearer sk_submail_xxx</code></small>
        </div>
        {mcpToolNames.map((tool) => (
          <div className="toolRow" key={tool}>
            <Sparkles size={14} />
            <code>{tool}</code>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panelTitle"><KeyRound size={16} /> MCP / API Key</div>
        {state.apiKeys.map((apiKey) => (
          <div className="apiKeyRow" key={apiKey.id}>
            <div className="apiKeyMain">
              <span>{apiKey.name}</span>
              <small>{apiKey.key_prefix}... · 调用 {apiKey.call_count} 次 · 最后使用 {formatDate(apiKey.last_used_at)}</small>
              <small>{apiKey.account_ids?.length ? `限定 ${apiKey.account_ids.length} 个邮箱` : "全部邮箱"} · {apiKey.expires_at ? `过期 ${formatDate(apiKey.expires_at)}` : "永不过期"} · 日发送上限 {apiKey.daily_send_limit ?? 100}</small>
              {apiKey.revoked_at && <small className="errorText">已撤销</small>}
              <div className="scopePills">
                {apiKey.scopes.map((scope) => <code key={scope}>{mcpScopeLabel(scope)}</code>)}
              </div>
            </div>
            <button className="rowAction danger" onClick={() => deleteMcpKey(apiKey.id)} title="删除"><Trash2 size={13} /></button>
          </div>
        ))}
        <div className="mcpKeyForm">
          <label>Key 名称<input value={state.mcpKeyName} onChange={(event) => setState({ mcpKeyName: event.target.value })} /></label>
          <div className="scopeGrid">
            {mcpScopeOptions.map((scope) => (
              <label className="filterCheck" key={scope.value}>
                <input
                  type="checkbox"
                  checked={state.mcpKeyScopes.includes(scope.value)}
                  onChange={(event) => {
                    const nextScopes = event.target.checked
                      ? [...state.mcpKeyScopes, scope.value]
                      : state.mcpKeyScopes.filter((item) => item !== scope.value);
                    setState({ mcpKeyScopes: nextScopes });
                  }}
                />
                {scope.label}
              </label>
            ))}
          </div>
          <label className="filterCheck"><input type="checkbox" checked={state.mcpKeyAllAccounts} onChange={(event) => setState({ mcpKeyAllAccounts: event.target.checked, mcpKeyAccountIds: [] })} /> 允许全部当前及未来邮箱</label>
          {!state.mcpKeyAllAccounts && (
            <div className="accountScopeGrid">
              {state.accounts.map((account) => (
                <label className="filterCheck" key={account.id}>
                  <input type="checkbox" checked={state.mcpKeyAccountIds.includes(account.id)} onChange={(event) => {
                    const nextAccountIds = event.target.checked
                      ? [...state.mcpKeyAccountIds, account.id]
                      : state.mcpKeyAccountIds.filter((id) => id !== account.id);
                    setState({ mcpKeyAccountIds: nextAccountIds });
                  }} />
                  {account.display_name} · {account.email}
                </label>
              ))}
            </div>
          )}
          <div className="mcpKeyLimits">
            <label>过期时间<input type="datetime-local" value={state.mcpKeyExpiresAt} onChange={(event) => setState({ mcpKeyExpiresAt: event.target.value })} /></label>
            <label>每日发送上限<input type="number" min={0} max={10000} value={state.mcpKeyDailySendLimit} onChange={(event) => setState({ mcpKeyDailySendLimit: Number(event.target.value) })} /></label>
          </div>
          {state.mcpKeyMessage && <p className="inlineNotice" role="status">{state.mcpKeyMessage}</p>}
          <button className="secondaryAction fullWidth" onClick={createMcpKey}>
            <Plus size={15} /> 生成 Key
          </button>
        </div>
        {state.newApiKey && (
          <div className="keySecretBox">
            <p className="keySecret">{state.newApiKey}</p>
            <button className="secondaryAction fullWidth" onClick={copyNewMcpKey}><Copy size={15} /> 复制完整 Key</button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panelTitle"><Activity size={16} /> MCP 调用日志</div>
        {state.mcpLogs.length === 0 && <p className="emptyText">暂无调用记录</p>}
        {state.mcpLogs.slice(0, 6).map((log) => (
          <div className="logRow" key={log.id}>
            <span>{log.tool_name}</span>
            <small className={log.status === "ok" ? "okText" : "errorText"}>{log.status} · {formatDate(log.created_at)}</small>
          </div>
        ))}
      </div>

      <div className="panel compact">
        <div className="panelTitle"><Clock3 size={16} /> 部署形态</div>
        <p>
          Docker + {state.setupStatus?.databaseDriver === "mysql" ? "MySQL" : "SQLite"} + Redis 队列；
          附件当前存储在数据库 BLOB，后续可适配本地文件或 S3/MinIO。
        </p>
      </div>
      </>}
    </aside>
  );
}

function SettingsDialog({
  state,
  createMcpKey,
  deleteMcpKey,
  copyNewMcpKey,
  openAdminDialog,
  openPasswordDialog,
  openResetAdminDialog,
  syncAccount,
  testAccount,
  editAccount,
  deleteAccount,
  saveEmailDisplaySettings,
  saveSyncSettings,
  runAllSync,
  cancelSyncRun,
  openSyncRunDetails,
  saveAttachmentSettings,
  previewAttachment,
  saveAiSettings,
  testAiSettings,
  saveTranslationSettings,
  testTranslationSettings,
  setState,
  downloadAttachment,
  onClose
}: {
  state: State;
  createMcpKey: () => void;
  deleteMcpKey: (id: string) => void;
  copyNewMcpKey: () => void;
  openAdminDialog: () => void;
  openPasswordDialog: () => void;
  openResetAdminDialog: (admin: Admin) => void;
  syncAccount: (id: string) => void;
  testAccount: (account: Account) => void;
  editAccount: (account: Account) => void;
  deleteAccount: (account: Account) => void;
  saveEmailDisplaySettings: () => void;
  saveSyncSettings: () => void;
  runAllSync: () => void;
  cancelSyncRun: (run: SyncRun) => void;
  openSyncRunDetails: (run: SyncRun) => void;
  saveAttachmentSettings: () => void;
  previewAttachment: (attachment: Attachment) => void;
  saveAiSettings: () => void;
  testAiSettings: () => void;
  saveTranslationSettings: () => void;
  testTranslationSettings: () => void;
  setState: (value: Partial<State>) => void;
  downloadAttachment: (attachment: Attachment) => void;
  onClose: () => void;
}) {
  return (
    <div className="modalLayer">
      <section className="modal settingsModal">
        <div className="settingsHeader">
          <div>
            <h2>设置</h2>
            <p>邮箱同步、AI/翻译与 MCP 访问配置</p>
          </div>
          <button type="button" className="toolbarButton" onClick={onClose}>关闭</button>
        </div>
        <nav className="settingsTabs" aria-label="设置分组">
          {([
            ["mail", "邮箱与同步"],
            ["integrations", "AI 与翻译"],
            ["access", "MCP 与管理员"]
          ] as Array<[SettingsTab, string]>).map(([tab, label]) => (
            <button key={tab} type="button" className={state.settingsTab === tab ? "active" : ""} onClick={() => setState({ settingsTab: tab })}>{label}</button>
          ))}
        </nav>
        <Inspector
          state={state}
          createMcpKey={createMcpKey}
          deleteMcpKey={deleteMcpKey}
          copyNewMcpKey={copyNewMcpKey}
          openAdminDialog={openAdminDialog}
          openPasswordDialog={openPasswordDialog}
          openResetAdminDialog={openResetAdminDialog}
          syncAccount={syncAccount}
          testAccount={testAccount}
          editAccount={editAccount}
          deleteAccount={deleteAccount}
          saveEmailDisplaySettings={saveEmailDisplaySettings}
          saveSyncSettings={saveSyncSettings}
          runAllSync={runAllSync}
          cancelSyncRun={cancelSyncRun}
          openSyncRunDetails={openSyncRunDetails}
          saveAttachmentSettings={saveAttachmentSettings}
          previewAttachment={previewAttachment}
          saveAiSettings={saveAiSettings}
          testAiSettings={testAiSettings}
          saveTranslationSettings={saveTranslationSettings}
          testTranslationSettings={testTranslationSettings}
          setState={setState}
          downloadAttachment={downloadAttachment}
        />
      </section>
    </div>
  );
}

function AccountDialog({ account, onClose, onCreated }: { account?: Account; onClose: () => void; onCreated: () => void | Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [aliases, setAliases] = React.useState<AccountAlias[]>(() => account?.aliases.map((alias) => ({ ...alias })) ?? []);
  const [verificationCodes, setVerificationCodes] = React.useState<Record<string, string>>({});
  const [email, setEmail] = React.useState(account?.email ?? "");
  const [username, setUsername] = React.useState(account?.username ?? "");
  const [incomingProtocol, setIncomingProtocol] = React.useState<IncomingProtocol>(account?.incoming_protocol ?? "imap");
  const [authMode, setAuthMode] = React.useState<MailAuthMode>(account?.auth_mode ?? "app_password");
  const [incomingHost, setIncomingHost] = React.useState(normalizeMailboxHostInput(account?.imap_host));
  const [incomingPort, setIncomingPort] = React.useState(account?.imap_port ?? 993);
  const [incomingSecure, setIncomingSecure] = React.useState(account?.imap_secure ?? true);
  const [smtpHost, setSmtpHost] = React.useState(normalizeMailboxHostInput(account?.smtp_host));
  const [smtpPort, setSmtpPort] = React.useState(account?.smtp_port ?? 465);
  const [smtpSecure, setSmtpSecure] = React.useState(account?.smtp_secure ?? true);
  const provider = React.useMemo(() => detectMailProvider(email), [email]);

  React.useEffect(() => {
    if (provider.passwordAuthSupported === false && authMode !== "app_password") setAuthMode("app_password");
  }, [provider, authMode]);

  function applyProviderSettings(protocol: IncomingProtocol = incomingProtocol) {
    const incoming = protocol === "pop3" ? provider.pop3 : provider.imap;
    if (!incoming) {
      setError(`${provider.name} 不支持 ${protocol.toUpperCase()}，请改用 ${provider.imap ? "IMAP" : "服务商提供的其他方式"}。`);
      return;
    }
    setIncomingProtocol(protocol);
    setIncomingHost(incoming.host);
    setIncomingPort(incoming.port);
    setIncomingSecure(incoming.secure);
    setSmtpHost(provider.smtp.host);
    setSmtpPort(provider.smtp.port);
    setSmtpSecure(provider.smtp.secure);
    setAuthMode(provider.preferredAuth);
    setError(undefined);
  }

  function changeEmail(nextEmail: string) {
    const previousEmail = email;
    setEmail(nextEmail);
    if (!account && (!username || username === previousEmail)) setUsername(nextEmail);
  }

  function updateAlias(id: string, patch: Partial<AccountAlias>) {
    setAliases((current) => current.map((alias) => alias.id === id ? { ...alias, ...patch } : alias));
  }

  function addAlias() {
    setAliases((current) => [...current, {
      id: `new_${Date.now()}`,
      email: "",
      display_name: "",
      reply_to: "",
      send_enabled: false,
      verification_status: "unverified",
      verification_expires_at: null,
      verified_at: null
    }]);
  }

  async function sendAliasVerification(alias: AccountAlias) {
    if (!account || alias.id.startsWith("new_")) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ alias: AccountAlias }>(`/api/accounts/${encodeURIComponent(account.id)}/aliases/${encodeURIComponent(alias.id)}/verification`, { method: "POST" });
      updateAlias(alias.id, result.alias);
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "验证码发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmAliasVerification(alias: AccountAlias) {
    if (!account) return;
    const code = verificationCodes[alias.id]?.trim() ?? "";
    if (!/^\d{6}$/.test(code)) {
      setError("请输入 6 位邮箱验证码");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api<{ alias: AccountAlias }>(`/api/accounts/${encodeURIComponent(account.id)}/aliases/${encodeURIComponent(alias.id)}/verification/confirm`, {
        method: "POST",
        body: JSON.stringify({ code })
      });
      updateAlias(alias.id, result.alias);
      setVerificationCodes((current) => ({ ...current, [alias.id]: "" }));
      await onCreated();
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "别名验证失败");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError(undefined);
    try {
      await api(account ? `/api/accounts/${encodeURIComponent(account.id)}` : "/api/accounts", {
        method: account ? "PUT" : "POST",
        body: JSON.stringify({
          email: String(form.get("email") ?? "").trim(),
          displayName: String(form.get("displayName") ?? "").trim(),
          notes: String(form.get("notes") ?? "").trim(),
          aliases: aliases.filter((alias) => alias.email.trim()).map((alias) => ({
            ...(alias.id.startsWith("new_") ? {} : { id: alias.id }),
            email: alias.email.trim(),
            displayName: alias.display_name.trim(),
            replyTo: alias.reply_to.trim(),
            sendEnabled: alias.send_enabled
          })),
          username: String(form.get("username") ?? "").trim(),
          ...(password ? { password } : {}),
          incomingProtocol,
          authMode,
          imapHost: normalizeMailboxHostInput(form.get("imapHost")),
          imapPort: Number(form.get("imapPort")),
          imapSecure: form.get("imapSecure") === "on",
          smtpHost: normalizeMailboxHostInput(form.get("smtpHost")),
          smtpPort: Number(form.get("smtpPort")),
          smtpSecure: form.get("smtpSecure") === "on"
        })
      });
      await onCreated();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "邮箱保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalLayer">
      <form className="modal accountModal" onSubmit={submit}>
        <div className="accountModalHeader">
          <div>
            <h2>{account ? "编辑邮箱" : "添加邮箱"}</h2>
            <p>建议使用邮箱服务商提供的客户端授权码，不要填写网页登录密码。</p>
          </div>
        </div>
        <div className="formGrid">
          <div className="formSectionTitle">账号信息</div>
          <label>显示名称<input name="displayName" required placeholder="工作邮箱" defaultValue={account?.display_name} /></label>
          <label>邮箱地址<input name="email" type="email" required placeholder="name@example.com" value={email} onChange={(event) => changeEmail(event.target.value)} /></label>
          <div className="formWide providerSuggestion">
            <MailProviderIcon email={email} size={42} />
            <div><strong>{provider.name}</strong><small>{provider.id === "generic" ? "暂未识别服务商，可手动填写服务器" : `已根据 @${email.split("@").at(-1) ?? ""} 识别`}</small></div>
            {provider.id !== "generic" && <button type="button" className="secondaryAction" onClick={() => applyProviderSettings()}><Check size={14} /> 应用推荐配置</button>}
          </div>
          <label className="formWide">备注<textarea name="notes" rows={2} placeholder="例如：客户支持主邮箱、仅用于账单通知" defaultValue={account?.notes} /></label>
          <div className="formWide aliasIdentitySection">
            <div className="aliasIdentityHeader">
              <div><strong>自有邮箱地址 / 发信身份</strong><small>这些地址都指向当前真实邮箱；它们只用于识别“我”和选择 From，不决定邮件是否属于同一对话。</small></div>
              <button type="button" className="secondaryAction" onClick={addAlias}><Plus size={14} /> 添加地址</button>
            </div>
            {aliases.length === 0 ? <p className="emptyText">暂无其他自有邮箱地址</p> : (
              <div className="aliasIdentityList">
                {aliases.map((alias) => (
                  <div className="aliasIdentityCard" key={alias.id}>
                    <label>邮箱地址<input type="email" value={alias.email} placeholder="alias@example.com" onChange={(event) => updateAlias(alias.id, { email: event.target.value, verification_status: "unverified", send_enabled: false })} /></label>
                    <label>显示名称<input value={alias.display_name} placeholder="例如：销售团队" onChange={(event) => updateAlias(alias.id, { display_name: event.target.value })} /></label>
                    <label>Reply-To<input type="email" value={alias.reply_to} placeholder="留空使用该别名" onChange={(event) => updateAlias(alias.id, { reply_to: event.target.value })} /></label>
                    <label className="aliasSendToggle"><input type="checkbox" checked={alias.send_enabled} disabled={alias.verification_status !== "verified"} onChange={(event) => updateAlias(alias.id, { send_enabled: event.target.checked })} /> 允许作为发信身份</label>
                    <div className={`aliasStatus ${alias.verification_status}`}>
                      {alias.verification_status === "verified" ? "已验证" : alias.verification_status === "pending" ? "等待验证码" : "未验证"}
                    </div>
                    <div className="aliasVerificationActions">
                      {alias.verification_status === "pending" && !alias.id.startsWith("new_") && (
                        <>
                          <input inputMode="numeric" maxLength={6} value={verificationCodes[alias.id] ?? ""} placeholder="6 位验证码" onChange={(event) => setVerificationCodes((current) => ({ ...current, [alias.id]: event.target.value.replace(/\D/g, "").slice(0, 6) }))} />
                          <button type="button" className="secondaryAction" disabled={busy} onClick={() => confirmAliasVerification(alias)}>确认验证</button>
                        </>
                      )}
                      {alias.verification_status !== "verified" && (
                        <button type="button" className="secondaryAction" disabled={busy || alias.id.startsWith("new_")} title={alias.id.startsWith("new_") ? "请先保存邮箱设置" : undefined} onClick={() => sendAliasVerification(alias)}>{alias.verification_status === "pending" ? "重新发送" : "发送验证码"}</button>
                      )}
                      <button type="button" className="toolbarIcon dangerButton" title="移除此地址" onClick={() => setAliases((current) => current.filter((item) => item.id !== alias.id))}><Trash2 size={15} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <label>用户名<input name="username" required placeholder="通常为完整邮箱地址" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>认证方式
            <select name="authMode" value={authMode} onChange={(event) => setAuthMode(event.target.value as MailAuthMode)}>
              <option value="app_password">应用专用密码 / 客户端授权码</option>
              <option value="password" disabled={provider.passwordAuthSupported === false}>普通账号密码{provider.passwordAuthSupported === false ? "（该服务商不支持）" : ""}</option>
            </select>
          </label>
          <label>{authMode === "app_password" ? "应用专用密码 / 授权码" : "邮箱密码"}<input name="password" type="password" autoComplete="new-password" required={!account || account.auth_mode !== authMode} placeholder={account && account.auth_mode === authMode ? "留空则不修改" : authMode === "app_password" ? "粘贴服务商生成的授权码" : undefined} /></label>
          <div className="formWide authModeHelp"><ShieldCheck size={17} /><span><strong>二次验证说明</strong>{provider.authHelp}</span></div>
          <div className="formSectionTitle">接收服务器 · {incomingProtocol.toUpperCase()}</div>
          <label>收件协议
            <select value={incomingProtocol} onChange={(event) => {
              const protocol = event.target.value as IncomingProtocol;
              setIncomingProtocol(protocol);
              if (provider.id !== "generic") applyProviderSettings(protocol);
              else {
                setIncomingPort(protocol === "pop3" ? 995 : 993);
                setIncomingSecure(true);
              }
            }}>
              <option value="imap">IMAP（推荐，可同步收件箱和已发送）</option>
              <option value="pop3" disabled={provider.id !== "generic" && !provider.pop3}>POP3（仅同步收件箱）</option>
            </select>
          </label>
          <label>{incomingProtocol.toUpperCase()} 主机<input name="imapHost" required placeholder={incomingProtocol === "pop3" ? "pop.example.com" : "imap.example.com"} value={incomingHost} onChange={(event) => setIncomingHost(event.target.value)} /></label>
          <label>{incomingProtocol.toUpperCase()} 端口<input name="imapPort" type="number" value={incomingPort} onChange={(event) => setIncomingPort(Number(event.target.value))} required /></label>
          <label className="checkLabel"><input name="imapSecure" type="checkbox" checked={incomingSecure} onChange={(event) => setIncomingSecure(event.target.checked)} /> {incomingProtocol.toUpperCase()} 直连 TLS{incomingProtocol === "imap" ? "（未勾选则强制 STARTTLS）" : ""}</label>
          {incomingProtocol === "pop3" && <div className="formWide protocolNotice"><Inbox size={16} /><span>POP3 通过 UIDL 增量去重，只读取收件箱且不会删除服务器邮件；“已发送”需由 SMTP 本地记录，无法从 POP3 服务器补齐。</span></div>}
          <div className="formSectionTitle">发送服务器 · SMTP</div>
          <label>SMTP 主机<input name="smtpHost" required placeholder="smtp.example.com" value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} /></label>
          <label>SMTP 端口<input name="smtpPort" type="number" value={smtpPort} onChange={(event) => setSmtpPort(Number(event.target.value))} required /></label>
          <label className="checkLabel"><input name="smtpSecure" type="checkbox" checked={smtpSecure} onChange={(event) => setSmtpSecure(event.target.checked)} /> SMTP 直连 TLS（未勾选则强制 STARTTLS）</label>
        </div>
        {error && <p className="authError accountDialogError">{error}</p>}
        <div className="modalActions">
          <button type="button" className="toolbarButton" onClick={onClose} disabled={busy}>取消</button>
          <button className="composeButton" disabled={busy}>{busy ? "保存中…" : account ? "保存修改" : "保存邮箱"}</button>
        </div>
      </form>
    </div>
  );
}

function parseRecipientText(message?: Message): string {
  if (!message?.recipients) return "";
  try {
    const recipients = JSON.parse(message.recipients);
    return Array.isArray(recipients) ? recipients.join(", ") : "";
  } catch {
    return "";
  }
}

function normalizeSubject(prefix: "Re" | "Fwd", subject: string): string {
  const clean = subject || "(无主题)";
  return new RegExp(`^${prefix}:`, "i").test(clean) ? clean : `${prefix}: ${clean}`;
}

function quotedBody(message: Message): string {
  const sender = message.sender_name || message.sender_email || "未知发件人";
  const sentAt = formatDate(message.sent_at);
  const body = message.text_body || message.snippet || "";
  return `\n\n---- 原始邮件 ----\n发件人：${sender}\n时间：${sentAt}\n主题：${message.subject}\n\n${body}`;
}

function preferredFromAlias(message: Message, accounts: Account[]): string | undefined {
  const account = accounts.find((item) => item.id === message.account_id);
  if (!account) return undefined;
  const ownAddresses = message.folder === "Sent"
    ? [message.sender_email ?? ""]
    : parseRecipientText(message).split(",").map((item) => item.trim());
  return account.aliases.find((alias) => ownAddresses.some((address) => address.toLowerCase() === alias.email.toLowerCase()) && alias.verification_status === "verified" && alias.send_enabled)?.id;
}

function replyPrefill(message: Message, accounts: Account[]): ComposerPrefill {
  let references: string[] = [];
  try {
    const parsed = JSON.parse(message.reference_ids ?? "[]");
    references = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    references = [];
  }
  if (message.message_id && !references.includes(message.message_id)) references.push(message.message_id);
  return {
    accountId: message.account_id,
    fromAliasId: preferredFromAlias(message, accounts),
    to: message.folder === "Sent" ? parseRecipientText(message) : message.sender_email ?? "",
    subject: normalizeSubject("Re", message.subject),
    text: quotedBody(message),
    inReplyTo: message.message_id ?? undefined,
    references
  };
}

function forwardPrefill(message: Message, accounts: Account[]): ComposerPrefill {
  const sender = message.sender_name || message.sender_email || "未知发件人";
  return {
    accountId: message.account_id,
    fromAliasId: preferredFromAlias(message, accounts),
    to: "",
    subject: normalizeSubject("Fwd", message.subject),
    text: `\n\n---- 转发邮件 ----\n发件人：${sender}\n时间：${formatDate(message.sent_at)}\n收件人：${parseRecipientText(message)}\n\n${message.text_body || message.snippet || ""}`
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("附件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function composerPayload(form: HTMLFormElement, files: File[], prefill?: ComposerPrefill) {
  const data = new FormData(form);
  const [accountId, fromAliasId] = String(data.get("identity") ?? "").split("::", 2);
  const payload: {
    accountId: string;
    fromAliasId?: string;
    to: string[];
    subject: string;
    text: string;
    attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
    inReplyTo?: string;
    references?: string[];
  } = {
    accountId,
    ...(fromAliasId && fromAliasId !== "primary" ? { fromAliasId } : {}),
    to: String(data.get("to") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    subject: String(data.get("subject") ?? ""),
    text: String(data.get("text") ?? ""),
    ...(prefill?.inReplyTo ? { inReplyTo: prefill.inReplyTo } : {}),
    ...(prefill?.references?.length ? { references: prefill.references } : {})
  };
  if (files.length > 0) {
    payload.attachments = await Promise.all(files.map(async (file) => ({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      contentBase64: await readFileAsBase64(file)
    })));
  }
  return payload;
}

function Composer({
  accounts,
  draft,
  prefill,
  draftAttachments,
  maxAttachmentBytes,
  onClose,
  onChanged,
  onDeliveryStatus
}: {
  accounts: Account[];
  draft?: Message;
  prefill?: ComposerPrefill;
  draftAttachments: Attachment[];
  maxAttachmentBytes?: number;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onDeliveryStatus: (message: string) => void;
}) {
  const [files, setFiles] = React.useState<File[]>([]);
  const [error, setError] = React.useState("");
  const [subject, setSubject] = React.useState(draft ? (draft.subject === "(无主题)" ? "" : draft.subject) : (prefill?.subject ?? ""));
  const [text, setText] = React.useState(draft?.text_body ?? prefill?.text ?? "");
  const [aiPrompt, setAiPrompt] = React.useState("");
  const [aiBusy, setAiBusy] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const identities = React.useMemo(() => accounts.flatMap((account) => [
    { value: `${account.id}::primary`, accountId: account.id, email: account.email, label: `${account.display_name} · ${account.email}（主地址）` },
    ...account.aliases
      .filter((alias) => alias.verification_status === "verified" && alias.send_enabled)
      .map((alias) => ({ value: `${account.id}::${alias.id}`, accountId: account.id, email: alias.email, label: `${alias.display_name || account.display_name} · ${alias.email}（已验证别名）` }))
  ]), [accounts]);
  const defaultIdentity = React.useMemo(() => {
    if (draft?.sender_email) {
      const match = identities.find((identity) => identity.accountId === draft.account_id && identity.email.toLowerCase() === draft.sender_email?.toLowerCase());
      if (match) return match.value;
    }
    if (prefill?.accountId && prefill.fromAliasId) return `${prefill.accountId}::${prefill.fromAliasId}`;
    if (prefill?.accountId) return `${prefill.accountId}::primary`;
    return identities[0]?.value;
  }, [draft?.account_id, draft?.sender_email, identities, prefill?.accountId, prefill?.fromAliasId]);

  async function generateWithAi() {
    const prompt = aiPrompt.trim();
    if (!prompt) {
      setError("请先输入希望 AI 撰写的邮件要求");
      return;
    }
    setError("");
    setAiBusy(true);
    try {
      const result = await api<{ subject: string; text: string }>("/api/ai/compose", {
        method: "POST",
        body: JSON.stringify({ prompt, subjectHint: subject || undefined })
      });
      setSubject(result.subject || subject);
      setText(result.text);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "AI 生成失败");
    } finally {
      setAiBusy(false);
    }
  }

  function validateFiles() {
    const maxBytes = maxAttachmentBytes ?? 10 * 1024 * 1024;
    const tooLarge = files.find((file) => file.size > maxBytes);
    if (!tooLarge) return true;
    setError(`附件 ${tooLarge.name} 超过大小限制 ${formatSize(maxBytes)}`);
    return false;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!validateFiles()) return;
    setSending(true);
    try {
      const payload = await composerPayload(event.currentTarget, files, prefill);
      let result: { rejected?: string[]; localRecordSaved?: boolean; warning?: string };
      if (draft) {
        await api(`/api/drafts/${encodeURIComponent(draft.id)}`, {
          method: "PATCH",
          body: JSON.stringify(payload)
        });
        result = await api(`/api/drafts/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
      } else {
        result = await api("/api/send", {
          method: "POST",
          body: JSON.stringify(payload)
        });
      }
      await onChanged();
      if (result.localRecordSaved === false) {
        onDeliveryStatus(result.warning ?? "邮件已发送，但本地记录保存失败；请勿直接重发");
      } else if ((result.rejected?.length ?? 0) > 0) {
        onDeliveryStatus(`邮件已部分发送：${result.rejected?.length ?? 0} 个收件人被上游拒绝`);
      } else {
        onDeliveryStatus("邮件已发送");
      }
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "邮件发送失败");
    } finally {
      setSending(false);
    }
  }

  async function saveDraft(event: React.MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    setError("");
    if (!validateFiles()) return;
    const payload = await composerPayload(form, files, prefill);
    await api(draft ? `/api/drafts/${encodeURIComponent(draft.id)}` : "/api/drafts", {
      method: draft ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    await onChanged();
    onClose();
  }

  return (
    <div className="modalLayer">
      <form className="modal composer" onSubmit={submit}>
        <h2>{draft ? "编辑草稿" : "写邮件"}</h2>
        <label>发信身份
          <select name="identity" required defaultValue={defaultIdentity}>
            {identities.map((identity) => <option key={identity.value} value={identity.value}>{identity.label}</option>)}
          </select>
          <small>未验证或未启用的别名不会出现在这里。</small>
        </label>
        <label>收件人<input name="to" type="text" required placeholder="user@example.com, team@example.com" defaultValue={draft ? parseRecipientText(draft) : prefill?.to} /></label>
        <div className="composerAiBox">
          <div>
            <strong><Sparkles size={16} /> AI 生成邮件</strong>
            <small>生成结果只会填入主题和正文，不会自动发送。</small>
          </div>
          <textarea rows={3} value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="例如：写一封简洁的项目进度确认邮件，语气专业" />
          <button type="button" className="secondaryAction" disabled={aiBusy} onClick={generateWithAi}>{aiBusy ? "正在生成" : "生成并填入"}</button>
        </div>
        <label>主题<input name="subject" required value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <label>正文<textarea name="text" rows={8} required value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label className="customFileField">
          <span>附件</span>
          <span className="customFilePicker"><Paperclip size={16} /> 选择附件</span>
          <input className="visuallyHiddenFile" name="attachments" type="file" multiple onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))} />
          <small>{files.length > 0 ? `已选择 ${files.length} 个文件` : "支持多选，发送前不会自动上传"}</small>
        </label>
        {(files.length > 0 || draftAttachments.length > 0) && (
          <div className="composerAttachments">
            {files.length > 0
              ? files.map((file) => <span key={`${file.name}-${file.size}`}>{file.name} · {formatSize(file.size)}</span>)
              : draftAttachments.map((attachment) => <span key={attachment.id}>{attachment.filename} · {formatSize(attachment.size)}</span>)}
          </div>
        )}
        {error && <p className="authError">{error}</p>}
        <div className="modalActions">
          <button type="button" className="toolbarButton" disabled={sending} onClick={onClose}>取消</button>
          <button type="button" className="toolbarButton" disabled={sending} onClick={saveDraft}><FileText size={15} /> 保存草稿</button>
          <button className="composeButton" disabled={sending}>{sending ? "发送中…" : "发送"}</button>
        </div>
      </form>
    </div>
  );
}

function AttachmentPreviewDialog({ preview, onClose, onDownload }: { preview: AttachmentPreview; onClose: () => void; onDownload: (attachment: Attachment) => void }) {
  return (
    <div className="modalLayer">
      <section className="modal attachmentPreviewModal">
        <div className="settingsHeader">
          <div>
        <h2>{attachmentDisplayName(preview.attachment)}</h2>
            <p>{preview.attachment.content_type} · {formatSize(preview.attachment.size)}</p>
          </div>
          <div className="previewActions">
            <button type="button" className="toolbarButton" onClick={() => onDownload(preview.attachment)}><Download size={15} /> 下载</button>
            <button type="button" className="toolbarButton" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="attachmentPreviewBody">
          {preview.error && <p className="emptyText">{preview.error}</p>}
          {preview.file && (
            <React.Suspense fallback={<div className="viewerLoading">正在启动 Flyfish Viewer…</div>}>
              <FlyfishAttachmentViewer
                file={preview.file}
                filename={attachmentDisplayName(preview.attachment)}
                contentType={preview.attachment.content_type}
              />
            </React.Suspense>
          )}
        </div>
      </section>
    </div>
  );
}

function SavedSearchDialog({ defaultName, onClose, onSave }: { defaultName: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = React.useState(defaultName);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;
    onSave(cleanName);
  }

  return (
    <div className="modalLayer">
      <form className="modal savedSearchModal" onSubmit={submit}>
        <h2>保存搜索条件</h2>
        <label>名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label>
        <div className="modalActions">
          <button type="button" className="toolbarButton" onClick={onClose}>取消</button>
          <button className="composeButton"><Check size={15} /> 保存</button>
        </div>
      </form>
    </div>
  );
}

function SyncRunDetailDialog({ run, accounts, onClose, onCancel }: { run: SyncRun; accounts: Account[]; onClose: () => void; onCancel: (run: SyncRun) => void }) {
  return (
    <div className="modalLayer">
      <section className="modal syncRunDetailModal">
        <div className="settingsHeader">
          <div>
            <h2>同步任务详情</h2>
            <p>{run.id}</p>
          </div>
          <div className="previewActions">
            {run.status === "retry_scheduled" && (
              <button type="button" className="toolbarButton dangerButton" onClick={() => onCancel(run)}><Trash2 size={15} /> 取消重试</button>
            )}
            <button type="button" className="toolbarButton" onClick={onClose}>关闭</button>
          </div>
        </div>
        <div className="syncRunSummary">
          <div>
            <span>状态</span>
            <strong className={syncRunStatusClass(run.status)}>{syncRunStatusLabel(run.status)}</strong>
          </div>
          <div>
            <span>导入</span>
            <strong>{run.imported} 封</strong>
          </div>
          <div>
            <span>尝试</span>
            <strong>{run.attempts} 次</strong>
          </div>
          <div>
            <span>耗时</span>
            <strong>{formatDuration(run.started_at, run.finished_at)}</strong>
          </div>
        </div>
        <div className="syncRunDetailGrid">
          <div><span>账号</span><strong>{accountLabel(accounts, run.account_id)}</strong></div>
          <div><span>来源</span><strong>{syncRunTriggerLabel(run.trigger_type)}</strong></div>
          <div><span>开始</span><strong>{formatDate(run.started_at)}</strong></div>
          <div><span>结束</span><strong>{formatDate(run.finished_at)}</strong></div>
          <div><span>下次重试</span><strong>{formatDate(run.next_retry_at)}</strong></div>
        </div>
        {run.error && (
          <div className="syncRunError">
            <span>错误信息</span>
            <pre>{run.error}</pre>
          </div>
        )}
      </section>
    </div>
  );
}

function AdminDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password")
      })
    });
    onCreated();
    onClose();
  }

  return (
    <div className="modalLayer">
      <form className="modal composer" onSubmit={submit}>
        <h2>新增管理员</h2>
        <label>名称<input name="name" required placeholder="运营管理员" /></label>
        <label>邮箱<input name="email" type="email" required placeholder="ops@example.com" /></label>
        <label>初始密码<input name="password" type="password" minLength={8} required /></label>
        <div className="modalActions">
          <button type="button" className="toolbarButton" onClick={onClose}>取消</button>
          <button className="composeButton">创建管理员</button>
        </div>
      </form>
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setError("两次新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({
          oldPassword: form.get("oldPassword"),
          newPassword
        })
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改密码失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalLayer">
      <form className="modal composer" onSubmit={submit}>
        <h2>修改密码</h2>
        <label>当前密码<input name="oldPassword" type="password" required /></label>
        <label>新密码<input name="newPassword" type="password" minLength={8} required /></label>
        <label>确认新密码<input name="confirmPassword" type="password" minLength={8} required /></label>
        {error && <p className="authError">{error}</p>}
        <div className="modalActions">
          <button type="button" className="toolbarButton" onClick={onClose}>取消</button>
          <button className="composeButton" disabled={busy}>{busy ? "保存中" : "保存密码"}</button>
        </div>
      </form>
    </div>
  );
}

function ResetAdminPasswordDialog({ admin, onClose, onChanged }: { admin: Admin; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setError("两次新密码不一致");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/users/${encodeURIComponent(admin.id)}/password`, {
        method: "PUT",
        body: JSON.stringify({ newPassword })
      });
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置密码失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalLayer">
      <form className="modal composer" onSubmit={submit}>
        <h2>重置管理员密码</h2>
        <p className="authHint">{admin.name} · {admin.email}</p>
        <label>新密码<input name="newPassword" type="password" minLength={8} required /></label>
        <label>确认新密码<input name="confirmPassword" type="password" minLength={8} required /></label>
        {error && <p className="authError">{error}</p>}
        <div className="modalActions">
          <button type="button" className="toolbarButton" onClick={onClose}>取消</button>
          <button className="composeButton" disabled={busy}>{busy ? "重置中" : "重置密码"}</button>
        </div>
      </form>
    </div>
  );
}

function textFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function App() {
  const [state, rawSetState] = React.useState<State>({
    authChecked: false,
    admins: [],
    accounts: [],
    messages: [],
    selectedMessageIds: [],
    attachments: [],
    selectedAttachments: [],
    savedSearches: [],
    apiKeys: [],
    mcpLogs: [],
    syncRuns: [],
    selectedThreadMessages: [],
    conversationMode: true,
    query: "",
    searchSender: "",
    searchDateFrom: "",
    searchDateTo: "",
    searchHasAttachment: false,
    attachmentQuery: "",
    attachmentTypeFilter: "",
    syncRunStatusFilter: "",
    syncRunTriggerFilter: "",
    syncRunAccountFilter: "",
    activeView: "mail",
    activeFolder: "INBOX",
    inboxUnreadCount: 0,
    messagePage: 1,
    messagePageSize: 20,
    messageTotal: 0,
    attachmentPage: 1,
    attachmentPageSize: 20,
    attachmentTotal: 0,
    syncRunPage: 1,
    syncRunPageSize: 20,
    syncRunTotal: 0,
    isComposerOpen: false,
    isAccountDialogOpen: false,
    isAdminDialogOpen: false,
    isPasswordDialogOpen: false,
    isSettingsOpen: false,
    isAdvancedSearchOpen: false,
    settingsTab: "mail",
    isSavedSearchDialogOpen: false,
    aiApiKeyInput: "",
    translationApiKeyInput: "",
    clearAiApiKey: false,
    clearTranslationApiKey: false,
    mcpKeyName: `API Key ${new Date().toLocaleString("zh-CN")}`,
    mcpKeyScopes: [...defaultMcpScopes],
    mcpKeyAllAccounts: false,
    mcpKeyAccountIds: [],
    mcpKeyExpiresAt: "",
    mcpKeyDailySendLimit: 100
  });
  const latestStateRef = React.useRef(state);
  latestStateRef.current = state;
  const loadRequestId = React.useRef(0);
  const messageSelectionRequestId = React.useRef(0);
  const assistantRequestId = React.useRef(0);
  const activeTranslationSettingsRef = React.useRef<TranslationSettings | undefined>(undefined);
  const translationCache = React.useRef(new Map<string, string>());

  const setState = (value: Partial<State>) => rawSetState((previous) => ({ ...previous, ...value }));

  function clearMessageSelection(value: Partial<State> = {}): Partial<State> {
    loadRequestId.current += 1;
    messageSelectionRequestId.current += 1;
    const next: Partial<State> = {
      ...value,
      selectedMessage: undefined,
      selectedThreadMessages: [],
      selectedAttachments: []
    };
    setState(next);
    return next;
  }

  function currentSearchCriteria(input: State = state): SearchCriteria {
    return {
      query: input.query,
      sender: input.searchSender,
      dateFrom: input.searchDateFrom,
      dateTo: input.searchDateTo,
      hasAttachment: input.searchHasAttachment,
      folder: input.activeFolder,
      accountId: input.selectedAccountId ?? ""
    };
  }

  async function load(overrides: Partial<State> = {}) {
    if (!state.admin) return;
    const requestId = ++loadRequestId.current;
    const effectiveState = { ...state, ...overrides };
    const attachmentParams = new URLSearchParams({
      page: String(effectiveState.attachmentPage),
      pageSize: String(effectiveState.attachmentPageSize),
      ...(effectiveState.attachmentQuery ? { query: effectiveState.attachmentQuery } : {}),
      ...(effectiveState.attachmentTypeFilter ? { type: effectiveState.attachmentTypeFilter } : {})
    });
    const syncRunParams = new URLSearchParams({
      page: String(effectiveState.syncRunPage),
      pageSize: String(effectiveState.syncRunPageSize),
      ...(effectiveState.syncRunStatusFilter ? { status: effectiveState.syncRunStatusFilter } : {}),
      ...(effectiveState.syncRunTriggerFilter ? { triggerType: effectiveState.syncRunTriggerFilter } : {}),
      ...(effectiveState.syncRunAccountFilter ? { accountId: effectiveState.syncRunAccountFilter } : {})
    });
    const [accountData, messageData, attachmentData, savedSearchData, keyData, adminData, logData, syncSettingsData, attachmentSettingsData, emailDisplaySettingsData, syncRunsData, aiSettingsData, translationSettingsData] = await Promise.all([
      api<{ accounts: Account[] }>("/api/accounts"),
      api<{ messages: Message[]; unreadTotal: number; pagination: { total: number; page: number; pageSize: number } }>(`/api/messages?${new URLSearchParams({
        ...(effectiveState.query ? { query: effectiveState.query } : {}),
        ...(effectiveState.searchSender ? { sender: effectiveState.searchSender } : {}),
        ...(effectiveState.searchDateFrom ? { dateFrom: `${effectiveState.searchDateFrom}T00:00:00.000Z` } : {}),
        ...(effectiveState.searchDateTo ? { dateTo: `${effectiveState.searchDateTo}T23:59:59.999Z` } : {}),
        ...(effectiveState.searchHasAttachment ? { hasAttachment: "true" } : {}),
        folder: effectiveState.activeFolder,
        page: String(effectiveState.messagePage),
        pageSize: String(effectiveState.messagePageSize),
        ...(effectiveState.selectedAccountId ? { accountId: effectiveState.selectedAccountId } : {})
      })}`),
      api<{ attachments: Attachment[]; pagination: { total: number; page: number; pageSize: number } }>(`/api/attachments?${attachmentParams.toString()}`),
      api<{ savedSearches: SavedSearch[] }>("/api/admin/saved-searches"),
      api<{ apiKeys: ApiKey[] }>("/api/admin/api-keys"),
      api<{ admins: Admin[] }>("/api/admin/users"),
      api<{ logs: McpLog[] }>("/api/admin/mcp-logs?limit=20"),
      api<{ settings: SyncSettings }>("/api/admin/sync-settings"),
      api<{ settings: AttachmentSettings }>("/api/admin/attachment-settings"),
      api<{ settings: EmailDisplaySettings }>("/api/admin/email-display-settings"),
      api<{ runs: SyncRun[]; pagination: { total: number; page: number; pageSize: number } }>(`/api/admin/sync-runs?${syncRunParams.toString()}`),
      api<{ settings: AiSettings }>("/api/admin/ai-settings"),
      api<{ settings: TranslationSettings }>("/api/admin/translation-settings")
    ]);
    const selectedMessage = effectiveState.selectedMessage
      ? messageData.messages.find((message) => message.id === effectiveState.selectedMessage?.id)
      : undefined;
    if (requestId !== loadRequestId.current) return;
    activeTranslationSettingsRef.current = translationSettingsData.settings;
    setState({
      accounts: accountData.accounts,
      messages: messageData.messages,
      inboxUnreadCount: messageData.unreadTotal,
      messageTotal: messageData.pagination.total,
      messagePage: messageData.pagination.page,
      messagePageSize: messageData.pagination.pageSize,
      selectedMessageIds: effectiveState.selectedMessageIds.filter((id) => messageData.messages.some((message) => message.id === id)),
      selectedThreadMessages: selectedMessage ? effectiveState.selectedThreadMessages : [],
      attachments: attachmentData.attachments,
      selectedAttachments: selectedMessage ? effectiveState.selectedAttachments : [],
      attachmentTotal: attachmentData.pagination.total,
      attachmentPage: attachmentData.pagination.page,
      attachmentPageSize: attachmentData.pagination.pageSize,
      savedSearches: savedSearchData.savedSearches,
      apiKeys: keyData.apiKeys,
      admins: adminData.admins,
      mcpLogs: logData.logs,
      syncSettings: syncSettingsData.settings,
      attachmentSettings: attachmentSettingsData.settings,
      emailDisplaySettings: emailDisplaySettingsData.settings,
      syncRuns: syncRunsData.runs,
      syncRunTotal: syncRunsData.pagination.total,
      syncRunPage: syncRunsData.pagination.page,
      syncRunPageSize: syncRunsData.pagination.pageSize,
      aiSettings: aiSettingsData.settings,
      translationSettings: translationSettingsData.settings,
      selectedMessage
    });
  }

  async function changeSyncRunView(patch: Partial<State>) {
    const next = { ...patch, syncRunPage: patch.syncRunPage ?? 1 };
    setState(next);
    await load(next);
  }

  async function changeAttachmentView(patch: Partial<State> = {}) {
    const next = { ...patch, attachmentPage: patch.attachmentPage ?? 1 };
    setState(next);
    await load(next);
  }

  async function changeMessagePage(page: number) {
    const patch: Partial<State> = {
      messagePage: page,
      selectedMessageIds: [],
      selectedMessage: undefined,
      selectedAttachments: []
    };
    const next = clearMessageSelection(patch);
    await load(next);
  }

  async function searchMessages() {
    const patch: Partial<State> = {
      messagePage: 1,
      selectedMessageIds: [],
      selectedMessage: undefined,
      selectedAttachments: []
    };
    const next = clearMessageSelection(patch);
    await load(next);
  }

  function toggleMessageSelection(id: string) {
    setState({
      selectedMessageIds: state.selectedMessageIds.includes(id)
        ? state.selectedMessageIds.filter((selectedId) => selectedId !== id)
        : [...state.selectedMessageIds, id]
    });
  }

  function togglePageSelection() {
    const pageIds = state.messages.map((message) => message.id);
    const selectedIds = new Set(state.selectedMessageIds);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    setState({ selectedMessageIds: allSelected ? [] : pageIds });
  }

  async function bulkUpdateSelected(messageState: { isRead?: boolean; isDeleted?: boolean }) {
    if (state.selectedMessageIds.length === 0) return;
    const selectedCount = state.selectedMessageIds.length;
    const movesCurrentPage = messageState.isDeleted !== undefined;
    const nextPage = movesCurrentPage && selectedCount === state.messages.length && state.messagePage > 1
      ? state.messagePage - 1
      : state.messagePage;
    const result = await api<{ updated: number }>("/api/messages/bulk-state", {
      method: "PATCH",
      body: JSON.stringify({ ids: state.selectedMessageIds, state: messageState })
    });
    const patch: Partial<State> = {
      messagePage: nextPage,
      selectedMessageIds: [],
      selectedMessage: movesCurrentPage ? undefined : state.selectedMessage,
      selectedAttachments: movesCurrentPage ? [] : state.selectedAttachments,
      busyText: messageState.isRead
        ? `已将 ${result.updated} 封邮件标记为已读`
        : messageState.isDeleted === false
          ? `已恢复 ${result.updated} 封邮件`
          : `已将 ${result.updated} 封邮件移入垃圾箱`
    };
    const next = movesCurrentPage ? clearMessageSelection(patch) : patch;
    if (!movesCurrentPage) setState(next);
    await load(next);
  }

  async function markAllInboxRead() {
    const key = "mark-all-inbox-read";
    const account = state.accounts.find((item) => item.id === state.selectedAccountId);
    const scopeLabel = account?.display_name ?? "全部账号";
    setState({
      busyText: "正在标记收件箱全部邮件为已读",
      operationNotice: { key, message: `正在将${scopeLabel}的收件箱全部标记为已读…`, tone: "loading" }
    });
    try {
      const scopeAccountId = state.selectedAccountId;
      const result = await api<{ updated: number }>("/api/admin/messages/mark-all-read", {
        method: "POST",
        body: JSON.stringify(scopeAccountId ? { accountId: scopeAccountId } : {})
      });
      const currentState = latestStateRef.current;
      if (currentState.selectedAccountId === scopeAccountId && currentState.activeFolder === "INBOX") {
        const selectedMessage = currentState.selectedMessage?.folder === "INBOX"
          && !currentState.selectedMessage.is_archived
          && !currentState.selectedMessage.is_deleted
          ? { ...currentState.selectedMessage, is_read: 1 }
          : currentState.selectedMessage;
        await load({
          activeFolder: currentState.activeFolder,
          selectedAccountId: currentState.selectedAccountId,
          query: currentState.query,
          searchSender: currentState.searchSender,
          searchDateFrom: currentState.searchDateFrom,
          searchDateTo: currentState.searchDateTo,
          searchHasAttachment: currentState.searchHasAttachment,
          messagePage: currentState.messagePage,
          selectedMessage,
          selectedThreadMessages: currentState.selectedThreadMessages.map((message) => message.folder === "INBOX"
            && !message.is_archived
            && !message.is_deleted
            ? { ...message, is_read: 1 }
            : message),
          selectedMessageIds: []
        });
      }
      const message = result.updated > 0
        ? `已将${scopeLabel}收件箱中的 ${result.updated} 封邮件标记为已读`
        : `${scopeLabel}收件箱已全部是已读状态`;
      setState({
        busyText: message,
        operationNotice: { key, message, tone: "success" }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "全部标记已读失败";
      setState({ busyText: message, operationNotice: { key, message: `全部标记已读失败：${message}`, tone: "error" } });
    }
  }

  async function bootstrapAuth() {
    const setupStatus = await api<SetupStatus>("/api/setup/status");
    const token = localStorage.getItem(sessionTokenKey);
    if (!setupStatus.requiresSetup && token) {
      try {
        const result = await api<{ admin: Admin | null }>("/api/auth/me");
        if (result.admin) {
          setState({ setupStatus, admin: result.admin, authChecked: true });
          return;
        }
      } catch {
        localStorage.removeItem(sessionTokenKey);
      }
    }
    setState({ setupStatus, authChecked: true });
  }

  async function clearSearch() {
    const patch: Partial<State> = {
      query: "",
      searchSender: "",
      searchDateFrom: "",
      searchDateTo: "",
      searchHasAttachment: false,
      activeSavedSearchId: undefined,
      messagePage: 1,
      selectedMessageIds: [],
      selectedMessage: undefined,
      selectedAttachments: []
    };
    const next = clearMessageSelection(patch);
    await load(next);
  }

  async function runAssistantAction(message: Message, kind: AssistantResult["kind"]) {
    const requestId = ++assistantRequestId.current;
    const labels = {
      summary: { busy: "AI 正在总结邮件", title: "AI 邮件总结", path: "/api/ai/summarize" },
      reply: { busy: "AI 正在生成推荐回信", title: "AI 推荐回信", path: "/api/ai/reply" },
      translation: { busy: "正在翻译邮件", title: `邮件译文（${state.translationSettings?.default_target_language ?? "zh-CN"}）`, path: "/api/translate" }
    } as const;
    const action = labels[kind];
    setState({ assistantBusy: action.busy, assistantError: undefined, assistantResult: undefined });
    try {
      const result = await api<{ text: string }>(action.path, {
        method: "POST",
        body: JSON.stringify({
          messageId: message.id,
          ...(kind === "translation" ? { targetLanguage: state.translationSettings?.default_target_language ?? "zh-CN" } : {})
        })
      });
      if (requestId !== assistantRequestId.current) return;
      setState({ assistantBusy: undefined, assistantResult: { kind, messageId: message.id, title: action.title, text: result.text } });
    } catch (error) {
      if (requestId !== assistantRequestId.current) return;
      setState({ assistantBusy: undefined, assistantError: error instanceof Error ? error.message : "邮件助手处理失败" });
    }
  }

  async function maybeAutoTranslate(
    message: Message,
    detectedLanguage: "en" | "unknown",
    selectionRequestId: number,
    assistantBaseline: number
  ) {
    const settings = activeTranslationSettingsRef.current;
    const targetLanguage = settings?.default_target_language ?? "zh-CN";
    if (!settings?.enabled
      || !settings.auto_translate_english_on_open
      || detectedLanguage !== "en"
      || /^en(?:-|$)/iu.test(targetLanguage)
      || assistantRequestId.current !== assistantBaseline) return;
    const content = message.text_body || message.html_body || message.snippet || "";
    const cacheKey = [
      message.id,
      textFingerprint(content),
      targetLanguage,
      settings.provider,
      settings.endpoint,
      settings.updated_at
    ].join(":");
    const title = `自动译文（${targetLanguage}）`;
    const cached = translationCache.current.get(cacheKey);
    if (cached) {
      if (selectionRequestId === messageSelectionRequestId.current && assistantRequestId.current === assistantBaseline)
        setState({ assistantBusy: undefined, assistantError: undefined, assistantResult: { kind: "translation", messageId: message.id, title, text: cached } });
      return;
    }
    if (selectionRequestId !== messageSelectionRequestId.current || assistantRequestId.current !== assistantBaseline) return;
    const requestId = ++assistantRequestId.current;
    setState({ assistantBusy: "正在自动翻译英文邮件", assistantError: undefined, assistantResult: undefined });
    try {
      const result = await api<{ text: string }>("/api/translate", {
        method: "POST",
        body: JSON.stringify({ messageId: message.id, sourceLanguage: "en", targetLanguage })
      });
      if (requestId !== assistantRequestId.current || selectionRequestId !== messageSelectionRequestId.current) return;
      if (translationCache.current.size >= 100) {
        const oldestKey = translationCache.current.keys().next().value;
        if (oldestKey) translationCache.current.delete(oldestKey);
      }
      translationCache.current.set(cacheKey, result.text);
      setState({ assistantBusy: undefined, assistantError: undefined, assistantResult: { kind: "translation", messageId: message.id, title, text: result.text } });
    } catch (error) {
      if (requestId !== assistantRequestId.current || selectionRequestId !== messageSelectionRequestId.current) return;
      const errorMessage = error instanceof Error ? error.message : "翻译服务不可用";
      setState({ assistantBusy: undefined, assistantError: `自动翻译失败：${errorMessage}` });
    }
  }

  function useSuggestedReply(message: Message, suggestedText: string) {
    const base = replyPrefill(message, state.accounts);
    setState({
      isComposerOpen: true,
      composerDraft: undefined,
      composerPrefill: { ...base, text: `${suggestedText.trim()}${quotedBody(message)}` }
    });
  }

  async function persistAiSettings(showSuccess = true): Promise<boolean> {
    if (!state.aiSettings) return false;
    setState({ integrationMessage: "正在保存 AI 配置" });
    try {
      const result = await api<{ settings: AiSettings }>("/api/admin/ai-settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: state.aiSettings.enabled,
          baseUrl: state.aiSettings.base_url,
          model: state.aiSettings.model,
          temperature: state.aiSettings.temperature,
          systemPrompt: state.aiSettings.system_prompt,
          ...(state.aiApiKeyInput.trim() ? { apiKey: state.aiApiKeyInput.trim() } : {}),
          ...(state.clearAiApiKey ? { clearApiKey: true } : {})
        })
      });
      setState({
        aiSettings: result.settings,
        aiApiKeyInput: "",
        clearAiApiKey: false,
        integrationMessage: showSuccess ? "AI 配置已保存" : "AI 配置已保存，正在测试"
      });
      return true;
    } catch (error) {
      setState({ integrationMessage: error instanceof Error ? error.message : "AI 配置保存失败" });
      return false;
    }
  }

  async function saveAiSettings() {
    await persistAiSettings(true);
  }

  async function testAiSettings() {
    if (!await persistAiSettings(false)) return;
    try {
      const result = await api<{ response: string }>("/api/admin/ai-settings/test", { method: "POST" });
      setState({ integrationMessage: `AI 连接正常：${result.response}` });
    } catch (error) {
      setState({ integrationMessage: error instanceof Error ? error.message : "AI 连接测试失败" });
    }
  }

  async function persistTranslationSettings(showSuccess = true): Promise<boolean> {
    if (!state.translationSettings) return false;
    setState({ integrationMessage: "正在保存翻译配置" });
    try {
      const result = await api<{ settings: TranslationSettings }>("/api/admin/translation-settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: state.translationSettings.enabled,
          provider: state.translationSettings.provider,
          endpoint: state.translationSettings.provider === "google" ? "" : state.translationSettings.endpoint,
          defaultTargetLanguage: state.translationSettings.default_target_language,
          autoTranslateEnglishOnOpen: state.translationSettings.auto_translate_english_on_open,
          ...(state.translationApiKeyInput.trim() ? { apiKey: state.translationApiKeyInput.trim() } : {}),
          ...(state.clearTranslationApiKey ? { clearApiKey: true } : {})
        })
      });
      activeTranslationSettingsRef.current = result.settings;
      translationCache.current.clear();
      setState({
        translationSettings: result.settings,
        translationApiKeyInput: "",
        clearTranslationApiKey: false,
        integrationMessage: showSuccess ? "翻译配置已保存" : "翻译配置已保存，正在测试"
      });
      return true;
    } catch (error) {
      setState({ integrationMessage: error instanceof Error ? error.message : "翻译配置保存失败" });
      return false;
    }
  }

  async function saveTranslationSettings() {
    await persistTranslationSettings(true);
  }

  async function testTranslationSettings() {
    if (!await persistTranslationSettings(false)) return;
    try {
      const result = await api<{ response: string }>("/api/admin/translation-settings/test", { method: "POST" });
      setState({ integrationMessage: `翻译连接正常：${result.response}` });
    } catch (error) {
      setState({ integrationMessage: error instanceof Error ? error.message : "翻译连接测试失败" });
    }
  }

  async function createMcpKey() {
    if (state.mcpKeyScopes.length === 0) {
      setState({ mcpKeyMessage: "至少选择一个 API 权限" });
      return;
    }
    if (!state.mcpKeyAllAccounts && state.mcpKeyAccountIds.length === 0) {
      setState({ mcpKeyMessage: "请至少选择一个允许的邮箱账号" });
      return;
    }
    try {
      const result = await api<{ apiKey: ApiKey }>("/api/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: state.mcpKeyName.trim() || `API Key ${new Date().toLocaleString("zh-CN")}`,
          scopes: state.mcpKeyScopes,
          ...(state.mcpKeyAllAccounts ? {} : { accountIds: state.mcpKeyAccountIds }),
          ...(state.mcpKeyExpiresAt ? { expiresAt: new Date(state.mcpKeyExpiresAt).toISOString() } : {}),
          dailySendLimit: state.mcpKeyDailySendLimit
        })
      });
      setState({
        newApiKey: result.apiKey.key,
        mcpKeyName: `API Key ${new Date().toLocaleString("zh-CN")}`,
        mcpKeyScopes: [...defaultMcpScopes],
        mcpKeyAllAccounts: false,
        mcpKeyAccountIds: [],
        mcpKeyExpiresAt: "",
        mcpKeyDailySendLimit: 100,
        mcpKeyMessage: "Key 已生成，完整值只显示本次"
      });
      await load();
    } catch (error) {
      setState({ mcpKeyMessage: error instanceof Error ? error.message : "API Key 生成失败" });
    }
  }

  async function deleteMcpKey(id: string) {
    const apiKey = state.apiKeys.find((item) => item.id === id);
    if (!window.confirm(`确定删除 MCP / API Key${apiKey ? `「${apiKey.name}」` : ""}？删除后外部 API 和 MCP 客户端会立即失效。`)) return;
    await api(`/api/admin/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    setState({ newApiKey: undefined });
    await load();
  }

  async function copyNewMcpKey() {
    if (!state.newApiKey) return;
    try {
      await navigator.clipboard.writeText(state.newApiKey);
      setState({ busyText: "API Key 已复制" });
    } catch {
      setState({ busyText: "复制失败，请手动复制" });
    }
  }

  async function syncAccount(id: string) {
    const account = state.accounts.find((item) => item.id === id);
    const key = `sync:${id}`;
    setState({ busyText: "正在同步", operationNotice: { key, message: `正在同步 ${account?.display_name ?? "邮箱"}…`, tone: "loading" } });
    try {
      const result = await api<{ imported: number }>(`/api/accounts/${encodeURIComponent(id)}/sync`, { method: "POST" });
      setState({ busyText: `已同步 ${result.imported} 封邮件`, operationNotice: { key, message: `${account?.display_name ?? "邮箱"} 同步成功，导入 ${result.imported} 封邮件`, tone: "success" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "同步失败";
      setState({ busyText: message, operationNotice: { key, message: `${account?.display_name ?? "邮箱"} 同步失败：${message}`, tone: "error" } });
    }
    await load();
  }

  async function testAccount(account: Account) {
    const key = `test:${account.id}`;
    setState({ busyText: `正在测试 ${account.display_name}`, operationNotice: { key, message: `正在测试 ${account.display_name} 的收信和发信连接，请稍候…`, tone: "loading" } });
    try {
      const result = await api<{ incoming: { protocol: IncomingProtocol; ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } }>(`/api/accounts/${encodeURIComponent(account.id)}/test`, { method: "POST" });
      const protocol = result.incoming.protocol.toUpperCase();
      const incomingText = result.incoming.ok ? `${protocol} 正常` : `${protocol} 失败：${result.incoming.error ?? "未知错误"}`;
      const smtpText = result.smtp.ok ? "SMTP 正常" : `SMTP 失败：${result.smtp.error ?? "未知错误"}`;
      const message = `${account.display_name}：${incomingText}；${smtpText}`;
      setState({ busyText: message, operationNotice: { key, message, tone: result.incoming.ok && result.smtp.ok ? "success" : "error" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接测试失败";
      setState({ busyText: message, operationNotice: { key, message: `${account.display_name} 测试失败：${message}`, tone: "error" } });
    }
  }

  async function deleteAccount(account: Account) {
    if (!window.confirm(`确定删除邮箱账号 ${account.display_name}？该账号下的本地邮件和附件也会删除。`)) return;
    await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    const patch: Partial<State> = {
      selectedAccountId: state.selectedAccountId === account.id ? undefined : state.selectedAccountId,
      busyText: "邮箱账号已删除"
    };
    const next = clearMessageSelection(patch);
    await load(next);
  }

  async function selectMessage(message: Message) {
    const requestId = ++messageSelectionRequestId.current;
    assistantRequestId.current += 1;
    const autoTranslationBaseline = assistantRequestId.current;
    // Open the list payload immediately so a secondary thread/read-state
    // request can never make the row appear unresponsive.
    setState({
      selectedMessage: message,
      selectedThreadMessages: [message],
      selectedAttachments: [],
      busyText: "正在打开邮件…",
      assistantBusy: undefined,
      assistantError: undefined,
      assistantResult: undefined
    });
    const detailPromise = api<{ message: Message; attachments: Attachment[]; detectedLanguage?: "en" | "unknown" }>(`/api/messages/${encodeURIComponent(message.id)}`);
    const threadPromise = api<{ messages: Message[] }>(`/api/messages/${encodeURIComponent(message.id)}/thread`);
    const readStatePromise = message.is_read
      ? Promise.resolve(undefined)
      : api<{ message: Message; attachments: Attachment[] }>(`/api/messages/${encodeURIComponent(message.id)}/state`, {
        method: "PATCH",
        body: JSON.stringify({ isRead: true })
      });
    const reconciledReadStatePromise = readStatePromise.then((readState) => {
      if (!readState) return readState;
      rawSetState((previous) => {
        const listMessage = previous.messages.find((item) => item.id === readState.message.id);
        const stoppedCountingAsUnreadInbox = listMessage?.folder === "INBOX"
          && !listMessage.is_read
          && !listMessage.is_archived
          && !listMessage.is_deleted
          && readState.message.is_read;
        return {
          ...previous,
          messages: previous.messages.map((item) => item.id === readState.message.id ? readState.message : item),
          inboxUnreadCount: stoppedCountingAsUnreadInbox
            ? Math.max(0, previous.inboxUnreadCount - 1)
            : previous.inboxUnreadCount
        };
      });
      return readState;
    });
    // Attach rejection handlers immediately. A fast secondary failure must not
    // become an unhandled rejection while the detail request is still pending.
    const secondaryRequests = Promise.allSettled([threadPromise, reconciledReadStatePromise]);
    try {
      const detail = await detailPromise;
      if (requestId !== messageSelectionRequestId.current) return;
      setState({
        selectedMessage: detail.message,
        selectedThreadMessages: [detail.message],
        selectedAttachments: detail.attachments,
        busyText: undefined
      });
      void maybeAutoTranslate(detail.message, detail.detectedLanguage ?? "unknown", requestId, autoTranslationBaseline);

      const [threadResult, readStateResult] = await secondaryRequests;
      if (requestId !== messageSelectionRequestId.current) return;

      const readState = readStateResult.status === "fulfilled" ? readStateResult.value : undefined;
      const currentMessage = readState?.message ?? detail.message;
      const threadMessages = threadResult.status === "fulfilled"
        ? threadResult.value.messages.map((item) => item.id === currentMessage.id ? currentMessage : item)
        : [currentMessage];
      const secondaryErrors = [
        threadResult.status === "rejected" ? "对话加载失败" : undefined,
        readStateResult.status === "rejected" ? "标记已读失败" : undefined
      ].filter((item): item is string => Boolean(item));
      rawSetState((previous) => ({
        ...previous,
        selectedMessage: currentMessage,
        selectedThreadMessages: threadMessages,
        selectedAttachments: readState?.attachments ?? detail.attachments,
        messages: previous.messages.map((item) => item.id === currentMessage.id ? currentMessage : item),
        busyText: secondaryErrors.length > 0 ? `邮件已打开，${secondaryErrors.join("、")}` : undefined,
        operationNotice: secondaryErrors.length > 0
          ? { key: `message:${message.id}`, message: `邮件已打开，但${secondaryErrors.join("、")}`, tone: "error" }
          : previous.operationNotice
      }));
    } catch (error) {
      if (requestId !== messageSelectionRequestId.current) return;
      const errorMessage = error instanceof Error ? error.message : "邮件详情加载失败";
      setState({
        busyText: errorMessage,
        operationNotice: { key: `message:${message.id}`, message: `已显示本地邮件内容，但详情刷新失败：${errorMessage}`, tone: "error" }
      });
    }
  }

  async function updateMessageState(message: Message, patch: Partial<{ isRead: boolean; isStarred: boolean; isArchived: boolean; isDeleted: boolean }>) {
    const result = await api<{ message: Message; attachments: Attachment[] }>(`/api/messages/${encodeURIComponent(message.id)}/state`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    setState({
      selectedMessage: result.message,
      selectedThreadMessages: state.selectedThreadMessages.map((item) => item.id === result.message.id ? result.message : item),
      selectedAttachments: result.attachments,
      messages: state.messages.map((item) => item.id === result.message.id ? result.message : item),
      inboxUnreadCount: state.activeFolder === "INBOX" && patch.isRead !== undefined && message.is_read !== result.message.is_read
        ? Math.max(0, state.inboxUnreadCount + (result.message.is_read ? -1 : 1))
        : state.inboxUnreadCount,
      busyText: patch.isRead === undefined ? "邮件状态已更新" : result.message.is_read ? "已标记为已读" : "已标记为未读"
    });
    if (patch.isArchived !== undefined || patch.isDeleted !== undefined) await load({ selectedMessage: result.message });
  }

  async function sendDraft(message: Message) {
    setState({ busyText: "正在发送草稿" });
    try {
      await api(`/api/drafts/${encodeURIComponent(message.id)}/send`, { method: "POST" });
      setState({ busyText: "草稿已发送" });
      await load();
    } catch (error) {
      setState({ busyText: error instanceof Error ? "草稿发送失败" : "草稿发送失败" });
    }
  }

  async function deleteDraft(message: Message) {
    await api(`/api/drafts/${encodeURIComponent(message.id)}`, { method: "DELETE" });
    const patch: Partial<State> = { busyText: "草稿已删除" };
    const next = clearMessageSelection(patch);
    await load(next);
  }

  async function downloadAttachment(attachment: Attachment) {
    const token = localStorage.getItem(sessionTokenKey);
    const response = await fetch(`${apiBaseUrl}/api/attachments/${encodeURIComponent(attachment.id)}/download`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined
    });
    if (!response.ok) {
      setState({ busyText: "附件下载失败" });
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachmentDisplayName(attachment);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function saveSyncSettings() {
    if (!state.syncSettings) return;
    const result = await api<{ settings: SyncSettings }>("/api/admin/sync-settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: state.syncSettings.enabled,
        intervalMinutes: state.syncSettings.interval_minutes,
        initialLimit: state.syncSettings.initial_limit,
        retryMaxAttempts: state.syncSettings.retry_max_attempts,
        retryDelayMinutes: state.syncSettings.retry_delay_minutes,
        concurrencyLimit: state.syncSettings.concurrency_limit,
        retentionDays: state.syncSettings.retention_days
      })
    });
    setState({ syncSettings: result.settings, busyText: "定时同步已保存" });
    await load();
  }

  async function saveEmailDisplaySettings() {
    if (!state.emailDisplaySettings) return;
    const result = await api<{ settings: EmailDisplaySettings }>("/api/admin/email-display-settings", {
      method: "PUT",
      body: JSON.stringify({
        loadExternalResourcesByDefault: state.emailDisplaySettings.load_external_resources_by_default
      })
    });
    setState({
      emailDisplaySettings: result.settings,
      busyText: "邮件阅读偏好已保存",
      operationNotice: {
        key: "email-display-settings",
        message: result.settings.load_external_resources_by_default
          ? "已设为默认加载邮件外部资源"
          : "已设为默认阻止邮件外部资源",
        tone: "success"
      }
    });
  }

  async function runAllSync() {
    const key = "sync-all";
    setState({ busyText: "正在同步全部账号", operationNotice: { key, message: "正在同步全部账号，请勿刷新页面…", tone: "loading" } });
    try {
      const result = await api<{ total: number; ok: number; error: number; skipped: number; imported: number }>("/api/admin/sync/run-all", { method: "POST" });
      const summary = `全部同步完成：${result.ok}/${result.total} 成功，${result.error} 个失败，导入 ${result.imported} 封邮件`;
      setState({ busyText: summary, operationNotice: { key, message: summary, tone: result.error > 0 ? "error" : "success" } });
      await load({ syncRunPage: 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "全部同步失败";
      setState({ busyText: message, operationNotice: { key, message: `全部同步失败：${message}`, tone: "error" } });
      await load({ syncRunPage: 1 });
    }
  }

  async function cancelSyncRun(run: SyncRun) {
    if (!window.confirm("确定取消这条等待重试的同步任务？")) return;
    await api(`/api/admin/sync-runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" });
    setState({ selectedSyncRun: undefined, busyText: "已取消同步重试" });
    await load();
  }

  async function deleteSyncRun(run: SyncRun) {
    await api(`/api/admin/sync-runs/${encodeURIComponent(run.id)}`, { method: "DELETE" });
    setState({ selectedSyncRun: undefined, busyText: "同步记录已删除" });
    await load();
  }

  async function cleanupSyncRuns() {
    const result = await api<{ deleted: number }>("/api/admin/sync-runs/cleanup", { method: "POST" });
    setState({ busyText: `已清理 ${result.deleted} 条过期同步记录` });
    await load();
  }

  async function openSyncRunDetails(run: SyncRun) {
    const result = await api<{ run: SyncRun }>(`/api/admin/sync-runs/${encodeURIComponent(run.id)}`);
    setState({ selectedSyncRun: result.run });
  }

  async function saveCurrentSearch(name: string) {
    if (!name.trim()) return;
    const result = await api<{ savedSearch: SavedSearch }>("/api/admin/saved-searches", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        criteria: currentSearchCriteria()
      })
    });
    setState({ activeSavedSearchId: result.savedSearch.id, isSavedSearchDialogOpen: false, busyText: "搜索条件已保存" });
    await load({ activeSavedSearchId: result.savedSearch.id });
  }

  async function applySavedSearch(id: string) {
    if (!id) {
      setState({ activeSavedSearchId: undefined });
      return;
    }
    const savedSearch = state.savedSearches.find((item) => item.id === id);
    if (!savedSearch) return;
    const patch: Partial<State> = {
      query: savedSearch.criteria.query ?? "",
      searchSender: savedSearch.criteria.sender ?? "",
      searchDateFrom: savedSearch.criteria.dateFrom ?? "",
      searchDateTo: savedSearch.criteria.dateTo ?? "",
      searchHasAttachment: Boolean(savedSearch.criteria.hasAttachment),
      activeFolder: savedSearch.criteria.folder ?? "INBOX",
      selectedAccountId: savedSearch.criteria.accountId || undefined,
      activeSavedSearchId: id,
      messagePage: 1,
      selectedMessageIds: [],
      selectedMessage: undefined,
      selectedAttachments: [],
      busyText: `已套用：${savedSearch.name}`
    };
    const next = clearMessageSelection(patch);
    await load(next);
  }

  async function deleteSavedSearch() {
    if (!state.activeSavedSearchId) return;
    const savedSearch = state.savedSearches.find((item) => item.id === state.activeSavedSearchId);
    if (!window.confirm(`确定删除保存的搜索条件${savedSearch ? `「${savedSearch.name}」` : ""}？`)) return;
    await api(`/api/admin/saved-searches/${encodeURIComponent(state.activeSavedSearchId)}`, { method: "DELETE" });
    setState({ activeSavedSearchId: undefined, busyText: "搜索条件已删除" });
    await load({ activeSavedSearchId: undefined });
  }

  async function saveAttachmentSettings() {
    if (!state.attachmentSettings) return;
    const result = await api<{ settings: AttachmentSettings }>("/api/admin/attachment-settings", {
      method: "PUT",
      body: JSON.stringify({
        maxSizeMb: Math.round(state.attachmentSettings.max_size_bytes / 1024 / 1024),
        retentionDays: state.attachmentSettings.retention_days
      })
    });
    setState({ attachmentSettings: result.settings, busyText: "附件设置已保存" });
  }

  async function cleanupAttachments() {
    const result = await api<{ deleted: number }>("/api/admin/attachments/cleanup", { method: "POST" });
    setState({ busyText: `已清理 ${result.deleted} 个过期附件` });
    await load();
  }

  async function previewAttachment(attachment: Attachment) {
    setState({ attachmentPreview: { attachment } });
    try {
      const file = await fetchAttachmentFile(attachment);
      setState({ attachmentPreview: { attachment, file } });
    } catch (error) {
      setState({ attachmentPreview: { attachment, error: error instanceof Error ? error.message : "附件预览失败" } });
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    localStorage.removeItem(sessionTokenKey);
    clearMessageSelection({ admin: undefined, admins: [], accounts: [], messages: [], selectedMessageIds: [], attachments: [], apiKeys: [], mcpLogs: [], syncRuns: [], selectedSyncRun: undefined });
  }

  React.useEffect(() => {
    bootstrapAuth().catch((error) => setState({ busyText: error instanceof Error ? error.message : "加载失败", authChecked: true }));
  }, []);

  React.useEffect(() => {
    if (state.admin) load().catch((error) => setState({ busyText: error instanceof Error ? error.message : "加载失败" }));
  }, [state.selectedAccountId, state.activeFolder, state.activeView, state.admin?.id]);

  React.useEffect(() => {
    const notice = state.operationNotice;
    if (!notice || notice.tone === "loading") return;
    const timer = window.setTimeout(() => {
      rawSetState((previous) => previous.operationNotice?.key === notice.key
        ? { ...previous, operationNotice: undefined }
        : previous);
    }, 7000);
    return () => window.clearTimeout(timer);
  }, [state.operationNotice?.key, state.operationNotice?.message, state.operationNotice?.tone]);

  if (!state.authChecked) {
    return <main className="authScreen"><div className="authCard">正在加载...</div></main>;
  }

  if (!state.admin) {
    return <AuthGate setupStatus={state.setupStatus} onAuthed={(admin) => setState({ admin })} />;
  }

  return (
    <main className="appShell">
      <Sidebar state={state} setState={setState} navigate={clearMessageSelection} onSync={runAllSync} />
      <div className="workspace">
        {state.activeView === "mail" ? (
          <Toolbar
            state={state}
            setState={setState}
            onSearch={searchMessages}
            onClearSearch={clearSearch}
            onSaveSearch={() => setState({ isSavedSearchDialogOpen: true })}
            onApplySavedSearch={applySavedSearch}
            onDeleteSavedSearch={deleteSavedSearch}
            onLogout={logout}
          />
        ) : (
          <ManagementToolbar
            title={state.activeView === "sync" ? "同步任务" : "附件管理"}
            description={state.activeView === "sync" ? "任务记录、错误与重试" : "集中预览和下载邮件附件"}
            onSettings={() => setState({ isSettingsOpen: true })}
            onLogout={logout}
          />
        )}
        {state.accounts.length === 0 ? (
          <FirstRunEmpty
            onAddAccount={() => setState({ isAccountDialogOpen: true, editingAccount: undefined })}
            onOpenIntegrations={() => setState({ isSettingsOpen: true, settingsTab: "integrations" })}
          />
        ) : state.activeView === "sync" ? (
          <SyncRunsPage
            state={state}
            onFilterChange={changeSyncRunView}
            onPageChange={(page) => changeSyncRunView({ syncRunPage: page })}
            onRunAll={runAllSync}
            onOpenDetails={openSyncRunDetails}
            onCancel={cancelSyncRun}
            onDelete={deleteSyncRun}
            onCleanup={cleanupSyncRuns}
          />
        ) : state.activeView === "attachments" ? (
          <AttachmentsPage
            state={state}
            setState={setState}
            onFilterChange={changeAttachmentView}
            onPageChange={(page) => changeAttachmentView({ attachmentPage: page })}
            onPreview={previewAttachment}
            onDownload={downloadAttachment}
            onSaveSettings={saveAttachmentSettings}
            onCleanup={cleanupAttachments}
          />
        ) : (
          <div className="contentGrid">
            <MessageList
              state={state}
              onSelectMessage={selectMessage}
              onToggleSelection={toggleMessageSelection}
              onTogglePageSelection={togglePageSelection}
              onMarkAllRead={markAllInboxRead}
              onBulkRead={() => bulkUpdateSelected({ isRead: true })}
              onBulkDelete={() => bulkUpdateSelected({ isDeleted: state.activeFolder !== "TRASH" })}
              onPageChange={changeMessagePage}
            />
            <Preview
              message={state.selectedMessage}
              threadMessages={state.selectedThreadMessages}
              accounts={state.accounts}
              loadExternalResourcesByDefault={state.emailDisplaySettings?.load_external_resources_by_default ?? false}
              conversationMode={state.conversationMode}
              onToggleConversation={() => setState({ conversationMode: !state.conversationMode })}
              attachments={state.selectedAttachments}
              onPreviewAttachment={previewAttachment}
              onDownloadAttachment={downloadAttachment}
              onUpdateMessageState={updateMessageState}
              onEditDraft={(message) => setState({ isComposerOpen: true, composerDraft: message })}
              onSendDraft={sendDraft}
              onDeleteDraft={deleteDraft}
              onReply={(message) => setState({ isComposerOpen: true, composerDraft: undefined, composerPrefill: replyPrefill(message, state.accounts) })}
              onForward={(message) => setState({ isComposerOpen: true, composerDraft: undefined, composerPrefill: forwardPrefill(message, state.accounts) })}
              onSummarize={(message) => runAssistantAction(message, "summary")}
              onSuggestReply={(message) => runAssistantAction(message, "reply")}
              onTranslate={(message) => runAssistantAction(message, "translation")}
              onUseSuggestedReply={useSuggestedReply}
              assistantBusy={state.assistantBusy}
              assistantError={state.assistantError}
              assistantResult={state.assistantResult}
            />
          </div>
        )}
      </div>
      {state.isAccountDialogOpen && <AccountDialog account={state.editingAccount} onClose={() => setState({ isAccountDialogOpen: false, editingAccount: undefined })} onCreated={load} />}
      {state.isAdminDialogOpen && <AdminDialog onClose={() => setState({ isAdminDialogOpen: false })} onCreated={load} />}
      {state.isPasswordDialogOpen && <PasswordDialog onClose={() => setState({ isPasswordDialogOpen: false })} />}
      {state.isSavedSearchDialogOpen && (
        <SavedSearchDialog
          defaultName={state.query || state.searchSender || folderLabels[state.activeFolder]}
          onClose={() => setState({ isSavedSearchDialogOpen: false })}
          onSave={saveCurrentSearch}
        />
      )}
      {state.resettingAdmin && <ResetAdminPasswordDialog admin={state.resettingAdmin} onClose={() => setState({ resettingAdmin: undefined })} onChanged={load} />}
      {state.isComposerOpen && (
        <Composer
          accounts={state.accounts}
          draft={state.composerDraft}
          prefill={state.composerPrefill}
          draftAttachments={state.composerDraft ? state.selectedAttachments : []}
          maxAttachmentBytes={state.attachmentSettings?.max_size_bytes}
          onClose={() => setState({ isComposerOpen: false, composerDraft: undefined, composerPrefill: undefined })}
          onChanged={load}
          onDeliveryStatus={(message) => setState({ busyText: message })}
        />
      )}
      {state.isSettingsOpen && (
        <SettingsDialog
          state={state}
          createMcpKey={createMcpKey}
          deleteMcpKey={deleteMcpKey}
          copyNewMcpKey={copyNewMcpKey}
          openAdminDialog={() => setState({ isAdminDialogOpen: true, isSettingsOpen: false })}
          openPasswordDialog={() => setState({ isPasswordDialogOpen: true, isSettingsOpen: false })}
          openResetAdminDialog={(admin) => setState({ resettingAdmin: admin, isSettingsOpen: false })}
          syncAccount={syncAccount}
          testAccount={testAccount}
          editAccount={(account) => setState({ editingAccount: account, isAccountDialogOpen: true, isSettingsOpen: false })}
          deleteAccount={deleteAccount}
          saveEmailDisplaySettings={saveEmailDisplaySettings}
          saveSyncSettings={saveSyncSettings}
          runAllSync={runAllSync}
          cancelSyncRun={cancelSyncRun}
          openSyncRunDetails={openSyncRunDetails}
          saveAttachmentSettings={saveAttachmentSettings}
          previewAttachment={previewAttachment}
          saveAiSettings={saveAiSettings}
          testAiSettings={testAiSettings}
          saveTranslationSettings={saveTranslationSettings}
          testTranslationSettings={testTranslationSettings}
          setState={setState}
          downloadAttachment={downloadAttachment}
          onClose={() => setState({ isSettingsOpen: false })}
        />
      )}
      <OperationToast notice={state.operationNotice} onClose={() => setState({ operationNotice: undefined })} />
      {state.attachmentPreview && (
        <AttachmentPreviewDialog
          preview={state.attachmentPreview}
          onClose={() => setState({ attachmentPreview: undefined })}
          onDownload={downloadAttachment}
        />
      )}
      {state.selectedSyncRun && (
        <SyncRunDetailDialog
          run={state.selectedSyncRun}
          accounts={state.accounts}
          onClose={() => setState({ selectedSyncRun: undefined })}
          onCancel={cancelSyncRun}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
