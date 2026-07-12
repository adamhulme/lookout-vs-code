import type * as vscode from 'vscode';
import {
  createTemplate,
  type SessionTemplate,
  type SessionTemplateDraft
} from './templates/templateModel';
import {
  emptyTemplateStore,
  markTemplateUsed,
  migrateTemplateStore,
  removeTemplate,
  upsertTemplate,
  type TemplateStore
} from './templates/templateStore';

const TEMPLATE_STORE_KEY = 'lookout.templates.v1';

export class TemplateManager {
  private store: TemplateStore = emptyTemplateStore();

  public constructor(private readonly state: vscode.Memento) {}

  public async initialize(): Promise<readonly string[]> {
    const migration = migrateTemplateStore(
      this.state.get<unknown>(TEMPLATE_STORE_KEY),
      Date.now()
    );
    this.store = migration.store;
    await this.persist();
    return migration.warnings;
  }

  public list(): readonly SessionTemplate[] {
    return this.store.templates;
  }

  public async create(draft: SessionTemplateDraft): Promise<SessionTemplate> {
    const now = Date.now();
    const parsed = createTemplate(draft, now);
    if (!parsed.ok) {
      throw new Error(parsed.errors.join(' '));
    }
    this.store = upsertTemplate(this.store, parsed.template, now);
    await this.persist();
    return parsed.template;
  }

  public async markUsed(templateId: string): Promise<void> {
    this.store = markTemplateUsed(this.store, templateId, Date.now());
    await this.persist();
  }

  public async remove(templateId: string): Promise<void> {
    this.store = removeTemplate(this.store, templateId);
    await this.persist();
  }

  private persist(): Thenable<void> {
    return this.state.update(TEMPLATE_STORE_KEY, this.store);
  }
}
