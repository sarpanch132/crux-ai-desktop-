import { EventEmitter } from 'events';
import log from 'electron-log';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  main?: string;
  icons?: Record<string, string>;
}

export interface Plugin {
  manifest: PluginManifest;
  enabled: boolean;
  loaded: boolean;
  instance: any;
}

export interface PluginHooks {
  'menu:before'?: (menu: any) => any;
  'menu:after'?: (menu: any) => any;
  'tab:created'?: (tab: any) => any;
  'tab:closed'?: (tab: any) => any;
  'ai:request'?: (request: any) => any;
  'ai:response'?: (response: any) => any;
  'file:opened'?: (file: any) => any;
  'file:saved'?: (file: any) => any;
  'terminal:created'?: (session: any) => any;
  'terminal:output'?: (output: any) => any;
  'indexer:progress'?: (progress: any) => any;
}

export interface PluginAPI {
  registerCommand: (command: any) => void;
  registerMenu: (menu: any) => void;
  registerTab: (tab: any) => void;
  registerShortcut: (shortcut: any) => void;
  getSettings: () => any;
  updateSettings: (settings: any) => void;
  getWorkspace: () => any;
  showNotification: (notification: any) => void;
  showInput: (input: any) => Promise<string>;
  confirm: (options: any) => Promise<boolean>;
}

export class PluginManager extends EventEmitter {
  private plugins: Map<string, Plugin> = new Map();
  private hooks: Map<string, PluginHooks[]> = new Map();
  private api: PluginAPI;

  constructor(api: PluginAPI) {
    super();
    this.api = api;
  }

  async loadPlugin(pluginId: string, pluginInstance: any): Promise<void> {
    try {
      const manifest = pluginInstance.manifest || { id: pluginId };

      const plugin: Plugin = {
        manifest,
        enabled: true,
        loaded: false,
        instance: pluginInstance,
      };

      if (typeof pluginInstance.activate === 'function') {
        await pluginInstance.activate(this.api);
      }

      if (pluginInstance.hooks) {
        this.registerHooks(pluginId, pluginInstance.hooks);
      }

      plugin.loaded = true;
      this.plugins.set(pluginId, plugin);

      this.emit('plugin:loaded', { pluginId, manifest });

      log.info(`Plugin loaded: ${manifest.name}`);
    } catch (error) {
      log.error(`Failed to load plugin ${pluginId}:`, error);
      throw error;
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);

    if (!plugin) return;

    try {
      if (typeof plugin.instance.deactivate === 'function') {
        await plugin.instance.deactivate();
      }

      this.unregisterHooks(pluginId);

      plugin.loaded = false;
      plugin.enabled = false;

      this.plugins.delete(pluginId);

      this.emit('plugin:unloaded', { pluginId });

      log.info(`Plugin unloaded: ${pluginId}`);
    } catch (error) {
      log.error(`Failed to unload plugin ${pluginId}:`, error);
      throw error;
    }
  }

  enablePlugin(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);

    if (plugin) {
      plugin.enabled = true;
      this.emit('plugin:enabled', { pluginId });
    }
  }

  disablePlugin(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);

    if (plugin) {
      plugin.enabled = false;
      this.emit('plugin:disabled', { pluginId });
    }
  }

  private registerHooks(pluginId: string, hooks: PluginHooks): void {
    for (const [event, handler] of Object.entries(hooks)) {
      const existing = this.hooks.get(event) || [];
      existing.push({ ...hooks, pluginId } as any);
      this.hooks.set(event, existing);
    }
  }

  private unregisterHooks(pluginId: string): void {
    for (const [, hooks] of this.hooks) {
      const index = hooks.findIndex((h: any) => h.pluginId === pluginId);
      if (index >= 0) {
        hooks.splice(index, 1);
      }
    }
  }

  async emitHook(hookName: string, data: any): Promise<any> {
    const hooks = this.hooks.get(hookName);

    if (!hooks || hooks.length === 0) return data;

    let result = data;

    for (const hook of hooks) {
      if (typeof hook === 'function') {
        result = await hook(result);
      }
    }

    return result;
  }

  getPlugin(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }

  getPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  getEnabledPlugins(): Plugin[] {
    return Array.from(this.plugins.values()).filter(p => p.enabled);
  }

  getStats(): { totalPlugins: number; enabledPlugins: number; loadedPlugins: number } {
    const plugins = Array.from(this.plugins.values());

    return {
      totalPlugins: plugins.length,
      enabledPlugins: plugins.filter(p => p.enabled).length,
      loadedPlugins: plugins.filter(p => p.loaded).length,
    };
  }
}

export interface PluginTemplate {
  activate: (api: PluginAPI) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  hooks?: Partial<PluginHooks>;
  commands?: any[];
  menus?: any[];
}

export const createPlugin = (template: PluginTemplate): PluginTemplate => template;

export const defaultPlugins: PluginTemplate[] = [];

export const pluginManager = new PluginManager({
  registerCommand: (command) => {},
  registerMenu: (menu) => {},
  registerTab: (tab) => {},
  registerShortcut: (shortcut) => {},
  getSettings: () => ({}),
  updateSettings: () => {},
  getWorkspace: () => null,
  showNotification: () => {},
  showInput: async () => '',
  confirm: async () => false,
});