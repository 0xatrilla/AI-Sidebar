import {
  App,
  ButtonComponent,
  DropdownComponent,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";

const VIEW_TYPE_AI_SIDEBAR = "ai-sidebar-view";

type AccessMode = "read-only" | "confirm" | "full-access";
type ProviderAuthType = "api-key" | "oauth" | "cli";
type ReasoningEffort = "low" | "medium" | "high";

interface AgentProvider {
  id: string;
  name: string;
  authType: ProviderAuthType;
  command: string;
  signInCommand?: string;
  setupUrl?: string;
  connectedAt?: number;
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  models?: string;
  reasoningEffort?: ReasoningEffort;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

interface AISidebarSettings {
  providers: AgentProvider[];
  defaultProviderId: string;
  defaultAccessMode: AccessMode;
  includeFolders: string;
  excludeFolders: string;
  maxContextChars: number;
  enableConversationMemory: boolean;
  maxMemoryMessages: number;
  rememberedMessages: ChatMessage[];
}

interface VaultContextFile {
  path: string;
  content: string;
  reason: string;
}

interface AgentSkill {
  name: string;
  path: string;
  content: string;
}

interface SkillReference {
  name: string;
  path: string;
  source: "vault" | "global";
}

interface VaultContext {
  activeFile?: VaultContextFile;
  selection?: string;
  linkedFiles: VaultContextFile[];
  backlinkFiles: VaultContextFile[];
  relevantFiles: VaultContextFile[];
  baseFiles: VaultContextFile[];
  selectedSkills: AgentSkill[];
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface AgentRequest {
  prompt: string;
  accessMode: AccessMode;
  context: VaultContext;
  instructions: string;
  conversation: ChatMessage[];
  options: AgentRequestOptions;
}

interface AgentRequestOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  memoryEnabled: boolean;
}

interface ParsedPrompt {
  cleanPrompt: string;
  selectedSkillNames: string[];
  options: AgentRequestOptions;
  accessMode?: AccessMode;
}

type VaultAction =
  | { type: "create"; path: string; content: string }
  | { type: "edit"; path: string; content: string }
  | { type: "append"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "rename"; path: string; newPath: string };

interface ProviderPreset {
  id: string;
  name: string;
  description: string;
  provider: AgentProvider;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "codex",
    name: "Codex",
    description: "Sign in with Codex locally and use the Codex CLI agent.",
    provider: {
      id: "codex",
      name: "Codex",
      authType: "cli",
      command: "codex exec",
      signInCommand: "codex login",
      models: "gpt-5.4, gpt-5.4-mini, gpt-5.3-codex",
      reasoningEffort: "medium",
    },
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "Sign in with your Claude subscription or Anthropic Console account.",
    provider: {
      id: "claude",
      name: "Claude Code",
      authType: "cli",
      command: "claude",
      signInCommand: "claude auth login",
      setupUrl: "https://code.claude.com/docs/en/cli-usage",
      models: "opus, sonnet, haiku",
    },
  },
  {
    id: "opencode",
    name: "opencode",
    description: "Connect opencode to any provider it supports, including subscription/API accounts.",
    provider: {
      id: "opencode",
      name: "opencode",
      authType: "cli",
      command: "opencode",
      signInCommand: "opencode auth login",
      setupUrl: "https://opencode.ai/docs/cli/",
      models: "anthropic/claude-sonnet-4-5, openai/gpt-5.4, google/gemini-2.5-pro",
    },
  },
  {
    id: "openai",
    name: "OpenAI API",
    description: "Use an OpenAI API key with the Responses API.",
    provider: {
      id: "openai",
      name: "OpenAI",
      authType: "api-key",
      command: "",
      setupUrl: "https://platform.openai.com/api-keys",
      apiBaseUrl: "https://api.openai.com/v1/responses",
      model: "gpt-4.1-mini",
      models: "gpt-4.1-mini, gpt-4.1, o4-mini",
      reasoningEffort: "medium",
    },
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    description: "Use an Anthropic API key directly through an OpenAI-compatible proxy endpoint.",
    provider: {
      id: "anthropic-api",
      name: "Anthropic API",
      authType: "api-key",
      command: "",
      setupUrl: "https://console.anthropic.com/settings/keys",
      apiBaseUrl: "",
      model: "claude-sonnet-4-5",
      models: "claude-sonnet-4-5, claude-opus-4-1, claude-haiku-4-5",
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    description: "Use Google Gemini CLI with its native sign-in and subscription/API setup.",
    provider: {
      id: "gemini-cli",
      name: "Gemini CLI",
      authType: "cli",
      command: "gemini",
      signInCommand: "gemini",
      setupUrl: "https://google-gemini.github.io/gemini-cli/docs/",
      models: "gemini-2.5-pro, gemini-2.5-flash",
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Use one API key for many model providers through an OpenAI-compatible endpoint.",
    provider: {
      id: "openrouter",
      name: "OpenRouter",
      authType: "api-key",
      command: "",
      setupUrl: "https://openrouter.ai/settings/keys",
      apiBaseUrl: "https://openrouter.ai/api/v1/chat/completions",
      model: "openai/gpt-4.1-mini",
      models: "openai/gpt-4.1-mini, anthropic/claude-sonnet-4.5, google/gemini-2.5-pro",
      reasoningEffort: "medium",
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "Use DeepSeek with an API key and OpenAI-compatible endpoint.",
    provider: {
      id: "deepseek",
      name: "DeepSeek",
      authType: "api-key",
      command: "",
      setupUrl: "https://platform.deepseek.com/api_keys",
      apiBaseUrl: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      models: "deepseek-chat, deepseek-reasoner",
    },
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Use Mistral models with an API key and OpenAI-compatible endpoint.",
    provider: {
      id: "mistral",
      name: "Mistral",
      authType: "api-key",
      command: "",
      setupUrl: "https://console.mistral.ai/api-keys",
      apiBaseUrl: "https://api.mistral.ai/v1/chat/completions",
      model: "mistral-large-latest",
      models: "mistral-large-latest, codestral-latest, ministral-8b-latest",
    },
  },
  {
    id: "aider",
    name: "Aider",
    description: "Use Aider with keys from OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, and more.",
    provider: {
      id: "aider",
      name: "Aider",
      authType: "cli",
      command: "aider",
      signInCommand: "aider",
      setupUrl: "https://aider.chat/docs/config/api-keys.html",
      models: "sonnet, opus, gpt-4.1, o4-mini, gemini/gemini-2.5-pro",
    },
  },
];

const DEFAULT_SETTINGS: AISidebarSettings = {
  providers: [
    cloneProvider(PROVIDER_PRESETS[0].provider),
    cloneProvider(PROVIDER_PRESETS[3].provider),
  ],
  defaultProviderId: "codex",
  defaultAccessMode: "confirm",
  includeFolders: "",
  excludeFolders: ".obsidian, node_modules, .git",
  maxContextChars: 45000,
  enableConversationMemory: true,
  maxMemoryMessages: 30,
  rememberedMessages: [],
};

export default class AISidebarPlugin extends Plugin {
  settings: AISidebarSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_AI_SIDEBAR,
      (leaf) => new AISidebarView(leaf, this),
    );

    this.addRibbonIcon("sparkles", "Toggle AI Sidebar", () => {
      void this.toggleSidebar();
    });

    this.addCommand({
      id: "toggle-ai-sidebar",
      name: "Toggle AI Sidebar",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "A" }],
      callback: () => {
        void this.toggleSidebar();
      },
    });

    this.addSettingTab(new AISidebarSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_SIDEBAR);
  }

  async toggleSidebar() {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_SIDEBAR).first();
    if (existingLeaf) {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_SIDEBAR);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open the AI sidebar.");
      return;
    }

    await leaf.setViewState({ type: VIEW_TYPE_AI_SIDEBAR, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.settings.providers = normalizeProviders(this.settings.providers);
    this.settings.rememberedMessages = Array.isArray(this.settings.rememberedMessages)
      ? this.settings.rememberedMessages
      : [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getProvider(id: string): AgentProvider | undefined {
    return this.settings.providers.find((provider) => provider.id === id);
  }

  async rememberMessages(messages: ChatMessage[]) {
    if (!this.settings.enableConversationMemory) return;
    this.settings.rememberedMessages = messages.slice(-this.settings.maxMemoryMessages);
    await this.saveSettings();
  }

  async clearMemory() {
    this.settings.rememberedMessages = [];
    await this.saveSettings();
  }

  async upsertProviderFromPreset(preset: ProviderPreset) {
    const provider = cloneProvider(preset.provider);
    const existingIndex = this.settings.providers.findIndex((item) => item.id === provider.id);
    if (existingIndex >= 0) {
      this.settings.providers[existingIndex] = {
        ...provider,
        apiKey: this.settings.providers[existingIndex].apiKey,
        accessToken: this.settings.providers[existingIndex].accessToken,
        refreshToken: this.settings.providers[existingIndex].refreshToken,
      };
    } else {
      this.settings.providers.push(provider);
    }
    this.settings.defaultProviderId = provider.id;
    await this.saveSettings();
  }
}

class AISidebarView extends ItemView {
  private plugin: AISidebarPlugin;
  private messages: ChatMessage[] = [];
  private providerId: string;
  private accessMode: AccessMode;
  private threadEl: HTMLElement;
  private textareaEl: HTMLTextAreaElement;
  private contextEl: HTMLElement;
  private slashEl: HTMLElement;
  private modelBadgeEl: HTMLElement;
  private activeContextPath = "";
  private refreshTimer: number | undefined;
  private sendButton: ButtonComponent;
  private isRunning = false;

  constructor(leaf: WorkspaceLeaf, plugin: AISidebarPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = plugin.settings.enableConversationMemory
      ? [...plugin.settings.rememberedMessages]
      : [];
    this.providerId = plugin.settings.defaultProviderId;
    this.accessMode = plugin.settings.defaultAccessMode;
  }

  getViewType(): string {
    return VIEW_TYPE_AI_SIDEBAR;
  }

  getDisplayText(): string {
    return "AI Sidebar";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen() {
    this.render();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleContextRefresh();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.scheduleContextRefresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.activeContextPath) {
          this.scheduleContextRefresh();
        }
      }),
    );
    await this.refreshContextPreview();
  }

  async onClose() {
    this.contentEl.empty();
  }

  private render() {
    this.contentEl.empty();
    this.contentEl.addClass("ai-sidebar");

    const header = this.contentEl.createDiv("ai-sidebar__header");
    header.createDiv({ cls: "ai-sidebar__title", text: "AI Sidebar" });
    header.createDiv({ cls: "ai-sidebar__subtitle", text: "Vault-aware agents" });

    const controls = this.contentEl.createDiv("ai-sidebar__controls");
    new DropdownComponent(controls)
      .addOptions(this.providerOptions())
      .setValue(this.providerId)
      .onChange((value) => {
        this.providerId = value;
        this.updateModelBadge();
      });

    new DropdownComponent(controls)
      .addOptions({
        "read-only": "Read only",
        confirm: "Confirm actions",
        "full-access": "Full access",
      })
      .setValue(this.accessMode)
      .onChange((value: AccessMode) => {
        this.accessMode = value;
        void this.refreshContextPreview();
      });

    this.contextEl = this.contentEl.createDiv("ai-sidebar__context");

    this.threadEl = this.contentEl.createDiv("ai-sidebar__thread");
    this.renderMessages();

    const composer = this.contentEl.createDiv("ai-sidebar__composer");
    this.textareaEl = composer.createEl("textarea", {
      cls: "ai-sidebar__input",
      attr: {
        placeholder: "Ask about your vault, draft a note, or request an edit...",
        rows: "4",
      },
    });

    this.textareaEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.slashEl.hasClass("is-hidden")) {
        event.preventDefault();
        this.hideSlashCommands();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.sendPrompt();
      }
    });
    this.textareaEl.addEventListener("input", () => {
      void this.updateSlashCommands();
      this.updateModelBadge();
    });

    this.slashEl = composer.createDiv("ai-sidebar__slash is-hidden");

    const actions = composer.createDiv("ai-sidebar__composer-actions");
    new ButtonComponent(actions)
      .setButtonText("Refresh context")
      .onClick(() => {
        void this.refreshContextPreview();
      });
    new ButtonComponent(actions)
      .setButtonText("Clear")
      .onClick(() => {
        void this.clearConversation();
      });

    this.modelBadgeEl = actions.createDiv("ai-sidebar__model-badge");
    this.updateModelBadge();

    this.sendButton = new ButtonComponent(actions)
      .setCta()
      .setButtonText("Send")
      .onClick(() => {
        void this.sendPrompt();
      });
  }

  private providerOptions(): Record<string, string> {
    return this.plugin.settings.providers.reduce<Record<string, string>>((options, provider) => {
      options[provider.id] = provider.name || provider.id;
      return options;
    }, {});
  }

  private renderMessages() {
    this.threadEl.empty();

    if (this.messages.length === 0) {
      const empty = this.threadEl.createDiv("ai-sidebar__empty");
      empty.createDiv({ text: "Ask a local agent to work with the notes in this vault." });
      empty.createDiv({ text: "Use confirm mode when you want to review file edits first." });
      return;
    }

    for (const message of this.messages) {
      const messageEl = this.threadEl.createDiv(`ai-sidebar__message ai-sidebar__message--${message.role}`);
      messageEl.createDiv({ cls: "ai-sidebar__message-role", text: message.role });
      messageEl.createEl("pre", { text: message.content });
    }

    if (this.isRunning) {
      const thinkingEl = this.threadEl.createDiv("ai-sidebar__message ai-sidebar__message--thinking");
      thinkingEl.createDiv({ cls: "ai-sidebar__message-role", text: "assistant" });
      const row = thinkingEl.createDiv("ai-sidebar__typing");
      row.createSpan({ text: "Thinking" });
      const dots = row.createSpan("ai-sidebar__typing-dots");
      dots.createSpan();
      dots.createSpan();
      dots.createSpan();
    }

    this.threadEl.scrollTo({ top: this.threadEl.scrollHeight });
  }

  private async refreshContextPreview(prompt = "") {
    const context = await collectVaultContext(
      this.plugin.app,
      this.plugin.settings,
      prompt,
      this.extractSelectedSkillNames(prompt),
    );
    this.activeContextPath = context.activeFile?.path ?? "";
    this.contextEl.empty();
    this.contextEl.createDiv({
      cls: "ai-sidebar__context-title",
      text: `Context preview · ${this.accessModeLabel()}`,
    });

    const items = [
      context.activeFile ? `Active: ${context.activeFile.path}` : "No active note",
      context.selection ? "Selection included" : "No selection",
      `${context.linkedFiles.length} linked`,
      `${context.backlinkFiles.length} backlinks`,
      `${context.relevantFiles.length} relevant`,
      `${context.baseFiles.length} bases`,
      `${context.selectedSkills.length} skills`,
    ];

    const list = this.contextEl.createEl("ul");
    for (const item of items) {
      list.createEl("li", { text: item });
    }
  }

  private scheduleContextRefresh() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshContextPreview(this.textareaEl?.value ?? "");
    }, 150);
  }

  private accessModeLabel(): string {
    if (this.accessMode === "read-only") return "read only";
    if (this.accessMode === "full-access") return "full access";
    return "confirm actions";
  }

  private async sendPrompt() {
    const rawPrompt = this.textareaEl.value.trim();
    if (!rawPrompt || this.isRunning) return;

    const provider = this.plugin.getProvider(this.providerId);
    if (!provider) {
      new Notice("Choose a provider in AI Sidebar settings.");
      return;
    }

    if (!isProviderReady(provider)) {
      new Notice("Connect or configure this provider in AI Sidebar settings first.");
      return;
    }

    const parsed = this.parsePromptControls(rawPrompt, provider);
    if (this.isSlashOnlyPrompt(rawPrompt, parsed)) {
      await this.applySlashControls(provider, parsed);
      this.textareaEl.value = "";
      this.updateModelBadge();
      await this.refreshContextPreview();
      return;
    }

    this.isRunning = true;
    this.sendButton.setButtonText("Running...");
    this.sendButton.setDisabled(true);
    this.textareaEl.value = "";
    const effectiveAccessMode = parsed.accessMode ?? this.accessMode;
    this.messages.push({ role: "user", content: rawPrompt });
    this.renderMessages();

    try {
      const context = await collectVaultContext(
        this.plugin.app,
        this.plugin.settings,
        parsed.cleanPrompt,
        parsed.selectedSkillNames,
      );
      await this.refreshContextPreview(rawPrompt);
      const request: AgentRequest = {
        prompt: parsed.cleanPrompt,
        accessMode: effectiveAccessMode,
        context,
        instructions: buildAgentInstructions(effectiveAccessMode),
        conversation: this.plugin.settings.enableConversationMemory ? this.messages.slice(0, -1) : [],
        options: parsed.options,
      };

      const response = await runProvider(provider, request, this.app);
      const actionResult = await this.handleActions(response);
      const assistantContent = actionResult ? `${response}\n\n${actionResult}` : response;
      this.messages.push({ role: "assistant", content: assistantContent.trim() || "No response." });
      await this.plugin.rememberMessages(this.messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.messages.push({ role: "system", content: `Provider failed: ${message}` });
      await this.plugin.rememberMessages(this.messages);
      new Notice("AI provider failed. Check the sidebar for details.");
    } finally {
      this.isRunning = false;
      this.sendButton.setButtonText("Send");
      this.sendButton.setDisabled(false);
      this.updateModelBadge();
      this.renderMessages();
    }
  }

  private async clearConversation() {
    this.messages = [];
    await this.plugin.clearMemory();
    this.renderMessages();
    new Notice("AI Sidebar memory cleared.");
  }

  private async handleActions(response: string): Promise<string> {
    const actions = extractVaultActions(response);
    if (actions.length === 0) return "";

    if (this.accessMode === "read-only") {
      return "Vault actions were proposed, but read-only mode blocked all writes.";
    }

    if (this.accessMode === "confirm") {
      const approved = await confirmVaultActions(this.app, actions);
      if (!approved) return "Vault actions were not applied.";
    }

    const results: string[] = [];
    for (const action of actions) {
      try {
        await applyVaultAction(this.app, action);
        results.push(`Applied ${action.type}: ${action.path}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(`Failed ${action.type}: ${action.path} · ${message}`);
      }
    }
    return results.join("\n");
  }

  private async updateSlashCommands() {
    const query = this.currentSlashQuery();
    if (query === null) {
      this.hideSlashCommands();
      return;
    }

    const provider = this.plugin.getProvider(this.providerId);
    const commands = provider ? nativeSlashCommands(provider, query, this.accessMode) : [];
    const skills = await listAgentSkills(this.plugin.app, query);
    this.slashEl.empty();

    if (commands.length === 0 && skills.length === 0) {
      this.hideSlashCommands();
      return;
    }

    this.slashEl.removeClass("is-hidden");
    if (skills.length > 0) {
      this.slashEl.createDiv({ cls: "ai-sidebar__slash-section", text: "Skills" });
    }
    for (const skill of skills.slice(0, 12)) {
      const item = this.slashEl.createDiv("ai-sidebar__slash-item");
      item.createDiv({ cls: "ai-sidebar__slash-name", text: `/${skill.name}` });
      item.createDiv({ cls: "ai-sidebar__slash-path", text: skill.path });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insertSlashToken(`/${skill.name}`);
      });
    }
    if (commands.length > 0) {
      this.slashEl.createDiv({ cls: "ai-sidebar__slash-section", text: "Controls" });
    }
    for (const command of commands.slice(0, 8)) {
      const item = this.slashEl.createDiv("ai-sidebar__slash-item");
      item.createDiv({ cls: "ai-sidebar__slash-name", text: command.label });
      item.createDiv({ cls: "ai-sidebar__slash-path", text: command.description });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.insertSlashToken(command.insert);
      });
    }
  }

  private hideSlashCommands() {
    this.slashEl.empty();
    this.slashEl.addClass("is-hidden");
  }

  private currentSlashQuery(): string | null {
    const cursor = this.textareaEl.selectionStart;
    const beforeCursor = this.textareaEl.value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)\/([A-Za-z0-9_.:-]*)$/);
    return match ? match[1].toLowerCase() : null;
  }

  private insertSlashToken(token: string) {
    const cursor = this.textareaEl.selectionStart;
    const value = this.textareaEl.value;
    const beforeCursor = value.slice(0, cursor);
    const afterCursor = value.slice(cursor);
    const replaced = beforeCursor.replace(/(?:^|\s)\/([A-Za-z0-9_.:-]*)$/, (match) => {
      const prefix = match.startsWith(" ") ? " " : "";
      return `${prefix}${token} `;
    });
    this.textareaEl.value = `${replaced}${afterCursor}`;
    this.textareaEl.focus();
    this.textareaEl.selectionStart = replaced.length;
    this.textareaEl.selectionEnd = replaced.length;
    this.hideSlashCommands();
    this.scheduleContextRefresh();
  }

  private extractSelectedSkillNames(prompt: string): string[] {
    const native = new Set(["model", "reasoning", "access", "memory"]);
    return Array.from(prompt.matchAll(/(?:^|\s)\/([A-Za-z0-9_.-]+)/g), (match) => match[1])
      .filter((name) => !native.has(name.split(":")[0].toLowerCase()));
  }

  private parsePromptControls(prompt: string, provider: AgentProvider): ParsedPrompt {
    const options: AgentRequestOptions = {
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
      memoryEnabled: this.plugin.settings.enableConversationMemory,
    };
    let accessMode: AccessMode | undefined;

    const cleanPrompt = prompt.replace(/(?:^|\s)\/(model|reasoning|access|memory):([A-Za-z0-9_.-]+)/gi, (match, key, value) => {
      const normalizedKey = String(key).toLowerCase();
      const normalizedValue = String(value).toLowerCase();
      if (normalizedKey === "model") {
        options.model = value;
      } else if (normalizedKey === "reasoning" && isReasoningEffort(normalizedValue)) {
        options.reasoningEffort = normalizedValue;
      } else if (normalizedKey === "access" && isAccessMode(normalizedValue)) {
        accessMode = normalizedValue;
      } else if (normalizedKey === "memory") {
        options.memoryEnabled = normalizedValue === "on";
      }
      return match.startsWith(" ") ? " " : "";
    }).trim();

    return {
      cleanPrompt,
      selectedSkillNames: this.extractSelectedSkillNames(prompt),
      options,
      accessMode,
    };
  }

  private isSlashOnlyPrompt(prompt: string, parsed: ParsedPrompt): boolean {
    return parsed.cleanPrompt.length === 0 && this.extractSelectedSkillNames(prompt).length === 0;
  }

  private async applySlashControls(provider: AgentProvider, parsed: ParsedPrompt) {
    const changes: string[] = [];
    if (parsed.options.model && parsed.options.model !== provider.model) {
      provider.model = parsed.options.model;
      changes.push(`model ${parsed.options.model}`);
    }
    if (parsed.options.reasoningEffort && parsed.options.reasoningEffort !== provider.reasoningEffort) {
      provider.reasoningEffort = parsed.options.reasoningEffort;
      changes.push(`reasoning ${parsed.options.reasoningEffort}`);
    }
    if (parsed.accessMode && parsed.accessMode !== this.accessMode) {
      this.accessMode = parsed.accessMode;
      this.plugin.settings.defaultAccessMode = parsed.accessMode;
      changes.push(`access ${this.accessModeLabel()}`);
    }
    if (parsed.options.memoryEnabled !== this.plugin.settings.enableConversationMemory) {
      this.plugin.settings.enableConversationMemory = parsed.options.memoryEnabled;
      changes.push(`memory ${parsed.options.memoryEnabled ? "on" : "off"}`);
    }
    await this.plugin.saveSettings();
    new Notice(changes.length > 0 ? `Updated ${changes.join(", ")}.` : "Slash command applied.");
  }

  private updateModelBadge() {
    if (!this.modelBadgeEl) return;
    const provider = this.plugin.getProvider(this.providerId);
    const override = this.textareaEl?.value.match(/(?:^|\s)\/model:([A-Za-z0-9_.:/-]+)/i)?.[1];
    const model = override || provider?.model || parseProviderModels(provider ?? DEFAULT_SETTINGS.providers[0]).first() || "default";
    this.modelBadgeEl.setText(model);
    this.modelBadgeEl.toggleClass("is-override", Boolean(override));
    this.modelBadgeEl.setAttr("aria-label", override ? `Model override: ${model}` : `Model: ${model}`);
  }
}

class AISidebarSettingTab extends PluginSettingTab {
  plugin: AISidebarPlugin;

  constructor(app: App, plugin: AISidebarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AI Sidebar" });

    new Setting(containerEl)
      .setName("Default provider")
      .setDesc("The AI provider used when the sidebar opens.")
      .addDropdown((dropdown) => {
        dropdown.addOptions(this.providerOptions());
        dropdown.setValue(this.plugin.settings.defaultProviderId);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultProviderId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default vault access")
      .setDesc("How much permission the agent has when it proposes changes.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("read-only", "Read only")
          .addOption("confirm", "Confirm actions")
          .addOption("full-access", "Full access")
          .setValue(this.plugin.settings.defaultAccessMode)
          .onChange(async (value: AccessMode) => {
            this.plugin.settings.defaultAccessMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Include folders")
      .setDesc("Comma-separated folder prefixes to include. Leave blank for the whole vault.")
      .addText((text) => {
        text
          .setPlaceholder("Projects, Daily Notes")
          .setValue(this.plugin.settings.includeFolders)
          .onChange(async (value) => {
            this.plugin.settings.includeFolders = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Comma-separated folder prefixes that should never be sent to an agent.")
      .addText((text) => {
        text
          .setValue(this.plugin.settings.excludeFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Max context characters")
      .setDesc("Upper bound for note text sent to the agent.")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.maxContextChars))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 1000) {
              this.plugin.settings.maxContextChars = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Conversation memory")
      .setDesc("Remember previous sidebar messages after closing and reopening Obsidian.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableConversationMemory)
          .onChange(async (value) => {
            this.plugin.settings.enableConversationMemory = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Memory length")
      .setDesc("Maximum number of recent sidebar messages to remember.")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.maxMemoryMessages))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 2) {
              this.plugin.settings.maxMemoryMessages = parsed;
              await this.plugin.saveSettings();
            }
          });
      })
      .addButton((button) => {
        button.setButtonText("Clear memory").onClick(async () => {
          await this.plugin.clearMemory();
          new Notice("AI Sidebar memory cleared.");
        });
      });

    containerEl.createEl("h3", { text: "Connect a Provider" });
    this.renderProviderPresets(containerEl);

    containerEl.createEl("h3", { text: "Connected Providers" });
    for (const provider of this.plugin.settings.providers) {
      this.renderProviderSetting(containerEl, provider);
    }

    new Setting(containerEl)
      .setName("Advanced provider")
      .setDesc("Create a custom API, OAuth, or local CLI provider.")
      .addButton((button) => {
        button.setButtonText("Add custom").onClick(async () => {
          const id = `provider-${Date.now()}`;
          this.plugin.settings.providers.push({ id, name: "New provider", authType: "oauth", command: "" });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderProviderPresets(containerEl: HTMLElement) {
    const grid = containerEl.createDiv("ai-sidebar-provider-grid");
    for (const preset of PROVIDER_PRESETS) {
      const provider = this.plugin.getProvider(preset.provider.id);
      const card = grid.createDiv("ai-sidebar-provider-card");
      card.createDiv({ cls: "ai-sidebar-provider-card__name", text: preset.name });
      card.createDiv({ cls: "ai-sidebar-provider-card__desc", text: preset.description });
      const status = provider ? providerConnectionLabel(provider) : "Not added";
      card.createDiv({ cls: "ai-sidebar-provider-card__status", text: status });

      const actions = card.createDiv("ai-sidebar-provider-card__actions");
      new ButtonComponent(actions)
        .setButtonText(provider ? "Use" : "Add")
        .onClick(async () => {
          await this.plugin.upsertProviderFromPreset(preset);
          this.display();
        });

      new ButtonComponent(actions)
        .setCta()
        .setButtonText(providerConnectionActionText(provider ?? preset.provider))
        .onClick(async () => {
          await this.plugin.upsertProviderFromPreset(preset);
          const connectedProvider = this.plugin.getProvider(preset.provider.id) ?? preset.provider;
          if (await startProviderSignIn(connectedProvider)) {
            connectedProvider.connectedAt = Date.now();
            await this.plugin.saveSettings();
          }
          this.display();
        });
    }
  }

  private providerOptions(): Record<string, string> {
    return this.plugin.settings.providers.reduce<Record<string, string>>((options, provider) => {
      options[provider.id] = provider.name || provider.id;
      return options;
    }, {});
  }

  private renderProviderSetting(containerEl: HTMLElement, provider: AgentProvider) {
    const wrapper = containerEl.createDiv("ai-sidebar-settings-provider");
    const header = wrapper.createDiv("ai-sidebar-settings-provider__header");
    const title = header.createDiv("ai-sidebar-settings-provider__title");
    title.createDiv({ cls: "ai-sidebar-settings-provider__name", text: provider.name || provider.id });
    title.createDiv({ cls: "ai-sidebar-settings-provider__desc", text: this.providerDescription(provider) });
    header.createSpan({
      cls: `ai-sidebar-settings-provider__badge ${isProviderConnected(provider) ? "is-connected" : ""}`,
      text: providerConnectionLabel(provider),
    });

    const actions = wrapper.createDiv("ai-sidebar-settings-provider__actions");
    new ButtonComponent(actions)
      .setButtonText(this.plugin.settings.defaultProviderId === provider.id ? "Default" : "Use")
      .setDisabled(this.plugin.settings.defaultProviderId === provider.id)
      .onClick(async () => {
        this.plugin.settings.defaultProviderId = provider.id;
        await this.plugin.saveSettings();
        this.display();
      });
    this.configureConnectButton(new ButtonComponent(actions), provider);
    new ButtonComponent(actions)
      .setIcon("trash")
      .setTooltip("Remove provider")
      .onClick(async () => {
        this.plugin.settings.providers = this.plugin.settings.providers.filter((item) => item !== provider);
        if (this.plugin.settings.defaultProviderId === provider.id) {
          this.plugin.settings.defaultProviderId = this.plugin.settings.providers.first()?.id ?? "";
        }
        await this.plugin.saveSettings();
        this.display();
      });

    const fields = wrapper.createDiv("ai-sidebar-settings-provider__fields");
    this.renderTextField(fields, "Name", provider.name, async (value) => {
      provider.name = value;
      await this.plugin.saveSettings();
      this.display();
    });

    if (provider.authType === "cli") {
      this.renderTextField(fields, "Command", provider.command, async (value) => {
        provider.command = value;
        await this.plugin.saveSettings();
      });
      if (provider.signInCommand) {
        this.renderTextField(fields, "Sign-in command", provider.signInCommand, async (value) => {
          provider.signInCommand = value;
          provider.connectedAt = undefined;
          await this.plugin.saveSettings();
        });
      }
    }

    if (provider.authType === "api-key") {
      this.renderTextField(fields, "API key", provider.apiKey ?? "", async (value) => {
        provider.apiKey = value;
        provider.connectedAt = value ? Date.now() : undefined;
        await this.plugin.saveSettings();
        this.display();
      }, true);
      this.renderTextField(fields, "Endpoint", provider.apiBaseUrl ?? "", async (value) => {
        provider.apiBaseUrl = value;
        await this.plugin.saveSettings();
      });
      this.renderTextField(fields, "Default model", provider.model ?? "", async (value) => {
        provider.model = value;
        await this.plugin.saveSettings();
      });
      this.renderTextField(fields, "Slash models", provider.models ?? "", async (value) => {
        provider.models = value;
        await this.plugin.saveSettings();
      });
    }

    if (provider.authType === "oauth") {
      this.renderTextField(fields, "Authorization URL", provider.authorizationUrl ?? "", async (value) => {
        provider.authorizationUrl = value;
        await this.plugin.saveSettings();
      });
      this.renderTextField(fields, "Client ID", provider.clientId ?? "", async (value) => {
        provider.clientId = value;
        await this.plugin.saveSettings();
      });
      this.renderTextField(fields, "Access token", provider.accessToken ?? "", async (value) => {
        provider.accessToken = value;
        provider.connectedAt = value ? Date.now() : undefined;
        await this.plugin.saveSettings();
        this.display();
      }, true);
    }
  }

  private renderTextField(
    containerEl: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => Promise<void>,
    secret = false,
  ) {
    const field = containerEl.createDiv("ai-sidebar-settings-field");
    field.createDiv({ cls: "ai-sidebar-settings-field__label", text: label });
    const input = field.createEl("input", {
      cls: "ai-sidebar-settings-field__input",
      attr: { type: secret ? "password" : "text" },
    });
    input.value = value;
    input.addEventListener("change", () => {
      void onChange(input.value);
    });
  }

  private providerDescription(provider: AgentProvider): string {
    if (provider.authType === "api-key") {
      return provider.apiKey ? "Connected with API key." : "Add an API key to connect.";
    }
    if (provider.authType === "oauth") {
      return provider.accessToken ? "Connected with OAuth." : "Connect with OAuth when the provider exposes a desktop OAuth app.";
    }
    return provider.command ? `Runs local command: ${provider.command}` : "Add the local CLI command.";
  }

  private configureConnectButton(button: ButtonComponent, provider: AgentProvider) {
    button
      .setButtonText(providerConnectionActionText(provider))
      .onClick(async () => {
        if (await startProviderSignIn(provider)) {
          provider.connectedAt = Date.now();
          await this.plugin.saveSettings();
          this.display();
        }
      });
  }
}

class ConfirmActionsModal extends Modal {
  private actions: VaultAction[];
  private resolve: (approved: boolean) => void;

  constructor(app: App, actions: VaultAction[], resolve: (approved: boolean) => void) {
    super(app);
    this.actions = actions;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Apply AI vault actions?" });
    contentEl.createEl("p", { text: "Review these proposed file changes before they are applied." });

    for (const action of this.actions) {
      const actionEl = contentEl.createDiv("ai-sidebar-action-preview");
      actionEl.createEl("strong", { text: `${action.type}: ${action.path}` });
      if (action.type === "rename") {
        actionEl.createDiv({ text: `New path: ${action.newPath}` });
      }
      if ("content" in action) {
        actionEl.createEl("pre", { text: action.content.slice(0, 1200) });
      }
    }

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.resolve(false);
          this.close();
        });
      })
      .addButton((button) => {
        button.setCta().setButtonText("Apply").onClick(() => {
          this.resolve(true);
          this.close();
        });
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

async function collectVaultContext(
  app: App,
  settings: AISidebarSettings,
  prompt: string,
  selectedSkillNames: string[] = [],
): Promise<VaultContext> {
  const activeView = app.workspace.getActiveViewOfType(MarkdownView);
  const activeFile = activeView?.file ?? app.workspace.getActiveFile();
  const selection = activeView?.editor.getSelection() || undefined;
  const budget = new ContextBudget(settings.maxContextChars);

  const context: VaultContext = {
    selection,
    linkedFiles: [],
    backlinkFiles: [],
    relevantFiles: [],
    baseFiles: [],
    selectedSkills: [],
  };

  const activeContext = activeFile ? await readContextFile(app, activeFile, "active note", budget) : undefined;
  if (activeContext) context.activeFile = activeContext;

  const linked = activeFile ? getLinkedFiles(app, activeFile) : [];
  for (const file of linked) {
    const item = await readContextFile(app, file, "linked note", budget);
    if (item) context.linkedFiles.push(item);
  }

  const backlinks = activeFile ? getBacklinkFiles(app, activeFile) : [];
  for (const file of backlinks) {
    const item = await readContextFile(app, file, "backlink", budget);
    if (item) context.backlinkFiles.push(item);
  }

  const baseFiles = app.vault
    .getFiles()
    .filter((file) => file.extension === "base" && shouldIncludeFile(file, settings))
    .slice(0, 5);
  for (const file of baseFiles) {
    const item = await readContextFile(app, file, "base file", budget);
    if (item) context.baseFiles.push(item);
  }

  const relatedFiles = await findRelevantFiles(app, settings, prompt, activeFile, budget.remaining());
  for (const file of relatedFiles) {
    const item = await readContextFile(app, file, "relevant match", budget);
    if (item) context.relevantFiles.push(item);
  }

  context.selectedSkills = await readSelectedSkills(app, selectedSkillNames, budget);

  return context;
}

async function readContextFile(
  app: App,
  file: TFile,
  reason: string,
  budget: ContextBudget,
): Promise<VaultContextFile | undefined> {
  if (!budget.hasRoom()) return undefined;
  const content = await app.vault.cachedRead(file);
  const clipped = budget.take(content);
  return { path: file.path, content: clipped, reason };
}

function getLinkedFiles(app: App, activeFile: TFile): TFile[] {
  const cache = app.metadataCache.getFileCache(activeFile);
  const links = cache?.links ?? [];
  const files: TFile[] = [];

  for (const link of links) {
    const linkedFile = app.metadataCache.getFirstLinkpathDest(link.link, activeFile.path);
    if (linkedFile) files.push(linkedFile);
  }

  return uniqueFiles(files).slice(0, 8);
}

function getBacklinkFiles(app: App, activeFile: TFile): TFile[] {
  const resolvedLinks = app.metadataCache.resolvedLinks;
  const files: TFile[] = [];

  for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
    if (targets[activeFile.path]) {
      const file = app.vault.getAbstractFileByPath(sourcePath);
      if (file instanceof TFile) files.push(file);
    }
  }

  return uniqueFiles(files).slice(0, 8);
}

async function findRelevantFiles(
  app: App,
  settings: AISidebarSettings,
  prompt: string,
  activeFile: TFile | null,
  maxChars: number,
): Promise<TFile[]> {
  if (!prompt.trim() || maxChars <= 0) return [];
  const terms = prompt
    .toLowerCase()
    .split(/[^a-z0-9/_-]+/i)
    .filter((term) => term.length > 2)
    .slice(0, 16);
  if (terms.length === 0) return [];

  const scored: Array<{ file: TFile; score: number }> = [];
  const files = app.vault
    .getFiles()
    .filter((file) => file !== activeFile && shouldIncludeFile(file, settings) && isReadableContextFile(file));

  for (const file of files) {
    const content = (await app.vault.cachedRead(file)).toLowerCase();
    const path = file.path.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (path.includes(term)) score += 4;
      const matches = content.match(new RegExp(escapeRegExp(term), "g"));
      score += matches ? Math.min(matches.length, 8) : 0;
    }
    if (score > 0) scored.push({ file, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((item) => item.file);
}

function shouldIncludeFile(file: TFile, settings: AISidebarSettings): boolean {
  const includes = parseFolderList(settings.includeFolders);
  const excludes = parseFolderList(settings.excludeFolders);
  if (includes.length > 0 && !includes.some((folder) => file.path.startsWith(folder))) return false;
  if (excludes.some((folder) => file.path.startsWith(folder))) return false;
  return isReadableContextFile(file);
}

function isReadableContextFile(file: TFile): boolean {
  return ["md", "canvas", "base", "json", "txt"].includes(file.extension);
}

function nativeSlashCommands(
  provider: AgentProvider,
  query: string,
  currentAccessMode: AccessMode,
): Array<{ label: string; description: string; insert: string }> {
  const commands: Array<{ label: string; description: string; insert: string }> = [];
  const modelChoices = parseProviderModels(provider);

  for (const model of modelChoices) {
    commands.push({
      label: `/model:${model}`,
      description: `Use ${model} for this request`,
      insert: `/model:${model}`,
    });
  }

  if (provider.authType === "api-key" || provider.id.includes("codex") || provider.id.includes("openai")) {
    for (const effort of ["low", "medium", "high"] as ReasoningEffort[]) {
      commands.push({
        label: `/reasoning:${effort}`,
        description: `Set reasoning effort to ${effort}`,
        insert: `/reasoning:${effort}`,
      });
    }
  }

  for (const mode of ["read-only", "confirm", "full-access"] as AccessMode[]) {
    commands.push({
      label: `/access:${mode}`,
      description: mode === currentAccessMode ? "Current vault access mode" : `Use ${mode} for this request`,
      insert: `/access:${mode}`,
    });
  }

  commands.push(
    { label: "/memory:on", description: "Include remembered chat history for this request", insert: "/memory:on" },
    { label: "/memory:off", description: "Do not include remembered chat history for this request", insert: "/memory:off" },
  );

  const normalizedQuery = query.toLowerCase();
  return commands.filter((command) => command.label.slice(1).toLowerCase().includes(normalizedQuery));
}

function parseProviderModels(provider: AgentProvider): string[] {
  const configured = provider.models
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean) ?? [];
  const models = configured.length > 0 ? configured : [provider.model].filter((model): model is string => Boolean(model));
  return Array.from(new Set(models)).slice(0, 12);
}

async function listAgentSkills(app: App, query = ""): Promise<SkillReference[]> {
  const normalizedQuery = query.toLowerCase();
  const vaultSkills = app.vault
    .getFiles()
    .filter((file) => isSkillFile(file))
    .map((file) => ({
      name: skillNameFromPath(file.path),
      path: file.path,
      source: "vault" as const,
    }));
  const adapterSkills = await listAgentSkillsFromAdapter(app);
  const globalSkills = await listGlobalAgentSkills();
  const skills = [...vaultSkills, ...adapterSkills, ...globalSkills]
    .filter((skill) => !normalizedQuery || skill.name.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.source}:${skill.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function listAgentSkillsFromAdapter(app: App): Promise<SkillReference[]> {
  const roots = [".agent/skills", ".agents/skills", "agent/skills", "agents/skills"];
  const files: string[] = [];
  for (const root of roots) {
    files.push(...await listAdapterFiles(app, root));
  }
  return files
    .filter((path) => isSkillPath(path))
    .map((path) => ({
      name: skillNameFromPath(path),
      path,
      source: "vault" as const,
    }));
}

async function listGlobalAgentSkills(): Promise<SkillReference[]> {
  const roots = [
    path.join(homedir(), ".agent", "skills"),
    path.join(homedir(), ".agents", "skills"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    files.push(...await listFilesystemFiles(root));
  }
  return files
    .filter((filePath) => isSkillPath(filePath))
    .map((filePath) => ({
      name: skillNameFromPath(filePath),
      path: filePath,
      source: "global" as const,
    }));
}

async function listFilesystemFiles(folder: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const results = await Promise.all(entries.map(async (entry) => {
      const childPath = path.join(folder, entry.name);
      if (entry.isDirectory()) return listFilesystemFiles(childPath);
      if (entry.isFile()) return [childPath];
      return [];
    }));
    return results.flat();
  } catch {
    return [];
  }
}

async function listAdapterFiles(app: App, folder: string): Promise<string[]> {
  try {
    const listed = await app.vault.adapter.list(folder);
    const childFiles = listed.files;
    const nested = await Promise.all(listed.folders.map((child) => listAdapterFiles(app, child)));
    return [...childFiles, ...nested.flat()];
  } catch {
    return [];
  }
}

async function readSelectedSkills(
  app: App,
  selectedSkillNames: string[],
  budget: ContextBudget,
): Promise<AgentSkill[]> {
  const names = new Set(selectedSkillNames.map((name) => name.toLowerCase()));
  if (names.size === 0) return [];

  const skills: AgentSkill[] = [];
  const skillFiles = [...await listAgentSkillsFromAdapter(app), ...await listGlobalAgentSkills()];
  const vaultFiles = app.vault
    .getFiles()
    .filter((candidate) => isSkillFile(candidate))
    .map((file) => ({ name: skillNameFromPath(file.path), path: file.path, source: "vault" as const }));
  for (const skillFile of [...vaultFiles, ...skillFiles]) {
    const name = skillFile.name;
    if (!names.has(name.toLowerCase()) || !budget.hasRoom()) continue;
    const content = await readSkillContent(app, skillFile);
    skills.push({
      name,
      path: skillFile.path,
      content: budget.take(content),
    });
  }
  return skills;
}

async function readSkillContent(app: App, skill: SkillReference): Promise<string> {
  if (skill.source === "global") return fs.readFile(skill.path, "utf8");
  const file = app.vault.getAbstractFileByPath(skill.path);
  if (file instanceof TFile) return app.vault.cachedRead(file);
  return app.vault.adapter.read(skill.path);
}

function isSkillFile(file: TFile): boolean {
  return isSkillPath(file.path);
}

function isSkillPath(path: string): boolean {
  const extension = path.split(".").last()?.toLowerCase() ?? "";
  if (!["md", "txt", "json", "yaml", "yml", "prompt"].includes(extension)) return false;
  const normalized = path.replace(/^\/+/, "");
  return normalized.startsWith(".agent/skills/")
    || normalized.startsWith(".agents/skills/")
    || normalized.startsWith("agent/skills/")
    || normalized.startsWith("agents/skills/");
}

function skillNameFromPath(path: string): string {
  const parts = path.split("/");
  const fileName = parts.last() ?? path;
  if (fileName.toLowerCase() === "skill.md" && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return fileName.replace(/\.[^.]+$/, "");
}

function parseFolderList(value: string): string[] {
  return value
    .split(",")
    .map((folder) => folder.trim().replace(/^\/+/, ""))
    .filter(Boolean);
}

class ContextBudget {
  private remainingChars: number;

  constructor(maxChars: number) {
    this.remainingChars = maxChars;
  }

  hasRoom(): boolean {
    return this.remainingChars > 0;
  }

  remaining(): number {
    return this.remainingChars;
  }

  take(content: string): string {
    const clipped = content.slice(0, this.remainingChars);
    this.remainingChars -= clipped.length;
    return clipped;
  }
}

function buildAgentInstructions(accessMode: AccessMode): string {
  return [
    "You are running inside an Obsidian AI Sidebar plugin.",
    "Use the provided vault context to answer the user.",
    "If the prompt contains slash commands such as /writer or /reviewer, apply the matching selectedSkills instructions from the request context.",
    "The request may include conversation memory and per-request options such as model or reasoning effort.",
    "When you need file changes, include a JSON code block with this shape:",
    '{"actions":[{"type":"edit","path":"Note.md","content":"new content"}]}',
    "Allowed action types: create, edit, append, delete, rename.",
    `Current access mode: ${accessMode}. The plugin enforces this mode before applying actions.`,
  ].join("\n");
}

async function runProvider(provider: AgentProvider, request: AgentRequest, app: App): Promise<string> {
  if (provider.authType === "api-key") {
    return runOpenAICompatibleProvider(provider, request);
  }

  if (provider.authType === "oauth") {
    if (!provider.accessToken) {
      throw new Error("This OAuth provider is not connected yet.");
    }
    return runOAuthProvider(provider, request);
  }

  return runCliProvider(provider, request, app);
}

async function runOpenAICompatibleProvider(provider: AgentProvider, request: AgentRequest): Promise<string> {
  if (!provider.apiKey) throw new Error("Missing API key.");
  const url = provider.apiBaseUrl || "https://api.openai.com/v1/responses";
  const model = request.options.model || provider.model || "gpt-4.1-mini";
  const userPayload = JSON.stringify({
    prompt: request.prompt,
    accessMode: request.accessMode,
    context: request.context,
    options: request.options,
  });
  const messages = [
    { role: "system", content: request.instructions },
    ...request.conversation.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    })),
    { role: "user", content: userPayload },
  ];
  const usesChatCompletions = url.includes("/chat/completions");
  const body: Record<string, unknown> = usesChatCompletions
    ? { model, messages }
    : { model, input: messages };
  if (request.options.reasoningEffort && model.startsWith("o")) {
    body.reasoning = { effort: request.options.reasoningEffort };
  }
  const response = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.text || `HTTP ${response.status}`);
  }

  return extractOpenAIText(response.json);
}

async function runOAuthProvider(provider: AgentProvider, request: AgentRequest): Promise<string> {
  if (!provider.apiBaseUrl) {
    throw new Error("OAuth provider needs an API endpoint after login.");
  }
  const response = await requestUrl({
    url: provider.apiBaseUrl,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    throw: false,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.text || `HTTP ${response.status}`);
  }

  if (typeof response.json?.text === "string") return response.json.text;
  if (typeof response.json?.output_text === "string") return response.json.output_text;
  return response.text;
}

function runCliProvider(provider: AgentProvider, request: AgentRequest, app: App): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = cliPromptFromRequest(request);
    const command = cliCommandForRequest(provider, request, app);
    const shellCommand = `${command} ${shellQuote(prompt)}`;
    const child = spawn("/bin/zsh", ["-lc", shellCommand], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Command exited with code ${code}. Check that ${command} is installed and available in your shell.`));
      }
    });

  });
}

