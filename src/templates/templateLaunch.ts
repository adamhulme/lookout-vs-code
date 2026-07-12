import type { AgentKind, LaunchRequest } from '../types';
import type { SessionTemplate } from './templateModel';

export interface RuntimeProfileLaunch {
  readonly id: string;
  readonly kind: AgentKind;
  /** Runtime-only command resolved from user configuration or an explicit prompt. */
  readonly command: string;
  readonly displayName: string;
}

export interface TemplateWorkspaceFolder {
  readonly name: string;
  readonly path: string;
}

export interface TemplateLaunchContext {
  readonly profile: RuntimeProfileLaunch;
  readonly workspaceFolders: readonly TemplateWorkspaceFolder[];
  readonly selectedFolder?: string;
  readonly counter?: number;
}

export interface BuiltTemplateLaunch {
  readonly session: LaunchRequest;
  readonly templateId: string;
  readonly profileId: string;
  readonly worktreePolicy: SessionTemplate['worktreePolicy'];
  readonly reviewLayout: SessionTemplate['reviewLayout'];
  readonly initialTask?: string;
  readonly browserUrl?: string;
  readonly verificationPolicyRef?: string;
}

export type TemplateLaunchResult =
  | { readonly ok: true; readonly request: BuiltTemplateLaunch }
  | { readonly ok: false; readonly errors: readonly string[] };

export function buildTemplateLaunchRequest(
  template: SessionTemplate,
  context: TemplateLaunchContext
): TemplateLaunchResult {
  const errors: string[] = [];
  if (context.profile.id !== template.profileId) {
    errors.push(
      `Template profile ${template.profileId} does not match ${context.profile.id}.`
    );
  }
  const command = context.profile.command.trim();
  if (!command) {
    errors.push('The selected profile has no runtime launch command.');
  }
  const cwd = resolveFolder(template, context, errors);
  if (errors.length > 0 || !cwd || !command) {
    return { ok: false, errors };
  }
  const label = renderTemplateLabel(template, context, cwd);
  if (!label) {
    return { ok: false, errors: ['The label pattern produced an empty label.'] };
  }
  return {
    ok: true,
    request: {
      templateId: template.id,
      profileId: template.profileId,
      session: {
        kind: context.profile.kind,
        label,
        command,
        cwd
      },
      worktreePolicy: template.worktreePolicy,
      reviewLayout: template.reviewLayout,
      ...(template.initialTask ? { initialTask: template.initialTask } : {}),
      ...(template.browserUrl ? { browserUrl: template.browserUrl } : {}),
      ...(template.verificationPolicyRef
        ? { verificationPolicyRef: template.verificationPolicyRef }
        : {})
    }
  };
}

export function renderTemplateLabel(
  template: SessionTemplate,
  context: Pick<TemplateLaunchContext, 'profile' | 'counter'>,
  cwd: string
): string {
  const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  return template.labelPattern
    .replaceAll('{template}', template.name)
    .replaceAll('{profile}', context.profile.displayName)
    .replaceAll('{folder}', folder)
    .replaceAll('{counter}', String(context.counter ?? 1))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function resolveFolder(
  template: SessionTemplate,
  context: TemplateLaunchContext,
  errors: string[]
): string | undefined {
  switch (template.folderPolicy.kind) {
    case 'fixed':
      return template.folderPolicy.path;
    case 'prompt':
      if (!context.selectedFolder?.trim()) {
        errors.push('This template requires a selected working folder.');
        return undefined;
      }
      return context.selectedFolder.trim();
    case 'workspace': {
      const workspaceFolderName = template.folderPolicy.workspaceFolder;
      const folder = workspaceFolderName
        ? context.workspaceFolders.find(
            (candidate) => candidate.name === workspaceFolderName
          )
        : context.workspaceFolders[0];
      if (!folder) {
        errors.push(
          workspaceFolderName
            ? `Workspace folder ${workspaceFolderName} is not open.`
            : 'No workspace folder is open.'
        );
        return undefined;
      }
      return folder.path;
    }
  }
}
