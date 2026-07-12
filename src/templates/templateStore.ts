import {
  TEMPLATE_VERSION,
  asRecord,
  parseStoredTemplate,
  type SessionTemplate
} from './templateModel';

export interface TemplateStore {
  readonly version: typeof TEMPLATE_VERSION;
  readonly templates: readonly SessionTemplate[];
}

export interface TemplateRetentionPolicy {
  readonly maxTemplates: number;
  readonly maxUnusedAgeMs?: number;
}

export interface TemplateStoreMigration {
  readonly store: TemplateStore;
  readonly warnings: readonly string[];
}

export const DEFAULT_TEMPLATE_RETENTION: TemplateRetentionPolicy = {
  maxTemplates: 100
};

export function emptyTemplateStore(): TemplateStore {
  return { version: TEMPLATE_VERSION, templates: [] };
}

export function migrateTemplateStore(
  value: unknown,
  now: number,
  retention: TemplateRetentionPolicy = DEFAULT_TEMPLATE_RETENTION
): TemplateStoreMigration {
  const record = asRecord(value);
  const rawTemplates = Array.isArray(value)
    ? value
    : Array.isArray(record?.templates)
      ? record.templates
      : [];
  const warnings: string[] = [];
  const templates: SessionTemplate[] = [];
  for (const [index, rawTemplate] of rawTemplates.entries()) {
    const parsed = parseStoredTemplate(rawTemplate, now);
    if (!parsed.ok) {
      warnings.push(
        `Discarded template ${index + 1}: ${parsed.errors.join(' ')}`
      );
      continue;
    }
    warnings.push(...parsed.warnings.map((warning) =>
      `Template ${parsed.template.id}: ${warning}`
    ));
    templates.push(parsed.template);
  }
  if (record && record.version !== undefined && record.version !== TEMPLATE_VERSION) {
    warnings.push(`Migrated template store version ${String(record.version)} to ${TEMPLATE_VERSION}.`);
  }
  return {
    store: retainTemplates({ version: TEMPLATE_VERSION, templates }, now, retention),
    warnings
  };
}

export function upsertTemplate(
  store: TemplateStore,
  template: SessionTemplate,
  now: number,
  retention: TemplateRetentionPolicy = DEFAULT_TEMPLATE_RETENTION
): TemplateStore {
  const parsed = parseStoredTemplate(template, now);
  if (!parsed.ok) {
    return retainTemplates(store, now, retention);
  }
  const safeTemplate = parsed.template;
  const existing = store.templates.find(
    (candidate) => candidate.id === safeTemplate.id
  );
  const updated: SessionTemplate = {
    ...safeTemplate,
    version: TEMPLATE_VERSION,
    createdAt: existing?.createdAt ?? safeTemplate.createdAt,
    updatedAt: now
  };
  return retainTemplates(
    {
      version: TEMPLATE_VERSION,
      templates: [
        updated,
        ...store.templates.filter(
          (candidate) => candidate.id !== safeTemplate.id
        )
      ]
    },
    now,
    retention
  );
}

export function removeTemplate(
  store: TemplateStore,
  templateId: string
): TemplateStore {
  return {
    version: TEMPLATE_VERSION,
    templates: safeTemplates(store.templates, 0).filter(
      (template) => template.id !== templateId
    )
  };
}

export function markTemplateUsed(
  store: TemplateStore,
  templateId: string,
  now: number
): TemplateStore {
  return {
    version: TEMPLATE_VERSION,
    templates: safeTemplates(store.templates, now).map((template) =>
      template.id === templateId
        ? { ...template, lastUsedAt: now, updatedAt: now }
        : template
    )
  };
}

export function retainTemplates(
  store: TemplateStore,
  now: number,
  policy: TemplateRetentionPolicy = DEFAULT_TEMPLATE_RETENTION
): TemplateStore {
  const maxTemplates = Math.max(1, Math.floor(policy.maxTemplates));
  const newestById = new Map<string, SessionTemplate>();
  for (const candidate of store.templates) {
    const parsed = parseStoredTemplate(candidate, now);
    if (!parsed.ok) {
      continue;
    }
    const template = parsed.template;
    const existing = newestById.get(template.id);
    if (!existing || recency(template) > recency(existing)) {
      newestById.set(template.id, template);
    }
  }
  const retained = [...newestById.values()]
    .filter((template) =>
      policy.maxUnusedAgeMs === undefined ||
      now - (template.lastUsedAt ?? template.updatedAt) <= policy.maxUnusedAgeMs
    )
    .sort((left, right) => recency(right) - recency(left))
    .slice(0, maxTemplates);
  return { version: TEMPLATE_VERSION, templates: retained };
}

function recency(template: SessionTemplate): number {
  return template.lastUsedAt ?? template.updatedAt;
}

function safeTemplates(
  templates: readonly SessionTemplate[],
  fallbackNow: number
): SessionTemplate[] {
  return templates.flatMap((template) => {
    const parsed = parseStoredTemplate(template, fallbackNow);
    return parsed.ok ? [parsed.template] : [];
  });
}