function cliCommandForRequest(provider: AgentProvider, request: AgentRequest, app: App): string {
  const vaultPath = getVaultPath(app);
  if (provider.id === "codex" || provider.command.startsWith("codex exec")) {
    const sandbox = providerSandboxForAccessMode(request.accessMode);
    const cdArg = vaultPath ? ` -C ${shellQuote(vaultPath)}` : "";
    return `${provider.command}${cdArg} --skip-git-repo-check -s ${sandbox}`;
  }
  return provider.command;
}

function providerSandboxForAccessMode(accessMode: AccessMode): string {
  if (accessMode === "full-access") return "workspace-write";
  return "read-only";
}

function getVaultPath(app: App): string | undefined {
  const adapter = app.vault.adapter;
  if ("basePath" in adapter && typeof adapter.basePath === "string") {
    return adapter.basePath;
  }
  return undefined;
}

function cliPromptFromRequest(request: AgentRequest): string {
  return [
    request.instructions,
    "",
    "User request:",
    request.prompt,
    "",
    "Vault context and options:",
    JSON.stringify({
      accessMode: request.accessMode,
      options: request.options,
      conversation: request.options.memoryEnabled ? request.conversation : [],
      context: request.context,
    }, null, 2),
  ].join("\n");
}

function openInteractiveTerminal(command: string, title: string): Promise<void> {
  const escapedCommand = escapeForSingleQuotedShell(command);
  const script = [
    `tell application "Terminal"`,
    "activate",
    `do script "printf '\\\\033]0;${escapeForAppleScript(title)}\\\\007'; clear; echo 'AI Sidebar sign-in'; echo ''; echo 'Running: ${escapeForAppleScript(command)}'; echo ''; /bin/zsh -lc '${escapedCommand}; echo; echo Sign-in command finished. You can close this window when done.'"`
    ,
    "end tell",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Could not open Terminal. Exit code ${code}`));
    });
  });
}

function extractOpenAIText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const response = json as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  if (typeof response.choices?.[0]?.message?.content === "string") {
    return response.choices[0].message.content;
  }
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

async function startOAuthLogin(provider: AgentProvider): Promise<boolean> {
  if (!provider.authorizationUrl || !provider.clientId) {
    new Notice("Add an authorization URL and client ID first.");
    return false;
  }

  const url = new URL(provider.authorizationUrl);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
  if (provider.scope) url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", crypto.randomUUID());

  window.open(url.toString());
  new Notice("OAuth sign-in opened in your browser. Paste the returned token into this provider when available.");
  return true;
}

async function startProviderSignIn(provider: AgentProvider): Promise<boolean> {
  if (provider.authType === "cli") {
    if (!provider.signInCommand) {
      new Notice("This local provider does not have a sign-in command configured.");
      return false;
    }
    try {
      await openInteractiveTerminal(provider.signInCommand, `${provider.name} Sign In`);
      new Notice(`Opened Terminal for ${provider.name} sign-in.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not open sign-in: ${message}`);
      return false;
    }
  }

  if (provider.authType === "api-key") {
    if (provider.setupUrl) window.open(provider.setupUrl);
    new Notice(provider.apiKey ? `${provider.name} is connected.` : `Add your ${provider.name} API key below to connect.`);
    return Boolean(provider.apiKey);
  }

  return startOAuthLogin(provider);
}

function escapeForSingleQuotedShell(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function shellQuote(value: string): string {
  return `'${escapeForSingleQuotedShell(value)}'`;
}

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function providerConnectionActionText(provider: AgentProvider): string {
  if (provider.authType === "cli") return isProviderConnected(provider) ? "Reconnect" : "Sign in";
  if (provider.authType === "api-key") return provider.apiKey ? "Connected" : "Get key";
  return provider.accessToken ? "Reconnect" : "Sign in";
}

function providerConnectionLabel(provider: AgentProvider): string {
  if (isProviderConnected(provider)) return "Connected";
  if (provider.authType === "api-key") return "Needs API key";
  if (provider.authType === "oauth") return "Needs sign-in";
  return provider.signInCommand ? "Ready to sign in" : "Needs command";
}

function isProviderConnected(provider: AgentProvider): boolean {
  if (provider.authType === "api-key") return Boolean(provider.apiKey);
  if (provider.authType === "oauth") return Boolean(provider.accessToken);
  return Boolean(provider.connectedAt);
}

function isProviderReady(provider: AgentProvider): boolean {
  if (provider.authType === "api-key") return Boolean(provider.apiKey && provider.apiBaseUrl);
  if (provider.authType === "oauth") return Boolean(provider.accessToken && provider.apiBaseUrl);
  return Boolean(provider.command.trim());
}

function normalizeProviders(providers: AgentProvider[]): AgentProvider[] {
  return providers.map((provider) => {
    const migrated = provider as AgentProvider;
    const command = migrated.id === "codex" && migrated.command === "codex"
      ? "codex exec"
      : migrated.command ?? "";
    return {
      ...migrated,
      authType: migrated.authType ?? (migrated.command ? "cli" : "api-key"),
      command,
      connectedAt: migrated.connectedAt,
    };
  });
}

function cloneProvider(provider: AgentProvider): AgentProvider {
  return { ...provider };
}

function extractVaultActions(response: string): VaultAction[] {
  const actions: VaultAction[] = [];
  const codeBlockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = codeBlockPattern.exec(response)) !== null) {
    candidates.push(match[1]);
  }
  candidates.push(response);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as { actions?: VaultAction[] };
      if (Array.isArray(parsed.actions)) {
        actions.push(...parsed.actions.filter(isVaultAction));
      }
    } catch {
      continue;
    }
  }

  return actions;
}

function isVaultAction(value: unknown): value is VaultAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Partial<VaultAction>;
  if (typeof action.type !== "string" || typeof action.path !== "string") return false;
  if (["create", "edit", "append"].includes(action.type)) {
    return typeof (action as { content?: unknown }).content === "string";
  }
  if (action.type === "delete") return true;
  if (action.type === "rename") {
    return typeof (action as { newPath?: unknown }).newPath === "string";
  }
  return false;
}

function confirmVaultActions(app: App, actions: VaultAction[]): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmActionsModal(app, actions, resolve).open();
  });
}

async function applyVaultAction(app: App, action: VaultAction): Promise<void> {
  const path = normalizeVaultPath(action.path);
  const file = app.vault.getAbstractFileByPath(path);

  if (action.type === "create") {
    if (file) throw new Error("File already exists.");
    await ensureParentFolder(app, path);
    await app.vault.create(path, action.content);
    return;
  }

  if (!(file instanceof TFile)) {
    throw new Error("File does not exist.");
  }

  if (action.type === "edit") {
    await app.vault.modify(file, action.content);
  } else if (action.type === "append") {
    const current = await app.vault.read(file);
    await app.vault.modify(file, `${current}${current.endsWith("\n") ? "" : "\n"}${action.content}`);
  } else if (action.type === "delete") {
    await app.vault.delete(file);
  } else if (action.type === "rename") {
    await ensureParentFolder(app, action.newPath);
    await app.fileManager.renameFile(file, normalizeVaultPath(action.newPath));
  }
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const parts = normalizeVaultPath(path).split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function normalizeVaultPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

function uniqueFiles(files: TFile[]): TFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function sanitizeProviderId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}

function isAccessMode(value: string): value is AccessMode {
  return value === "read-only" || value === "confirm" || value === "full-access";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
